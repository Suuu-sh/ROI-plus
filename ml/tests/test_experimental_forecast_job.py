import json
from io import BytesIO
from urllib.error import HTTPError

import pytest

from edgelab.experimental_forecast_job import (ExperimentalForecastJobError,
                                               _eligible_forecasts,
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


def test_forecast_job_keeps_all_overlapping_races_even_with_more_than_four():
    model_id = "boat-trifecta-exp-noweather-test"
    sha = "a" * 64
    forecasts = [{"raceId": f"race-{index}", "predictedAt": "2026-10-13T04:00:00Z",
                  "predictions": [{"selection": "1-2-3"}] * 120} for index in range(6)]
    store = {"races": [{"id": f"race-{index}", "sport": "boat", "status": "scheduled",
                        "data_origin": "real", "betting_cutoff_at": f"2026-10-13T04:{5-index:02d}:00Z"}
                       for index in range(6)]}
    selected = _eligible_forecasts({"modelId": model_id, "artifactSha256": sha, "races": forecasts}, store)
    assert selected is not None
    assert len(selected["races"]) == 6
    assert selected["races"][0]["raceId"] == "race-5"


def test_forecast_job_rejects_pathologically_unbounded_envelope():
    with pytest.raises(ExperimentalForecastJobError) as error:
        _eligible_forecasts({"races": [{"raceId": str(i)} for i in range(181)]}, {"races": []})
    assert error.value.failure_category == "invalid_forecast_envelope"


def test_loop_refreshes_each_tick_and_recovers_from_safe_failure():
    from edgelab.experimental_forecast_job import run_forecast_loop
    clock = [0.0]
    emitted = []
    calls = []
    def job(**kwargs):
        calls.append(clock[0])
        if len(calls) == 1:
            raise ExperimentalForecastJobError("archive_refresh_unavailable")
        return {"status": "no_eligible_forecast"}
    result = run_forecast_loop(duration_minutes=2, job=job,
        monotonic=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0]+seconds),
        emit=emitted.append)
    assert calls == [0.0, 60.0]
    assert result == {"ticks": 2, "failedTicks": 1}
    assert emitted[0]["reason"] == "archive_refresh_unavailable"


def test_slow_loop_skips_missed_ticks_without_replaying_backdated_jobs():
    from edgelab.experimental_forecast_job import run_forecast_loop
    clock = [0.0]
    calls = []
    def job(**kwargs):
        calls.append(clock[0])
        clock[0] += 75
        return {"status": "forecast_stored"}
    run_forecast_loop(duration_minutes=2, job=job, monotonic=lambda: clock[0],
                      sleep=lambda _: pytest.fail("must not sleep after a slow tick"), emit=lambda _: None)
    assert calls == [0.0, 75.0]


def test_job_submits_all_races_independently_after_one_rejection(monkeypatch, tmp_path):
    import edgelab.experimental_forecast_job as module
    model_id = "boat-trifecta-exp-noweather-test"
    digest = "a" * 64
    forecasts = [{"raceId": f"race-{i}", "predictedAt": "2026-10-13T04:00:00Z",
                  "predictions": [{"selection": "1-2-3"}] * 120} for i in range(6)]
    envelope = {"modelId": model_id, "artifactSha256": digest,
                "trainingMode": "experimental", "experimentalOnly": True, "races": forecasts}
    monkeypatch.chdir(tmp_path)
    output = tmp_path / "ml/data/learning/trifecta-experimental-forecast.json"
    output.parent.mkdir(parents=True)
    output.write_text(json.dumps(envelope))
    monkeypatch.setattr(module, "validate_forecast_only_artifact", lambda *a, **k: None)
    monkeypatch.setattr(module, "load_rows", lambda *_: {"races": [{"id": f"race-{i}",
        "sport": "boat", "status": "scheduled", "data_origin": "real",
        "betting_cutoff_at": "2026-10-13T04:05:00Z"} for i in range(6)]})
    calls = []
    def submit(envelope, **kwargs):
        assert len(envelope["races"]) == 1
        race_id = envelope["races"][0]["raceId"]
        calls.append(race_id)
        return {"status": "submission_failed"} if race_id == "race-0" else {
            "status": "forecast_stored", "storedRaceCount": 1, "raceIds": [race_id]}
    from types import SimpleNamespace
    result = module.run_forecast_job(base_url="https://api.example", token="test-only",
        opener=lambda *a, **k: _Response({"model": {"modelId": model_id, "artifactSha256": digest}}),
        refresh=lambda *a, **k: {"status": "refreshed"},
        predictor=lambda *a, **k: SimpleNamespace(returncode=0), submitter=submit)
    assert calls == [f"race-{i}" for i in range(6)]
    assert result["status"] == "partially_stored"
    assert result["storedRaceCount"] == 5
