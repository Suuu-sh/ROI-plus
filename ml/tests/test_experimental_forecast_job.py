import json
from io import BytesIO
from urllib.error import HTTPError

import pytest

from edgelab.experimental_forecast_job import (ExperimentalForecastJobError,
                                               _worker_first_forecast,
                                               resolve_latest_forecast_model)


class _Response:
    def __init__(self, payload):
        self.body = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, _limit):
        return self.body


def test_model_resolution_uses_authenticated_exact_registered_descriptor():
    seen = {}
    model_id = "boat-trifecta-exp-noweather-20261013-latest"
    digest = "a" * 64

    def opener(request, timeout):
        seen.update(url=request.full_url, authorization=request.get_header("Authorization"), timeout=timeout)
        return _Response({"model": {"modelId": model_id, "artifactSha256": digest}})

    assert resolve_latest_forecast_model("https://api.example/", "test-only", opener=opener) == {
        "modelId": model_id, "artifactSha256": digest}
    assert seen == {"url": "https://api.example/api/ingest/experimental-trifecta/forecast-model",
                    "authorization": "Bearer test-only", "timeout": 20}


def test_model_resolution_fails_closed_without_local_fallback_or_remote_details():
    with pytest.raises(ExperimentalForecastJobError) as error:
        resolve_latest_forecast_model("https://api.example", "test-only",
            opener=lambda *_args, **_kwargs: _Response({"model": None}))
    assert error.value.failure_category == "no_registered_model"
    assert "test-only" not in str(error.value)

    def rejected(*_args, **_kwargs):
        raise HTTPError("https://api.example/?token=private", 500, "private", {}, BytesIO(b"private"))

    with pytest.raises(ExperimentalForecastJobError) as error:
        resolve_latest_forecast_model("https://api.example", "test-only", opener=rejected)
    assert error.value.failure_category == "model_endpoint_http_error"
    assert "private" not in str(error.value)


def test_forecast_job_bounds_busy_window_to_worker_first_cutoff_even_with_more_than_four_races():
    model_id = "boat-trifecta-exp-noweather-test"
    sha = "a" * 64
    forecasts = [{"raceId": f"race-{index}", "predictedAt": "2026-10-13T04:00:00Z",
                  "predictions": [{"selection": "1-2-3"}] * 120} for index in range(6)]
    store = {"races": [{"id": f"race-{index}", "sport": "boat", "status": "scheduled",
                        "data_origin": "real", "betting_cutoff_at": f"2026-10-13T04:{5-index:02d}:00Z"}
                       for index in range(6)]}
    selected = _worker_first_forecast({"modelId": model_id, "artifactSha256": sha, "races": forecasts}, store)
    assert selected is not None
    assert len(selected["races"]) == 1
    assert selected["races"][0]["raceId"] == "race-5"


def test_forecast_job_rejects_pathologically_unbounded_envelope():
    with pytest.raises(ExperimentalForecastJobError) as error:
        _worker_first_forecast({"races": [{"raceId": str(i)} for i in range(181)]}, {"races": []})
    assert error.value.failure_category == "invalid_forecast_envelope"
