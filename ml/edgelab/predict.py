"""Load local EdgeLab artifacts and produce race-normalized win probabilities."""
from __future__ import annotations

import math
import pickle
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from .models.train import _features, _race_softmax, _score
from .normalization.availability import available_by


def load_artifact(path: str | Path) -> dict[str, Any]:
    """Read a model artifact written by models.train.train_model."""
    with Path(path).open("rb") as stream:
        value = pickle.load(stream)
    if not isinstance(value, dict) or "metadata" not in value:
        raise ValueError("Unsupported EdgeLab model artifact")
    return value


def predict_rows(rows: Sequence[Mapping[str, Any]], artifact: Mapping[str, Any] | str | Path,
                 *, predicted_at: str | None = None, data_origin: str = "real") -> list[dict[str, Any]]:
    """Predict win probability for each entry, normalized within race.

    Rows with ``available_at`` later than the prediction timestamp are excluded
    from output, preserving the project's point-in-time data rule. Untrained
    artifacts emit null probabilities rather than fabricated estimates.
    """
    loaded = load_artifact(artifact) if isinstance(artifact, (str, Path)) else dict(artifact)
    timestamp = predicted_at or datetime.now(timezone.utc).isoformat()
    meta = loaded.get("metadata") or {}
    model_id = meta.get("id")
    usable = []
    for row in rows:
        if not available_by(row, timestamp):
            continue
        if row.get("race_id") is not None and row.get("number") is not None:
            usable.append(dict(row))
    if not usable:
        return []
    if meta.get("status") == "untrained" or loaded.get("model") is None:
        return [{"id": f"{r['race_id']}:{model_id}:{int(r['number'])}:{timestamp}", "race_id": str(r["race_id"]), "number": int(r["number"]), "model_id": model_id,
                 "probability": None, "prob_std": None, "predicted_at": timestamp,
                 "data_origin": data_origin} for r in usable]
    columns = list(loaded.get("feature_columns") or meta.get("featureColumns") or [])
    if not columns:
        raise ValueError("Model artifact is missing feature_columns")
    models = [loaded["model"], *list(loaded.get("bootstrap_models") or [])]
    temp = float(loaded.get("temperature", meta.get("temperature", 1.0)))
    # Each bootstrap estimator gets its own race softmax. The mean/std retain
    # within-race normalization while representing epistemic uncertainty.
    member_probs = []
    for estimator in models:
        scores = _score(estimator, usable, columns)
        member_probs.append(_race_softmax(scores, usable, temp))
    output = []
    for idx, row in enumerate(usable):
        vals = [p[idx] for p in member_probs]
        mean = sum(vals) / len(vals)
        std = statistics.stdev(vals) if len(vals) > 1 else 0.0
        output.append({"id": f"{row['race_id']}:{model_id}:{int(row['number'])}:{timestamp}", "race_id": str(row["race_id"]), "number": int(row["number"]),
                       "model_id": model_id, "probability": mean, "prob_std": std,
                       "predicted_at": timestamp, "data_origin": data_origin})
    return output


predict = predict_rows
