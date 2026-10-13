import hashlib
import json
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError, URLError

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

    disabled = {
        "date": "2026-10-11", "enabled": False, "limit": 0,
        "essentialLimit": 0, "optionalLimit": 0, "oddsLimit": 0,
        "allowance": None, "reserved": None, "essentialReserved": None,
        "optionalReserved": None, "oddsReserved": None, "collectionReserved": None,
        "collectionRemaining": None, "remaining": None,
        "essentialRemaining": None, "optionalRemaining": None, "state": "disabled",
    }
    monkeypatch.setattr(sync, "urlopen", lambda *_args, **_kwargs: _Response(disabled))
    assert sync.fetch_write_budget(base_url="https://example.test", token="t")["state"] == "disabled"

    for bad in (
        {"date": "2026-2-3", "limit": 20_000, "reserved": 10, "remaining": 19_990, "state": "known"},
        {"date": "2026-10-11", "limit": 20_000, "reserved": None, "remaining": None, "state": "known"},
        {"date": "2026-10-11", "limit": 20_000, "reserved": 10, "remaining": 19_000, "state": "known"},
        {**disabled, "enabled": True},
        {**disabled, "remaining": 1},
    ):
        monkeypatch.setattr(sync, "urlopen", lambda *_args, _payload=bad, **_kwargs: _Response(_payload))
        with pytest.raises(RuntimeError):
            sync.fetch_write_budget(base_url="https://example.test", token="t")


def test_fetch_open_bet_race_ids_validates_narrow_contract_and_fails_closed(monkeypatch):
    requests = []
    def accept(req, **_kwargs):
        requests.append(req)
        return _Response({"date": "2026-10-11", "raceIds": ["boat-20261011-01-01"]})
    monkeypatch.setattr(sync, "urlopen", accept)
    assert sync.fetch_open_bet_race_ids("2026-10-11", base_url="https://example.test", token="t") == {"boat-20261011-01-01"}
    assert requests[0].full_url == "https://example.test/api/ingest/open-bet-race-ids?date=2026-10-11"
    assert requests[0].get_header("Authorization") == "Bearer t"

    for bad in (
        {"date": "2026-10-10", "raceIds": []},
        {"date": "2026-10-11", "raceIds": ["boat-20261011-01-01", "boat-20261011-01-01"]},
        {"date": "2026-10-11", "raceIds": ["not-a-boat-race"]},
        {"date": "2026-10-11", "raceIds": ["boat-" + "x" * 70]},
        {"date": "2026-10-11", "raceIds": ["boat-20261011-01-01"] * 501},
    ):
        monkeypatch.setattr(sync, "urlopen", lambda *_args, _payload=bad, **_kwargs: _Response(_payload))
        with pytest.raises(RuntimeError, match="response is invalid"):
            sync.fetch_open_bet_race_ids("2026-10-11", base_url="https://example.test", token="t")

    def refused(req, **_kwargs):
        raise HTTPError(req.full_url, 503, "unavailable", {}, BytesIO(b"private body"))
    monkeypatch.setattr(sync, "urlopen", refused)
    with pytest.raises(RuntimeError, match="HTTP 503") as exc:
        sync.fetch_open_bet_race_ids("2026-10-11", base_url="https://example.test", token="t")
    assert "private body" not in str(exc.value)


def test_ingest_noop_is_explicit_not_reported_as_changed(monkeypatch):
    monkeypatch.setattr(sync, "urlopen", lambda *_args, **_kwargs: _Response({"upserted": 3, "changed": 0}))
    result = sync.sync_rows({"races": [{"id": "r1"}]}, base_url="https://example.test", token="t")
    assert result["races"]["noop"] is True
    assert result["races"]["changed"] == 0


def test_budget_refusal_stops_without_retry_or_fake_success(monkeypatch):
    for code in ("d1_write_budget_unavailable", "d1_write_budget_exhausted"):
        requests = []

        def refused(req, **_kwargs):
            requests.append(req)
            body = json.dumps({"code": code}).encode()
            raise HTTPError(req.full_url, 429, "Too Many Requests", {}, BytesIO(body))

        monkeypatch.setattr(sync, "urlopen", refused)
        with pytest.raises(sync.WriteBudgetRefused) as refusal:
            sync.sync_rows({"races": [{"id": "r1"}], "entries": [{"id": "e1"}]},
                           base_url="https://example.test", token="t")
        assert len(requests) == 1
        assert refusal.value.table == "races"
        assert refusal.value.completed_chunks == []
        assert (refusal.value.chunk, refusal.value.total_chunks) == (1, 1)


def test_unknown_or_plain_text_429_is_not_a_budget_refusal(monkeypatch):
    body = {"value": b"upstream rate limit"}
    requests = []

    def refused(req, **_kwargs):
        requests.append(req)
        raise HTTPError(req.full_url, 429, "Too Many Requests", {}, BytesIO(body["value"]))

    monkeypatch.setattr(sync, "urlopen", refused)
    for payload in (b"upstream rate limit", b'{"code":"unknown_rate_limit"}'):
        body["value"] = payload
        requests.clear()
        with pytest.raises(RuntimeError, match="HTTP 429") as refusal:
            sync.sync_rows({"prerace_observations": [{"id": "observation"}]},
                           base_url="https://example.test", token="t")
        assert "write budget" not in str(refusal.value)
        assert len(requests) == 1


def test_forbidden_ingest_remains_fail_closed(monkeypatch):
    requests = []

    def forbidden(req, **_kwargs):
        requests.append(req)
        raise HTTPError(req.full_url, 403, "Forbidden", {}, None)

    monkeypatch.setattr(sync, "urlopen", forbidden)
    with pytest.raises(RuntimeError, match="HTTP 403"):
        sync.sync_rows({"prerace_observations": [{"id": "observation"}]},
                       base_url="https://example.test", token="t")
    assert len(requests) == 1


def test_budget_refusal_exposes_prior_successful_chunks_without_retry(monkeypatch):
    requests = []

    def one_chunk_then_refuse(req, **_kwargs):
        requests.append(req.data)
        if len(requests) == 1:
            return _Response({"upserted": 50, "changed": 50})
        body = json.dumps({"code": "d1_write_budget_exhausted"}).encode()
        raise HTTPError(req.full_url, 429, "Too Many Requests", {}, BytesIO(body))

    monkeypatch.setattr(sync, "urlopen", one_chunk_then_refuse)
    with pytest.raises(sync.WriteBudgetRefused) as refused:
        sync.sync_rows({"prerace_observations": [{"id": f"o{i}"} for i in range(56)]},
                       base_url="https://example.test", token="t")
    assert len(requests) == 2
    assert refused.value.table == "prerace_observations"
    assert refused.value.completed_chunks == [
        {"status": 200, "upserted": 50, "changed": 50, "noop": False},
    ]
    assert (refused.value.chunk, refused.value.total_chunks) == (2, 2)


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
    "odds_snapshots", "predictions", "ticket_predictions",
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


@pytest.mark.parametrize("table", ["races", "results", "payouts", "entries"])
def test_sequential_lookup_ingests_use_smaller_chunks(monkeypatch, table):
    payload_sizes = []

    def accept(req, **_kwargs):
        size = len(json.loads(req.data))
        payload_sizes.append(size)
        return _Response({"upserted": size, "changed": size})

    monkeypatch.setattr(sync, "urlopen", accept)
    result = sync.sync_rows({table: [{"id": f"row{i}"} for i in range(23)]},
                            base_url="https://example.test", token="t")
    assert payload_sizes == [10, 10, 3]
    assert sum(payload_sizes) == 23
    assert len(result[table]) == 3
    diagnostics = result["_ingest_diagnostics"]
    assert [item["row_count"] for item in diagnostics] == [10, 10, 3]
    assert [item["chunk_index"] for item in diagnostics] == [1, 2, 3]
    assert all(item["chunk_count"] == 3 and item["attempt_count"] == 1
               and len(item["attempt_ids"]) == 1 for item in diagnostics)
    assert all(len(item["payload_sha256"]) == 64 for item in diagnostics)
    assert all(item["table"] == table for item in diagnostics)
    assert "race_id" not in json.dumps(diagnostics)


def test_dry_run_results_outbox_uses_live_ten_row_chunk_size(tmp_path):
    rows = [{"id": f"result-{index}"} for index in range(23)]
    result = sync.sync_rows({"results": rows}, dry_run=True, output_dir=tmp_path)
    chunks = [json.loads(Path(path).read_text(encoding="utf-8")) for path in result["files"]]
    assert [len(chunk) for chunk in chunks] == [10, 10, 3]
    assert [row["id"] for chunk in chunks for row in chunk] == [row["id"] for row in rows]


def test_ingest_retries_timeout_after_commit_with_same_idempotent_results_chunk(monkeypatch):
    requests = []
    committed = {}

    def timeout_after_commit(req, **_kwargs):
        payload = json.loads(req.data)
        requests.append(req)
        changed = 0
        for row in payload:
            natural_key = (row["race_id"], row["number"])
            if natural_key not in committed:
                committed[natural_key] = row
                changed += 1
        if len(requests) == 1:
            raise TimeoutError("response lost after commit")
        return _Response({"upserted": len(payload), "changed": changed})

    row = {"race_id": "boat-20261013-01-01", "number": 1,
           "finish_order": 1, "data_origin": "real"}
    monkeypatch.setattr(sync, "urlopen", timeout_after_commit)
    monkeypatch.setattr(sync.time, "sleep", lambda _seconds: None)
    result = sync.sync_rows({"results": [row]},
                            base_url="https://example.test", token="t")

    assert len(requests) == 2
    assert requests[0].data == requests[1].data
    assert len(committed) == 1
    assert result["results"] == {"status": 200, "upserted": 1, "changed": 0, "noop": True}
    diagnostic = result["_ingest_diagnostics"][0]
    assert diagnostic["attempt_count"] == 2
    assert len(diagnostic["attempt_ids"]) == 2
    assert diagnostic["attempt_ids"][0] != diagnostic["attempt_ids"][1]
    assert diagnostic["chunk_id"] in diagnostic["attempt_ids"][0]
    assert diagnostic["row_count"] == 1
    assert diagnostic["payload_sha256"] == hashlib.sha256(requests[0].data).hexdigest()
    assert row["race_id"] not in json.dumps(diagnostic)


def test_timeout_failure_includes_safe_chunk_and_attempt_diagnostics(monkeypatch):
    requests = []
    row = {"race_id": "boat-private-payload", "number": 1,
           "finish_order": 1, "data_origin": "real"}

    def timeout(req, **_kwargs):
        requests.append(req)
        raise TimeoutError("response timed out")

    monkeypatch.setattr(sync, "urlopen", timeout)
    monkeypatch.setattr(sync.time, "sleep", lambda _seconds: None)
    with pytest.raises(RuntimeError, match="ingest results failed") as error:
        sync.sync_rows({"results": [row]}, base_url="https://example.test", token="t")

    message = str(error.value)
    assert len(requests) == 2
    assert requests[0].data == requests[1].data
    assert "chunk_id=" in message and "attempt_id=" in message
    assert "attempt=2/2" in message and "chunk=1/1" in message
    assert "attempt_ids=" in message and "row_count=1" in message
    assert "payload_sha256=" in message
    assert row["race_id"] not in message and "finish_order" not in message


def test_ingest_does_not_retry_non_timeout_or_repeat_timeout(monkeypatch):
    requests = []

    def refused(req, **_kwargs):
        requests.append(req)
        raise URLError("connection refused")

    monkeypatch.setattr(sync, "urlopen", refused)
    with pytest.raises(RuntimeError, match="ingest races failed"):
        sync.sync_rows({"races": [{"id": "race"}]},
                       base_url="https://example.test", token="t")
    assert len(requests) == 1

    requests.clear()

    def repeated_timeout(req, **_kwargs):
        requests.append(req)
        raise TimeoutError("timeout")

    monkeypatch.setattr(sync, "urlopen", repeated_timeout)
    monkeypatch.setattr(sync.time, "sleep", lambda _seconds: None)
    with pytest.raises(RuntimeError, match="ingest races failed"):
        sync.sync_rows({"races": [{"id": "race"}]},
                       base_url="https://example.test", token="t")
    assert len(requests) == 2


@pytest.mark.parametrize("status", [500, 503])
def test_ingest_retries_one_transient_worker_5xx_but_keeps_429_fail_closed(monkeypatch, status):
    requests = []

    def unavailable_then_accept(req, **_kwargs):
        requests.append(req.data)
        if len(requests) == 1:
            raise HTTPError(req.full_url, status, "Worker Error", {}, None)
        return _Response({"upserted": 1, "changed": 0})

    monkeypatch.setattr(sync, "urlopen", unavailable_then_accept)
    monkeypatch.setattr(sync.time, "sleep", lambda _seconds: None)
    result = sync.sync_rows({"payouts": [{"id": "payout"}]},
                            base_url="https://example.test", token="t")
    assert len(requests) == 2
    assert requests[0] == requests[1]
    assert result["payouts"]["noop"] is True

    requests.clear()

    def repeated_unavailable(req, **_kwargs):
        requests.append(req.data)
        raise HTTPError(req.full_url, status, "Worker Error", {}, None)

    monkeypatch.setattr(sync, "urlopen", repeated_unavailable)
    with pytest.raises(RuntimeError, match=f"HTTP {status}"):
        sync.sync_rows({"payouts": [{"id": "payout"}]},
                       base_url="https://example.test", token="t")
    assert len(requests) == 2


def test_ingest_error_diagnostic_includes_only_whitelisted_api_code(monkeypatch):
    def refused(req, **_kwargs):
        body = json.dumps({"code": "d1_write_budget_exhausted", "error": "private detail must not escape"}).encode()
        raise HTTPError(req.full_url, 409, "Conflict", {}, BytesIO(body))

    monkeypatch.setattr(sync, "urlopen", refused)
    with pytest.raises(RuntimeError, match=r"HTTP 409 \(code: d1_write_budget_exhausted\)") as exc:
        sync.sync_rows({"entries": [{"id": "entry"}]}, base_url="https://example.test", token="t")
    assert "private detail" not in str(exc.value)


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
