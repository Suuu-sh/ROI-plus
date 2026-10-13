"""Safe client for registering immutable experimental trifecta artifacts."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class ExperimentalModelRegistrationError(RuntimeError):
    """A registration failure carrying only a fixed safe diagnostic category."""

    def __init__(self, category: str):
        allowed = {"credentials_unavailable", "artifact_invalid", "request_too_large",
                   "http_401", "http_403", "http_404", "http_409", "http_413",
                   "http_429", "http_5xx", "http_other", "transport_error",
                   "invalid_json", "oversized_response", "invalid_response"}
        self.failure_category = category if category in allowed else "transport_error"


class ForecastOnlyArtifactError(ValueError):
    """Safe validation failure for an explicitly pinned cached model artifact."""

    def __init__(self, category: str):
        allowed = {"invalid_model_id", "invalid_expected_sha256", "artifact_missing",
                   "artifact_metadata_mismatch", "artifact_sha256_mismatch",
                   "artifact_manifest_mismatch"}
        self.failure_category = category if category in allowed else "artifact_metadata_mismatch"


def validate_forecast_only_artifact(model_id: str, expected_sha256: str, *,
                                    artifact_dir: str | Path) -> dict[str, str]:
    """Require a specific pinned ID/SHA and fully matching cached sidecars; never fallback."""
    if not isinstance(model_id, str) or not re.fullmatch(
            r"boat-trifecta-exp-noweather-[A-Za-z0-9._-]{1,128}", model_id):
        raise ForecastOnlyArtifactError("invalid_model_id")
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", expected_sha256):
        raise ForecastOnlyArtifactError("invalid_expected_sha256")
    root = Path(artifact_dir)
    pkl_path, metadata_path = root / f"{model_id}.pkl", root / f"{model_id}.json"
    manifest_path = root / f"experimental-trifecta-{model_id}.manifest.json"
    try:
        pkl_bytes, metadata_bytes = pkl_path.read_bytes(), metadata_path.read_bytes()
        metadata = json.loads(metadata_bytes.decode("utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        raise ForecastOnlyArtifactError("artifact_missing") from None
    actual = hashlib.sha256(pkl_bytes).hexdigest()
    if actual != expected_sha256.lower():
        raise ForecastOnlyArtifactError("artifact_sha256_mismatch")
    if (not isinstance(metadata, dict) or metadata.get("id") != model_id
            or metadata.get("status") != "candidate" or metadata.get("trainingMode") != "experimental"
            or metadata.get("experimentalOnly") is not True
            or metadata.get("boatFeatureSchemaVersion") != "boat-prerace-v2-no-weather-experimental-v1"
            or metadata.get("ticketArtifactSha256") != actual):
        raise ForecastOnlyArtifactError("artifact_metadata_mismatch")
    files = manifest.get("files") if isinstance(manifest, dict) else None
    manifest_file = files.get(pkl_path.name) if isinstance(files, dict) else None
    metadata_file = files.get(metadata_path.name) if isinstance(files, dict) else None
    if (not isinstance(manifest, dict) or manifest.get("schema") != "edgelab-experimental-trifecta-artifact-v1"
            or manifest.get("modelId") != model_id or manifest.get("trainingMode") != "experimental"
            or manifest.get("experimentalOnly") is not True
            or manifest.get("boatFeatureSchemaVersion") != "boat-prerace-v2-no-weather-experimental-v1"
            or not isinstance(manifest_file, dict) or manifest_file.get("sha256") != actual
            or manifest_file.get("sizeBytes") != len(pkl_bytes)
            or not isinstance(metadata_file, dict)
            or metadata_file.get("sha256") != hashlib.sha256(metadata_bytes).hexdigest()
            or metadata_file.get("sizeBytes") != len(metadata_bytes)):
        raise ForecastOnlyArtifactError("artifact_manifest_mismatch")
    return {"modelId": model_id, "artifactSha256": actual}


def register_experimental_model(model_id: str, *, artifact_dir: str | Path,
                                base_url: str, token: str, opener=None) -> dict[str, Any]:
    """POST manifest + exact metadata text to the isolated experimental registry.

    Neither pickle bytes nor exception/body/URL details are transmitted to logs.
    """
    if not base_url or not token:
        raise ExperimentalModelRegistrationError("credentials_unavailable")
    root = Path(artifact_dir)
    manifest_path = root / f"experimental-trifecta-{model_id}.manifest.json"
    metadata_path = root / f"{model_id}.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        metadata_json = metadata_path.read_text(encoding="utf-8")
        metadata = json.loads(metadata_json)
        if (not isinstance(manifest, dict) or not isinstance(metadata, dict)
                or metadata.get("id") != model_id
                or metadata.get("trainingMode") != "experimental"
                or metadata.get("experimentalOnly") is not True):
            raise ValueError
        canonical = json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":"), allow_nan=False).encode("utf-8")
        payload = {"manifest": manifest,
                   "manifestSha256": hashlib.sha256(canonical).hexdigest(),
                   "metadataJson": metadata_json}
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (OSError, ValueError, TypeError, UnicodeDecodeError):
        raise ExperimentalModelRegistrationError("artifact_invalid") from None
    # Keep below the Worker's 128 KB Content-Length guard with headroom.
    if len(body) > 120_000:
        raise ExperimentalModelRegistrationError("request_too_large")
    request = Request(base_url.rstrip("/") + "/api/ingest/experimental-trifecta/model",
        data=body, method="POST", headers={"Authorization": "Bearer " + token,
        "Content-Type": "application/json", "Accept": "application/json",
        "User-Agent": "EdgeLab-ML/0.1"})
    open_request = opener or urlopen
    try:
        with open_request(request, timeout=30) as response:
            response_body = response.read(16_385)
    except HTTPError as exc:
        code = exc.code
        category = (f"http_{code}" if code in {401, 403, 404, 409, 413, 429} else
                    "http_5xx" if 500 <= code <= 599 else "http_other")
        raise ExperimentalModelRegistrationError(category) from None
    except (URLError, TimeoutError, OSError):
        raise ExperimentalModelRegistrationError("transport_error") from None
    if not response_body or len(response_body) > 16_384:
        raise ExperimentalModelRegistrationError("oversized_response")
    try:
        result = json.loads(response_body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ExperimentalModelRegistrationError("invalid_json") from None
    if not isinstance(result, dict) or result.get("modelId") != model_id:
        raise ExperimentalModelRegistrationError("invalid_response")
    return {"status": "registered", "modelId": model_id}
