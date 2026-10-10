from __future__ import annotations

import json
import os
import pickle
from datetime import date, timedelta

from edgelab.baseline_validation import _canonical_sha256, validate_initial_baseline
from edgelab.models.compare import compute_metrics, temporal_split
from edgelab.models.train import _race_softmax, _score, candidate_version


class _FixtureModel:
    def predict(self, matrix, raw_score=False):
        return [5.0 * row[0] for row in matrix]


def _synthetic_store():
    races, entries, results = [], [], []
    first = date(2026, 1, 1)
    for day_offset in range(100):
        race_date = (first + timedelta(days=day_offset)).isoformat()
        for race_no in range(30):
            index = day_offset * 30 + race_no
            race_id = f"synthetic-{index:05d}"
            winner = index % 6 + 1
            races.append({"id": race_id, "sport": "boat", "race_date": race_date,
                          "post_time": f"{race_date}T12:00:00+09:00", "status": "finished",
                          "data_origin": "real"})
            for number in range(1, 7):
                entries.append({"race_id": race_id, "number": number, "lane": number,
                    "national_win_rate": .9 if number == winner else .1,
                    "available_at": f"{race_date}T00:00:00+09:00", "data_origin": "real"})
                results.append({"race_id": race_id, "number": number,
                    "finish_order": 1 if number == winner else number + 1, "data_origin": "real"})
    return {"races": races, "entries": entries, "results": results,
            "payouts": [], "odds_snapshots": []}


def test_initial_baseline_validation_replays_exact_safe_artifact_and_requires_authenticated_snapshot(tmp_path):
    from edgelab.cli import _make_training_rows

    model_id = "boat-win-lgbm-20261010-1234abcd"
    store = _synthetic_store()
    rows = _make_training_rows(store, "boat")
    train, valid, test = temporal_split(rows)
    dates = lambda part: sorted({str(row["race_date"]) for row in part})
    feature_columns = ["national_win_rate"]
    temperature = 1.0
    primary_predictions = []
    grouped = {}
    for row in test:
        grouped.setdefault(str(row["race_id"]), []).append(row)
    for race in grouped.values():
        probabilities = _race_softmax(_score(_FixtureModel(), race, feature_columns), race, temperature)
        primary_predictions.extend({**row, "probability": probabilities[index]}
                                   for index, row in enumerate(race))
    metadata = {"id": model_id, "sport": "boat", "betType": "win", "version": candidate_version(model_id),
        "algorithm": "synthetic-test-only", "status": "candidate", "trainFrom": dates(train)[0],
        "trainTo": dates(train)[-1], "validFrom": dates(valid)[0], "validTo": dates(valid)[-1],
        "testFrom": dates(test)[0], "testTo": dates(test)[-1], "nTrain": len(train),
        "nTrainRaces": len({row["race_id"] for row in train}), "temperature": temperature,
        "featureColumns": feature_columns, "trainedAt": "2026-04-15T00:00:00+00:00",
        "metrics": compute_metrics(primary_predictions)}
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    (artifact_dir / f"{model_id}.json").write_text(json.dumps(metadata), encoding="utf-8")
    with (artifact_dir / f"{model_id}.pkl").open("wb") as stream:
        pickle.dump({"metadata": metadata, "model": _FixtureModel(), "bootstrap_models": [],
                     "feature_columns": feature_columns, "temperature": temperature}, stream)
    registry = [{"id": model_id, "sport": "boat", "bet_type": "win",
                 "version": metadata["version"], "status": "candidate"},
                {"id": "legacy-synthetic-retired", "sport": "boat", "bet_type": "win",
                 "version": "synthetic-v0", "status": "retired", "metrics_json": '{"legacy":true}'}]
    report = validate_initial_baseline(store, model_id=model_id, artifact_dir=artifact_dir,
        registry=registry, generated_at="2026-04-20T00:00:00+00:00", workflow_run_id="synthetic-test-run")
    fixture_path = os.environ.get("EDGELAB_WRITE_BASELINE_FIXTURE")
    if fixture_path:
        from pathlib import Path
        Path(fixture_path).parent.mkdir(parents=True, exist_ok=True)
        Path(fixture_path).write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                                      encoding="utf-8")

    assert report["initialBaselineEligible"] is True
    assert report["modelEvidenceEligible"] is True
    assert report["cohort"]["raceCount"] == 450
    assert report["cohort"]["dayCount"] == 15
    assert report["pairedComparison"]["logLossCI95"][1] < 0
    assert report["pairedComparison"]["brierCI95"][1] < 0
    assert report["profitability"]["status"] == "counterfactual_replay_unproven"
    assert report["sourceAvailability"] == "assumed_from_B_prerace_content_not_recorded"
    assert report["workflowRunId"] == "synthetic-test-run"
    assert _canonical_sha256({"a": 1e-6, "b": -0.0, "c": 1e21,
                              "d": 1.23e-6, "e": 1e-7}) == (
        "6010cf77436d4633dbae7e6489823106b01177bc19d0ad552129b6163decd1a4")


def test_initial_baseline_fails_closed_without_candidate_artifact_pair(tmp_path):
    report = validate_initial_baseline({}, artifact_dir=tmp_path)
    assert report["initialBaselineEligible"] is False
    assert report["checks"]["safeFeatureSchema"] is False
    assert "exact candidate JSON/pickle artifact pair" in report["failureReason"]


def test_runtime_artifact_hash_mismatch_fails_closed(tmp_path):
    import hashlib
    import pytest
    from edgelab.cli import _verify_runtime_artifact

    artifact = tmp_path / "candidate.pkl"
    artifact.write_bytes(b"test-artifact-bytes")
    model = {"metrics_json": json.dumps({"boatFeatureSchemaVersion": "boat-base-v1",
        "boatArtifactSha256": "0" * 64})}
    with pytest.raises(RuntimeError, match="SHA256"):
        _verify_runtime_artifact(model, artifact)
    model["metrics_json"] = json.dumps({"boatFeatureSchemaVersion": "boat-base-v1",
        "boatArtifactSha256": hashlib.sha256(artifact.read_bytes()).hexdigest()})
    _verify_runtime_artifact(model, artifact)
