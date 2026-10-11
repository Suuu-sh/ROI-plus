"""One-day, fixed-model operator for the explicitly approved boat baseline."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from edgelab.cli import _verify_runtime_artifact
from edgelab.predict import load_artifact, predict_rows
from edgelab.sync import fetch_model_registry, fetch_write_budget, sync_rows


DAY = "2026-10-11"
MODEL_ID = "boat-win-lgbm-20261010-14b4a90a"
ARTIFACT_RUN_ID = "38053091327"
ARTIFACT_NAME = f"candidate-model-artifact-{MODEL_ID}"
JSON_SHA = "ac1de4e7959fa2d5429db5728f97ea8da3d5cfde8efcf0666e5166aabca0513f"
PICKLE_SHA = "33f6735c9f30697f1d2584cd6af0b28d194786b9c448dbaa92fd3e3fd540fe83"
FINGERPRINT = "a5596554c3def74853149fdaba5b54557473459ba12ffb717d2d6ad805e0acec"
SOURCE_SHA = "e683dabcb9bc2842d3d10db5599b52f9cd50f6d186ada1419761dc392ac957ed"
REQUIRED_CHECKS = {
    "safeFeatureSchema", "realOnly", "completeFullRaceCohorts", "probabilitiesFiniteNormalized",
    "storedMetricsReproduced", "temporalSplitMatchesArtifact", "disjointRaceIds",
    "fitAndValidationPrecedeHoldout", "minHeldoutRaceCount", "minHeldoutDateCount",
    "pairedLogLossImprovement", "pairedBrierImprovement", "pairedLogLossDateClusterImprovement",
    "pairedBrierDateClusterImprovement", "eceWithinThreshold", "noGrossDateSliceReversal",
    "authenticatedRegistrySnapshot", "candidateRegisteredAsCandidate", "noCompatibleActiveModels",
}
BASE_URL = os.environ.get("EDGELAB_API_URL", "").rstrip("/")
TOKEN = os.environ.get("INGEST_TOKEN", "")


def _request(method: str, path: str, *, body: dict[str, Any] | None = None) -> Any:
    if not BASE_URL or not TOKEN:
        raise RuntimeError("EDGELAB_API_URL and INGEST_TOKEN are required")
    data = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    request = Request(f"{BASE_URL}/api/{path.lstrip('/')}", data=data, method=method,
                      headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json",
                               "Content-Type": "application/json", "User-Agent": "EdgeLab-OneDayOperator/1"})
    try:
        with urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"API operation failed: HTTP {exc.code}") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        raise RuntimeError(f"API operation failed: {type(exc).__name__}") from exc


def _today() -> None:
    if datetime.now(timezone.utc).date().isoformat() != DAY:
        raise RuntimeError("this operator is pinned to UTC 2026-10-11 only")


def _models() -> dict[str, dict[str, Any]]:
    return {str(row.get("id")): row for row in fetch_model_registry()}


def _metrics(model: dict[str, Any]) -> dict[str, Any]:
    value = model.get("metrics_json")
    if not isinstance(value, str):
        raise RuntimeError("approved model registry evidence is missing")
    try:
        result = json.loads(value)
    except ValueError as exc:
        raise RuntimeError("approved model registry evidence is invalid") from exc
    if not isinstance(result, dict):
        raise RuntimeError("approved model registry evidence is invalid")
    return result


def _artifact_pair(path: Path) -> tuple[Path, Path]:
    pkl = path / f"{MODEL_ID}.pkl"
    meta = path / f"{MODEL_ID}.json"
    if hashlib.sha256(pkl.read_bytes()).hexdigest() != PICKLE_SHA:
        raise RuntimeError("restored model artifact SHA-256 differs from approved bytes")
    if hashlib.sha256(meta.read_bytes()).hexdigest() != JSON_SHA:
        raise RuntimeError("restored model metadata SHA-256 differs from approved bytes")
    return pkl, meta


def allowance() -> dict[str, Any]:
    _today()
    current = fetch_write_budget()
    if current.get("date") != DAY or current.get("state") not in {"known", "exhausted"}:
        raise RuntimeError("today's valid existing D1 ledger is required")
    if current.get("allowance"):
        raise RuntimeError("today's one-time allowance is already applied")
    result = _request("POST", "ingest/write-budget/allowance", body={
        "date": DAY, "confirmed": True, "limit": 30_000,
        "essentialLimit": 24_000, "optionalLimit": 6_000,
    })
    return {"date": result.get("date"), "limit": result.get("limit"),
            "reserved": result.get("reserved"), "remaining": result.get("remaining"),
            "allowance": result.get("allowance")}


def promote(artifact_dir: Path) -> dict[str, Any]:
    _today()
    pkl, _ = _artifact_pair(artifact_dir)
    models = _models()
    model = models.get(MODEL_ID)
    if not model or model.get("status") != "candidate":
        raise RuntimeError("approved model is no longer registered as candidate")
    metrics = _metrics(model)
    validation = metrics.get("initialBaselineValidation")
    if (metrics.get("initialBaselineEligible") is not True or not isinstance(validation, dict)
            or validation.get("fingerprint") != FINGERPRINT
            or validation.get("status") != "evaluated"
            or validation.get("initialBaselineEligible") is not True
            or validation.get("candidateModelId") != MODEL_ID
            or validation.get("dataOrigin") != "real"
            or validation.get("correctedTrainingDataSha256") != SOURCE_SHA
            or metrics.get("correctedTrainingDataSha256") != SOURCE_SHA
            or metrics.get("boatArtifactSha256") != PICKLE_SHA
            or metrics.get("boatVenueSchemaVersion") != "boat-venue-v2"):
        raise RuntimeError("live candidate evidence differs from the approved initial-baseline record")
    _verify_runtime_artifact(model, pkl)
    checks = validation.get("checks")
    if not isinstance(checks, dict) or set(checks) != REQUIRED_CHECKS or not all(value is True for value in checks.values()):
        raise RuntimeError("all 19 approved initial-baseline checks must remain true")
    result = _request("POST", "ingest/approved-boat-baseline/promote", body={
        "date": DAY, "confirmed": True, "validationFingerprint": FINGERPRINT,
    })
    if result.get("status") != "active" or result.get("id") != MODEL_ID:
        raise RuntimeError("promotion did not return the approved active model")
    return {"modelId": MODEL_ID, "status": result.get("status"), "checks": len(checks),
            "fingerprint": FINGERPRINT, "artifactVerified": hashlib.sha256(pkl.read_bytes()).hexdigest() == PICKLE_SHA}


def forecast(artifact_dir: Path) -> dict[str, Any]:
    _today()
    pkl, _ = _artifact_pair(artifact_dir)
    model = _models().get(MODEL_ID)
    if not model or model.get("status") != "active":
        raise RuntimeError("only the exact approved active baseline can forecast")
    metrics = _metrics(model)
    if metrics.get("boatArtifactSha256") != PICKLE_SHA or metrics.get("correctedTrainingDataSha256") != SOURCE_SHA:
        raise RuntimeError("active model registry no longer binds the exact approved artifact")
    _verify_runtime_artifact(model, pkl)
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat(timespec="seconds").replace("+00:00", "Z")
    query = urlencode({"date": DAY, "cutoff": cutoff})
    source = _request("GET", f"ingest/today-boat-forecast-inputs?{query}")
    if source.get("date") != DAY or source.get("cutoff") != cutoff:
        raise RuntimeError("forecast input endpoint returned a mismatched day or cutoff")
    races = source.get("races")
    entries = source.get("entries")
    if not isinstance(races, list) or not isinstance(entries, list) or not races or len(entries) > 1_000:
        raise RuntimeError("no bounded eligible live race inputs are available")
    race_map = {str(row["id"]): row for row in races if isinstance(row, dict) and row.get("data_origin") == "real" and row.get("status") == "scheduled"}
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("data_origin") != "real" or entry.get("race_id") not in race_map:
            raise RuntimeError("forecast inputs contain an unexpected/non-real entry")
        grouped[str(entry["race_id"])].append(entry)
    if set(grouped) != set(race_map) or any(len(rows) != 6 or {int(row.get("number", 0)) for row in rows} != set(range(1, 7)) for rows in grouped.values()):
        raise RuntimeError("only complete six-lane race cohorts may be forecast")

    from edgelab.features.boat import FEATURE_COLUMNS, build_boat_features
    enriched: list[dict[str, Any]] = []
    for race_id, group in grouped.items():
        race = race_map[race_id]
        merged = [{**row, "wind_speed": race.get("wind_speed"), "wave_height": race.get("wave_height")} for row in group]
        features = build_boat_features(merged, race_date=DAY, predicted_at=cutoff)
        enriched.extend({**{key: value for key, value in row.items() if key not in FEATURE_COLUMNS}, **feature}
                        for row, feature in zip(merged, features))
    predictions = predict_rows(enriched, load_artifact(pkl), predicted_at=cutoff, data_origin="real")
    if len(predictions) != len(entries):
        raise RuntimeError("inference dropped one or more eligible entries")
    by_race: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in predictions:
        row["predicted_at"] = cutoff
        row["id"] = f"{row['race_id']}:{MODEL_ID}:{row['number']}:{cutoff}"
        if not isinstance(row.get("probability"), (int, float)) or not math.isfinite(row["probability"]) or not 0 <= row["probability"] <= 1:
            raise RuntimeError("non-finite model probability")
        if not isinstance(row.get("prob_std"), (int, float)) or not math.isfinite(row["prob_std"]) or row["prob_std"] < 0:
            raise RuntimeError("non-finite model uncertainty")
        by_race[row["race_id"]].append(row)
    if any(abs(sum(x["probability"] for x in rows) - 1) > 1e-8 for rows in by_race.values()):
        raise RuntimeError("race probabilities are not normalized")
    sync = sync_rows({"predictions": predictions})
    responses = sync.get("predictions")
    changed = sum(item.get("changed", 0) for item in (responses if isinstance(responses, list) else [responses]) if isinstance(item, dict))
    return {"date": DAY, "cutoff": cutoff, "modelId": MODEL_ID, "raceCount": len(by_race),
            "entryCount": len(predictions), "synced": True, "changedRows": changed}


def collect_odds() -> dict[str, Any]:
    _today()
    model = _models().get(MODEL_ID)
    if not model or model.get("status") != "active":
        raise RuntimeError("approved baseline must be active before odds collection")
    budget = fetch_write_budget()
    if budget.get("date") != DAY or budget.get("state") not in {"known", "exhausted"}:
        raise RuntimeError("today's valid write ledger is required")
    result = _request("POST", "ingest/collect-win-odds", body={"date": DAY, "confirmed": True})
    return {key: result.get(key) for key in ("status", "records", "targets", "failed", "excluded", "reason") if key in result}


def verify() -> dict[str, Any]:
    _today()
    status = _request("GET", f"ingest/today-boat-forecast-status?{urlencode({'date': DAY, 'model_id': MODEL_ID})}")
    model = status.get("model") or {}
    if model.get("id") != MODEL_ID or model.get("status") != "active":
        raise RuntimeError("approved baseline is not the active boat-win model")
    eligible=status.get("eligible") or {}
    predictions=status.get("predictions") or {}
    budget=status.get("writeBudget") or {}
    if (predictions.get("row_count") != eligible.get("entry_count")
            or predictions.get("race_count") != eligible.get("race_count")):
        raise RuntimeError("current eligible race/entry coverage does not match synced active-model forecasts")
    if status.get("autoBetEnabled") != "false" or status.get("autoBetPaused") != "true":
        raise RuntimeError("auto-bet must remain disabled and paused pending root review")
    if budget.get("date") != DAY or budget.get("state") not in {"known", "exhausted"}:
        raise RuntimeError("today's write budget is unavailable or invalid")
    return {key: status.get(key) for key in ("date", "cutoff", "model", "eligible", "predictions", "freshOfficialWinOdds", "autoBetEnabled", "autoBetPaused", "writeBudget")}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=("allowance", "promote", "forecast", "odds", "verify"))
    parser.add_argument("--artifact-dir", type=Path, default=Path("ml/artifacts"))
    args = parser.parse_args()
    handlers = {"allowance": allowance, "promote": lambda: promote(args.artifact_dir),
                "forecast": lambda: forecast(args.artifact_dir), "odds": collect_odds, "verify": verify}
    print(json.dumps(handlers[args.stage](), ensure_ascii=False, sort_keys=True, allow_nan=False))


if __name__ == "__main__":
    main()
