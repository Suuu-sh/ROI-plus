"""Resolve and submit all bounded current-time experimental T-60 forecasts."""
from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from edgelab.experimental_registry import (ForecastOnlyArtifactError,
                                           validate_forecast_only_artifact)
from edgelab.experimental_forecast_refresh import refresh_current_day_archives
from edgelab.experimental_forecast_submit import submit_forecasts
from edgelab.storage import DEFAULT_STORE, load_rows


class ExperimentalForecastJobError(RuntimeError):
    """Fixed safe failure category; never carries remote response details."""

    def __init__(self, category: str):
        allowed = {"credentials_unavailable", "model_endpoint_http_error", "model_endpoint_unavailable",
                   "invalid_model_response", "no_registered_model", "artifact_rejected",
                   "archive_refresh_unavailable", "forecast_generation_failed",
                   "invalid_forecast_envelope", "submission_failed"}
        self.failure_category = category if category in allowed else "model_endpoint_unavailable"


def resolve_latest_forecast_model(base_url: str, token: str, *, opener=None) -> dict[str, str]:
    """Fetch the API's exact latest model descriptor; never search/fallback locally."""
    if not base_url or not token:
        raise ExperimentalForecastJobError("credentials_unavailable")
    request = urllib.request.Request(base_url.rstrip("/") + "/api/ingest/experimental-trifecta/forecast-model",
        method="GET", headers={"Authorization": "Bearer " + token,
                                "Accept": "application/json", "User-Agent": "ROIPlus-Forecast/1.0"})
    open_request = opener or urllib.request.urlopen
    try:
        with open_request(request, timeout=20) as response:
            body = response.read(16_385)
    except urllib.error.HTTPError as exc:
        raise ExperimentalForecastJobError("model_endpoint_http_error") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ExperimentalForecastJobError("model_endpoint_unavailable") from None
    if not body or len(body) > 16_384:
        raise ExperimentalForecastJobError("invalid_model_response")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ExperimentalForecastJobError("invalid_model_response") from None
    model = payload.get("model") if isinstance(payload, dict) else None
    if model is None:
        raise ExperimentalForecastJobError("no_registered_model")
    if (not isinstance(model, dict)
            or not isinstance(model.get("modelId"), str)
            or not re.fullmatch(r"boat-trifecta-exp-noweather-[A-Za-z0-9._-]{1,128}", model["modelId"])
            or not isinstance(model.get("artifactSha256"), str)
            or not re.fullmatch(r"[a-fA-F0-9]{64}", model["artifactSha256"])):
        raise ExperimentalForecastJobError("invalid_model_response")
    return {"modelId": model["modelId"], "artifactSha256": model["artifactSha256"].lower()}


def _eligible_forecasts(envelope: dict[str, Any], store: dict[str, Any]) -> dict[str, Any] | None:
    """Keep every eligible race in cutoff order; the API still receives one race per call."""
    forecast_races = envelope.get("races")
    if not isinstance(forecast_races, list) or len(forecast_races) > 180:
        raise ExperimentalForecastJobError("invalid_forecast_envelope")
    races = {str(row.get("id")): row for row in store.get("races", [])
             if isinstance(row, dict) and row.get("sport") == "boat" and row.get("status") == "scheduled"
             and row.get("data_origin") == "real"}
    eligible: list[tuple[dt.datetime, str, dict[str, Any]]] = []
    for forecast in forecast_races:
        if not isinstance(forecast, dict) or not isinstance(forecast.get("raceId"), str):
            raise ExperimentalForecastJobError("invalid_forecast_envelope")
        race = races.get(forecast["raceId"])
        if not race:
            continue
        try:
            cutoff = dt.datetime.fromisoformat(str(race.get("betting_cutoff_at", "")).replace("Z", "+00:00"))
            if cutoff.tzinfo is None or cutoff.utcoffset() is None:
                continue
        except (TypeError, ValueError):
            continue
        eligible.append((cutoff.astimezone(dt.timezone.utc), forecast["raceId"], forecast))
    if not eligible:
        return None
    eligible.sort(key=lambda row: (row[0], row[1]))
    return {**{key: value for key, value in envelope.items() if key != "races"},
            "races": [row[2] for row in eligible]}


def run_forecast_job(*, base_url: str, token: str, artifact_dir: str | Path = "ml/artifacts",
                     store_path: str | Path = str(DEFAULT_STORE), opener=None,
                     refresh: Callable[..., dict[str, Any]] = refresh_current_day_archives,
                     predictor: Callable[..., Any] = subprocess.run,
                     submitter: Callable[..., dict[str, Any]] = submit_forecasts) -> dict[str, Any]:
    """Refresh PIT inputs, capture actual post-refresh time, and submit every eligible race independently."""
    model = resolve_latest_forecast_model(base_url, token, opener=opener)
    try:
        validate_forecast_only_artifact(model["modelId"], model["artifactSha256"], artifact_dir=artifact_dir)
    except ForecastOnlyArtifactError:
        raise ExperimentalForecastJobError("artifact_rejected") from None
    today = dt.datetime.now(ZoneInfo("Asia/Tokyo")).date().isoformat()
    refreshed = refresh(today, store_path=store_path, base_url=base_url, token=token)
    if refreshed.get("status") not in {"refreshed", "no_new_archives"}:
        raise ExperimentalForecastJobError("archive_refresh_unavailable")
    # The actual timestamp is deliberately captured after the awaited refresh.
    as_of = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    envelope_path = Path("ml/data/learning/trifecta-experimental-forecast.json")
    command = [sys.executable, "-m", "edgelab", "predict-trifecta-experimental",
               "--model-id", model["modelId"], "--date", today, "--as-of", as_of,
               "--artifact-dir", str(artifact_dir), "--store", str(store_path), "--output", str(envelope_path)]
    try:
        generated = predictor(command, capture_output=True, text=True, check=False)
    except (OSError, subprocess.SubprocessError):
        raise ExperimentalForecastJobError("forecast_generation_failed") from None
    if generated.returncode != 0:
        raise ExperimentalForecastJobError("forecast_generation_failed")
    try:
        envelope = json.loads(envelope_path.read_text(encoding="utf-8"))
        if (not isinstance(envelope, dict) or envelope.get("modelId") != model["modelId"]
                or envelope.get("artifactSha256") != model["artifactSha256"]
                or envelope.get("trainingMode") != "experimental" or envelope.get("experimentalOnly") is not True):
            raise ValueError
        selected = _eligible_forecasts(envelope, load_rows(store_path))
    except (OSError, ValueError, TypeError, KeyError):
        raise ExperimentalForecastJobError("invalid_forecast_envelope") from None
    if selected is None:
        return {"status": "no_eligible_forecast", "reason": "no_actual_t60_race_in_window",
                "modelId": model["modelId"], "asOf": as_of,
                "archiveRefresh": refreshed.get("status")}
    stored: list[str] = []
    failures: list[dict[str, Any]] = []
    metadata = {key: value for key, value in selected.items() if key != "races"}
    for forecast in selected["races"]:
        result = submitter({**metadata, "races": [forecast]}, base_url=base_url, token=token)
        if result.get("status") == "forecast_stored" and result.get("storedRaceCount") == 1:
            stored.extend(result.get("raceIds", [forecast["raceId"]]))
        else:
            # One rejected or expired race must not starve other simultaneous races.
            failures.append({"raceId": forecast["raceId"], "reason": "submission_failed"})
    return {"status": "partially_stored" if failures and stored else
                      "forecast_failed" if failures else "forecast_stored",
            "modelId": model["modelId"], "asOf": as_of, "raceIds": stored,
            "eligibleRaceCount": len(selected["races"]), "storedRaceCount": len(stored),
            "failures": failures, "archiveRefresh": refreshed.get("status")}


def run_forecast_loop(*, duration_minutes: int, interval_seconds: int = 60,
                      job: Callable[..., dict[str, Any]] = run_forecast_job,
                      monotonic=None, sleep=None, emit=None, **kwargs) -> dict[str, int]:
    """Reuse one initialized runner, refresh inputs/time every tick, and recover next tick.

    Execution latency is not a guarantee: all PIT and pre-cutoff API gates remain.
    Missed ticks are skipped rather than replayed with historical timestamps.
    """
    import time
    if not 1 <= duration_minutes <= 300 or not 1 <= interval_seconds <= 60:
        raise ValueError("invalid bounded forecast loop duration or interval")
    monotonic = monotonic or time.monotonic
    sleep = sleep or time.sleep
    emit = emit or (lambda result: print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True))
    deadline = monotonic() + duration_minutes * 60
    ticks = failures = 0
    while monotonic() < deadline:
        started = monotonic()
        try:
            result = job(**kwargs)
        except ExperimentalForecastJobError as exc:
            result = {"status": "forecast_failed", "reason": exc.failure_category}
        emit(result)
        ticks += 1
        failures += result.get("status") in {"forecast_failed", "partially_stored"}
        remaining = min(deadline - monotonic(), interval_seconds - (monotonic() - started))
        if remaining > 0:
            sleep(remaining)
    return {"ticks": ticks, "failedTicks": failures}



def main() -> int:
    import os
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration-minutes", type=int, default=0)
    args = parser.parse_args()
    try:
        operation = run_forecast_job if not args.duration_minutes else lambda **kwargs: run_forecast_loop(duration_minutes=args.duration_minutes, **kwargs)
        result = operation(base_url=os.environ.get("EDGELAB_API_URL", ""),
            token=os.environ.get("INGEST_TOKEN", ""), artifact_dir=os.environ.get("EXPERIMENTAL_ARTIFACT_DIR", "ml/artifacts"),
            store_path=os.environ.get("EXPERIMENTAL_STORE_PATH", str(DEFAULT_STORE)))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except ExperimentalForecastJobError as exc:
        print(json.dumps({"status": "forecast_failed", "reason": exc.failure_category}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
