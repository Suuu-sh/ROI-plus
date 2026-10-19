from __future__ import annotations

from datetime import date
from pathlib import Path
from urllib.error import HTTPError

import pytest

from edgelab import cli
from edgelab.collectors import boatrace


class _Response:
    status = 200

    def __init__(self, payload: bytes):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self):
        return self.payload


def test_refresh_replaces_valid_cache_but_unavailable_refresh_preserves_previous_bytes(tmp_path, monkeypatch):
    cache = tmp_path / "boatrace"
    cache.mkdir()
    target = cache / "k261009.lzh"
    target.write_bytes(b"old-valid")
    monkeypatch.setattr(boatrace, "read_lzh", lambda path: "valid K contents")
    monkeypatch.setattr(boatrace, "urlopen", lambda *args, **kwargs: _Response(b"new-valid"))

    refreshed = boatrace.fetch_boatrace_file("K", date(2026, 10, 9), cache_dir=cache, refresh=True)

    assert refreshed == target
    assert target.read_bytes() == b"new-valid"
    source = boatrace.read_source_file_metadata(target, "K", date(2026, 10, 9))
    assert source["sourceSha256"]
    assert source["targetDate"] == "2026-10-09"
    assert boatrace.read_source_file_metadata(target, "B", date(2026, 10, 9)) is None
    with pytest.raises(ValueError, match="invalid K content"):
        boatrace.fetch_boatrace_file("K", date(2026, 10, 9), cache_dir=cache, refresh=True,
                                     validator=lambda content: (_ for _ in ()).throw(ValueError("invalid K content")))
    assert target.read_bytes() == b"new-valid"
    monkeypatch.setattr(boatrace, "urlopen", lambda request, **kwargs: (_ for _ in ()).throw(
        HTTPError(request.full_url, 404, "not found", {}, None)))
    unavailable = boatrace.fetch_boatrace_file("K", date(2026, 10, 9), cache_dir=cache, refresh=True)
    assert unavailable is None
    assert target.read_bytes() == b"new-valid"


def test_cached_file_without_sidecar_does_not_gain_synthetic_arrival_metadata(tmp_path):
    target = tmp_path / "b261009.lzh"
    target.write_bytes(b"old-cache-only")
    assert boatrace.read_source_file_metadata(target, "B", date(2026, 10, 9)) is None


def test_daily_forced_k_refresh_consumes_request_budget_even_when_cached(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    cache = Path("data/raw/boatrace")
    cache.mkdir(parents=True)
    stale_k = cache / "k261009.lzh"
    stale_k.write_bytes(b"stale K")
    store = {key: [] for key in ("races", "entries", "results", "payouts", "odds_snapshots",
                                  "predictions", "models", "collection_runs")}
    fetch_calls = []
    monkeypatch.setattr(cli, "load_rows", lambda: store)
    monkeypatch.setattr(cli, "save_rows", lambda value: None)
    monkeypatch.setattr(boatrace, "fetch_boatrace_file", lambda kind, day, **kwargs:
                        fetch_calls.append((kind, kwargs.get("refresh"))) or Path("downloaded"))
    monkeypatch.setattr(boatrace, "read_lzh", lambda path: "fixture text")
    monkeypatch.setattr("edgelab.parsers.boatrace_b.parse_b", lambda content, race_date: {
        "races": [{"id": "boat-20261009-01-01", "sport": "boat", "race_date": race_date,
                   "status": "finished", "data_origin": "real"}]})
    monkeypatch.setattr("edgelab.parsers.boatrace_k.parse_k", lambda content, race_date: {})

    cli.collect_boat("2026-10-09", "2026-10-09", max_requests=1,
                     refresh_k_dates={"2026-10-09"})

    assert fetch_calls == [("B", False)]  # Cached K would require a second request and is not falsely fresh.
    run = store["collection_runs"][-1]
    assert run["status"] == "partial"
    assert "K refresh skipped" in run["error"]


def test_collect_boat_propagates_only_verified_b_file_arrival_metadata(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    store = {key: [] for key in ("races", "entries", "results", "payouts", "odds_snapshots",
                                  "predictions", "models", "collection_runs")}
    monkeypatch.setattr(cli, "load_rows", lambda: store)
    monkeypatch.setattr(cli, "save_rows", lambda value: None)
    monkeypatch.setattr(boatrace, "fetch_boatrace_file", lambda kind, day, **kwargs: Path(f"{kind}.lzh"))
    monkeypatch.setattr(boatrace, "read_lzh", lambda path: "fixture text")
    monkeypatch.setattr(boatrace, "read_source_file_metadata", lambda path, kind, day: {
        "fetchedAt": "2026-10-09T06:00:00+00:00", "sourceSha256": "a" * 64,
        "sourceUrl": "https://www1.mbrace.or.jp/od2/B/202610/b261009.lzh"} if kind == "B" else None)
    monkeypatch.setattr("edgelab.parsers.boatrace_b.parse_b", lambda content, race_date: {
        "races": [{"id": "boat-20261009-01-01", "sport": "boat", "race_date": race_date,
                   "status": "scheduled", "data_origin": "real"}],
        "entries": [{"race_id": "boat-20261009-01-01", "number": 1, "data_origin": "real"}],
    })
    monkeypatch.setattr("edgelab.parsers.boatrace_k.parse_k", lambda content, race_date: {})

    cli.collect_boat("2026-10-09", "2026-10-09")

    assert store["entries"][0]["available_at"] == "2026-10-09T06:00:00+00:00"
    assert store["entries"][0]["source_available_at"] == "2026-10-09T06:00:00+00:00"
    assert store["entries"][0]["source_sha256"] == "a" * 64


@pytest.mark.parametrize(
    ("target_date", "now", "verified_b", "b_has_cutoff", "k_content", "k_mode", "pending"),
    [
        ("2026-10-13", "2026-10-13T00:00:00+00:00", True, True,
         "2026年10月13日\n", "empty", True),
        ("2026-10-13", "2026-10-13T01:30:00+00:00", True, True,
         "2026年10月13日\n", "empty", False),
        ("2026-10-12", "2026-10-13T00:00:00+00:00", True, True,
         "2026年10月12日\n", "empty", False),
        ("2026-10-13", "2026-10-13T00:00:00+00:00", False, True,
         "2026年10月13日\n", "empty", False),
        ("2026-10-13", "2026-10-13T00:00:00+00:00", True, False,
         "2026年10月13日\n", "empty", False),
        ("2026-10-13", "2026-10-13T00:00:00+00:00", True, True,
         "2026年10月13日\n", "entry", False),
        ("2026-10-13", "2026-10-13T00:00:00+00:00", True, True,
         "2026年10月13日\n", "payout", False),
        ("2026-10-13", "2026-10-13T00:00:00+00:00", True, True,
         "unlinked partial result", "partial", False),
        ("2026-10-13", "2026-10-13T00:00:00+00:00", True, True,
         "2026年10月12日\n", "empty", False),
        ("2026-10-13", "2026-10-13T00:00:00+00:00", True, True,
         "malformed K source", "empty", False),
    ],
)
def test_empty_k_results_are_pending_only_before_verified_same_day_first_cutoff(
        tmp_path, monkeypatch, target_date, now, verified_b, b_has_cutoff, k_content, k_mode, pending):
    monkeypatch.chdir(tmp_path)
    cache = Path("data/raw/boatrace")
    cache.mkdir(parents=True)
    day = date.fromisoformat(target_date)
    b_path = cache / f"b{day:%y%m%d}.lzh"
    k_path = cache / f"k{day:%y%m%d}.lzh"
    b_path.write_bytes(b"cached B")
    k_path.write_bytes(b"old K cache")
    store = {key: [] for key in ("races", "entries", "results", "payouts", "odds_snapshots",
                                  "predictions", "models", "collection_runs")}
    monkeypatch.setattr(cli, "load_rows", lambda: store)
    monkeypatch.setattr(cli, "save_rows", lambda _value: None)
    monkeypatch.setattr(cli, "_now", lambda: now)
    monkeypatch.setattr(boatrace, "read_lzh", lambda path:
                        "B schedule" if Path(path).name.startswith("b") else k_content)
    monkeypatch.setattr(boatrace, "read_source_file_metadata", lambda _path, kind, _day:
                        {"fetchedAt": f"{target_date}T00:00:00+00:00",
                         "targetDate": target_date, "sourceSha256": "a" * 64}
                        if kind == "B" and verified_b else None)

    def fetch(kind, _day, **kwargs):
        if kind == "K" and kwargs.get("refresh"):
            kwargs["validator"](k_content)
        return b_path if kind == "B" else k_path

    monkeypatch.setattr(boatrace, "fetch_boatrace_file", fetch)
    race_id = f"boat-{target_date.replace('-', '')}-01-01"
    monkeypatch.setattr("edgelab.parsers.boatrace_b.parse_b",
                        lambda _content, race_date: {"races": [{
                            "id": race_id, "sport": "boat", "race_date": race_date,
                            "post_time": (f"{race_date}T10:30:00+09:00" if b_has_cutoff else None),
                            "status": "scheduled", "data_origin": "real"}],
                            "entries": []})

    def parse_k(_content, race_date):
        results = ([{"race_id": "unlinked-race", "finish_order": 1, "data_origin": "real"}]
                   if k_mode == "partial" else [])
        entries = ([{"race_id": "unlinked-race", "number": 1,
                     "features_json": '{"finish_code":"F"}'}]
                   if k_mode == "entry" else [])
        payouts = ([{"race_id": "unlinked-race", "bet_type": "win",
                     "selection": "1", "payout": 120, "data_origin": "real"}]
                   if k_mode == "payout" else [])
        return {"races": [], "entries": entries, "results": results, "payouts": payouts}

    monkeypatch.setattr("edgelab.parsers.boatrace_k.parse_k", parse_k)

    cli.collect_boat(target_date, target_date, refresh_k_dates={target_date})

    run = store["collection_runs"][-1]
    assert run["status"] == "partial"
    assert k_path.read_bytes() == b"old K cache"
    assert store["results"] == []
    assert store["payouts"] == []
    if pending:
        assert run["reason"] == cli.EXPECTED_PENDING_K_RESULTS_REASON
        assert run["error"] is None
    else:
        assert run["reason"] is None
        assert "no valid same-day race results" in run["error"]



def test_same_day_k_payout_without_results_is_not_pending(tmp_path, monkeypatch):
    from edgelab.parsers.boatrace_k import parse_k

    monkeypatch.chdir(tmp_path)
    target_date = "2026-10-13"
    k_content = "2026年10月13日\n01KBGN\n1R\n単勝 1 120\n"
    parsed = parse_k(k_content)
    assert len(parsed["races"]) == 1
    assert parsed["results"] == []
    assert len(parsed["payouts"]) == 1

    cache = Path("data/raw/boatrace")
    cache.mkdir(parents=True)
    b_path = cache / "b261013.lzh"
    k_path = cache / "k261013.lzh"
    b_path.write_bytes(b"cached B")
    k_path.write_bytes(b"old K cache")
    store = {key: [] for key in ("races", "entries", "results", "payouts", "odds_snapshots",
                                  "predictions", "models", "collection_runs")}
    monkeypatch.setattr(cli, "load_rows", lambda: store)
    monkeypatch.setattr(cli, "save_rows", lambda _value: None)
    monkeypatch.setattr(cli, "_now", lambda: "2026-10-13T00:00:00+00:00")
    monkeypatch.setattr(boatrace, "read_lzh", lambda path:
                        "B schedule" if Path(path).name.startswith("b") else k_content)
    monkeypatch.setattr(boatrace, "read_source_file_metadata", lambda _path, kind, _day:
                        {"fetchedAt": "2026-10-13T00:00:00+00:00",
                         "targetDate": target_date, "sourceSha256": "a" * 64}
                        if kind == "B" else None)

    def fetch(kind, _day, **kwargs):
        if kind == "K" and kwargs.get("refresh"):
            kwargs["validator"](k_content)
        return b_path if kind == "B" else k_path

    monkeypatch.setattr(boatrace, "fetch_boatrace_file", fetch)
    monkeypatch.setattr("edgelab.parsers.boatrace_b.parse_b",
                        lambda _content, race_date: {"races": [{
                            "id": "boat-20261013-01-01", "sport": "boat", "race_date": race_date,
                            "post_time": "2026-10-13T10:30:00+09:00",
                            "status": "scheduled", "data_origin": "real"}],
                            "entries": []})

    cli.collect_boat(target_date, target_date, refresh_k_dates={target_date})

    run = store["collection_runs"][-1]
    assert run["status"] == "partial"
    assert run["reason"] is None
    assert "no valid same-day race results" in run["error"]
    assert k_path.read_bytes() == b"old K cache"
    assert store["results"] == []
    assert store["payouts"] == []
