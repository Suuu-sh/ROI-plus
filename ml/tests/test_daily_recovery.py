import copy
import hashlib
from pathlib import Path

import pytest

from edgelab import cli
from edgelab.daily_marker import is_complete_daily_marker, main as daily_marker_main


def _store():
    return {
        "races": [
            {"id": "prev", "sport": "boat", "race_date": "2026-10-08", "status": "finished"},
            {"id": "today", "sport": "boat", "race_date": "2026-10-09", "status": "scheduled"},
            {"id": "older", "sport": "boat", "race_date": "2026-10-07"},
        ],
        "entries": [{"race_id": race_id, "number": 1} for race_id in ("prev", "today", "older")],
        "results": [{"race_id": race_id, "number": 1} for race_id in ("prev", "older")],
        "payouts": [{"race_id": race_id, "bet_type": "win", "selection": "1"}
                    for race_id in ("prev", "older")],
        "predictions": [], "ticket_predictions": [], "prerace_observations": [], "models": [],
        "collection_runs": [{"id": "today-run", "sport": "boat", "target_date": "2026-10-09",
                             "status": "success"}],
    }


def test_missing_selected_artifact_keeps_collection_success_separate_from_forecast_readiness(monkeypatch):
    store = _store()
    synced, sync_calls = {}, []
    trifecta_daily = hasattr(cli, "_predict_boat_trifecta_date")
    selected = {"id": "registered-active-test", "sport": "boat",
                "bet_type": "trifecta" if trifecta_daily else "win", "status": "active"}
    monkeypatch.setattr(cli, "load_rows", lambda: copy.deepcopy(store))
    monkeypatch.setattr(cli, "save_rows", lambda value: None)
    monkeypatch.setattr(cli, "collect_boat", lambda *args, **kwargs: 0)
    if hasattr(cli, "collect_beforeinfo"):
        monkeypatch.setattr(cli, "collect_beforeinfo",
                            lambda *args, **kwargs: {"status": "success", "observations": 0})
    if hasattr(cli, "_inference_timestamp"):
        monkeypatch.setattr(cli, "_inference_timestamp", lambda: "2026-10-09T07:30:00+00:00")
    monkeypatch.setattr("edgelab.sync.fetch_model_registry", lambda: [selected])
    monkeypatch.setattr("edgelab.sync.fetch_open_bet_race_ids", lambda _day: {"prev"})
    monkeypatch.setattr("edgelab.learning.score_feedback", lambda rows: {"models": {}})
    predictor = "_predict_boat_trifecta_date" if trifecta_daily else "_predict_boat_date"
    monkeypatch.setattr(cli, predictor,
                        lambda *args: (_ for _ in ()).throw(FileNotFoundError("approved artifact unavailable")))
    def sync(payload):
        sync_calls.append(copy.deepcopy(payload))
        for table, values in payload.items():
            synced.setdefault(table, []).extend(values)
        return {table: {"status": 200, "upserted": len(values), "changed": len(values),
                        "noop": not values}
                for table, values in payload.items() if values}
    monkeypatch.setattr("edgelab.sync.sync_rows", sync)

    result = cli.run_daily("2026-10-09", "2026-10-09T07:30:00+09:00")

    assert result["daily_collection_success"] is True
    assert result["forecast_ready"] is False
    assert result["forecast_status"] == "not_ready"
    assert result["forecast_reason"] == "FileNotFoundError: approved artifact unavailable"
    assert result.get("predictions", result.get("ticket_predictions")) == 0
    assert synced.get("predictions", synced.get("ticket_predictions")) == []
    assert {row["race_id"] for row in synced["results"]} == {"prev"}
    assert sync_calls[1]["results"] == [next(r for r in store["results"] if r["race_id"] == "prev")]
    assert "prev" not in {r["id"] for r in sync_calls[2]["races"]}
    assert result["sync"]["results"] == {"status": 200, "upserted": 1, "changed": 1, "noop": False}


def test_daily_workflow_restores_pinned_bundle_and_skips_only_complete_forecasts():
    workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/daily.yml").read_text()
    assert "if: github.event_name == 'schedule' && steps.guard.outputs.skip != 'true'" in workflow
    assert "candidate-model-artifact-boat-win-lgbm-20261010-14b4a90a" in workflow
    assert "run-id: '38053091327'" in workflow
    assert "continue-on-error: true" in workflow
    assert 'path: ml/artifacts' in workflow
    assert 'python -m edgelab.daily_marker "$MARK"' in workflow
    assert 'Current-model recovery only' in workflow
    assert "steps.daily_pipeline.outputs.daily_collection_success == 'true'" in workflow
    assert "steps.daily_pipeline.outputs.forecast_ready == 'true'" in workflow


def test_daily_marker_requires_both_success_flags_and_rejects_legacy_or_ambiguous_markers(tmp_path, capsys):
    cases = {
        "both-ready": ("daily_collection_success=true\nforecast_ready=true\n", True),
        "collection-only": ("daily_collection_success=true\nforecast_ready=false\n", False),
        "legacy-empty": ("", False),
        "legacy-touch": ("\n", False),
        "conflicting-duplicate": (
            "daily_collection_success=true\nforecast_ready=true\nforecast_ready=false\n", False),
    }
    for name, (contents, expected) in cases.items():
        marker = tmp_path / name
        marker.write_text(contents, encoding="utf-8")
        assert is_complete_daily_marker(marker) is expected
        assert daily_marker_main([str(marker)]) == 0
        assert capsys.readouterr().out.strip() == str(expected).lower()


def test_restored_artifact_layout_and_hash_mismatch_fail_before_pickle_load(tmp_path, monkeypatch):
    model_id = "boat-win-lgbm-layout-fixture"
    untrusted_bytes = b"fixture bytes; deliberately not a pickle"
    model = {
        "id": model_id, "sport": "boat", "bet_type": "win", "status": "active",
        "metrics": {
            "boatFeatureSchemaVersion": "boat-base-v1",
            "boatVenueSchemaVersion": "boat-venue-v2",
            "correctedTrainingDataSha256": "b" * 64,
            "boatArtifactSha256": hashlib.sha256(b"registry-approved different bytes").hexdigest(),
        },
    }
    rows = {"models": [model], "races": [], "entries": []}
    artifact_dir = tmp_path / "ml" / "artifacts"
    load_calls = []

    def forbidden_load(*args, **kwargs):
        load_calls.append(args)
        raise AssertionError("hash-mismatched fixture must not be unpickled")

    monkeypatch.setattr("edgelab.predict.load_artifact", forbidden_load)

    # A wrapper directory is not the documented download layout; runtime looks
    # for the exact registered model ID directly under ml/artifacts.
    nested = artifact_dir / "candidate-model-artifact"
    nested.mkdir(parents=True)
    (nested / f"{model_id}.pkl").write_bytes(untrusted_bytes)
    with pytest.raises(FileNotFoundError, match="model artifact not found"):
        cli._predict_boat_date(rows, "2026-10-09", "2026-10-09T07:30:00+00:00", artifact_dir)

    # A directly extracted file reaches SHA verification and is rejected
    # before pickle deserialization or JSON-sidecar inspection.
    (artifact_dir / f"{model_id}.pkl").write_bytes(untrusted_bytes)
    with pytest.raises(RuntimeError, match="registry-approved SHA256"):
        cli._predict_boat_date(rows, "2026-10-09", "2026-10-09T07:30:00+00:00", artifact_dir)
    assert load_calls == []
