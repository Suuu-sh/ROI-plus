import copy
from pathlib import Path

from edgelab import cli


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
    synced = {}
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
    monkeypatch.setattr("edgelab.learning.score_feedback", lambda rows: {"models": {}})
    predictor = "_predict_boat_trifecta_date" if trifecta_daily else "_predict_boat_date"
    monkeypatch.setattr(cli, predictor,
                        lambda *args: (_ for _ in ()).throw(FileNotFoundError("approved artifact unavailable")))
    monkeypatch.setattr("edgelab.sync.sync_rows", lambda payload: synced.update(payload) or {"ok": True})

    result = cli.run_daily("2026-10-09", "2026-10-09T07:30:00+09:00")

    assert result["daily_collection_success"] is True
    assert result["forecast_ready"] is False
    assert result["forecast_status"] == "not_ready"
    assert result["forecast_reason"] == "FileNotFoundError: approved artifact unavailable"
    assert result.get("predictions", result.get("ticket_predictions")) == 0
    assert synced.get("predictions", synced.get("ticket_predictions")) == []
    assert {row["race_id"] for row in synced["results"]} == {"prev"}


def test_daily_workflow_restores_pinned_bundle_and_skips_only_complete_forecasts():
    workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/daily.yml").read_text()
    assert "if: github.event_name == 'schedule' && steps.guard.outputs.skip != 'true'" in workflow
    assert "candidate-model-artifact-boat-win-lgbm-20261010-14b4a90a" in workflow
    assert "run-id: '38053091327'" in workflow
    assert "continue-on-error: true" in workflow
    assert "steps.daily_pipeline.outputs.daily_collection_success == 'true'" in workflow
    assert "steps.daily_pipeline.outputs.forecast_ready == 'true'" in workflow
    assert "grep -Fxq 'daily_collection_success=true' \"$MARK\"" in workflow
    assert "grep -Fxq 'forecast_ready=true' \"$MARK\"" in workflow
