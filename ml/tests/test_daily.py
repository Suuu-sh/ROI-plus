from __future__ import annotations

import copy
import json

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
    # Midday/night K data may already have today's results and payout available.
    store["results"].append({"race_id": "today", "number": 1, "finish_order": 1, "data_origin": "real"})
    store["payouts"].append({"race_id": "today", "bet_type": "win", "selection": "1",
                             "payout": 150, "data_origin": "real"})
    synced = {}
    collection_calls = []
    monkeypatch.setattr(cli, "load_rows", lambda: copy.deepcopy(store))
    monkeypatch.setattr(cli, "save_rows", lambda value: None)
    monkeypatch.setattr(cli, "collect_boat", lambda start, end, **kwargs: collection_calls.append((start, end, kwargs)) or 0)
    monkeypatch.setattr("edgelab.sync.fetch_model_registry", lambda: [])
    monkeypatch.setattr("edgelab.learning.score_feedback", lambda rows: {"models": {}})
    monkeypatch.setattr(cli, "_predict_boat_date", lambda rows, day, cutoff: [{"race_id": "today"}])
    monkeypatch.setattr("edgelab.sync.sync_rows", lambda payload: synced.update(payload) or {"ok": True})
    monkeypatch.setattr("edgelab.backfill_sync.run", lambda **kwargs: (_ for _ in ()).throw(RuntimeError("wrangler unavailable")))

    result = cli.run_daily("2026-10-09", "2026-10-09T07:30:00+09:00")

    assert collection_calls == [("2026-10-08", "2026-10-09",
                                 {"refresh_k_dates": {"2026-10-08", "2026-10-09"}})]
    assert {row["id"] for row in synced["races"]} == {"prev", "today"}
    assert {row["race_id"] for row in synced["entries"]} == {"today"}
    assert {row["race_id"] for row in synced["results"]} == {"prev", "today"}
    assert {row["race_id"] for row in synced["payouts"]} == {"prev", "today"}
    assert synced["predictions"] == [{"race_id": "today"}]
    assert result["backfill"]["skipped"] is True
    assert "wrangler unavailable" in result["backfill"]["reason"]


def test_predict_requires_artifact_even_if_model_exists(tmp_path):
    rows = {"models": [{"id": "boat-win-lgbm-v1", "sport": "boat", "status": "candidate"}],
            "races": [], "entries": []}
    with pytest.raises(RuntimeError, match="no active model"):
        cli._predict_boat_date(rows, "2026-10-09", "2026-10-09T07:30:00+09:00", tmp_path)


def test_venue_cache_migration_rebuilds_rows_once_and_preserves_only_history(monkeypatch, tmp_path):
    from edgelab.parsers import boatrace_b, boatrace_k
    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "b260101.lzh").write_bytes(b"B")
    (raw / "k260101.lzh").write_bytes(b"K")
    old = {"races": [{"id": "stale-merged"}], "entries": [{"race_id": "stale-merged"}],
           "results": [{"race_id": "stale-merged"}], "payouts": [{"race_id": "stale-merged"}],
           "predictions": [{"id": "historical-prediction", "model_id": "retired-old"}],
           "odds_snapshots": [{"id": "historical-odds"}], "models": [{"id": "stale-active", "status": "active"}]}
    parsed = {
        "races": [{"id": "boat-20260101-23-01", "sport": "boat", "venue_id": "23", "data_origin": "real"}],
        "entries": [{"race_id": "boat-20260101-23-01", "number": 1, "data_origin": "real"}],
        "results": [], "payouts": [],
    }
    saved = []
    monkeypatch.setattr(cli, "load_rows", lambda: copy.deepcopy(old))
    monkeypatch.setattr(cli, "save_rows", lambda rows: saved.append(copy.deepcopy(rows)))
    monkeypatch.setattr("edgelab.collectors.boatrace.read_lzh", lambda path: path.read_bytes())
    monkeypatch.setattr(boatrace_b, "parse_b", lambda content, race_date: copy.deepcopy(parsed))
    monkeypatch.setattr(boatrace_k, "parse_k", lambda content, race_date: {"races": [], "entries": [],
        "results": [], "payouts": []})

    marker = tmp_path / "ml-data" / "boat-venue-v2.json"
    first = cli.migrate_boat_venue_cache(raw, marker)
    assert first["status"] == "migrated"
    assert len(saved) == 1
    assert [row["id"] for row in saved[0]["races"]] == ["boat-20260101-23-01"]
    assert saved[0]["models"] == []
    assert saved[0]["predictions"] == old["predictions"]
    assert saved[0]["odds_snapshots"] == old["odds_snapshots"]
    assert json.loads(marker.read_text())["schemaVersion"] == "boat-venue-v2"

    second = cli.migrate_boat_venue_cache(raw, marker)
    assert second["status"] == "already_migrated"
    assert len(saved) == 1
