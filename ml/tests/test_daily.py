from __future__ import annotations

import copy
import json
import sys
from itertools import permutations
from types import SimpleNamespace

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
        "predictions": [], "ticket_predictions": [], "prerace_observations": [], "models": [],
        "collection_runs": [{"id": "today-run", "sport": "boat", "target_date": "2026-10-09", "status": "success"}],
    }


def test_daily_sync_keeps_previous_day_out_of_d1_without_open_bets(monkeypatch):
    store = _store()
    store["entries"][0]["features_json"] = json.dumps({"finish_code": "F"})
    store["entries"].append({"race_id": "prev", "number": 2, "features_json": "{}"})
    store["entries"].append({"race_id": "older", "number": 2,
                             "features_json": json.dumps({"finish_code": "F"})})
    # Midday/night K data may already have today's results and payout available.
    store["results"].append({"race_id": "today", "number": 1, "finish_order": 1, "data_origin": "real"})
    store["payouts"].append({"race_id": "today", "bet_type": "win", "selection": "1",
                             "payout": 150, "data_origin": "real"})
    synced, sync_calls = {}, []
    collection_calls = []
    timing_events = []
    fresh_as_of = "2026-10-08T22:31:02.345+00:00"
    monkeypatch.setattr(cli, "load_rows", lambda: copy.deepcopy(store))
    monkeypatch.setattr(cli, "save_rows", lambda value: None)
    monkeypatch.setattr(cli, "collect_boat", lambda start, end, **kwargs: collection_calls.append((start, end, kwargs)) or 0)
    monkeypatch.setattr(cli, "collect_beforeinfo", lambda day, **kwargs: timing_events.append("collection") or
                        {"status": "success", "observations": 0})
    monkeypatch.setattr("edgelab.sync.fetch_model_registry", lambda: timing_events.append("registry") or [])
    monkeypatch.setattr("edgelab.sync.fetch_open_bet_race_ids", lambda target_date: set())
    monkeypatch.setattr(cli, "_inference_timestamp", lambda: timing_events.append("timestamp") or fresh_as_of)
    feedback_rows = []
    monkeypatch.setattr("edgelab.learning.score_feedback", lambda rows: feedback_rows.append(rows) or {"models": {}})
    def predict(rows, day, as_of):
        timing_events.append(("prediction", as_of))
        return [{"race_id": "today", "bet_type": "trifecta"}]
    monkeypatch.setattr(cli, "_predict_boat_trifecta_date", predict)
    monkeypatch.setattr(cli, "_predict_boat_date", lambda *args: (_ for _ in ()).throw(AssertionError("daily must not fall back to win")))
    def sync(payload):
        sync_calls.append(copy.deepcopy(payload))
        for table, values in payload.items():
            synced.setdefault(table, []).extend(values)
        return {table: {"ok": True} for table in payload}
    monkeypatch.setattr("edgelab.sync.sync_rows", sync)

    result = cli.run_daily("2026-10-09", "2026-10-09T07:30:00+09:00")

    assert collection_calls == [("2026-10-08", "2026-10-09",
                                 {"refresh_k_dates": {"2026-10-08", "2026-10-09"}})]
    assert {row["id"] for row in synced["races"]} == {"today"}
    assert {(row["race_id"], row["number"]) for row in synced["entries"]} == {("today", 1)}
    assert {row["race_id"] for row in synced["results"]} == {"today"}
    assert {row["race_id"] for row in synced["payouts"]} == {"today"}
    assert sync_calls[0] == {"results": [], "payouts": []}
    assert sync_calls[1]["races"] == [next(r for r in store["races"] if r["id"] == "today")]
    # The fixture omits one prior race, one K-entry, one result, and one payout
    # from D1 (14 units at current Worker factors 5/4/3/2). Local learning history stays.
    assert {row["id"] for row in feedback_rows[0]["races"]} == {"prev", "today", "older"}
    assert {row["id"] for row in feedback_rows[0]["races"]} == {"prev", "today", "older"}
    assert synced["ticket_predictions"] == [{"race_id": "today", "bet_type": "trifecta"}]
    assert "predictions" not in synced
    assert result["ticket_predictions"] == 1
    assert result["daily_collection_success"] is True
    assert result["forecast_ready"] is True
    assert result["forecast_status"] == "ready"
    assert result["forecast_reason"] is None
    assert result["prediction_as_of"] == fresh_as_of
    assert timing_events == ["collection", "registry", "timestamp", ("prediction", fresh_as_of)]


def test_model_unavailable_marks_forecast_not_ready_but_still_syncs_results(monkeypatch):
    store = _store()
    synced, sync_calls = {}, []
    monkeypatch.setattr(cli, "load_rows", lambda: copy.deepcopy(store))
    monkeypatch.setattr(cli, "save_rows", lambda value: None)
    monkeypatch.setattr(cli, "collect_boat", lambda *args, **kwargs: 0)
    monkeypatch.setattr("edgelab.sync.fetch_model_registry", lambda: [])
    monkeypatch.setattr("edgelab.sync.fetch_open_bet_race_ids", lambda target_date: {"prev"})
    monkeypatch.setattr("edgelab.learning.score_feedback", lambda rows: {"models": {}})
    monkeypatch.setattr(cli, "_predict_boat_trifecta_date",
                        lambda *args: (_ for _ in ()).throw(RuntimeError("no active model in authoritative local registry")))
    def sync(payload):
        sync_calls.append(copy.deepcopy(payload))
        for table, values in payload.items():
            synced.setdefault(table, []).extend(values)
        return {table: {"ok": True} for table in payload}
    monkeypatch.setattr("edgelab.sync.sync_rows", sync)

    result = cli.run_daily("2026-10-09", "2026-10-09T07:30:00+09:00")

    assert result["daily_collection_success"] is True
    assert result["forecast_ready"] is False
    assert result["forecast_status"] == "not_ready"
    assert result["forecast_reason"] == "RuntimeError: no active model in authoritative local registry"
    assert {row["race_id"] for row in synced["results"]} == {"prev"}
    assert sync_calls[0]["results"] == [next(r for r in store["results"] if r["race_id"] == "prev")]
    assert "prev" not in {r["id"] for r in sync_calls[1]["races"]}
    assert synced["ticket_predictions"] == []
    assert "predictions" not in synced


def test_daily_fails_closed_when_open_bet_lookup_is_unavailable(monkeypatch):
    collected = []
    monkeypatch.setattr("edgelab.sync.fetch_open_bet_race_ids",
                        lambda _date: (_ for _ in ()).throw(RuntimeError("lookup unavailable")))
    monkeypatch.setattr(cli, "collect_boat", lambda *args, **kwargs: collected.append(args))
    with pytest.raises(RuntimeError, match="lookup unavailable"):
        cli.run_daily("2026-10-09", "2026-10-09T07:30:00+09:00")
    assert collected == []


def test_primary_prediction_asof_is_t60_not_the_betting_deadline():
    assert cli._primary_prediction_as_of("2026-10-10T12:59:00+09:00") == "2026-10-10T12:58:00+09:00"
    with pytest.raises(ValueError, match="timezone"):
        cli._primary_prediction_as_of("2026-10-10T12:59:00")


def test_daily_trifecta_helper_keeps_only_complete_valid_ticket_groups(monkeypatch, tmp_path):
    model_id = "boat-trifecta-v2-fixture"
    model = {"id": model_id, "sport": "boat", "bet_type": "trifecta", "status": "active",
             "metrics": {"boatFeatureSchemaVersion": "boat-prerace-v2"}}
    race_id = "boat-20261011-01-01"
    predictions = [{"id": f"{race_id}:{a}-{b}-{c}", "race_id": race_id,
                    "model_id": model_id, "bet_type": "trifecta", "predicted_at": "2026-10-10T23:30:00+00:00",
                    "selection": f"{a}-{b}-{c}", "probability": 1 / 120, "prob_std": 0.0}
                   for a, b, c in permutations(range(1, 7), 3)]
    fake_trifecta = SimpleNamespace(active_ticket_predictions=lambda *args, **kwargs: predictions)
    fake_predict = SimpleNamespace(load_artifact=lambda path: {"fixture": True})
    monkeypatch.setitem(sys.modules, "edgelab.models.trifecta", fake_trifecta)
    monkeypatch.setitem(sys.modules, "edgelab.predict", fake_predict)
    (tmp_path / f"{model_id}.pkl").write_bytes(b"fixture artifact")
    rows = {"models": [model], "ticket_predictions": []}

    result = cli._predict_boat_trifecta_date(rows, "2026-10-11", "2026-10-10T23:30:00+00:00", tmp_path)
    assert len(result) == 120
    assert rows["ticket_predictions"] == result

    predictions[0]["probability"] = 10**1000
    rejected = cli._predict_boat_trifecta_date(rows, "2026-10-11", "2026-10-10T23:30:00+00:00", tmp_path)
    assert rejected == []


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
