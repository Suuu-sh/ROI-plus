import json
import hashlib
from urllib.error import HTTPError
from unittest.mock import MagicMock

import pytest

from edgelab.experimental_registry import (ExperimentalModelRegistrationError,
                                          ForecastOnlyArtifactError,
                                          register_experimental_model,
                                          validate_forecast_only_artifact)


def _artifact_files(tmp_path):
    model_id = "boat-trifecta-exp-noweather-20261013-test"
    metadata = {"id": model_id, "status": "candidate", "trainingMode": "experimental",
                "experimentalOnly": True}
    (tmp_path / f"{model_id}.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    (tmp_path / f"experimental-trifecta-{model_id}.manifest.json").write_text(
        json.dumps({"schema": "test-manifest", "files": {}}, indent=2) + "\n", encoding="utf-8")
    return model_id


def test_register_experimental_model_accepts_model_id_and_posts_metadata_only(tmp_path):
    model_id = _artifact_files(tmp_path)
    response = MagicMock()
    response.__enter__.return_value.read.return_value = json.dumps({"modelId": model_id}).encode()
    seen = {}

    def opener(request, timeout):
        seen["path"] = request.full_url
        seen["body"] = json.loads(request.data)
        seen["timeout"] = timeout
        return response

    result = register_experimental_model(model_id, artifact_dir=tmp_path,
        base_url="https://example.test", token="secret-never-logged", opener=opener)
    assert result == {"status": "registered", "modelId": model_id}
    assert seen["path"] == "https://example.test/api/ingest/experimental-trifecta/model"
    assert seen["body"]["metadataJson"].endswith("\n")
    assert "pkl" not in json.dumps(seen["body"])


def test_registration_http_error_reports_only_fixed_status_category(tmp_path):
    model_id = _artifact_files(tmp_path)

    def opener(_request, timeout):
        raise HTTPError("https://example.test/?token=private", 404, "private body", {}, None)

    with pytest.raises(ExperimentalModelRegistrationError) as error:
        register_experimental_model(model_id, artifact_dir=tmp_path,
            base_url="https://example.test", token="private", opener=opener)
    assert error.value.failure_category == "http_404"
    assert "private" not in str(error.value)


def test_registration_requires_model_id_response_not_unrelated_id(tmp_path):
    model_id = _artifact_files(tmp_path)
    response = MagicMock()
    response.__enter__.return_value.read.return_value = json.dumps({"id": model_id}).encode()
    with pytest.raises(ExperimentalModelRegistrationError) as error:
        register_experimental_model(model_id, artifact_dir=tmp_path,
            base_url="https://example.test", token="test", opener=lambda *a, **k: response)
    assert error.value.failure_category == "invalid_response"


def _pinned_artifact_files(tmp_path):
    model_id = "boat-trifecta-exp-noweather-20261013-pinned"
    pkl = b"trusted test artifact bytes"
    metadata = {"id": model_id, "status": "candidate", "trainingMode": "experimental",
                "experimentalOnly": True,
                "boatFeatureSchemaVersion": "boat-prerace-v2-no-weather-experimental-v1",
                "ticketArtifactSha256": hashlib.sha256(pkl).hexdigest()}
    metadata_bytes = (json.dumps(metadata, indent=2) + "\n").encode()
    (tmp_path / f"{model_id}.pkl").write_bytes(pkl)
    (tmp_path / f"{model_id}.json").write_bytes(metadata_bytes)
    manifest = {"schema": "edgelab-experimental-trifecta-artifact-v1", "modelId": model_id,
                "trainingMode": "experimental", "experimentalOnly": True,
                "boatFeatureSchemaVersion": "boat-prerace-v2-no-weather-experimental-v1",
                "files": {f"{model_id}.pkl": {"sha256": hashlib.sha256(pkl).hexdigest(),
                                                "sizeBytes": len(pkl)},
                          f"{model_id}.json": {"sha256": hashlib.sha256(metadata_bytes).hexdigest(),
                                                "sizeBytes": len(metadata_bytes)}}}
    (tmp_path / f"experimental-trifecta-{model_id}.manifest.json").write_text(
        json.dumps(manifest), encoding="utf-8")
    return model_id, hashlib.sha256(pkl).hexdigest()


def test_forecast_only_requires_exact_cached_artifact_id_sha_and_sidecars(tmp_path):
    model_id, digest = _pinned_artifact_files(tmp_path)
    result = validate_forecast_only_artifact(model_id, digest, artifact_dir=tmp_path)
    assert result == {"modelId": model_id, "artifactSha256": digest}
    with pytest.raises(ForecastOnlyArtifactError) as error:
        validate_forecast_only_artifact(model_id, "0" * 64, artifact_dir=tmp_path)
    assert error.value.failure_category == "artifact_sha256_mismatch"


def test_forecast_only_does_not_fallback_when_model_cache_missing(tmp_path):
    with pytest.raises(ForecastOnlyArtifactError) as error:
        validate_forecast_only_artifact("boat-trifecta-exp-noweather-exact", "a" * 64,
                                        artifact_dir=tmp_path)
    assert error.value.failure_category == "artifact_missing"
