import json

from edgelab import backfill_sync as bs


def _store():
    races, entries = [], []
    for day in ("2026-07-01", "2026-07-02", "2026-07-03"):
        rid = f"boat-{day.replace('-', '')}-01-01"
        races.append({"id": rid, "race_date": day})
        entries += [{"race_id": rid, "number": n} for n in range(1, 7)]
    return {"races": races, "entries": entries, "results": [], "payouts": [], "predictions": [], "models": []}


def test_groups_rows_by_race_day_and_estimates_amplified_writes():
    days = bs.group_by_date(_store(), "2026-07-02", None)
    assert list(days) == ["2026-07-02", "2026-07-03"]
    assert len(days["2026-07-02"]["entries"]) == 6
    # 1 race + 6 entries + 1 finished update, amplified
    assert bs.estimate_writes(days["2026-07-02"]) == int(8 * bs.WRITE_AMPLIFICATION)


def test_stops_at_budget_and_skips_done_days(tmp_path, monkeypatch):
    monkeypatch.setattr(bs, "load_rows", _store)
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"done": ["2026-07-01"]}))
    one_day = int(8 * bs.WRITE_AMPLIFICATION)
    result = bs.run(since="2026-07-01", until=None, budget=one_day, database="x", state_path=state, dry_run=True)
    assert result["sent_days"] == ["2026-07-02"]
    assert result["next_day"] == "2026-07-03"


def test_remote_historical_sync_is_disabled_without_budget_read_or_write(tmp_path, monkeypatch):
    monkeypatch.setattr(bs, "load_rows", _store)
    monkeypatch.setattr(bs, "fetch_write_budget", lambda: (_ for _ in ()).throw(AssertionError("must not read")), raising=False)
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"done": []}))
    result = bs.run(since="2026-07-01", until=None, budget=20_000, database="x", state_path=tmp_path / "state.json")
    assert result["skipped"] is True
    assert result["sent_days"] == []
    assert result["reason"] == "remote historical D1 backfill is disabled; only --dry-run is available"
    assert json.loads(state.read_text()) == {"done": []}


def test_dry_run_estimates_with_local_cap_without_remote_sync(tmp_path, monkeypatch):
    monkeypatch.setattr(bs, "load_rows", _store)
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"done": []}))
    one_day = int(8 * bs.WRITE_AMPLIFICATION)
    result = bs.run(since="2026-07-01", until=None, budget=99_999, database="x",
                    state_path=state, dry_run=True)
    assert result["backfill_budget"] == bs.MAX_BACKFILL_BUDGET
    assert result["sent_days"] == ["2026-07-01", "2026-07-02", "2026-07-03"]
    assert result["estimated_rows_written"] == one_day * 3
    assert result["remote_sync_performed"] is False
    assert json.loads(state.read_text()) == {"done": []}
