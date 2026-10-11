import math

import pytest

from edgelab.models.trifecta import (_captured_odds, _fit, _complete_race,
                                     ordered_triple_probabilities, train_trifecta,
                                     _proper_ticket_metrics, active_ticket_predictions,
                                     _consistent_payout,
                                     _select_runtime_like_tickets, _replay,
                                     REPLAY_SELECTION_POLICY)
from edgelab.features.boat import BASE_FEATURE_COLUMNS


def race(race_id="race", day="2026-01-01", winner=1):
    order = [winner, *[lane for lane in range(1, 7) if lane != winner]]
    ranks = {lane: rank for rank, lane in enumerate(order, 1)}
    return [{"race_id": race_id, "race_date": day, "number": lane,
             "finish_order": ranks[lane],
             "lane": lane, "national_win_rate": 0.2 + (0.1 if lane == winner else 0),
             "data_origin": "real",
             "available_at": f"{day}T00:00:00+09:00",
             "predicted_at": f"{day}T12:00:00+09:00"}
            for lane in range(1, 7)]


def test_complete_order_requires_six_unique_numbers_and_rank_values():
    group = race()
    assert _complete_race(group)
    assert not _complete_race(group[:-1])
    assert not _complete_race([{**r, "finish_order": 1} for r in group])
    assert not _complete_race([{**r, "number": r["number"] + 6} for r in group])


def test_ordered_trifecta_probabilities_are_full_exact_order_distribution():
    rows = race()
    model = _fit(rows, BASE_FEATURE_COLUMNS)
    probabilities = ordered_triple_probabilities(model, rows)
    assert len(probabilities) == 120
    assert math.isclose(sum(probabilities.values()), 1.0, abs_tol=1e-12)
    assert "1-2-3" in probabilities
    assert probabilities["1-2-3"] != pytest.approx(
        (1 / 6) * (1 / 6) * (1 / 6))


def test_top_ticket_calibration_reports_race_sample_counts():
    group = race()
    probabilities = {f"{a}-{b}-{c}": .98 / 119
                     for a in range(1, 7) for b in range(1, 7) for c in range(1, 7)
                     if len({a, b, c}) == 3}
    probabilities["6-5-4"] = .02
    metrics = _proper_ticket_metrics([group], [probabilities])
    assert metrics["topTicketEce"] == pytest.approx(.02)
    assert sum(bucket["nRaces"] for bucket in metrics["topTicketCalibration"]) == 1


def test_virtual_replay_single_pick_uses_runtime_expected_roi_rank_after_conservative_gate():
    selected = _select_runtime_like_tickets(
        {"1-2-3": .2, "1-2-4": .1, "1-2-5": .3},
        {"1-2-3": .1, "1-2-4": .01, "1-2-5": .3},
        {"1-2-3": 10, "1-2-4": 20, "1-2-5": 10}, max_picks=1)
    assert selected[0]["selection"] == "1-2-4"
    assert selected[0]["conservativeRoi"] == pytest.approx((.1 - .01) * 20 - 1)


def test_runtime_like_replay_selector_allows_zero_one_or_multiple_picks_and_ties_by_selection():
    probs = {"1-2-3": .10, "1-2-4": .10, "1-2-5": .10}
    deviations = {selection: .01 for selection in probs}
    odds = {selection: 20 for selection in probs}
    multiple = _select_runtime_like_tickets(probs, deviations, odds, max_picks=2, race_budget=101)
    assert [row["selection"] for row in multiple] == ["1-2-3", "1-2-4"]
    assert [row["stake"] for row in multiple] == [51, 50]
    assert _select_runtime_like_tickets(dict(reversed(list(probs.items()))), deviations, odds,
        max_picks=2, race_budget=101) == multiple
    one = _select_runtime_like_tickets(probs, deviations, odds, max_picks=1, race_budget=100)
    assert len(one) == 1 and one[0]["selection"] == "1-2-3"
    assert _select_runtime_like_tickets({"1-2-3": .001}, {"1-2-3": .01}, {"1-2-3": 20}) == []
    assert _select_runtime_like_tickets({"1-2-3": .1}, {"1-2-3": -.01}, {"1-2-3": 20}) == []


def test_payout_replay_fails_closed_on_extra_positive_payout_not_in_finish_order():
    rows = [{"race_id": "r", "data_origin": "real", "bet_type": "trifecta",
             "selection": "4-2-1", "payout": 19570}]
    assert _consistent_payout(rows, "r", "4-2-1") == 19570
    rows.append({"race_id": "r", "data_origin": "real", "bet_type": "trifecta",
                 "selection": "1-4-2", "payout": 710})
    assert _consistent_payout(rows, "r", "4-2-1") is None


def test_odds_replay_is_strictly_pre_cutoff_and_exact_trifecta_only():
    cutoff = "2026-01-01T12:00:00+09:00"
    race_id = "boat-20260101-24-01"
    url = "https://www.boatrace.jp/owpc/pc/race/odds3t?rno=1&jcd=24&hd=20260101"
    market = [{"race_id": race_id, "bet_type": "trifecta", "selection": f"{a}-{b}-{c}",
        "odds": 25, "captured_at": "2026-01-01T11:59:00+09:00", "source": "boatrace-trifecta-official-v1",
        "source_url": url, "source_sha256": "a" * 64, "quality_status": "verified-complete-v1",
        "data_origin": "real"} for a in range(1, 7) for b in range(1, 7) for c in range(1, 7)
        if len({a, b, c}) == 3]
    market.append({**market[0], "selection": "1-2-3", "captured_at": cutoff})
    store = {"races": [{"id": race_id, "venue_id": "24", "race_date": "2026-01-01", "race_no": 1}],
             "odds_snapshots": market}
    odds = _captured_odds(store, race_id, cutoff, "2026-01-01T12:10:00+09:00")
    assert len(odds) == 120
    assert odds["1-2-3"] == 25
    store["odds_snapshots"][0]["source_sha256"] = "b" * 64
    assert _captured_odds(store, race_id, cutoff, "2026-01-01T12:10:00+09:00") == {}
    store["odds_snapshots"][0]["source_sha256"] = "a" * 64
    store["odds_snapshots"][0]["quality_status"] = "verified-final-complete-v1"
    assert _captured_odds(store, race_id, cutoff, "2026-01-01T12:10:00+09:00") == {}


def test_odds_replay_excludes_market_older_than_runtime_freshness_window():
    as_of = "2026-01-01T12:00:00+09:00"
    race_id = "boat-20260101-24-01"
    url = "https://www.boatrace.jp/owpc/pc/race/odds3t?rno=1&jcd=24&hd=20260101"
    stale_market = [{"race_id": race_id, "bet_type": "trifecta", "selection": f"{a}-{b}-{c}",
        "odds": 25, "captured_at": "2026-01-01T11:49:59+09:00",
        "source": "boatrace-trifecta-official-v1", "source_url": url,
        "source_sha256": "a" * 64, "quality_status": "verified-complete-v1",
        "data_origin": "real"} for a in range(1, 7) for b in range(1, 7) for c in range(1, 7)
        if len({a, b, c}) == 3]
    store = {"races": [{"id": race_id, "venue_id": "24", "race_date": "2026-01-01", "race_no": 1}],
             "odds_snapshots": stale_market}

    assert _captured_odds(store, race_id, as_of, "2026-01-01T12:10:00+09:00") == {}


def test_replay_consumes_local_archive_odds_and_versions_multi_ticket_policy(monkeypatch):
    group = race("boat-20260101-24-01", "2026-01-01", winner=1)
    for row in group:
        row["predicted_at"] = "2026-01-01T11:59:30+09:00"
    race_id = group[0]["race_id"]
    url = "https://www.boatrace.jp/owpc/pc/race/odds3t?rno=1&jcd=24&hd=20260101"
    store = {"races": [{"id": race_id, "venue_id": "24", "race_date": "2026-01-01",
                        "race_no": 1, "post_time": "2026-01-01T12:10:00+09:00"}],
        "odds_snapshots": [], "prerace_capture_odds": [{
            "race_id": race_id, "bet_type": "trifecta", "selection": f"{a}-{b}-{c}",
            "odds": 20, "captured_at": "2026-01-01T11:59:00+09:00",
            "source": "boatrace-trifecta-official-v1", "source_url": url,
            "source_sha256": "c" * 64, "quality_status": "verified-complete-v1", "data_origin": "real"}
            for a in range(1, 7) for b in range(1, 7) for c in range(1, 7)
            if len({a, b, c}) == 3],
        "payouts": [{"race_id": race_id, "data_origin": "real", "bet_type": "trifecta",
                     "selection": "1-2-3", "payout": 1000}]}
    probabilities = {f"{a}-{b}-{c}": .001 for a in range(1, 7) for b in range(1, 7) for c in range(1, 7)
                     if len({a, b, c}) == 3}
    probabilities.update({"1-2-3": .10, "1-2-4": .10})
    deviations = {selection: .01 for selection in probabilities}
    monkeypatch.setattr("edgelab.models.trifecta.ensemble_ordered_triples",
                        lambda *_: (probabilities, deviations))
    result = _replay(store, [group], {"model": {"unused": True}}, race_budget=101, max_picks=2)
    assert result["selectionPolicyVersion"] == REPLAY_SELECTION_POLICY
    assert result["selectionPolicy"]["tieBreak"] == "selection_ascending"
    assert result["races"] == result["racesWithPicks"] == 1
    assert result["ticketCount"] == 2
    assert result["stake"] == 101 and result["payout"] == 510
    assert result["roi"] == pytest.approx(510 / 101 - 1)
    single = _replay(store, [group], {"model": {"unused": True}}, race_budget=100, max_picks=1)
    assert single["ticketCount"] == 1 and single["stake"] == 100
    monkeypatch.setattr("edgelab.models.trifecta.ensemble_ordered_triples",
        lambda *_: ({selection: .001 for selection in probabilities}, deviations))
    empty = _replay(store, [group], {"model": {"unused": True}}, race_budget=100, max_picks=1)
    assert empty["races"] == 1 and empty["racesWithPicks"] == empty["ticketCount"] == empty["stake"] == 0
    assert empty["roi"] is None


def test_active_forecast_requires_registered_validation_and_trained_before_cutoff():
    model_id = "boat-trifecta-validated"
    fitted = _fit(race("train", "2026-01-01"), BASE_FEATURE_COLUMNS)
    artifact = {"metadata": {"id": model_id, "ticketModelSchemaVersion": "ticket-selection-v1",
        "ticketPredictionSemantics": "exact-selection-probability-v1", "ticketBetType": "trifecta",
        "trainedAt": "2026-01-01T00:00:00+00:00"}, "model": fitted,
        "bootstrap_models": [fitted, fitted, fitted, fitted], "columns": list(BASE_FEATURE_COLUMNS),
        "temperature": 1.0}
    digest = "a" * 64
    model_row = {"id": model_id, "status": "active", "bet_type": "trifecta", "metrics": {
        "ticketModelSchemaVersion": "ticket-selection-v1",
        "ticketPredictionSemantics": "exact-selection-probability-v1",
        "ticketBetType": "trifecta", "ticketArtifactSha256": digest, "promotionEligible": True}}
    race_id = "boat-20260102-24-01"
    entries = [{"race_id": race_id, "number": lane, "data_origin": "real",
        "available_at": "2026-01-02T00:00:00+09:00", "national_win_rate": .2,
        "local_win_rate": .2, "motor_2rate": 30, "boat_2rate": 30} for lane in range(1, 7)]
    store = {"races": [{"id": race_id, "sport": "boat", "race_date": "2026-01-02",
                        "data_origin": "real", "status": "scheduled",
                        "post_time": "2026-01-02T13:00:00+09:00"}], "entries": entries}
    predictions = active_ticket_predictions(store, model_row=model_row, artifact=artifact,
        model_id=model_id, cutoff="2026-01-02T12:00:00+09:00", artifact_sha256=digest)
    assert len(predictions) == 120
    assert sum(row["probability"] for row in predictions) == pytest.approx(1.0)
    assert all(row["prob_std"] == pytest.approx(0, abs=1e-15) for row in predictions)
    artifact["metadata"]["trainedAt"] = "2026-01-02T12:00:00+09:00"
    with pytest.raises(ValueError, match="trained strictly before"):
        active_ticket_predictions(store, model_row=model_row, artifact=artifact,
            model_id=model_id, cutoff="2026-01-02T12:00:00+09:00", artifact_sha256=digest)


def test_temporal_candidate_reports_no_profitability_without_real_odds(tmp_path):
    rows = [r for day in range(1, 13) for r in race(
        f"r{day}", f"2026-01-{day:02d}", winner=(day % 6) + 1)]
    result = train_trifecta(rows, {"races": [], "payouts": [], "odds_snapshots": []},
                            model_id="boat-trifecta-test", artifact_dir=tmp_path,
                            min_train_races=2)
    assert result["status"] == "candidate"
    assert result["metrics"]["promotionEligible"] is False
    assert result["metrics"]["payoutReplay"]["roi"] is None
    assert result["metrics"]["payoutReplay"]["status"] == "insufficient_odds_or_payout_data"
    assert result["nBootstrapModels"] == 4
