"""Command-line entry point for collection, training, prediction and sync."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pickle
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Any

from edgelab.storage import DEFAULT_STORE, load_rows, merge_rows, save_rows


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _inference_timestamp() -> str:
    """Capture the real as-of time after collection, never reuse the run start."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _coerce_dt(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def _primary_prediction_as_of(betting_cutoff_at: str) -> str:
    """Use the primary T-60 input boundary, never the final betting deadline."""
    parsed = datetime.fromisoformat(betting_cutoff_at.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("official betting cutoff must include a timezone")
    return (parsed - timedelta(seconds=60)).isoformat(timespec="seconds")


def _apply_model_registry(rows: dict[str, Any], registry: list[dict[str, Any]]) -> set[str]:
    """Replace cached lifecycle claims with the authenticated registry snapshot."""
    remote = {str(model.get("id")): model for model in registry if model.get("id")}
    # Keep only locally-created candidates absent from the registry; never retain
    # a stale cached active/retired claim as authoritative state.
    local_candidates = [model for model in rows.get("models", [])
                        if model.get("status") in {"candidate", "untrained"}
                        and str(model.get("id")) not in remote]
    rows["models"] = [*local_candidates, *remote.values()]
    return set(remote)


def _safe_boat_schema_version(model_id: str, artifact_dir: Path = Path("ml/artifacts")) -> str | None:
    """Return the runtime feature marker only for a matching, safe JSON/pickle pair."""
    try:
        from edgelab.features.boat import BASE_FEATURE_COLUMNS
        from edgelab.predict import load_artifact
        json_meta = json.loads((artifact_dir / f"{model_id}.json").read_text(encoding="utf-8"))
        artifact = load_artifact(artifact_dir / f"{model_id}.pkl")
        pkl_meta = artifact.get("metadata") or {}
        columns = list(artifact.get("feature_columns") or [])
        saved_columns = list(json_meta.get("featureColumns") or [])
        stable_json = {k: v for k, v in json_meta.items() if k != "metrics"}
        stable_pkl = {k: v for k, v in pkl_meta.items() if k != "metrics"}
        json_metrics, pkl_metrics = json_meta.get("metrics") or {}, pkl_meta.get("metrics") or {}
        metrics_match = all(json_metrics.get(k) == pkl_metrics.get(k)
                            for k in ("logLoss", "brier", "ece"))
        return ("boat-base-v1" if json_meta.get("id") == model_id
                and pkl_meta.get("id") == model_id and stable_json == stable_pkl
                and metrics_match
                and columns == saved_columns and columns
                and all(column in BASE_FEATURE_COLUMNS for column in columns)
                and artifact.get("model") is not None and json_meta.get("status") == "candidate"
                else None)
    except (OSError, ValueError, TypeError, KeyError, pickle.UnpicklingError, EOFError):
        return None


def _verify_runtime_artifact(model_row: dict[str, Any], artifact_path: Path) -> None:
    """Fail closed unless registry evidence binds the safe schema to these exact bytes."""
    try:
        metrics = model_row.get("metrics")
        if not isinstance(metrics, dict):
            metrics = json.loads(model_row.get("metrics_json") or "{}")
        expected = metrics.get("boatArtifactSha256")
        source_digest = metrics.get("correctedTrainingDataSha256")
        if (metrics.get("boatFeatureSchemaVersion") != "boat-base-v1" or not expected
                or metrics.get("boatVenueSchemaVersion") != "boat-venue-v2"
                or not isinstance(source_digest, str) or len(source_digest) != 64
                or any(char not in "0123456789abcdef" for char in source_digest)):
            raise RuntimeError("active boat model lacks verified safe-schema/artifact identity metadata")
        actual = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError("active boat model artifact bytes do not match the registry-approved SHA256")
        from edgelab.predict import load_artifact
        sidecar_path = artifact_path.with_suffix(".json")
        sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        artifact = load_artifact(artifact_path)
        pickle_metadata = artifact.get("metadata") or {}
        for metadata in (sidecar, pickle_metadata):
            if (metadata.get("boatVenueSchemaVersion") != "boat-venue-v2"
                    or metadata.get("correctedTrainingDataSha256") != source_digest
                    or sidecar.get("id") != model_row.get("id")
                    or pickle_metadata.get("id") != model_row.get("id")):
                raise RuntimeError("active boat artifact metadata does not match venue-v2 registry provenance")
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        raise RuntimeError("active boat model has invalid safe-schema/artifact identity metadata") from exc


def _date_range(start: str, end: str):
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    if first > last:
        raise ValueError("--from must be on or before --to")
    current = first
    while current <= last:
        yield current
        current += timedelta(days=1)


def _predict_boat_date(rows: dict[str, list[dict[str, Any]]], day: str, cutoff: str,
                       artifact_dir: Path = Path("ml/artifacts")) -> list[dict[str, Any]]:
    """Predict one boat day with the selected persisted model; fail closed without artifacts."""
    from edgelab.features.boat import build_boat_features
    from edgelab.predict import load_artifact, predict_rows
    models = [m for m in rows.get("models", []) if m.get("sport") == "boat"]
    selected = next((m for m in models if m.get("status") == "active"), None)
    if selected is None:
        raise RuntimeError("no active model in authoritative local registry; candidate models are evaluation-only")
    model_id = str(selected["id"])
    artifact = artifact_dir / f"{model_id}.pkl"
    if not artifact.is_file():
        raise FileNotFoundError(f"model artifact not found: {artifact}; restore ml/artifacts cache or run train first")
    _verify_runtime_artifact(selected, artifact)
    race_map = {r["id"]: r for r in rows.get("races", [])
                if r.get("sport") == "boat" and r.get("race_date") == day
                and r.get("data_origin") == "real"}
    grouped: dict[str, list[dict[str, Any]]] = {}
    cutoff_dt = _coerce_dt(cutoff)
    for entry in rows.get("entries", []):
        rid = entry.get("race_id")
        race = race_map.get(rid)
        post_time = _coerce_dt(str(race["post_time"])) if race and race.get("post_time") else None
        if (race and entry.get("data_origin") == "real"
                and race.get("status") not in {"finished", "closed", "cancelled"}
                and post_time and post_time > cutoff_dt):
            grouped.setdefault(str(rid), []).append(dict(entry))
    from edgelab.features.boat import FEATURE_COLUMNS
    entries = [{**{k: v for k, v in entry.items() if k not in FEATURE_COLUMNS}, **feature}
               for rid, group in grouped.items()
               for entry, feature in zip(group, build_boat_features(group, race_date=day, predicted_at=cutoff))]
    predictions = predict_rows(entries, load_artifac