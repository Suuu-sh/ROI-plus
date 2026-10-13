import json
from io import BytesIO
from urllib.error import HTTPError
from edgelab.experimental_forecast_submit import submit_forecasts


def _envelope(count=3):
    return {"schema": "edgelab-experimental-trifecta-forecast-v1", "modelId": "exp-model",
            "artifactSha256": "a" * 64, "trainingMode": "experimental", "experimentalOnly": True,
            "ticketModelSchemaVersion": "ticket-selection-v1",
            "ticketPredictionSemantics": "exact-selection-probability-v1",
            "boatFeatureSchemaVersion": "boat-prerace-v2-no-weather-experimental-v1",
            "races": [{"raceId": f"race-{index}", "predictedAt": "2026-10-13T04:00:00Z",
                       "predictions": [{"selection": f"pick-{i}", "probability": 1 / 120,
                                        "prob_std": 0.01} for i in range(120)]}
                      for index in range(count)]}


class _Response:
    def __init__(self, result):
        self.body = json.dumps(result).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, _limit):
        return self.body


def test_submit_forecasts_uses_one_race_per_api_request_and_preserves_metadata():
    requests = []

    def opener(request, timeout):
        payload = json.loads(request.data)
        requests.append((payload, timeout, request.get_header("Authorization")))
        race = payload["races"][0]
        return _Response({"stored": [{"raceId": race["raceId"], "modelId": payload["modelId"],
                                      "predictionCount": 120}]})

    result = submit_forecasts(_envelope(), base_url="https://api.example/", token="test-only", opener=opener)
    assert result["status"] == "forecast_stored"
    assert result["storedRaceCount"] == 3
    assert [payload["races"][0]["raceId"] for payload, _, _ in requests] == ["race-0", "race-1", "race-2"]
    assert all(len(payload["races"]) == 1 and len(payload["races"][0]["predictions"]) == 120
               for payload, _, _ in requests)
    assert all(payload["artifactSha256"] == "a" * 64 and timeout == 30
               for payload, timeout, _ in requests)
    assert all(auth == "Bearer test-only" for _, _, auth in requests)


def test_submit_forecasts_reports_partial_storage_after_later_failure_without_retry():
    requests = []

    def opener(request, timeout):
        payload = json.loads(request.data)
        requests.append(payload["races"][0]["raceId"])
        if len(requests) == 2:
            raise OSError("private transport detail must not be reported")
        race = payload["races"][0]
        return _Response({"stored": [{"raceId": race["raceId"], "modelId": payload["modelId"],
                                      "predictionCount": 120}]})

    result = submit_forecasts(_envelope(), base_url="https://api.example", token="test-only", opener=opener)
    assert result == {"status": "partially_stored", "storedRaceCount": 1,
                      "eligibleRaceCount": 3, "failedRaceCount": 2,
                      "reason": "api_unavailable_or_rejected", "failureCategory": "transport_error"}
    assert requests == ["race-0", "race-1"]
    assert "private" not in json.dumps(result)


def test_submit_forecasts_does_not_claim_success_for_malformed_response():
    result = submit_forecasts(_envelope(count=1), base_url="https://api.example", token="test-only",
                              opener=lambda *_args, **_kwargs: _Response({"stored": []}))
    assert result["status"] == "submission_failed"
    assert result["reason"] == "invalid_api_response"
    assert result["storedRaceCount"] == 0


def test_submit_forecasts_reports_http_and_allowlisted_api_reason_without_raw_body():
    body = json.dumps({"error": "official archive identity, six-lane, or complete odds provenance is invalid",
                       "private": "do not expose"}).encode()

    def opener(*_args, **_kwargs):
        raise HTTPError("https://private.example/?token=secret", 400, "private", {}, BytesIO(body))

    result = submit_forecasts(_envelope(count=1), base_url="https://api.example", token="secret", opener=opener)
    assert result["status"] == "submission_failed"
    assert result["failureCategory"] == "http_400"
    assert result["apiReason"] == "archive_evidence_invalid"
    assert "private" not in json.dumps(result)
    assert "secret" not in json.dumps(result)


def test_submit_forecasts_maps_budget_code_without_exposing_unknown_fields():
    body = json.dumps({"error": "internal details", "code": "d1_write_budget_exhausted",
                       "budget": {"private": "data"}}).encode()

    def opener(*_args, **_kwargs):
        raise HTTPError("https://api.example", 429, "private", {}, BytesIO(body))

    result = submit_forecasts(_envelope(count=1), base_url="https://api.example", token="test", opener=opener)
    assert result["failureCategory"] == "http_429"
    assert result["apiReason"] == "d1_write_budget_exhausted"
    assert "internal" not in json.dumps(result)
    assert "private" not in json.dumps(result)
