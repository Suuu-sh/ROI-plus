from __future__ import annotations
import json
import math
import sys
from pathlib import Path

from edgelab.models.compare import compare_models, temporal_split
from edgelab.features.boat import BASE_FEATURE_COLUMNS, FEATURE_COLUMNS, build_boat_features
from edgelab.cli import _parser
from edgelab.models.train import (_feature_columns, _lane_baseline_log_loss,
                                  _race_softmax, train_model)
from edgelab.normalization.availability import filter_historical


class _FakeLGBM:
    """Pickleable test-only stand-in for hosts missing LightGBM's libomp."""
    def __init__(self, **kwargs):
        self.bias = 0.0
    def fit(self, X, y):
        self.bias = sum(y) / max(len(y), 1)
        return self
    def predict(self, X, raw_score=False):
        return [float(row[0]) + self.bias for row in X]


def test_availability_and_historical_leakage_are_fail_closed():
    history = [
        {"race_date": "2026-09-01", "available_at": "2026-09-01T09:50:00+09:00", "finish_order": 1},
        {"race_date": "2026-09-02", "available_at": "2026-09-02T09:00:00+09:00", "finish_order": 1},
        {"race_date": "2026-08-31", "available_at": "2026-09-02T10:01:00+09:00", "finish_order": 1},
        {"race_date": "2026-08-30", "finish_order": 1},
    ]
    safe = filter_historical(history, race_date="2026-09-02", predicted_at="2026-09-02T10:00:00+09:00")
    assert len(safe) == 1
    assert safe[0]["race_date"] == "2026-09-01"


def test_race_softmax_sums_to_one():
    rows = [{"race_id": "a"} for _ in range(6)] + [{"race_id": "b"} for _ in range(2)]
    probs = _race_softmax([0.2, 0.4, -1, 2, 0, -0.1, 0, 2], rows)
    assert math.isclose(sum(probs[:6]), 1.0)
    assert math.isclose(sum(probs[6:]), 1.0)


def test_boat_default_feature_set_excludes_result_and_pre_race_only_inputs():
    entry = {"number": 3, "exhibition_time": 6.72, "start_exhibition": 0.05,
             "wind_speed": 4, "wave_height": 5, "finish_order": 1,
             "features_json": json.dumps({"race_start_timing": 0.25, "entry_course": 3,
                                           "weather": "晴", "wind_direction": "北"})}
    features = build_boat_features([entry], race_date="2026-09-01")[0]
    assert tuple(features) == BASE_FEATURE_COLUMNS
    assert not set(FEATURE_COLUMNS).intersection({
        "race_start_timing", "entry_course", "finish_order", "race_time", "payout", "winner", "target"
    })
    assert not {"exhibition_time", "start_exhibition", "wind_speed", "wave_height",
                "wind_direction_code"}.intersection(features)


def test_boat_pre_race_opt_in_still_never_exposes_results():
    entry = {"number": 3, "exhibition_time": 6.72, "start_exhibition": 0.05,
             "wind_speed": 4, "wave_height": 5, "finish_order": 1,
             "race_start_timing": 0.25, "entry_course": 3,
             "features_json": json.dumps({"race_start_timing": 0.25, "entry_course": 3})}
    features = build_boat_features([entry], race_date="2026-09-01", include_pre_race_info=True)[0]
    assert features["exhibition_time"] == 6.72
    assert features["start_exhibition"] == 0.05
    assert not {"finish_order", "race_start_timing", "entry_course", "race_time", "payout",
                "winner", "target"}.intersection(features)


def test_train_rejects_result_and_unknown_feature_columns():
    for forbidden in ("finish_order", "race_start_timing", "entry_course", "race_time",
                      "payout", "winner", "target", "future_unknown"):
        try:
            _feature_columns([forbidden])
        except ValueError:
            pass
        else:
            raise AssertionError(f"feature column {forbidden!r} was not rejected")


def test_rebuild_command_accepts_explicit_raw_directory():
    args = _parser().parse_args(["rebuild", "--raw", "data/raw/boatrace"])
    assert args.command == "rebuild"
    assert args.raw == "data/raw/boatrace"


def test_lane_baseline_uses_train_win_rates_and_normalizes_each_test_race():
    train = [
        {"race_id": "train-1", "number": 1, "winner": True},
        {"race_id": "train-1", "number": 2, "winner": False},
        {"race_id": "train-2", "number": 1, "winner": True},
        {"race_id": "train-2", "number": 2, "winner": False},
        {"race_id": "train-3", "number": 1, "winner": False},
        {"race_id": "train-3", "number": 2, "winner": True},
    ]
    test = [
        {"race_id": "test-1", "number": 1, "winner": True},
        {"race_id": "test-1", "number": 2, "winner": False},
    ]
    assert math.isclose(_lane_baseline_log_loss(train, test), -math.log(2 / 3))


def test_temporal_split_keeps_dates_disjoint():
    rows = [{"race_id": f"{day}-r{i}", "race_date": f"2026-09-{day:02d}"} for day in range(1, 21) for i in range(2)]
    train, valid, test = temporal_split(rows)
    date_sets = [{r["race_date"] for r in group} for group in (train, valid, test)]
    assert all(date_sets[i].isdisjoint(date_sets[j]) for i in range(3) for j in range(i + 1, 3))
    assert max(r["race_date"] for r in train) < min(r["race_date"] for r in valid)
    assert max(r["race_date"] for r in valid) < min(r["race_date"] for r in test)


def test_insufficient_data_creates_untrained_artifact(tmp_path):
    result = train_model([], sport="boat", model_id="boat-win-lgbm-v1",
                         artifact_dir=tmp_path, min_train_races=300)
    assert result["status"] == "untrained"
    assert (tmp_path / "boat-win-lgbm-v1.pkl").exists()
    assert json.loads((tmp_path / "boat-win-lgbm-v1.json").read_text())["status"] == "untrained"


def test_synthetic_training_calibrates_and_emits_metrics(tmp_path, monkeypatch):
    # Test-only LightGBM test double allows exercising calibration and metric
    # flow even on hosts missing LightGBM's optional native libomp runtime.
    monkeypatch.setitem(sys.modules, "lightgbm", type("FakeModule", (), {"LGBMClassifier": _FakeLGBM}))
    rows = []
    for day in range(1, 21):
        for number in range(1, 7):
            rows.append({"race_id": f"r{day}", "race_date": f"2026-09-{day:02d}",
                         "number": number, "lane": number,
                         "national_win_rate": 7.0 - number * .5,
                         "winner": number == (day % 6) + 1, "data_origin": "real"})
    result = train_model(rows, sport="boat", model_id="boat-win-lgbm-v1",
                         artifact_dir=tmp_path, min_train_races=5, n_bootstrap=5)
    assert result["status"] == "candidate"
    assert result["calibration"]
    assert result["metrics"]["logLoss"] is not None
    assert result["metrics"]["brier"] is not None
    assert result["metrics"]["baselineLogLoss"] is not None
    assert math.isclose(result["metrics"]["baselineUniformLogLoss"], math.log(6))
    assert result["metrics"]["logLossDefinition"] == "race_multiclass"
    assert (tmp_path / "boat-win-lgbm-v1.pkl").exists()


def test_compare_requires_both_proper_scores_and_nonworse_ece():
    old = {"metrics": {"logLoss": .8, "brier": .4, "ece": .1, "roi": 1.4, "maxDrawdown": 20}}
    candidate = {"metrics": {"logLoss": .7, "brier": .3, "ece": .1, "roi": .1, "maxDrawdown": 50}}
    assert compare_models(old, candidate)["candidate"] is True
    candidate["metrics"]["ece"] = .11
    assert compare_models(old, candidate)["candidate"] is False
    candidate["metrics"]["ece"] = .1
    candidate["metrics"]["brier"] = .45
    assert compare_models(old, candidate)["candidate"] is False
