"""Read-only-in-API current-day diagnostic for the experimental T-60 forecast gates."""
from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from edgelab.experimental_forecast_job import (
    ExperimentalForecastJobError,
    resolve_latest_forecast_model,
)
from edgelab.experimental_forecast_refresh import ARCHIVE_EXCLUSION_REASONS, refresh_current_day_archives
from edgelab.experimental_registry import (
    ForecastOnlyArtifactError,
    validate_forecast_only_artifact,
)
from edgelab.storage import DEFAULT_STORE, load_rows


GATE_REASONS = (
    "invalid_cutoff", "invalid_cutoff_source", "post_passed", "outside_t60_window",
    "cutoff_observation_late", "entry_coverage_incomplete", "market_incomplete",
    "exhibition_incomplete",
)
def _zero_diagnostics() -> dict[str, Any]:
    return {
        "schema": "experimental-forecast-preflight-v2", "status": "failed", "stage": "resolve",
        "errorCategory": None, "modelReady": False, "artifactFileCount": 0,
        "currentDayScheduledRaceCount": 0, "archiveImportedCount": 0, "archiveExcludedCount": 0,
        "archiveExclusionCounts": {reason: 0 for reason in ARCHIVE_EXCLUSION_REASONS},
        "forecastRaceCount": 0,
        "gateCounts": {"candidateRaceCount": 0, **{reason: 0 for reason in GATE_REASONS}},
    }


def _safe_count(value: Any) -> int:
    return value if type(value) is int and value >= 0 else 0


def _safe_archive_exclusions(value: Any) -> dict[str, int]:
    counts = {reason: 0 for reason in ARCHIVE_EXCLUSION_REASONS}
    if isinstance(value, dict):
        for reason, count in value.items():
            counts[reason if reason in counts else "other"] += _safe_count(count)
    return counts


def _scheduled_today(store_path: str | Path, today: str) -> int:
    rows = load_rows(store_path)
    return sum(1 for race in rows.get("races", [])
               if isinstance(race, dict) and race.get("sport") == "boat"
               and race.get("data_origin") == "real" and race.get("status") == "scheduled"
               and race.get("race_date") == today)


def run_preflight(*, base_url: str, token: str, artifact_dir: str | Path,
                  store_path: str | Path = str(DEFAULT_STORE),
                  resolver: Callable[..., dict[str, str]] = resolve_latest_forecast_model,
                  validator: Callable[..., Any] = validate_forecast_only_artifact,
                  refresher: Callable[..., dict[str, Any]] = refresh_current_day_archives,
                  predictor: Callable[..., Any] = subprocess.run,
                  clock: Callable[[], dt.datetime] = lambda: dt.datetime.now(dt.timezone.utc)) -> dict[str, Any]:
    """Refresh saved archives locally, run actual-time prediction, and emit allowlisted counts only.

    The API is read-only: the only remote calls resolve the registered model and fetch saved
    capture archives. Prediction writes a temporary local report; no forecast submitter is used.
    """
    result = _zero_diagnostics()
    try:
        model = resolver(base_url, token)
    except ExperimentalForecastJobError as exc:
        result["errorCategory"] = exc.failure_category
        return result
    except Exception:
        result["errorCategory"] = "preflight_unavailable"
        return result

    result["stage"] = "artifact_validation"
    root = Path(artifact_dir)
    try:
        validator(model["modelId"], model["artifactSha256"], artifact_dir=root)
    except ForecastOnlyArtifactError as exc:
        result["errorCategory"] = exc.failure_category
        names = (f'{model["modelId"]}.pkl', f'{model["modelId"]}.json',
                 f'experimental-trifecta-{model["modelId"]}.manifest.json')
        result["artifactFileCount"] = sum((root / name).is_file() for name in names)
        return result
    except Exception:
        result["errorCategory"] = "preflight_unavailable"
        return result

    result.update({"modelReady": True, "artifactFileCount": 3})
    try:
        today = clock().astimezone(ZoneInfo("Asia/Tokyo")).date().isoformat()
        result["stage"] = "archive_refresh"
        refreshed = refresher(today, store_path=store_path, base_url=base_url, token=token)
        if refreshed.get("status") not in {"refreshed", "no_new_archives"}:
            result["errorCategory"] = "archive_refresh_unavailable"
            return result
        result["archiveImportedCount"] = _safe_count(refreshed.get("importedArchives"))
        result["archiveExcludedCount"] = _safe_count(refreshed.get("excludedArchives"))
        result["archiveExclusionCounts"] = _safe_archive_exclusions(refreshed.get("exclusionCounts"))
        result["currentDayScheduledRaceCount"] = _scheduled_today(store_path, today)

        # Capture the clock only after the awaited archive refresh, matching the real prediction path.
        as_of = clock().astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        result["stage"] = "prediction_diagnostic"
        with tempfile.TemporaryDirectory(prefix="roi-forecast-preflight-") as temporary:
            output = Path(temporary) / "forecast.json"
            command = [sys.executable, "-m", "edgelab", "predict-trifecta-experimental",
                       "--model-id", model["modelId"], "--date", today, "--as-of", as_of,
                       "--artifact-dir", str(root), "--store", str(store_path), "--output", str(output)]
            completed = predictor(command, capture_output=True, text=True, check=False)
            if completed.returncode != 0:
                result["errorCategory"] = "forecast_generation_failed"
                return result
            try:
                envelope = json.loads(output.read_text(encoding="utf-8"))
            except (OSError, ValueError, UnicodeDecodeError):
                result["errorCategory"] = "invalid_forecast_envelope"
                return result

        diagnostics = envelope.get("diagnostics") if isinstance(envelope, dict) else None
        races = envelope.get("races") if isinstance(envelope, dict) else None
        counts = diagnostics.get("abstentionReasonCounts") if isinstance(diagnostics, dict) else None
        if (not isinstance(envelope, dict)
                or envelope.get("modelId") != model["modelId"]
                or envelope.get("artifactSha256") != model["artifactSha256"]
                or envelope.get("trainingMode") != "experimental"
                or envelope.get("experimentalOnly") is not True
                or not isinstance(diagnostics, dict)
                or not isinstance(races, list) or len(races) > 180
                or not isinstance(counts, dict)
                or type(diagnostics.get("candidateRaceCount")) is not int
                or diagnostics["candidateRaceCount"] < 0
                or any(not isinstance(row, dict) or not isinstance(row.get("raceId"), str) for row in races)
                or any(type(counts.get(reason)) is not int or counts[reason] < 0 for reason in GATE_REASONS)):
            result["errorCategory"] = "invalid_forecast_envelope"
            return result
        gates = {reason: counts[reason] for reason in GATE_REASONS}
        candidates = diagnostics["candidateRaceCount"]
        if len(races) + sum(gates.values()) != candidates:
            result["errorCategory"] = "invalid_forecast_envelope"
            return result
        result["forecastRaceCount"] = len(races)
        result["gateCounts"] = {"candidateRaceCount": candidates, **gates}
        result.update({"status": "diagnosed", "stage": "complete",
                       "forecastState": "generated" if races else "no_eligible_forecasts",
                       "errorCategory": None})
        return result
    except Exception:
        result["errorCategory"] = "preflight_unavailable"
        return result


def main() -> int:
    result = run_preflight(
        base_url=os.environ.get("EDGELAB_API_URL", ""),
        token=os.environ.get("INGEST_TOKEN", ""),
        artifact_dir=os.environ.get("EXPERIMENTAL_ARTIFACT_DIR", "ml/artifacts"),
        store_path=os.environ.get("EXPERIMENTAL_STORE_PATH", str(DEFAULT_STORE)),
    )
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0 if result["status"] == "diagnosed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
