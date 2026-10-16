"""Synthetic-only coverage for the explicitly separate NumPy candidate backend."""
from __future__ import annotations

import builtins
import json
import math
import pickle
from datetime import date, timedelta

from edgelab.models.train import train_model


def _synthetic_labeled_rows() -> list[dict]:
    """Create a test-only dataset where lane 1 wins every synthetic race."""
    rows = []
    first_day = date(2026, 1, 1)
    for offset in range(30):
        race_day = first_day + timedelta(days=offset)
        for lane in range(1, 7):
            rows.append({
                "race_id": f"test-only-{race_day.isoformat()}",
                "race_date": race_day.isoformat(),
                "number": lane,
                "lane": lane,
                "winner": lane == 1,
                "data_origin": "sample",
                "fixture": True,
                "available_at": f"{race_day.isoformat()}T07:00:00+09:00",
                "predicted_at": f"{race_day.isoformat()}T08:00:00+09:00",
            })
    # This synthetic label has a post-prediction feature timestamp and must be excluded.
    rows.append({
        "race_id": "test-only-future-leak",
        "race_date": "2026-01-31",
        "number": 1,
        "lane": 1,
        "winner": True,
        "data_origin": "sample",
        "fixture": True,
        "available_at": "2026-01-31T09:00:00+09:00",
        "predicted_at": "2026-01-31T08:00:00+09:00",
    })
    # A row without a label must also be filtered before splitting.
    rows.append({
        "race_id": "test-only-missing-label",
        "race_date": "2026-02-01",
        "number": 1,
        "lane": 1,
        "data_origin": "sample",
        "fixture": True,
        "available_at": "2026-02-01T07:00:00+09:00",
        "predicted_at": "2026-02-01T08:00:00+09:00",
    })
    # A timestamp-safe row without a race date cannot enter a temporal partition.
    rows.append({
        "race_id": "test-only-missing-date",
        "number": 1,
        "lane": 1,
        "winner": True,
        "data_origin": "sample",
        "fixture": True,
        "available_at": "2026-02-02T07:00:00+09:00",
        "predicted_at": "2026-02-02T08:00:00+09:00",
    })
    return rows


def _synthetic_rows_with_missing_features() -> list[dict]:
    rows = _synthetic_labeled_rows()
    for row in rows:
        lane = row["number"]
        race_date = row.get("race_date", "")
        # Fixed, test-only missingness occurs in both the train and held-out dates.
        if race_date and (lane + int(race_date[-2:])) % 5 == 0:
            row["national_win_rate"] = None
        else:
            row["national_win_rate"] = 9.0 - lane * 0.4
    return rows


def test_numpy_logistic_is_separate_candidate_and_keeps_data_gates(tmp_path, monkeypatch):
    # The selected branch must not import runtime scipy, sklearn, or LightGBM.
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name.split(".", 1)[0] in {"scipy", "sklearn", "lightgbm"}:
            raise AssertionError(f"unexpected optional runtime import: {name}")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    metadata = train_model(
        _synthetic_labeled_rows(),
        model_id="boat-win-numpy-logistic-test-candidate",
        feature_columns=["lane"],
        artifact_dir=tmp_path,
        min_train_races=20,
        n_bootstrap=2,
        estimator_backend="numpy-logistic",
    )

    assert metadata["status"] == "candidate"
    assert metadata["backend"] == "numpy-logistic"
    assert metadata["algorithm"] == "NumPy binary logistic regression + per-race softmax"
    assert metadata["id"] != "boat-win-lgbm-v1"
    assert metadata["nTrainRaces"] == 22
    assert metadata["nTrain"] == 22 * 6
    assert metadata["validFrom"] == "2026-01-23"
    assert metadata["validTo"] == "2026-01-26"
    assert metadata["testFrom"] == "2026-01-27"
    assert metadata["testTo"] == "2026-01-30"
    assert metadata["nBootstrapModels"] == 2
    assert metadata["metrics"]["nRaces"] == 4
    assert math.isfinite(metadata["metrics"]["logLoss"])
    assert math.isfinite(metadata["metrics"]["brier"])
    assert math.isfinite(metadata["metrics"]["ece"])
    assert metadata["metrics"]["baselineLogLoss"] is not None
    assert metadata["metrics"]["baselineUniformLogLoss"] == math.log(6)

    with (tmp_path / f"{metadata['id']}.pkl").open("rb") as artifact_file:
        artifact = pickle.load(artifact_file)
    json_metadata = json.loads((tmp_path / f"{metadata['id']}.json").read_text())
    assert artifact["metadata"] == json_metadata == metadata
    assert artifact["metadata"]["backend"] == "numpy-logistic"
    assert type(artifact["model"]).__name__ == "NumpyImputedLogisticRegression"
    assert artifact["metadata"]["preprocessing"]["method"] == (
        "training_median_imputation_then_standardization")
    assert artifact["metadata"]["artifactProvenance"]["artifactName"] == (
        f"candidate-model-artifact-{metadata['id']}")


def test_numpy_logistic_keeps_minimum_and_temporal_data_gates(tmp_path):
    rows = []
    for day, winner in ((1, 1), (2, 2)):
        race_date = f"2026-02-{day:02d}"
        rows.extend({"race_id": f"short-{day}", "race_date": race_date,
                     "number": lane, "lane": lane, "winner": lane == winner}
                    for lane in range(1, 7))
    metadata = train_model(
        rows,
        model_id="boat-win-numpy-logistic-too-small",
        feature_columns=["lane"],
        artifact_dir=tmp_path,
        min_train_races=1,
        estimator_backend="numpy-logistic",
    )
    assert metadata["status"] == "untrained"
    assert metadata["backend"] == "numpy-logistic"
    assert metadata["algorithm"].startswith("NumPy binary logistic regression")
    assert metadata["reason"].startswith("insufficient_temporal_data:")


def test_numpy_candidate_cannot_use_incumbent_model_id(tmp_path):
    try:
        train_model([], model_id="boat-win-lgbm-v1", artifact_dir=tmp_path,
                    estimator_backend="numpy-logistic")
    except ValueError as exc:
        assert "incumbent LightGBM model id" in str(exc)
    else:
        raise AssertionError("NumPy candidate must not write under the incumbent model id")


def test_numpy_candidate_imputes_missing_features_from_train_only(tmp_path):
    rows = _synthetic_rows_with_missing_features()
    assert any(row.get("national_win_rate") is None for row in rows
               if row.get("race_date", "").endswith(("01", "02", "03", "04", "05")))
    assert any(row.get("national_win_rate") is None for row in rows
               if row.get("race_date", "").endswith(("27", "28", "29", "30")))

    baseline = train_model(
        rows,
        model_id="boat-win-numpy-logistic-missing-base",
        feature_columns=["lane", "national_win_rate"],
        artifact_dir=tmp_path / "base",
        min_train_races=20,
        n_bootstrap=2,
        estimator_backend="numpy-logistic",
    )
    assert baseline["status"] == "candidate"
    assert baseline["nBootstrapModels"] == 2
    transform = baseline["preprocessing"]
    assert transform["method"] == "training_median_imputation_then_standardization"
    assert transform["featureColumns"] == ["lane", "national_win_rate"]
    assert len(transform["medians"]) == len(transform["means"]) == len(transform["scales"]) == 2
    assert all(math.isfinite(value) for key in ("medians", "means", "scales")
               for value in transform[key])
    with (tmp_path / "base" / f"{baseline['id']}.pkl").open("rb") as artifact_file:
        artifact = pickle.load(artifact_file)
    assert artifact["model"].medians_.tolist() == transform["medians"]
    assert artifact["model"].means_.tolist() == transform["means"]
    assert artifact["model"].scales_.tolist() == transform["scales"]

    # Change only test-period values, including new missing values. Fitted preprocessing
    # statistics must remain derived from the unchanged training period only.
    perturbed_rows = [dict(row) for row in rows]
    for row in perturbed_rows:
        if row.get("race_date", "") >= "2026-01-27" and row.get("race_date", "") <= "2026-01-30":
            row["national_win_rate"] = None if row["number"] % 2 else 10_000.0 + row["number"]
    perturbed = train_model(
        perturbed_rows,
        model_id="boat-win-numpy-logistic-missing-perturbed",
        feature_columns=["lane", "national_win_rate"],
        artifact_dir=tmp_path / "perturbed",
        min_train_races=20,
        n_bootstrap=2,
        estimator_backend="numpy-logistic",
    )
    assert perturbed["status"] == "candidate"
    assert perturbed["preprocessing"] == transform

