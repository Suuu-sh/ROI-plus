"""One-time, read-only export of the pinned native forecast model and PIT inputs."""
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo

from edgelab.experimental_forecast_job import resolve_latest_forecast_model
from edgelab.experimental_registry import validate_forecast_only_artifact
from edgelab.experimental_worker_model_export import export_worker_model
from edgelab.experimental_forecast_refresh import refresh_current_day_archives
from edgelab.features.boat import (build_boat_prerace_v2_features, classify_prerace_observation,
                                   completed_racer_history, _observation_selection_key)
from edgelab.models.trifecta import ensemble_ordered_triples, experimental_ticket_predictions
from edgelab.normalization.availability import filter_historical
from edgelab.predict import load_artifact
from edgelab.storage import DEFAULT_STORE, load_rows


HISTORY_SCHEMA = "native-racer-history-v1"
PARITY_SCHEMA = "native-forecast-python-parity-v1"
_ENTRY_INPUT_FIELDS = ("race_id", "number", "data_origin", "available_at",
                       "national_win_rate", "local_win_rate", "motor_2rate",
                       "boat_2rate", "weight_carried", "racer_class")
_ENTRY_FEATURE_JSON_FIELDS = ("racer_id", "age", "national_2rate", "local_2rate")
_OBSERVATION_INPUT_FIELDS = ("race_id", "kind", "entry_number", "data_origin",
                             "fetched_at", "available_at", "source_observed_at",
                             "source_sha256", "source_url")
_OBSERVATION_VALUE_FIELDS = ("exhibition_time", "tilt", "weight", "start_exhibition",
                             "start_exhibition_course", "start_exhibition_false_start")


def _feature_replay_input(race: Mapping[str, Any], entries: list[Mapping[str, Any]],
                          observations: list[Mapping[str, Any]], predicted_at: str) -> dict[str, Any]:
    """Keep only current-race fields consumed by the no-weather feature builder."""
    safe_race = {key: race.get(key) for key in ("id", "race_date", "venue_id", "race_no", "data_origin")}
    safe_entries = []
    for entry in entries:
        try:
            extra = json.loads(entry.get("features_json") or "{}")
        except (TypeError, ValueError):
            extra = {}
        if not isinstance(extra, dict):
            extra = {}
        safe_entries.append({**{key: entry.get(key) for key in _ENTRY_INPUT_FIELDS},
                             "features_json": json.dumps(
                                 {key: extra.get(key) for key in _ENTRY_FEATURE_JSON_FIELDS
                                  if key in extra}, ensure_ascii=False, separators=(",", ":"))})
    safe_observations = []
    for observation in observations:
        try:
            values = json.loads(observation.get("values_json") or "{}")
        except (TypeError, ValueError):
            values = {}
        if not isinstance(values, dict):
            values = {}
        safe_observations.append({**{key: observation.get(key) for key in _OBSERVATION_INPUT_FIELDS},
                                  "values_json": json.dumps(
                                      {key: values.get(key) for key in _OBSERVATION_VALUE_FIELDS
                                       if key in values}, ensure_ascii=False, separators=(",", ":"))})
    return {"race": safe_race, "entries": safe_entries,
            "observations": safe_observations, "historyRaces": [],
            "predictedAt": predicted_at}


def _iso_utc(value: dt.datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timezone_required")
    return value.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_history_snapshot(store: Mapping[str, Any], *, today: str, as_of: str) -> dict[str, Any]:
    """Aggregate only complete verified history strictly before today/as-of."""
    history = completed_racer_history(store)
    prior = filter_historical(history, race_date=today, predicted_at=as_of)
    totals: dict[str, dict[str, int]] = {}
    for row in prior:
        racer_id = row.get("racer_id")
        if not isinstance(racer_id, str):
            continue
        item = totals.setdefault(racer_id, {"starts": 0, "wins": 0})
        item["starts"] += 1
        if row.get("finish_order") == 1 or str(row.get("finish_order")) == "1":
            item["wins"] += 1
    yesterday = (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat()
    return {"schema": HISTORY_SCHEMA, "asOf": as_of, "throughRaceDate": yesterday,
            "totals": totals}


def _actual_parity_fixture(store: Mapping[str, Any], artifact: Mapping[str, Any], *,
                           model_id: str, artifact_sha256: str, today: str,
                           as_of: str) -> dict[str, Any] | None:
    envelope = experimental_ticket_predictions(
        store, artifact=artifact, model_id=model_id, cutoff=as_of,
        artifact_sha256=artifact_sha256, race_date=today)
    if not envelope.get("races"):
        return None
    predicted = envelope["races"][0]
    race_id = predicted["raceId"]
    race = next(row for row in store.get("races", []) if str(row.get("id")) == race_id)
    entries = [dict(row) for row in store.get("entries", [])
               if str(row.get("race_id")) == race_id and row.get("data_origin") == "real"]
    observations = [row for row in store.get("prerace_observations", [])
                    if str(row.get("race_id")) == race_id and row.get("data_origin") == "real"]
    history = completed_racer_history(store)
    features = build_boat_prerace_v2_features(
        entries, race=race, predicted_at=predicted["predictedAt"],
        history=history, observations=observations)
    columns = list(artifact["columns"])
    feature_rows = [{column: feature.get(column) for column in columns}
                    for feature in features]
    group = [{**feature, "number": int(entry["number"])}
             for entry, feature in zip(entries, feature_rows)]
    mean, std = ensemble_ordered_triples(artifact, group)
    selected = {}
    for observation in observations:
        if observation.get("kind") != "exhibition":
            continue
        try:
            lane = int(observation.get("entry_number"))
        except (TypeError, ValueError):
            continue
        if not 1 <= lane <= 6:
            continue
        values, _reason = classify_prerace_observation(
            observation, race, predicted["predictedAt"])
        if not values:
            continue
        key = _observation_selection_key(observation, values)
        if lane not in selected or key > selected[lane][0]:
            selected[lane] = (key, observation)
    captured = {str(lane): observation.get("fetched_at") or observation.get("available_at")
                for lane, (_key, observation) in selected.items()}
    replay_observations = [row for _key, row in selected.values()]
    return {
        "schema": PARITY_SCHEMA, "raceId": race_id,
        "raceDate": today, "predictedAt": predicted["predictedAt"],
        "captureTimesByLane": captured, "columns": columns,
        "input": _feature_replay_input(race, entries, replay_observations,
                                       predicted["predictedAt"]),
        "numbers": [int(row["number"]) for row in entries],
        "features": [[row.get(column) for column in columns] for row in features],
        "meanProbabilities": mean, "populationStdProbabilities": std,
    }


def export_native_forecast_inputs(*, base_url: str, token: str,
                                  artifact_dir: str | Path, store_path: str | Path,
                                  output_dir: str | Path,
                                  resolver: Callable[..., dict[str, str]] = resolve_latest_forecast_model,
                                  validator: Callable[..., Any] = validate_forecast_only_artifact,
                                  refresher: Callable[..., dict[str, Any]] = refresh_current_day_archives,
                                  clock: Callable[[], dt.datetime] = lambda: dt.datetime.now(dt.timezone.utc)) -> dict[str, Any]:
    """Resolve and validate exact cache model; write only bounded inference inputs."""
    model = resolver(base_url, token)
    validator(model["modelId"], model["artifactSha256"], artifact_dir=artifact_dir)
    root = Path(output_dir)
    root.mkdir(parents=True, exist_ok=True)
    model_path = root / "experimental-worker-model.json"
    model_summary = export_worker_model(model["modelId"], model["artifactSha256"],
                                        artifact_dir=artifact_dir, output_path=model_path)
    today = clock().astimezone(ZoneInfo("Asia/Tokyo")).date().isoformat()
    refreshed = refresher(today, store_path=store_path, base_url=base_url, token=token)
    if refreshed.get("status") not in {"refreshed", "no_new_archives"}:
        raise ValueError("archive_refresh_unavailable")
    now = clock()
    as_of = _iso_utc(now)
    today = now.astimezone(ZoneInfo("Asia/Tokyo")).date().isoformat()
    store = load_rows(store_path)
    history = build_history_snapshot(store, today=today, as_of=as_of)
    history_path = root / "native-racer-history.json"
    history_path.write_text(json.dumps(history, ensure_ascii=False, allow_nan=False,
                                       separators=(",", ":")) + "\n", encoding="utf-8")
    artifact = load_artifact(Path(artifact_dir) / f'{model["modelId"]}.pkl')
    parity = _actual_parity_fixture(store, artifact, model_id=model["modelId"],
                                    artifact_sha256=model["artifactSha256"],
                                    today=today, as_of=as_of)
    parity_path = root / "actual-python-parity.json"
    if parity is not None:
        parity_path.write_text(json.dumps(parity, ensure_ascii=False, allow_nan=False,
                                          separators=(",", ":")) + "\n", encoding="utf-8")
    summary = {"schema": "native-forecast-input-export-v1", "status": "exported",
               "asOf": as_of, "todayJst": today, "modelReady": True,
               "modelMemberCount": model_summary["memberCount"],
               "archiveImportedCount": refreshed.get("importedArchives", 0)
               if type(refreshed.get("importedArchives")) is int else 0,
               "historyRacerCount": len(history["totals"]),
               "parityFixtureStatus": "created" if parity is not None else "no_eligible_race",
               "parityRaceCount": 1 if parity is not None else 0}
    (root / "export-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n",
        encoding="utf-8")
    return summary


def main() -> int:
    output_dir = Path(os.environ.get("NATIVE_EXPORT_DIR", "native-forecast-input-export"))
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        result = export_native_forecast_inputs(
            base_url=os.environ.get("EDGELAB_API_URL", ""),
            token=os.environ.get("INGEST_TOKEN", ""),
            artifact_dir=os.environ.get("EXPERIMENTAL_ARTIFACT_DIR", "ml/artifacts"),
            store_path=os.environ.get("EXPERIMENTAL_STORE_PATH", str(DEFAULT_STORE)),
            output_dir=output_dir,
        )
    except Exception:
        result = {"schema": "native-forecast-input-export-v1", "status": "failed",
                  "errorCategory": "export_failed"}
        (output_dir / "export-summary.json").write_text(
            json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        print(json.dumps(result, sort_keys=True), flush=True)
        return 1
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
