"""Synthetic-only tests for trifecta evidence guards and probability integrity."""
from datetime import datetime, timezone

import pytest

from edgelab.features.boat import (_observation_freshness_reason,
                                   _observation_selection_key,
                                   _source_observation_time_reason,
                                   _weather_source_time_reason,
                                   classify_prerace_observation)
from edgelab.models.trifecta_coverage import (
    EXPECTED_TRIFECTA_SELECTIONS,
    _t60_cutoff,
    audit_trifecta_coverage,
    evaluate_candidate_qualification,
    validate_ticket_probabilities,
)


def test_probability_evaluation_requires_all_120_normalized_tickets():
    distribution = {selection: 1 / 120 for selection in EXPECTED_TRIFECTA_SELECTIONS}
    validated = validate_ticket_probabilities(distribution)
    assert len(validated) == 120
    assert sum(validated.values()) == pytest.approx(1.0)

    with pytest.raises(ValueError, match="exactly 120"):
        validate_ticket_probabilities(dict(list(distribution.items())[:-1]))
    with pytest.raises(ValueError, match="sum to one"):
        validate_ticket_probabilities({selection: 0.001 for selection in EXPECTED_TRIFECTA_SELECTIONS})
    with pytest.raises(ValueError, match="finite numbers"):
        validate_ticket_probabilities({**distribution, "1-2-3": float("nan")})


def test_observation_freshness_is_explicit_at_cutoff_and_selection_order_is_stable():
    cutoff = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)
    assert _observation_freshness_reason(datetime(2026, 10, 12, 11, 30, tzinfo=timezone.utc), cutoff) is None
    assert _observation_freshness_reason(datetime(2026, 10, 12, 11, 29, 59, tzinfo=timezone.utc), cutoff) == "stale_observation"
    assert _observation_freshness_reason(datetime(2026, 10, 12, 12, 0, 1, tzinfo=timezone.utc), cutoff) == "observation_after_cutoff"

    # These are ordering fixtures only, marked as synthetic and never sent to
    # the feature builder or training pipeline.
    old = {"fixture": "synthetic", "fetched_at": "2026-10-12T11:55:00+00:00", "source_sha256": "a" * 64}
    new = {"fixture": "synthetic", "fetched_at": "2026-10-12T11:58:00+00:00", "source_sha256": "b" * 64}
    old_key = _observation_selection_key(old, {"exhibition_time": 6.8})
    new_key = _observation_selection_key(new, {"exhibition_time": 6.7})
    assert max(old_key, new_key) == new_key


def test_verified_cutoff_uses_boat_race_local_date_and_must_precede_start():
    race = {"fixture": "synthetic", "data_origin": "sample",
        "id": "boat-20261012-24-01", "race_date": "2026-10-12", "venue_id": "24",
        "race_no": 1, "betting_cutoff_source": "boatrace-racelist-cutoff-v1",
        "betting_cutoff_at": "2026-10-12T08:05:00+09:00",
        "betting_cutoff_observed_at": "2026-10-12T08:03:00+09:00",
        "post_time": "2026-10-12T08:06:00+09:00"}
    cutoff, reason = _t60_cutoff(race)
    assert reason is None
    assert cutoff == datetime(2026, 10, 11, 23, 4, tzinfo=timezone.utc)

    race["post_time"] = "2026-10-12T08:04:59+09:00"
    assert _t60_cutoff(race) == (None, "cutoff_after_post_time")


def test_point_in_time_observation_rejects_synthetic_rows_and_unknown_or_late_source_time():
    race = {"fixture": "synthetic", "data_origin": "sample",
            "id": "boat-20261012-24-01", "race_date": "2026-10-12", "venue_id": "24", "race_no": 1}
    observation = {
        "fixture": "synthetic", "race_id": race["id"], "kind": "weather", "entry_number": 0,
        "data_origin": "real", "source_url": "https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=20261012&jcd=24&rno=1",
        "source_sha256": "a" * 64, "fetched_at": "2026-10-12T11:58:00+00:00",
        "available_at": "2026-10-12T11:58:00+00:00", "source_observation_label": "12R時点",
        "values_json": '{"wind_speed": 2}',
    }
    assert classify_prerace_observation(observation, race, "2026-10-12T12:00:00+00:00") == (
        None, "synthetic_fixture_or_non_real_origin")
    assert _weather_source_time_reason("weather", "12R時点", None) == "weather_source_time_unknown"
    assert _source_observation_time_reason("2026-10-12T12:00:01+00:00",
        datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)) == "source_observation_after_cutoff"
    assert _source_observation_time_reason("2026-10-12T11:59:00+00:00",
        datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc),
        fetched_at=datetime(2026, 10, 12, 11, 58, tzinfo=timezone.utc)) == "source_observation_after_capture"


def test_feature_validator_rejects_synthetic_observation_rows():
    race = {"id": "boat-20261012-24-01", "race_date": "2026-10-12", "venue_id": "24", "race_no": 1}
    observation = {
        "fixture": "synthetic", "race_id": race["id"], "kind": "exhibition", "entry_number": 1,
        "data_origin": "sample", "source_url": "https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=20261012&jcd=24&rno=1",
        "source_sha256": "a" * 64, "fetched_at": "2026-10-12T11:58:00+00:00",
        "available_at": "2026-10-12T11:58:00+00:00", "values_json": '{"exhibition_time": 6.7}',
    }
    assert classify_prerace_observation(observation, race, "2026-10-12T12:00:00+00:00") == (
        None, "synthetic_fixture_or_non_real_origin")


def test_coverage_audit_never_counts_sample_races_as_real_evidence():
    race = {"id": "sample-20261012-24-01", "sport": "boat", "race_date": "2026-10-12",
            "status": "finished", "data_origin": "sample"}
    report = audit_trifecta_coverage({"races": [race], "entries": [], "results": []})
    assert report["dataOrigin"] == "real_only"
    assert report["finishedRealBoatRaces"] == 0
    assert report["completeEvidenceCoverage"] is None
    assert report["promotionEvidenceComplete"] is False


def test_candidate_gate_keeps_synthetic_or_incomplete_coverage_ineligible():
    metrics = {
        "dataOrigin": "real_only", "boatFeatureSchemaVersion": "boat-prerace-v2",
        "nTrainRaces": 500, "nTestRaces": 500, "nTestDates": 10, "topTicketEce": 0.01,
        "completeCombinationCoverage": True,
        "candidateVsLaneLogLossRaceBootstrap": {"ci95": [-0.2, -0.1]},
        "candidateVsLaneLogLossDateCluster": {"ci95": [-0.2, -0.1]},
        "candidateVsLaneBrierRaceBootstrap": {"ci95": [-0.03, -0.01]},
        "candidateVsLaneBrierDateCluster": {"ci95": [-0.03, -0.01]},
        "payoutReplay": {"racesWithPicks": 40, "roiInterval95": [0.1, 0.3],
                         "roiDateClusterInterval95": [0.05, 0.35]},
    }
    result = evaluate_candidate_qualification(
        metrics, {"dataOrigin": "sample", "promotionEvidenceComplete": False})
    assert result["evaluationQualified"] is False
    assert result["promotionEligible"] is False
    assert "coverage_source_is_real" in result["failedChecks"]
    assert "complete_real_point_in_time_coverage" in result["failedChecks"]
    assert result["promotionBlockers"] == ["independent_artifact_bound_ticket_review_required"]
