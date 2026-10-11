import json
from urllib.error import HTTPError

import pytest

from edgelab import sync


class _Response:
    status = 200

    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self):
        return json.dumps(self.payload).encode()


def test_fetch_write_budget_validates_authoritative_contract(monkeypatch):
    monkeypatch.setattr(sync, "urlopen", lambda *_args, **_kwargs: _Response({
        "date": "2026-10-11", "limit": 20_000, "reserved": 12_000,
        "remaining": 8_000, "state": "known"}))
    assert sync.fetch_write_budget(base_url="https://example.test", token="t")["remaining"] == 8_000

    monkeypatch.setattr(sync, "urlopen", lambda *_args, **_kwargs: _Response({
        "date": "2026-10-11", "limit": 20_000, "reserved": None,
        "remaining": None, "state": "missing"}))
    assert sync.fetch_write_budget(base_url="https://example.test", token="t")["state"] == "missing"

    for bad in (
        {"date": "2026-2-3", "limit": 20_000, "reserved": 10, "remaining": 19_990, "state": "known"},
        {"date": "2026-10-11", "limit": 20_000, "reserved": None, "remaining": None, "state": "known"},
        {"date": "2026-10-11", "limit": 20_000, "reserved": 10, "remaining": 19_000, "state": "known"},
    ):
        monkeypatch.setattr(sync, "urlopen", lambda *_args, _payload=bad, **_kwargs: _Response(_payload))
        with pytest.raises(RuntimeError):
            sync.fetch_write_budget(base_url="https://example.test", token="t")


def test_ingest_noop_is_explicit_not_reported_as_changed(monkeypatch):
    monkeypatch.setattr(sync, "urlopen", lambda *_args, **_kwargs: _Response({"upserted": 3, "changed": 0}))
    result = sync.sync_rows({"races": [{"id": "r1"}]}, base_url="https://example.test", token="t")
    assert result["races"]["noop"] is True
    assert result["races"]["changed"] == 0


def test_budget_refusal_stops_without_retry_or_fake_success(monkeypatch):
    requests = []

    def refused(req, **_kwargs):
        requests.append(req)
        raise HTTPError(req.full_url, 429, "Too Many Requests", {}, None)

    monkeypatch.setattr(sync, "urlopen", refused)
    with pytest.raises(sync.WriteBudgetRefused):
        sync.sync_rows({"races": [{"id": "r1"}], "entries": [{"id": "e1"}]},
                       base_url="https://example.test", token="t")
    assert len(requests) == 1


def test_sync_prioritizes_parent_rows_then_results_and_payouts_before_entries(monkeypatch):
    sent = []

    def accept(req, **_kwargs):
        sent.append(req.full_url.rsplit("/", 1)[-1])
        return _Response({"upserted": 1, "changed": 1})

    monkeypatch.setattr(sync, "urlopen", accept)
    sync.sync_rows({
        "entries": [{"id": "e"}], "predictions": [{"id": "p"}], "models": [{"id": "m"}],
        "payouts": [{"id": "pay"}], "results": [{"id": "r"}], "races": [{"id": "race"}],
        "venues": [{"id": "venue"}],
    }, base_url="https://example.test", token="t")
    assert sent == ["venues", "races", "models", "results", "payouts", "entries", "predictions"]


@pytest.mark.parametrize("table", [
    "races", "results", "payouts", "entries", "odds_snapshots", "predictions", "ticket_predictions",
])
def test_race_related_ingests_chunk_at_50_rows(monkeypatch, table):
    payload_sizes = []

    def accept(req, **_kwargs):
        size = len(json.loads(req.data))
        payload_sizes.append(size)
        return _Response({"upserted": size, "changed": size})

    monkeypatch.setattr(sync, "urlopen", accept)
    result = sync.sync_rows({table: [{"id": f"row{i}"} for i in range(123)]},
                            base_url="https://example.test", token="t")
    assert payload_sizes == [50, 50, 23]
    assert sum(payload_sizes) == 123
    assert len(result[table]) == 3


@pytest.mark.parametrize("table", ["venues", "models", "collection_runs"])
def test_metadata_ingests_keep_500_row_chunk(monkeypatch, table):
    payload_sizes = []

    def accept(req, **_kwargs):
        size = len(json.loads(req.data))
        payload_sizes.append(size)
        return _Response({"upserted": size, "changed": size})

    monkeypatch.setattr(sync, "urlopen", accept)
    result = sync.sync_rows({table: [{"id": f"row{i}"} for i in range(123)]},
                            base_url="https://example.test", token="t")
    assert payload_sizes == [123]
    assert result[table]["upserted"] == 123
