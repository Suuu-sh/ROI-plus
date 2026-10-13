from __future__ import annotations

import itertools
from datetime import date, datetime, timezone

from edgelab.features.boat import BASE_FEATURE_COLUMNS
from edgelab.historical_trifecta import (
    _validate_archive, _validate_label, archived_metrics, rolling_window,
)


def _archive():
    race_date = "2026-10-14"
    race_id = "boat-20261014-03-01"
    model_id = "boat-trifecta-historical-base-20261014"
    cutoff = "2026-10-14T06:00:00Z"
    target = "2026-10-14T05:59:00Z"
    predicted = "2026-10-14T05:58:59Z"
    digest = "a" * 64
    features = {column: 0.25 for column in BASE_FEATURE_COLUMNS}
    features["lane"] = 1
    tickets = [f"{a}-{b}-{c}" for a, b, c in itertools.permutations(range(1, 7), 3)]
    return {
        "schema": "roi-plus-trifecta-observation-v1", "dataOrigin": "real",
        "race": {"id": race_id, "raceDate": race_date, "venueId": "03", "raceNo": 1},
        "model": {"id": model_id, "sourceArtifactSha256": "b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a",
                  "immutableVersion": "2026-10-14.1", "trainedAt": "2026-10-13T16:21:26.363521+00:00",
                  "featureSchemaVersion": "boat-base-v1", "featureColumns": list(BASE_FEATURE_COLUMNS)},
        "timing": {"phase": "t60", "cutoffAt": cutoff, "cutoffSource": "boatrace-racelist-cutoff-v1",
                   "cutoffObservedAt": "2026-10-14T05:52:00Z", "targetAt": target,
                   "predictedAt": predicted, "observedAt": "2026-10-14T05:59:30Z"},
        "archiveEvidence": {"status": "verified", "reason": None, "id": "archive-id",
                            "capturedAt": "2026-10-14T05:54:00Z", "raceListSha256": "c" * 64},
        "input": {"status": "complete", "missingReason": None, "rows": [
            {"lane": lane, "availableAt": "2026-10-14T04:00:00Z",
             "source": {"kind": "official-daily-b-file",
                        "url": "https://www1.mbrace.or.jp/od2/B/202610/b261014.lzh",
                        "sha256": digest, "availableAt": "2026-10-14T04:00:00Z"},
             "features": {**features, "lane": lane}} for lane in range(1, 7)]},
        "predictions": {"status": "complete", "missingReason": None,
                        "rows": [{"selection": selection, "probability": 1 / 120, "probStd": 0.01}
                                 for selection in tickets]},
        "odds": {"status": "complete", "missingReason": None,
                 "sourceUrl": "https://www.boatrace.jp/owpc/pc/race/odds3t?rno=1&jcd=03&hd=20261014",
                 "requestedAt": "2026-10-14T05:59:01Z", "capturedAt": "2026-10-14T05:59:02Z",
                 "sha256": digest, "qualityStatus": "verified-complete-v1",
                 "rows": [{"selection": selection, "odds": 10.0} for selection in tickets]},
    }


def test_rolling_window_uses_calendar_months_and_excludes_asof_day():
    assert rolling_window(date(2026, 10, 14)) == (date(2026, 7, 14), date(2026, 10, 14))
    assert rolling_window(date(2026, 5, 31)) == (date(2026, 2, 28), date(2026, 5, 31))


def test_archive_accepts_only_real_roster_and_pre_target_sources():
    archive = _archive()
    result, reason = _validate_archive(
        archive, expected_key="historical-trifecta/v1/real/2026-10-14/03/1/boat-trifecta-historical-base-20261014/t-60.json.gz",
        expected_race_id="boat-20261014-03-01", lower=date(2026, 10, 14),
        upper_exclusive=date(2026, 10, 15), now=datetime(2026, 10, 15, tzinfo=timezone.utc))
    assert reason is None
    assert result is not None and len(result["probabilities"]) == len(result["odds"]) == 120

    late = _archive()
    late["input"]["rows"][0]["availableAt"] = "2026-10-14T05:59:00Z"
    late["input"]["rows"][0]["source"]["availableAt"] = "2026-10-14T05:58:00Z"
    rejected, reason = _validate_archive(
        late, expected_key="historical-trifecta/v1/real/2026-10-14/03/1/boat-trifecta-historical-base-20261014/t-60.json.gz",
        expected_race_id="boat-20261014-03-01", lower=date(2026, 10, 14),
        upper_exclusive=date(2026, 10, 15), now=datetime(2026, 10, 15, tzinfo=timezone.utc))
    assert rejected is None and reason == "input_after_prediction"


def test_late_prediction_and_wrong_odds_source_are_rejected():
    archive = _archive()
    archive["timing"]["predictedAt"] = "2026-10-14T05:59:11Z"
    result, reason = _validate_archive(
        archive, expected_key="historical-trifecta/v1/real/2026-10-14/03/1/boat-trifecta-historical-base-20261014/t-60.json.gz",
        expected_race_id="boat-20261014-03-01", lower=date(2026, 10, 14),
        upper_exclusive=date(2026, 10, 15), now=datetime(2026, 10, 15, tzinfo=timezone.utc))
    assert result is None and reason == "prediction_outside_t60_evaluation_window"


def test_result_label_requires_later_official_exact_payout():
    archive, reason = _validate_archive(
        _archive(), expected_key="historical-trifecta/v1/real/2026-10-14/03/1/boat-trifecta-historical-base-20261014/t-60.json.gz",
        expected_race_id="boat-20261014-03-01", lower=date(2026, 10, 14),
        upper_exclusive=date(2026, 10, 15), now=datetime(2026, 10, 15, tzinfo=timezone.utc))
    assert reason is None and archive
    label = {"archiveKey": archive["key"], "raceId": archive["raceId"], "raceDate": "2026-10-14",
             "venueId": "03", "raceNo": 1,
             "results": [{"number": n, "finishOrder": n} for n in range(1, 7)],
             "trifectaPayout": {"selection": "1-2-3", "payoutYen": 1200},
             "availableAt": "2026-10-14T08:00:00Z",
             "source": {"url": "https://www.boatrace.jp/owpc/pc/race/raceresult?rno=1&jcd=03&hd=20261014",
                        "sha256": "b" * 64, "availableAt": "2026-10-14T08:00:00Z",
                        "quality": "verified-official-outcome-v2"}}
    parsed, reason = _validate_label(label, archive, datetime(2026, 10, 15, tzinfo=timezone.utc))
    assert reason is None and parsed["winningSelection"] == "1-2-3"
    label["trifectaPayout"]["selection"] = "1-3-2"
    parsed, reason = _validate_label(label, archive, datetime(2026, 10, 15, tzinfo=timezone.utc))
    assert parsed is None and reason == "exact_trifecta_payout_invalid"


def test_archived_probability_metrics_are_separate_proper_scores():
    tickets = [f"{a}-{b}-{c}" for a, b, c in itertools.permutations(range(1, 7), 3)]
    probs = {ticket: 1 / 120 for ticket in tickets}
    assert archived_metrics([{"probabilities": probs, "winningSelection": "1-2-3"}])["exactOrderLogLoss"] == __import__("math").log(120)
