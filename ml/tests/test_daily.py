from __future__ import annotations

import copy

import pytest

from edgelab import cli


def _store():
    return {
        "races": [
            {"id": "prev", "sport": "boat", "race_date": "2026-10-08", "status": "finished"},
            {"id": "today", "sport": "boat", "race_date": "2026-10-09", "status": "scheduled"},
            {"id": "older", "sport": "boat", "race_date": "2026-10-07"},
        ],
        "entries": [{"race_id": x, "number": 1} for x in ("prev", "today", "older")],
        "results": [{"race_id": x, "number": 1} for x in ("prev", "older")],
        "payouts": [{"race_id": x, "bet_type": "win", "selection": "1"} for x in ("prev", "older")],
        "predictions": [], "models": [],
        "collection_runs": [{"id": "today-run", "sport": "boat", "target_date": "2026-10-09"}],
    }


def test_daily_sync_is_limited_to_today_and_previous_day_and_backfill_error_is_soft(monkeypatch):
    store = _store()
    synced = {}
    monkeypatch.setattr(cli, "load_rows", lambda: copy.deepcopy(store))
    monkeypatch.setattr(cli, "save_rows", lambda value: None)
    monkeypatch.setattr(cli, "collect_boat", lambda start, end: 0)
    monkeypatch.setattr("edgelab.sync.fetch_model_registry", lambda: [])
    monkeypatch.setattr("edgelab.learning.score_feedback", lambda rows: {"models": {}})
    monkeypatch.setattr(cli, "_predict_boat_date", lambda rows, day, cutoff: [{"race_id": "today"}])
    monkeypatch.setattr("edgelab.sync.sync_rows", lambda payload: synced.update(payload) or {"ok": True})
    monkeypatch.setattr("edgelab.backfill_sync.run", lambda **kwargs: (_ for _ in ()).throw(RuntimeError("wrangler unavailable")))

    result = cli.run_daily("2026-10-09", "2026-10-09T07:30:00+09:00")

    assert {row["id"] for row in synced["races"]} == {"prev", "today"}
    assert {row["race_id"] for row in synced["entries"]} == {"today"}
    assert {row["race_id"] for row in synced["results"]} == {"prev"}
    assert {row["race_id"] for row in synced["payouts"]} == {"prev"}
    assert synced["predictions"] == [{"race_id": "today"}]
    assert result["backfill"]["skipped"] is True
    assert "wrangler unavailable" in result["backfill"]["reason"]


def test_predict_requires_artifact_even_if_model_exists(tmp_path):
    rows = {"models": [{"id": "boat-win-lgbm-v1", "sport": "boat", "status": "candidate"}],
            "races": [], "entries": []}
    with pytest.raises(RuntimeError, match="no active model"):
        cli._predict_boat_date(rows, "2026-10-09", "2026-10-09T07:30:00+09:00", tmp_path)
