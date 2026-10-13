import json
from urllib.error import HTTPError
from unittest.mock import MagicMock

import pytest

from edgelab.experimental_registry import (ExperimentalModelRegistrationError,
                                          register_experimental_model)


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
