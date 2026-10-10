from __future__ import annotations

import json

from edgelab.cli import _make_training_rows
from edgelab.learning import guarded_candidate, score_feedback
from edgelab.predict import predict_rows


def _store():
    race = {"id": "real-race", "sport": "boat", "race_date": "2026-10-01",
            "post_time": "2026-10-01T12:00:00+09:00", "status": "finished", "data_origin": "real",
            "wind_speed": 9.0, "wave_height": 3.0}
    entries = [{"race_id": "real-race", "number": n, "lane": n, "national_win_rate": .2,
                "available_at": "2026-10-01T00:00:00+09:00", "data_origin": "real",
                "exhibition_time": 6.0 + n, "start_exhibition": .1 * n}
               for n in (1, 2)]
    results = [{"race_id": "real-race", "number": n, "finish_order": n,
                "data_origin": "real"} for n in (1, 2)]
    predictions = [{"race_id": "real-race", "number": n, "model_id": "model-a",
                    "probability": .7 if n == 1 else .3, "predicted_at": "2026-10-01T10:00:00+09:00",
                    "data_origin": "real"} for n in (1, 2)]
    odds = [{"race_id": "real-race", "selection": str(n), "bet_type": "win", "odds": 2.0,
             "captured_at": "2026-10-01T09:00:00+09:00", "data_origin": "real"} for n in (1, 2)]
    return {"races": [race], "entries": entries, "results": results,
            "predictions": predictions, "odds_snapshots": odds,
            "payouts": [{"race_id": "real-race", "selection": "1", "bet_type": "win",
                         "payout": 180, "data_origin": "real"}], "models": []}


def test_feedback_scores_only_complete_real_prediction_cohort_and_is_replay_safe(tmp_path):
    store = _store()
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    (artifacts / "model-a.json").write_text(json.dumps({"featureColumns": ["lane", "national_win_rate"],
        "trainTo": "2026-09-20", "validTo": "2026-09-25", "trainedAt": "2026-09-26T10:00:00+09:00"}))
    store["predictions"].extend([
        {"race_id": "real-race", "number": 1, "model_id": "model-a", "probability": .1,
         "predicted_at": "2026-10-01T12:01:00+09:00", "data_origin": "real"},
        {"race_id": "real-race", "number": 2, "model_id": "model-a", "probability": .9,
         "predicted_at": "2026-10-01T12:01:00+09:00", "data_origin": "real"},
    ])
    report_path, state_path = tmp_path / "report.json", tmp_path / "state.json"
    first = score_feedback(store, report_path=report_path, feedback_path=state_path, artifact_dir=artifacts)
    second = score_feedback(store, report_path=report_path, feedback_path=state_path, artifact_dir=artifacts)
    result = first["models"]["model-a"]
    assert result["completeRaces"] == 1
    assert result["roi"]["nBets"] == 1
    assert result["roi"]["empiricalROI"] == .8
    assert result["roi"]["confidenceInterval95"] is None
    assert result["roi"]["status"] == "unproven_insufficient_real_bets"
    assert result["top_pick_miss_rate"] == 0
    assert first["models"] == second["models"]
    assert json.loads(state_path.read_text())["scored"]


def test_feedback_rejects_incomplete_or_sample_prediction_cohorts(tmp_path):
    store = _store()
    store["predictions"].pop()
    store["predictions"].append({"race_id": "sample-race", "number": 1, "model_id": "model-a",
                                 "probability": .7, "predicted_at": "2026-10-01T10:00:00+09:00",
                                 "data_origin": "sample"})
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    (artifacts / "model-a.json").write_text(json.dumps({"featureColumns": ["lane"],
        "trainTo": "2026-09-20", "validTo": "2026-09-25", "trainedAt": "2026-09-26T10:00:00+09:00"}))
    report = score_feedback(store, report_path=tmp_path / "r.json", feedback_path=tmp_path / "s.json", artifact_dir=artifacts)
    model = report["models"]["model-a"]
    assert model["completeRaces"] == 0
    assert model["rejected"]["incomplete_prediction_cohort"] == 1


def test_feedback_excludes_artifacts_with_legacy_late_features(tmp_path):
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    (artifacts / "model-a.json").write_text(json.dumps({"featureColumns": ["lane", "exhibition_time"]}))
    report = score_feedback(_store(), report_path=tmp_path / "r.json", feedback_path=tmp_path / "s.json",
                            artifact_dir=artifacts)
    model = report["models"]["model-a"]
    assert model["completeRaces"] == 0
    assert model["status"] == "excluded_unverified_or_legacy_feature_schema"


def test_feedback_excludes_safe_artifact_prediction_inside_or_before_its_fit_window(tmp_path):
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    (artifacts / "model-a.json").write_text(json.dumps({"featureColumns": ["lane"],
        "trainTo": "2026-10-01", "validTo": "2026-10-02", "trainedAt": "2026-10-01T10:30:00+09:00"}))
    report = score_feedback(_store(), report_path=tmp_path / "r.json", feedback_path=tmp_path / "s.json",
                            artifact_dir=artifacts)
    model = report["models"]["model-a"]
    assert model["metrics"]["nRaces"] == 0
    assert model["roi"]["nBets"] == 0
    assert model["rejected"]["prediction_not_out_of_sample_for_artifact"] == 1


def test_training_rows_filter_sample_and_mask_late_boat_features():
    store = _store()
    rows = _make_training_rows(store, "boat")
    assert len(rows) == 2
    assert all(r.get("data_origin") == "real" for r in rows)
    assert all("exhibition_time" not in r and "start_exhibition" not in r for r in rows)
    assert all("wind_speed" not in r and "wave_height" not in r for r in rows)
    store["entries"].append({**store["entries"][0], "race_id": "sample-race", "data_origin": "sample"})
    assert len(_make_training_rows(store, "boat")) == 2


def test_predict_fails_closed_for_legacy_boat_feature_schema():
    artifact = {"metadata": {"id": "legacy", "sport": "boat", "featureColumns": ["lane", "exhibition_time"]},
                "feature_columns": ["lane", "exhibition_time"], "model": None}
    import pytest
    with pytest.raises(ValueError, match="unsafe/legacy feature schema"):
        predict_rows([], artifact)


def test_registered_candidate_id_is_never_retrained_over(tmp_path, monkeypatch):
    import edgelab.learning as learning
    monkeypatch.setattr(learning, "LEARNING_STATE", tmp_path / "state.json")
    monkeypatch.setattr(learning, "train_model", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("must not train")))
    rows = [{"race_id": f"r{i}", "race_date": f"2026-10-0{i % 3 + 1}", "winner": bool(i % 2), "lane": 1}
            for i in range(400)]
    result = guarded_candidate({}, rows, model_id="registered", authoritative_model_ids={"registered"},
                              min_new_races=0)
    assert result["status"] == "existing_registered_id"
