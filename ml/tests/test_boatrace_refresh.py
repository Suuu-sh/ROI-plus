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
    with pytest.raises(ValueError, match="invalid K content"):
        boatrace.fetch_boatrace_file("K", date(2026, 10, 9), cache_dir=cache, refresh=True,
                                     validator=lambda content: (_ for _ in ()).throw(ValueError("invalid K content")))
    assert target.read_bytes() == b"new-valid"
    monkeypatch.setattr(boatrace, "urlopen", lambda request, **kwargs: (_ for _ in ()).throw(
        HTTPError(request.full_url, 404, "not found", {}, None)))
    unavailable = boatrace.fetch_boatrace_file("K", date(2026, 10, 9), cache_dir=cache, refresh=True)
    assert unavailable is None
    assert target.read_bytes() == b"new-valid"


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
