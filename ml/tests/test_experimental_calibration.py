import pytest

from edgelab.calibration.experimental import audit


def ticket(id, race, selection, official, status, p, odds=20):
    return {"id": id, "raceId": race, "selection": selection, "officialSelection": official,
            "status": status, "predictedProb": p, "oddsAtBet": odds, "dataOrigin": "real",
            "recordKind": "experimental_paper", "betType": "trifecta"}


def test_filters_open_void_nonreal_and_invalid_settlement_and_scores_valid_tickets():
    rows = [
        ticket("won", "r1", "1-2-3", "1-2-3", "won", .2),
        ticket("lost", "r2", "1-2-4", "1-2-3", "lost", .1),
        {**ticket("open", "r3", "1-2-4", None, "open", .3), "officialSelection": None},
        {**ticket("void", "r4", "1-2-4", "1-2-3", "void", .4), "repairReason": "invalid"},
        {**ticket("sample", "r5", "1-2-3", "1-2-3", "won", .9), "dataOrigin": "sample"},
        ticket("inconsistent", "r6", "1-2-3", "1-2-3", "lost", .6),
    ]
    result = audit(rows, bootstrap_samples=100)
    assert result["counts"]["settled_valid"] == 2
    assert result["counts"]["open"] == 1
    assert result["counts"]["void_or_reconciled"] == 1
    assert result["counts"]["non_real"] == 1
    assert result["counts"]["invalid_settlement_or_probability"] == 1
    assert result["metrics"]["hits"] == 1
    assert result["metrics"]["expectedHits"] == pytest.approx(.3)
    assert result["metrics"]["brier"] == pytest.approx(.325)
    assert result["raceClusterUncertainty"]["samples"] == 100


def test_empty_valid_cohort_has_no_fake_metrics():
    result = audit([ticket("o", "r", "1-2-3", None, "open", .5)])
    assert result["n"] == 0
    assert result["metrics"] is None


def test_drops_duplicate_ids_and_race_probability_mass_over_one():
    rows = [
        ticket("same", "r1", "1-2-3", "1-2-4", "lost", .2),
        ticket("same", "r2", "1-2-3", "1-2-4", "lost", .1),
        ticket("x", "r3", "1-2-3", "1-2-4", "lost", .8),
        ticket("y", "r3", "1-2-5", "1-2-4", "lost", .5),
    ]
    result = audit(rows)
    assert result["counts"]["duplicate_or_missing_id"] == 1
    assert result["counts"]["incoherent_race_probability_mass_tickets"] == 2
    assert result["n"] == 1
    assert result["maxSettledRaceSelectedProbabilitySum"] == pytest.approx(1.3)


@pytest.mark.parametrize("field,value", [
    ("selection", "1-1-9"), ("selection", "1-2-x"), ("selection", "0-2-3"),
    ("selection", "1-2-7"), ("selection", "01-2-3"), ("selection", "1-2"),
    ("officialSelection", "1-1-9"), ("officialSelection", "1-2-x"),
    ("officialSelection", "0-2-3"), ("officialSelection", "1-2-7"),
])
def test_rejects_non_trifecta_or_invalid_lane_data_and_excludes_race(field, value):
    malformed = ticket("malformed", "r", "1-2-4", "1-2-3", "lost", .1)
    malformed[field] = value
    rows = [
        ticket("valid", "r", "1-2-3", "1-2-4", "lost", .1),
        malformed,
    ]
    result = audit(rows)
    assert result["counts"]["invalid_settlement_or_probability"] == 1
    assert result["counts"]["race_has_invalid_settled_ticket_count"] == 1
    assert result["counts"]["race_has_invalid_settled_ticket_valid_tickets"] == 1
    assert result["n"] == 0


def test_excludes_whole_race_for_inconsistent_official_result_or_duplicate_selection():
    rows = [
        ticket("a", "bad-result", "1-2-3", "1-2-3", "won", .2),
        ticket("b", "bad-result", "1-2-4", "1-2-5", "lost", .1),
        ticket("c", "duplicate-selection", "1-2-3", "1-2-3", "won", .2),
        ticket("d", "duplicate-selection", "1-2-3", "1-2-3", "won", .1),
        ticket("keep", "valid", "2-3-4", "1-2-3", "lost", .1),
    ]
    result = audit(rows)
    assert result["counts"]["race_inconsistent_official_result_count"] == 1
    assert result["counts"]["race_inconsistent_official_result_tickets"] == 2
    assert result["counts"]["race_duplicate_selection_count"] == 1
    assert result["counts"]["race_duplicate_selection_tickets"] == 2
    assert result["n"] == 1
