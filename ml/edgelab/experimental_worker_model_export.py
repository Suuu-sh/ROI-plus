"""Export a pinned experimental trifecta model to the Worker inference schema.

This is a serialization-only bridge: it never trains, promotes, or selects a
model. The registry's exact model-id/SHA/manifest gate runs before pickle load.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Mapping

from edgelab.experimental_registry import validate_forecast_only_artifact
from edgelab.predict import load_artifact
from edgelab.features.boat import TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS


SCHEMA = "experimental-trifecta-worker-model-v1"


def _finite_vector(value: Any, size: int) -> list[float]:
    try:
        items = [float(v) for v in value]
    except (TypeError, ValueError, OverflowError):
        raise ValueError("invalid_model_vector") from None
    if len(items) != size or not all(math.isfinite(v) for v in items):
        raise ValueError("invalid_model_vector")
    return items


def export_worker_model(model_id: str, expected_sha256: str, *,
                        artifact_dir: str | Path, output_path: str | Path) -> dict[str, Any]:
    """Validate exact registered cache artifact then write portable JSON."""
    identity = validate_forecast_only_artifact(
        model_id, expected_sha256, artifact_dir=artifact_dir)
    artifact = load_artifact(Path(artifact_dir) / f"{model_id}.pkl")
    metadata = artifact.get("metadata") or {}
    # trifecta training artifacts store the model matrix schema at top-level
    # `columns`; metadata's `featureColumns` is the matching registry sidecar.
    columns = list(artifact.get("columns") or [])
    expected_columns = list(TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS)
    if (metadata.get("id") != identity["modelId"]
            or columns != expected_columns
            or metadata.get("trainingMode") != "experimental"
            or metadata.get("experimentalOnly") is not True):
        raise ValueError("artifact_metadata_mismatch")
    try:
        temperature = float(artifact.get("temperature", 1.0))
    except (TypeError, ValueError, OverflowError):
        raise ValueError("invalid_temperature") from None
    if not math.isfinite(temperature) or temperature <= 0:
        raise ValueError("invalid_temperature")
    source_members = [artifact["model"], *list(artifact.get("bootstrap_models") or [])]
    if not 1 <= len(source_members) <= 5:
        raise ValueError("invalid_member_count")
    members = []
    for source in source_members:
        if list(source.get("columns") or []) != expected_columns:
            raise ValueError("artifact_metadata_mismatch")
        estimator = source.get("estimator")
        coefficients = getattr(estimator, "coef_", None)
        if coefficients is None or len(coefficients) != 1:
            raise ValueError("invalid_model_coefficients")
        members.append({
            "medians": _finite_vector(source.get("medians"), len(columns)),
            "means": _finite_vector(source.get("means"), len(columns)),
            "scales": _finite_vector(source.get("scales"), len(columns)),
            "coefficients": _finite_vector(coefficients[0], len(columns)),
        })
        if any(scale == 0 for scale in members[-1]["scales"]):
            raise ValueError("invalid_model_vector")
    result = {"schema": SCHEMA, "modelId": identity["modelId"],
              "artifactSha256": identity["artifactSha256"], "temperature": temperature,
              "columns": columns, "members": members}
    # Reject accidental non-JSON values and use stable formatting for hashable output.
    encoded = json.dumps(result, ensure_ascii=False, allow_nan=False,
                         sort_keys=True, separators=(",", ":"))
    Path(output_path).write_text(encoded + "\n", encoding="utf-8")
    return {"schema": result["schema"], "modelId": result["modelId"],
            "artifactSha256": result["artifactSha256"], "memberCount": len(members),
            "columnCount": len(columns)}
