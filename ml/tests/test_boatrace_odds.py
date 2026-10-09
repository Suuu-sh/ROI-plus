from datetime import datetime
from pathlib import Path
import pytest

from edgelab.collectors.boatrace_odds import parse_win_odds
from edgelab.live import DISABLED_REASON, run_live, select_odds_targets


FIXTURE = Path(__file__).parents[2] / "data/fixtures/boatrace/oddstf_24_12_20261009.html"
PRIVATE_FIXTURE = Path(__file__).parents[2] / "data/private_fixtures/boatrace/oddstf_24_12_20261009.html"


def test_fixture_win_odds_and_final():
    parsed = parse_win_odds(FIXTURE.read_text(encoding="utf-8"))
    assert parsed == {"final": True, "odds": {1: 2.1, 2: 3.2, 3: 4.3, 4: 5.4, 5: 6.5, 6: 7.6}}


@pytest.mark.skipif(not PRIVATE_FIXTURE.exists(), reason="private official fixtures are not installed")
def test_private_official_win_odds_regression():
    parsed = parse_win_odds(PRIVATE_FIXTURE.read_text(encoding="utf-8"))
    assert parsed == {"final": True, "odds": {1: 1.1, 2: 13.1, 3: 7.6, 4: 6.9, 5: 24.8, 6: 14.2}}


def test_non_numeric_odds_are_none():
    html = '<p>締切時オッズ</p>' + ''.join(
        f'<td class="oddsPoint">{value}</td>' for value in ("1.2", "欠場", "3.0", "4.0", "5.0", "6.0", "1-2")
    )
    parsed = parse_win_odds(html)
    assert parsed["final"] is True
    assert parsed["odds"][2] is None


def test_select_window_final_and_recent():
    now = datetime.fromisoformat("2026-10-09T18:00:00+09:00")
    races = [
        {"id": "due", "post_time": "2026-10-09T18:20:00+09:00"},
        {"id": "late", "post_time": "2026-10-09T18:26:00+09:00"},
        {"id": "past", "post_time": "2026-10-09T17:59:00+09:00"},
        {"id": "final", "post_time": "2026-10-09T18:10:00+09:00"},
        {"id": "recent", "post_time": "2026-10-09T18:10:00+09:00"},
    ]
    snapshots = [
        {"race_id": "final", "bet_type": "win", "source": "boatrace-odds-tf-final", "captured_at": now.isoformat()},
        {"race_id": "recent", "bet_type": "win", "source": "boatrace-odds-tf", "captured_at": "2026-10-09T17:55:00+09:00"},
    ]
    assert [r["id"] for r in select_odds_targets(races, snapshots, now)] == ["due"]


def test_disabled_flag_creates_skipped_run_without_fetch(monkeypatch, tmp_path):
    from edgelab import live
    import edgelab.cli
    monkeypatch.delenv("ENABLE_BOATRACE_ODDS_SCRAPE", raising=False)
    monkeypatch.setattr(live, "load_rows", lambda: {k: [] for k in
        ("races", "entries", "odds_snapshots", "predictions", "collection_runs", "models")})
    saved = {}
    monkeypatch.setattr(live, "save_rows", lambda rows: saved.update(rows))
    monkeypatch.setattr(edgelab.cli, "collect_boat", lambda *a, **kw: None)
    result = run_live("2026-10-09", now="2026-10-09T18:00:00+09:00")
    assert result["status"] == "skipped"
    assert saved["collection_runs"][0]["reason"] == DISABLED_REASON


def test_live_syncs_only_delta(monkeypatch):
    from edgelab import live
    monkeypatch.setenv("ENABLE_BOATRACE_ODDS_SCRAPE", "true")
    monkeypatch.delenv("EDGELAB_API_URL", raising=False)
    base = {k: [] for k in ("races", "entries", "odds_snapshots", "predictions", "collection_runs", "models")}
    base["races"] = [{"id": "r1", "sport": "boat", "race_date": "2026-10-09", "post_time": "2026-10-09T18:10:00+09:00"}]
    monkeypatch.setattr(live, "load_rows", lambda: {k: list(v) for k, v in base.items()})
    monkeypatch.setattr(live, "save_rows", lambda rows: None)
    monkeypatch.setattr(live, "merge_rows", lambda store, delta: None)
    monkeypatch.setattr(live, "collect_boat", lambda *a, **kw: None, raising=False)
    import edgelab.cli
    monkeypatch.setattr(edgelab.cli, "collect_boat", lambda *a, **kw: None)
    monkeypatch.setattr(live, "select_odds_targets", lambda *a, **kw: [])
    seen = []
    monkeypatch.setenv("EDGELAB_API_URL", "https://example.invalid")
    monkeypatch.setattr("edgelab.sync.sync_rows", lambda rows: seen.append(rows))
    run_live("2026-10-09", now="2026-10-09T18:00:00+09:00")
    assert len(seen) == 1
    assert seen[0]["races"] == base["races"]
    assert seen[0]["odds_snapshots"] == []
    assert set(seen[0]) == {"races", "entries", "odds_snapshots", "predictions", "collection_runs"}
