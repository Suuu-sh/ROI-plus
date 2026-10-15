from edgelab.experimental_forecast_job import ExperimentalForecastJobError
from edgelab.experimental_forecast_preflight import run_preflight
from edgelab.experimental_registry import ForecastOnlyArtifactError


MODEL = {"modelId": "boat-trifecta-exp-noweather-test", "artifactSha256": "a" * 64}


def test_preflight_reports_ready_without_disclosing_model(monkeypatch, tmp_path):
    def resolve(*args):
        return MODEL

    def validate(*args, **kwargs):
        return MODEL

    result = run_preflight(base_url="https://example.invalid", token="never-output",
                           artifact_dir=tmp_path, resolver=resolve, validator=validate)
    assert result == {"schema": "experimental-forecast-preflight-v1", "status": "ready",
                      "stage": "complete", "errorCategory": None, "modelReady": True,
                      "artifactFileCount": 3}
    assert "test" not in str(result)


def test_preflight_sanitizes_model_resolution_failure(tmp_path):
    def resolve(*args):
        raise ExperimentalForecastJobError("model_endpoint_unavailable")

    result = run_preflight(base_url="https://example.invalid", token="never-output",
                           artifact_dir=tmp_path, resolver=resolve)
    assert result["stage"] == "resolve"
    assert result["errorCategory"] == "model_endpoint_unavailable"
    assert result["modelReady"] is False


def test_preflight_reports_missing_exact_artifact_without_paths(tmp_path):
    def resolve(*args):
        return MODEL

    def validate(*args, **kwargs):
        raise ForecastOnlyArtifactError("artifact_missing")

    result = run_preflight(base_url="https://example.invalid", token="never-output",
                           artifact_dir=tmp_path, resolver=resolve, validator=validate)
    assert result["stage"] == "artifact_validation"
    assert result["errorCategory"] == "artifact_missing"
    assert result["artifactFileCount"] == 0
    assert MODEL["modelId"] not in str(result)
