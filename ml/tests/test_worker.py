from __future__ import annotations

import asyncio
import importlib
import json
import hashlib
import sys
from types import SimpleNamespace

import pytest

from src.worker import (MAX_RACES, _result_proof, _raise_stage_failure, handle_learning, handle_normal_learning,
                        load_training_store, persist_candidate_artifacts, _internal_error_response,
                        _safe_failure_diagnostic,
                        _log_safe_failure)


class _Statement:
    def __init__(self, db, sql):
        self.db, self.sql, self.args = db, sql, ()

    def bind(self, *args):
        self.args = args
        return self

    async def all(self):
        self.db.bind_counts.append(len(self.args))
        if self.db.overflow and self.sql.lstrip().startswith("SELECT r.id"):
            return SimpleNamespace(results=[{"id": f"boat-20261015-01-{i % 12 + 1:02d}",
                "race_date": "2026-10-15", "venue_id": "01", "race_no": i % 12 + 1,
                "result_proof": "{}"} for i in range(MAX_RACES + 1)])
        return SimpleNamespace(results=[])

    async def run(self):
        self.db.writes.append((self.sql, self.args))
        return SimpleNamespace(meta=SimpleNamespace(changes=1))


class _DB:
    def __init__(self, overflow=False):
        self.overflow = overflow
        self.bind_counts = []
        self.writes = []

    def prepare(self, sql):
        return _Statement(self, sql)


class _Bucket:
    def __init__(self):
        self.objects = {}

    async def put(self, key, value):
        self.objects[key] = value


def test_bounded_reader_returns_empty_store_without_untrusted_data():
    db = _DB()
    store, counts = asyncio.run(load_training_store(db))
    assert counts == {"candidateRaces": 0, "archives": 0, "labels": 0,
                      "truncatedCandidates": 0, "requestedWindowDays": 120,
                      "selectedFrom": None, "selectedTo": None}
    assert all(not rows for rows in store.values())
    assert db.bind_counts == [3]


def test_reader_records_bounded_recent_candidate_truncation():
    _, counts = asyncio.run(load_training_store(_DB(overflow=True)))
    assert counts["candidateRaces"] == MAX_RACES
    assert counts["truncatedCandidates"] == 1
    assert counts["selectedFrom"] is not None


def test_result_proof_requires_official_url_hash_and_quality():
    proof = {"quality": "verified-official-outcome-v2",
             "url": "https://www.boatrace.jp/owpc/pc/race/raceresult?rno=3&jcd=11&hd=20261015",
             "sha256": "a" * 64, "fetchedAt": "2026-10-15T03:00:00Z"}
    assert _result_proof({"reason": json.dumps(proof)}) == proof
    for key, value in (("quality", "unverified"), ("sha256", "not-a-hash"),
                       ("url", "https://example.invalid/result")):
        changed = {**proof, key: value}
        assert _result_proof({"reason": json.dumps(changed)}) is None


def test_learning_requires_confirmed_current_jst_date_before_db_access():
    result = asyncio.run(handle_learning(None, None, {"date": "2000-01-01", "confirmed": True}))
    assert result == {"status": "rejected", "reason": "request_confirmation_invalid"}


def test_json_response_uses_workers_sdk_constructor_signature(monkeypatch):
    calls = []

    class Response:
        def __init__(self, body=None, status=None, status_text="", headers=None):
            calls.append((body, status, status_text, headers))

    monkeypatch.setitem(sys.modules, "workers", SimpleNamespace(Response=Response))
    worker = importlib.import_module("src.worker")
    response = worker._json_response({"status": "rejected"}, 422)
    assert isinstance(response, Response)
    body, status, status_text, headers = calls[0]
    assert json.loads(body) == {"status": "rejected"}
    assert status == 422 and status_text == ""
    assert headers["content-type"] == "application/json; charset=utf-8"
    response = worker._internal_error_response("fit", RuntimeError("do not expose this"))
    body, status, _, _ = calls[-1]
    assert isinstance(response, Response) and status == 503
    assert json.loads(body) == {
        "status": "failed", "reason": "learner_internal_error",
        "diagnostic": {"stage": "fit", "errorClass": "RuntimeError"}}
    assert "do not expose" not in body


def test_safe_worker_failure_log_contains_only_fixed_stage_and_exception_class(capsys):
    _log_safe_failure("experimental-learn", RuntimeError("private SQL and object key"))
    line = capsys.readouterr().out.strip()
    assert json.loads(line) == {"event": "learner_failure", "stage": "experimental-learn",
                                "errorClass": "RuntimeError"}
    assert "private" not in line and "object key" not in line
    _log_safe_failure("unknown-request-path", type("OddFailure", (Exception,), {})())
    assert json.loads(capsys.readouterr().out.strip()) == {
        "event": "learner_failure", "stage": "response", "errorClass": "OtherError"}
    assert _safe_failure_diagnostic("fit", ModuleNotFoundError("sensitive module path")) == {
        "stage": "fit", "errorClass": "ModuleNotFoundError"}
    with pytest.raises(RuntimeError) as caught:
        _raise_stage_failure("load-cohort", RuntimeError("sensitive detail"))
    _log_safe_failure(caught.value.stage, caught.value.original)
    assert json.loads(capsys.readouterr().out.strip()) == {
        "event": "learner_failure", "stage": "load-cohort", "errorClass": "RuntimeError"}


def test_candidate_publisher_checks_exact_trainer_manifest_and_files(tmp_path):
    model_id = "worker-experimental-20261016T120000Z"
    files = {f"{model_id}.pkl": b"model-bytes", f"{model_id}.json": b"metadata-bytes"}
    metadata = {name: {"sha256": hashlib.sha256(value).hexdigest(), "sizeBytes": len(value)}
                for name, value in files.items()}
    for name, value in files.items():
        (tmp_path / name).write_bytes(value)
    manifest_name = f"experimental-trifecta-{model_id}.manifest.json"
    (tmp_path / manifest_name).write_text(json.dumps({"files": metadata}))
    bucket = _Bucket()
    asyncio.run(persist_candidate_artifacts(tmp_path, model_id, "learning-candidates/day/model/", bucket))
    assert set(bucket.objects) == {"learning-candidates/day/model/" + name
                                   for name in (*files, manifest_name)}

    metadata[f"{model_id}.pkl"]["sha256"] = "0" * 64
    (tmp_path / manifest_name).write_text(json.dumps({"files": metadata}))
    with pytest.raises(ValueError, match="candidate_artifact_checksum_invalid"):
        asyncio.run(persist_candidate_artifacts(tmp_path, model_id, "bad/", _Bucket()))


def test_actual_experimental_trainer_artifacts_are_publishable_without_zip(tmp_path, monkeypatch):
    """Exercise the real trainer's manifest contract with synthetic test evidence."""
    from edgelab.importers import experimental_result_labels
    from edgelab.models import trifecta

    model_id = "worker-experimental-test-artifact"
    race_id = "boat-20261010-01-01"
    rows = [{"race_id": race_id, "race_date": "2026-10-10", "number": lane,
             "finish_order": lane, "lane": lane, "national_win_rate": 0.2,
             "data_origin": "real", "available_at": "2026-10-10T10:00:00+09:00",
             "predicted_at": "2026-10-10T11:00:00+09:00"} for lane in range(1, 7)]
    evidence = {"raceId": race_id, "completeResult": True, "verifiedT60Cutoff": True,
                "sixEntryAvailability": True, "sourceArrivalVerified": True,
                "freshExhibitionLanes": [1, 2, 3, 4, 5, 6],
                "completeT60Odds": True, "consistentPayout": True, "freshWeather": False}
    monkeypatch.setattr(trifecta, "audit_trifecta_coverage", lambda *args, **kwargs:
                        {"races": [evidence], "finishedRealBoatRaces": 1})
    monkeypatch.setattr(experimental_result_labels, "verified_experimental_result_race_ids",
                        lambda store: {race_id})

    report = trifecta.train_trifecta_experimental(rows, {}, model_id=model_id, artifact_dir=tmp_path)
    assert report["artifactCreated"] is True
    assert (tmp_path / f"{model_id}.pkl").is_file()
    assert (tmp_path / f"{model_id}.json").is_file()
    assert (tmp_path / f"experimental-trifecta-{model_id}.manifest.json").is_file()
    assert not (tmp_path / f"{model_id}.zip").exists()

    bucket = _Bucket()
    asyncio.run(persist_candidate_artifacts(tmp_path, model_id, "candidate/", bucket))
    assert set(bucket.objects) == {
        f"candidate/{model_id}.pkl", f"candidate/{model_id}.json",
        f"candidate/experimental-trifecta-{model_id}.manifest.json"}


def test_normal_learning_keeps_verified_rows_uses_candidate_backend_and_saves_state(monkeypatch):
    from datetime import datetime, timezone, timedelta
    from edgelab.importers import experimental_result_labels
    from edgelab import cli, learning
    import src.worker as worker

    today = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=9))).date()
    race_id = f"boat-{today:%Y%m%d}-01-01"
    other_id = f"boat-{today:%Y%m%d}-01-02"
    store = {
        "races": [{"id": race_id}, {"id": other_id}],
        "entries": ([{"id": f"{race_id}-{lane}", "race_id": race_id, "number": lane}
                     for lane in range(1, 7)]
                    + [{"id": f"{other_id}-{lane}", "race_id": other_id, "number": lane}
                       for lane in range(1, 7)]),
        "results": ([{"race_id": race_id, "number": lane} for lane in range(1, 7)]
                    + [{"race_id": other_id, "number": lane} for lane in range(1, 7)]),
        "payouts": [{"race_id": race_id}, {"race_id": other_id}],
        "collection_runs": [{"id": f"boat-result:{race_id}"},
                             {"id": f"boat-result:{other_id}"}],
        "models": [{"id": "must-not-compare"}],
    }
    monkeypatch.setattr(worker, "load_training_store",
                        lambda *args, **kwargs: _async_value((store, {"candidateRaces": 1})))
    monkeypatch.setattr(experimental_result_labels, "verified_experimental_result_race_ids",
                        lambda ignored: {race_id})
    seen = {}
    training_rows = [{"race_id": race_id, "race_date": today.isoformat(), "winner": 1}]

    def make_rows(filtered, sport, *, require_source_arrival=False):
        seen["store"] = filtered
        seen["require_source_arrival"] = require_source_arrival
        return training_rows

    monkeypatch.setattr(cli, "_make_training_rows", make_rows)
    monkeypatch.setattr(worker, "_load_normal_learning_state",
                        lambda db: _async_value({"version": 1, "trainedRaceIds": []}))

    def guarded(filtered, rows, **kwargs):
        seen["backend"] = kwargs.get("estimator_backend")
        seen["model_id"] = kwargs["model_id"]
        assert len(filtered["entries"]) == 6
        assert len(filtered["results"]) == 6
        assert len(filtered["payouts"]) == 1
        return {"status": "candidate", "newRaces": 30,
                "holdoutStart": today.isoformat(), "holdoutEnd": today.isoformat()}

    monkeypatch.setattr(learning, "guarded_candidate", guarded)
    monkeypatch.setattr(worker, "_mark_normal_candidate_not_promotable", lambda *args: None)
    monkeypatch.setattr(worker, "_persist_normal_candidate", lambda *args: _async_value(None))
    db, bucket = _DB(), _Bucket()
    report = asyncio.run(handle_normal_learning(db, bucket,
        {"date": today.isoformat(), "confirmed": True}))

    assert report["status"] == "candidate" and report["candidateOnly"] is True
    assert report["registered"] is False and report["promoted"] is False
    assert seen["require_source_arrival"] is True
    assert seen["backend"] == "numpy-logistic"
    assert seen["model_id"].startswith("boat-win-logistic-")
    state_writes = [(sql, args) for sql, args in db.writes
                    if "INSERT INTO settings" in sql and args[0] == "native_normal_learning_state"]
    assert len(state_writes) == 1
    assert state_writes[0][1][0] == "native_normal_learning_state"
    assert json.loads(state_writes[0][1][1]) == {"version": 1, "trainedRaceIds": [race_id]}


def _async_value(value):
    async def resolved(*args, **kwargs):
        return value
    return resolved()
