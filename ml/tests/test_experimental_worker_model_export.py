import json
from pathlib import Path

import numpy as np

from edgelab.features.boat import (
    TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS,
    build_boat_prerace_v2_features,
)
from edgelab.models.trifecta import ensemble_ordered_triples
from edgelab import experimental_worker_model_export as exporter


def _synthetic_model(columns, shift=0.0):
    size = len(columns)
    return {
        "columns": list(columns),
        "medians": np.zeros(size),
        "means": np.zeros(size),
        "scales": np.ones(size),
        "estimator": type("Estimator", (), {
            "coef_": np.array([[((i % 5) - 2) * 0.03 + shift for i in range(size)]])
        })(),
    }


def _synthetic_group():
    columns = list(TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS)
    entries = []
    for lane in range(1, 7):
        entries.append({
            "number": lane,
            "race_id": "synthetic-race",
            "data_origin": "real",
            "available_at": "2026-10-15T10:00:00+09:00",
            "national_win_rate": 4.0 + lane / 10,
            "local_win_rate": 3.0 + lane / 20,
            "motor_2rate": 30 + lane,
            "boat_2rate": 25 + lane,
            "weight_carried": 52 + lane / 2,
            "racer_class": "A1" if lane % 2 else "B1",
            "features_json": json.dumps({"racer_id": f"synthetic-racer-{lane}",
                                          "age": 25 + lane,
                                          "national_2rate": 40 + lane,
                                          "local_2rate": 35 + lane}),
        })
    history = []
    for lane in range(1, 7):
        history.extend([
            {"racer_id": f"synthetic-racer-{lane}", "race_date": "2026-10-01",
             "available_at": "2026-10-01T12:00:00+09:00", "finish_order": 1},
            {"racer_id": f"synthetic-racer-{lane}", "race_date": "2026-10-02",
             "available_at": "2026-10-02T12:00:00+09:00", "finish_order": 2},
        ])
    group = build_boat_prerace_v2_features(
        entries, race={"id": "synthetic-race", "race_date": "2026-10-15",
                       "data_origin": "real"},
        predicted_at="2026-10-15T10:00:00+09:00", history=history)
    return columns, [{**{column: row.get(column) for column in columns},
                      "number": index} for index, row in enumerate(group, 1)]


def test_worker_export_requires_pinned_validation_before_pickle_load(tmp_path, monkeypatch):
    columns = list(TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS)
    model = _synthetic_model(columns)
    artifact = {"metadata": {"id": "boat-trifecta-exp-noweather-synthetic",
                              "ticketArtifactSha256": "a" * 64,
                              "trainingMode": "experimental", "experimentalOnly": True},
                "columns": columns, "temperature": 1.15,
                "model": model, "bootstrap_models": [_synthetic_model(columns, .01)]}
    calls = []
    monkeypatch.setattr(exporter, "validate_forecast_only_artifact",
                        lambda *a, **k: calls.append("validated") or {
                            "modelId": artifact["metadata"]["id"],
                            "artifactSha256": "a" * 64})
    monkeypatch.setattr(exporter, "load_artifact",
                        lambda path: calls.append("loaded") or artifact)
    target = tmp_path / "worker.json"
    summary = exporter.export_worker_model(artifact["metadata"]["id"], "a" * 64,
                                           artifact_dir=tmp_path, output_path=target)
    assert calls == ["validated", "loaded"]
    payload = json.loads(target.read_text())
    assert payload["schema"] == "experimental-trifecta-worker-model-v1"
    assert payload["columns"] == columns
    assert len(payload["members"]) == 2
    assert summary["columnCount"] == 19


def test_synthetic_feature_builder_and_ordered_probability_fixture():
    columns, group = _synthetic_group()
    assert columns == list(TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS)
    assert len(group) == 6
    assert all(set(row) == set(columns) | {"number"} for row in group)
    assert all(row["racer_history_starts"] == 2 for row in group)
    assert all(row["exhibition_time"] is None for row in group)
    model = _synthetic_model(columns)
    model2 = _synthetic_model(columns, .01)
    mean, std = ensemble_ordered_triples({"model": model, "bootstrap_models": [model2],
                                           "temperature": 1.15}, group)
    assert len(mean) == 120 and len(std) == 120
    assert abs(sum(mean.values()) - 1.0) < 1e-12
    assert all(value is None for value in std.values())  # fewer than five fits
    # Compact golden values for the Worker-side pure math equivalence check.
    assert abs(mean["1-2-3"] - 0.009681291319868612) < 1e-12


def test_checked_in_worker_equivalence_fixture_matches_python():
    fixture_path = Path(__file__).parent / "fixtures" / "experimental_worker_equivalence.synthetic.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    columns, group = _synthetic_group()
    assert fixture["columns"] == columns
    assert fixture["numbers"] == [row["number"] for row in group]
    assert fixture["features"] == [[row.get(column) for column in columns] for row in group]
    models = []
    for member in fixture["members"]:
        models.append({
            "columns": columns,
            "medians": np.asarray(member["medians"]),
            "means": np.asarray(member["means"]),
            "scales": np.asarray(member["scales"]),
            "estimator": type("Estimator", (), {
                "coef_": np.asarray([member["coefficients"]])
            })(),
        })
    mean, std = ensemble_ordered_triples({"model": models[0],
                                           "bootstrap_models": models[1:],
                                           "temperature": fixture["temperature"]}, group)
    assert set(mean) == set(fixture["meanProbabilities"])
    assert all(abs(mean[key] - fixture["meanProbabilities"][key]) < 1e-15 for key in mean)
    assert all(abs(std[key] - fixture["populationStdProbabilities"][key]) < 1e-15
               for key in std)
