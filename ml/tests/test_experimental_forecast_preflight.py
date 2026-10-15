import datetime as dt
import json

from edgelab.experimental_forecast_job import ExperimentalForecastJobError
from edgelab.experimental_forecast_preflight import run_preflight
from edgelab.experimental_registry import ForecastOnlyArtifactError
from edgelab.storage import save_rows


MODEL = {"modelId": "boat-trifecta-exp-noweather-test", "artifactSha256": "a" * 64}


def test_preflight_sanitizes_model_resolution_failure(tmp_path):
    def resolve(*args):
        raise ExperimentalForecastJobError("model_endpoint_unavailable")

    result = run_preflight(base_url="https://example.invalid", token="never-output",
                           artifact_dir=tmp_path, resolver=resolve)
    assert result["stage"] == "resolve"
    assert result["errorCategory"] == "model_endpoint_unavailable"
    assert result["modelReady"] is False


def test_preflight_reports_missing_exact_artifact_without_paths(tmp_path):
    def validate(*args, **kwargs):
        raise ForecastOnlyArtifactError("artifact_missing")

    result = run_preflight(base_url="https://example.invalid", token="never-output",
                           artifact_dir=tmp_path, resolver=lambda *args: MODEL, validator=validate)
    assert result["stage"] == "artifact_validation"
    assert result["errorCategory"] == "artifact_missing"
    assert result["artifactFileCount"] == 0
    assert MODEL["modelId"] not in str(result)


def test_preflight_refreshes_current_day_then_predicts_locally_and_emits_only_allowlisted_counts(tmp_path):
    store_path = tmp_path / "rows.json"
    artifact_dir = tmp_path / "artifact-cache"
    now = iter((dt.datetime(2026, 10, 15, 0, 0, tzinfo=dt.timezone.utc),
                dt.datetime(2026, 10, 15, 0, 1, tzinfo=dt.timezone.utc)))
    refreshed_dates = []

    def refresh(day, **kwargs):
        refreshed_dates.append(day)
        save_rows({"races": [
            {"id": "hidden-real-1", "sport": "boat", "data_origin": "real", "status": "scheduled", "race_date": day},
            {"id": "hidden-real-2", "sport": "boat", "data_origin": "real", "status": "scheduled", "race_date": day},
            {"id": "hidden-real-3", "sport": "boat", "data_origin": "real", "status": "scheduled", "race_date": day},
            {"id": "sample-race", "sport": "boat", "data_origin": "sample", "status": "scheduled", "race_date": day},
            {"id": "other-day", "sport": "boat", "data_origin": "real", "status": "scheduled", "race_date": "2026-10-14"},
        ]}, store_path)
        return {"status": "refreshed", "importedArchives": 2, "excludedArchives": 2,
                "exclusionCounts": {"race_identity_or_real_race_missing": 1, "unknown secret id": 1}}

    def predict(command, **kwargs):
        assert command[command.index("--as-of") + 1] == "2026-10-15T00:01:00.000Z"
        assert command[command.index("--date") + 1] == "2026-10-15"
        assert "submit" not in command
        output = command[command.index("--output") + 1]
        envelope = {"modelId": MODEL["modelId"], "artifactSha256": MODEL["artifactSha256"],
                    "trainingMode": "experimental", "experimentalOnly": True,
                    "races": [{"raceId": "must-not-leak"}],
                    "diagnostics": {"candidateRaceCount": 3, "abstentionReasonCounts": {
                        "invalid_cutoff": 1, "invalid_cutoff_source": 0, "post_passed": 0,
                        "outside_t60_window": 1, "cutoff_observation_late": 0,
                        "entry_coverage_incomplete": 0, "market_incomplete": 0,
                        "exhibition_incomplete": 0, "unexpected": 1000}}}
        with open(output, "w", encoding="utf-8") as file:
            json.dump(envelope, file)
        return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    result = run_preflight(
        base_url="https://example.invalid", token="never-output", artifact_dir=artifact_dir,
        store_path=store_path, resolver=lambda *args: MODEL, validator=lambda *args, **kwargs: MODEL,
        refresher=refresh, predictor=predict, clock=lambda: next(now))

    assert refreshed_dates == ["2026-10-15"]
    assert result["status"] == "diagnosed"
    assert result["currentDayScheduledRaceCount"] == 3
    assert result["archiveImportedCount"] == 2
    assert result["archiveExcludedCount"] == 2
    assert result["archiveExclusionCounts"]["race_identity_or_real_race_missing"] == 1
    assert result["archiveExclusionCounts"]["other"] == 1
    assert result["forecastRaceCount"] == 1
    assert result["gateCounts"] == {"candidateRaceCount": 3, "invalid_cutoff": 1,
                                    "invalid_cutoff_source": 0, "post_passed": 0,
                                    "outside_t60_window": 1, "cutoff_observation_late": 0,
                                    "entry_coverage_incomplete": 0, "market_incomplete": 0,
                                    "exhibition_incomplete": 0}
    assert "must-not-leak" not in json.dumps(result)
    assert "never-output" not in json.dumps(result)
    assert "test" not in json.dumps(result)
