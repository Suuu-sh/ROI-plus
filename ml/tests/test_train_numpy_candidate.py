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
    assert type(artifact["model"]).__name__ == "NumpyLogisticRegression"
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

