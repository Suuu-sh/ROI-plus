"""Private Cloudflare Python Worker for isolated experimental learning.

The handler intentionally trains only from the same immutable D1 evidence and
the existing EdgeLab training path. It never promotes or registers a model.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

MAX_RACES = 500
LOOKBACK_DAYS = 120
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_NORMAL_RACE_ID = re.compile(r"^boat-\d{8}-\d{2}-\d{2}$")


def _rows(result: Any) -> list[dict[str, Any]]:
    """Convert D1's JS result rows into ordinary Python dictionaries."""
    value = getattr(result, "results", None)
    if value is None:
        return []
    converter = getattr(value, "to_py", None)
    if callable(converter):
        value = converter()
    return [dict(row) for row in value]


async def _query(db: Any, sql: str, *args: Any) -> list[dict[str, Any]]:
    statement = db.prepare(sql)
    if args:
        statement = statement.bind(*args)
    return _rows(await statement.all())


async def persist_candidate_artifacts(base: Path, model_id: str, prefix: str, bucket: Any) -> None:
    """Persist only the trainer's immutable two-file model and its manifest."""
    manifest_name = f"experimental-trifecta-{model_id}.manifest.json"
    manifest_path = base / manifest_name
    manifest = json.loads(manifest_path.read_text())
    files = manifest.get("files")
    expected_files = {f"{model_id}.pkl", f"{model_id}.json"}
    if not isinstance(files, dict) or set(files) != expected_files:
        raise ValueError("candidate_artifact_manifest_invalid")
    for name in sorted(expected_files | {manifest_name}):
        if Path(name).name != name or not (base / name).is_file():
            raise ValueError("candidate_artifact_incomplete")
        content = (base / name).read_bytes()
        if name in files:
            metadata = files[name]
            if (not isinstance(metadata, dict)
                    or metadata.get("sha256") != hashlib.sha256(content).hexdigest()
                    or metadata.get("sizeBytes") != len(content)):
                raise ValueError("candidate_artifact_checksum_invalid")
        await bucket.put(prefix + name, content)


def _result_proof(row: dict[str, Any]) -> dict[str, Any] | None:
    try:
        proof = json.loads(row.get("reason") or "")
    except (TypeError, ValueError):
        return None
    if not isinstance(proof, dict) or proof.get("quality") != "verified-official-outcome-v2":
        return None
    url, digest, fetched = proof.get("url"), proof.get("sha256"), proof.get("fetchedAt")
    if (not isinstance(url, str) or not re.fullmatch(r"https://www\.boatrace\.jp/owpc/pc/race/raceresult\?rno=\d{1,2}&jcd=\d{2}&hd=\d{8}", url)
            or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or not isinstance(fetched, str)):
        return None
    return proof


async def load_training_store(db: Any, *, today: date | None = None) -> tuple[dict[str, list[dict[str, Any]]], dict[str, int]]:
    """Load a bounded, official-proof-only cohort from existing D1 tables.

    The newest bounded cohort is explicit in returned counts; every selected
    row still passes the immutable archive and official-label validators.
    """
    today = today or datetime.now(timezone.utc).date()
    start = (today - timedelta(days=LOOKBACK_DAYS)).isoformat()
    end = today.isoformat()
    candidates = await _query(db, """
      SELECT r.id,r.sport,r.venue_id,r.race_no,r.race_date,r.post_time,r.status,r.data_origin,
             r.betting_cutoff_at,r.betting_cutoff_source,r.betting_cutoff_observed_at,
             cr.reason AS result_proof
      FROM races r JOIN collection_runs cr ON cr.id='boat-result:'||r.id
      WHERE r.sport='boat' AND r.data_origin='real' AND r.race_date>=? AND r.race_date<?
        AND cr.source='boatrace-results-worker-v1' AND cr.status='success'
        AND json_valid(cr.reason) AND json_extract(cr.reason,'$.quality')='verified-official-outcome-v2'
        AND EXISTS(SELECT 1 FROM boatrace_prerace_capture_archives a WHERE a.race_id=r.id AND a.data_origin='real')
      ORDER BY r.race_date DESC,r.id DESC LIMIT ?
    """, start, end, MAX_RACES + 1)
    truncated = max(0, len(candidates) - MAX_RACES)
    candidates = candidates[:MAX_RACES]
    store: dict[str, list[dict[str, Any]]] = {
        key: [] for key in ("races", "entries", "results", "payouts", "collection_runs",
                            "prerace_observations", "prerace_capture_archive_manifest",
                            "prerace_capture_odds")
    }
    if not candidates:
        return store, {"candidateRaces": 0, "archives": 0, "labels": 0,
                       "truncatedCandidates": 0, "requestedWindowDays": LOOKBACK_DAYS,
                       "selectedFrom": None, "selectedTo": None}
    store["races"] = candidates
    ids = [r["id"] for r in candidates]
    # D1's bind limit is kept comfortably below 100. Each batch is separately
    # bounded and cannot silently lose a race due to a parameter-limit error.
    for offset in range(0, len(ids), 40):
        batch = ids[offset:offset + 40]
        marks = ",".join("?" for _ in batch)
        entries = await _query(db, f"SELECT e.* FROM entries e WHERE e.data_origin='real' AND e.race_id IN ({marks})", *batch)
        results = await _query(db, f"SELECT x.* FROM results x WHERE x.data_origin='real' AND x.race_id IN ({marks})", *batch)
        payouts = await _query(db, f"SELECT p.* FROM payouts p WHERE p.data_origin='real' AND p.bet_type='trifecta' AND p.race_id IN ({marks})", *batch)
        archives = await _query(db, f"""
          SELECT a.id,a.race_id,a.race_date,a.captured_at,a.archive_json
          FROM boatrace_prerace_capture_archives a
          WHERE a.data_origin='real' AND a.race_id IN ({marks})
            AND julianday(a.captured_at)<=julianday((SELECT r.betting_cutoff_at FROM races r WHERE r.id=a.race_id),'-60 seconds')
          ORDER BY a.race_id,julianday(a.captured_at) DESC
        """, *batch)
        # Use only the latest eligible archive per race; it still passes the
        # same archive validator used by offline ingestion.
        latest: dict[str, dict[str, Any]] = {}
        for archive in archives:
            latest.setdefault(str(archive["race_id"]), archive)
        runs = await _query(db, f"SELECT cr.* FROM collection_runs cr WHERE cr.source='boatrace-results-worker-v1' AND cr.id IN ({','.join('?' for _ in batch)})", *["boat-result:" + i for i in batch])
        store["entries"].extend(entries)
        store["results"].extend(results)
        store["payouts"].extend(payouts)
        store["collection_runs"].extend(runs)
        # Importers validate archive hash, full race identity, cutoff, 120 odds,
        # lane roster, timestamped source proofs and immutable observation rows.
        from edgelab.importers.boatrace_capture_archive import ARCHIVE_EXPORT_SCHEMA, import_capture_archives
        from edgelab.importers.experimental_result_labels import import_experimental_result_labels
        for archive in latest.values():
            raw = archive.get("archive_json")
            if not isinstance(raw, str):
                continue
            wrapper = {"id": archive["id"], "raceId": archive["race_id"], "raceDate": archive["race_date"],
                       "date": archive["race_date"], "capturedAt": archive["captured_at"], "archiveJson": raw,
                       "archiveSha256": hashlib.sha256(raw.encode("utf-8")).hexdigest()}
            page = {"schema": ARCHIVE_EXPORT_SCHEMA, "date": archive["race_date"], "limit": 25,
                    "archives": [wrapper], "nextCursor": None}
            import_capture_archives(store, [page], archive["race_date"], allow_missing_weather=True)
        labels_by_day: dict[str, list[dict[str, Any]]] = {}
        by_id = {str(r["id"]): r for r in candidates}
        for run in runs:
            proof = _result_proof(run)
            race_id = str(run.get("id", "")).removeprefix("boat-result:")
            race = by_id.get(race_id)
            if proof is None or race is None:
                continue
            # Raw result/payout rows are not used as labels absent the collector's
            # matching official source proof; importer cross-checks both.
            label = {"raceId": race_id, "raceDate": race["race_date"], "venueId": race["venue_id"],
                     "raceNo": int(race["race_no"]), "results": proof.get("results"),
                     "payouts": proof.get("payouts"), "source": {"url": proof.get("url"),
                     "sha256": proof.get("sha256"), "fetchedAt": proof.get("fetchedAt"),
                     "quality": proof.get("quality")}}
            labels_by_day.setdefault(race["race_date"], []).append(label)
        for day, labels in labels_by_day.items():
            import_experimental_result_labels(store, [{"schema": "boat-official-k-result-label-export-v1",
                "date": day, "limit": 5, "labels": labels[:5]}], day)
            # Above importer pages cap at five labels. Process additional labels
            # in separate pages, each with the schema's exact limit.
            for i in range(5, len(labels), 5):
                import_experimental_result_labels(store, [{"schema": "boat-official-k-result-label-export-v1",
                    "date": day, "limit": 5, "labels": labels[i:i + 5]}], day)
    return store, {"candidateRaces": len(candidates), "archives": len(store["prerace_capture_archive_manifest"]),
                   "labels": len(store["results"]) // 6, "truncatedCandidates": truncated,
                   "requestedWindowDays": LOOKBACK_DAYS,
                   "selectedFrom": min((r["race_date"] for r in candidates), default=None),
                   "selectedTo": max((r["race_date"] for r in candidates), default=None)}


def _json_response(body: dict[str, Any], status: int = 200):
    from workers import Response
    return Response(json.dumps(body, separators=(",", ":")), status=status,
        headers={"content-type": "application/json; charset=utf-8", "cache-control": "no-store"})


async def handle_learning(db: Any, archive_bucket: Any, request_body: Any) -> dict[str, Any]:
    """Train a real-data candidate only; callers must privately authorize it."""
    now = datetime.now(timezone.utc)
    today = now.astimezone(timezone(timedelta(hours=9))).date()
    if (not isinstance(request_body, dict) or set(request_body) != {"date", "confirmed"}
            or request_body.get("date") != today.isoformat() or request_body.get("confirmed") is not True):
        return {"status": "rejected", "reason": "request_confirmation_invalid"}
    lease_key = f"native_experimental_learning:{today.isoformat()}"
    lease_until = (now + timedelta(minutes=45)).isoformat()
    lease_value = json.dumps({"until": lease_until, "owner": uuid.uuid4().hex}, separators=(",", ":"))
    try:
        claimed = await db.prepare("""
          INSERT INTO settings(key,value) VALUES(?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value
          WHERE julianday(json_extract(settings.value,'$.until'))<=julianday(?)
        """).bind(lease_key, lease_value, now.isoformat()).run()
    except Exception as exc:
        _raise_stage_failure("lease", exc)
    if not bool(getattr(getattr(claimed, "meta", None), "changes", 0)):
        return {"status": "skipped", "reason": "daily_lease_active", "candidateOnly": True}
    keep_lease = False
    try:
        try:
            store, counts = await load_training_store(db, today=today)
        except Exception as exc:
            _raise_stage_failure("load-cohort", exc)
        try:
            from edgelab.cli import _make_training_rows
            from edgelab.features.boat import TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA
            rows = _make_training_rows(store, "boat", feature_schema=TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA,
                                       require_source_arrival=True)
        except Exception as exc:
            _raise_stage_failure("feature-build", exc)
        model_id = "worker-experimental-" + now.strftime("%Y%m%dT%H%M%SZ")
        # Isolate local temporary files; candidate bytes are copied to R2 only after
        # the existing learner succeeds and remain outside every registry path.
        import tempfile
        from edgelab.models.trifecta import train_trifecta_experimental
        with tempfile.TemporaryDirectory(prefix="edgelab-candidate-") as directory:
            try:
                report = train_trifecta_experimental(rows, store, model_id=model_id,
                    artifact_dir=Path(directory) / "candidate",
                    estimator_backend="numpy-newton")
            except Exception as exc:
                _raise_stage_failure("fit", exc)
            report.pop("artifactManifest", None)
            report.pop("artifactManifestData", None)
            report = {**report, "inputCounts": counts,
                      "inputSelection": "most-recent-bounded-real-cohort",
                      "inputSelectionTruncation": "reported-count-is-a-lower-bound",
                      "candidateOnly": True, "registered": False, "promoted": False,
                      "runtimePackages": _runtime_package_versions()}
            prefix = f"learning-candidates/{today.isoformat()}/{model_id}/"
            if report.get("artifactCreated"):
                base = Path(directory) / "candidate"
                try:
                    await persist_candidate_artifacts(base, model_id, prefix, archive_bucket)
                except Exception as exc:
                    _raise_stage_failure("persist-candidate", exc)
            try:
                await archive_bucket.put(prefix + "report.json", json.dumps(report, separators=(",", ":")))
            except Exception as exc:
                _raise_stage_failure("persist-report", exc)
            report["candidatePrefix"] = prefix
            keep_lease = report.get("status") != "insufficient_data"
        return report
    finally:
        if not keep_lease:
            await db.prepare("DELETE FROM settings WHERE key=? AND value=?").bind(lease_key, lease_value).run()


async def handle_normal_learning(db: Any, archive_bucket: Any, request_body: Any) -> dict[str, Any]:
    """Run guarded lightweight logistic candidate learning without promotion."""
    now = datetime.now(timezone.utc)
    today = now.astimezone(timezone(timedelta(hours=9))).date()
    if (not isinstance(request_body, dict) or set(request_body) != {"date", "confirmed"}
            or request_body.get("date") != today.isoformat() or request_body.get("confirmed") is not True):
        return {"status": "rejected", "reason": "request_confirmation_invalid"}
    lease_key = f"native_normal_learning:{today.isoformat()}"
    lease_until = (now + timedelta(minutes=45)).isoformat()
    lease_value = json.dumps({"until": lease_until, "owner": uuid.uuid4().hex}, separators=(",", ":"))
    try:
        claimed = await db.prepare("""
          INSERT INTO settings(key,value) VALUES(?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value
          WHERE julianday(json_extract(settings.value,'$.until'))<=julianday(?)
        """).bind(lease_key, lease_value, now.isoformat()).run()
    except Exception as exc:
        _raise_stage_failure("lease", exc)
    if not bool(getattr(getattr(claimed, "meta", None), "changes", 0)):
        return {"status": "skipped", "reason": "daily_lease_active", "candidateOnly": True}
    keep_lease = False
    try:
        try:
            store, counts = await load_training_store(db, today=today)
        except Exception as exc:
            _raise_stage_failure("load-cohort", exc)
        try:
            from edgelab.importers.experimental_result_labels import verified_experimental_result_race_ids
            verified_ids = verified_experimental_result_race_ids(store)
        except Exception as exc:
            _raise_stage_failure("feature-build", exc)
        normal_store = dict(store)
        normal_store["models"] = []  # This private learner has no authoritative registry snapshot.
        for key in ("races", "entries", "results", "payouts", "collection_runs"):
            def row_race_id(row: dict[str, Any]) -> str:
                if key == "races":
                    value = row.get("id")
                elif key == "collection_runs":
                    value = str(row.get("id") or "").removeprefix("boat-result:")
                else:
                    value = row.get("race_id")
                return str(value or "")
            normal_store[key] = [row for row in store.get(key, []) if row_race_id(row) in verified_ids]
        from edgelab.cli import _make_training_rows
        try:
            training_rows = _make_training_rows(normal_store, "boat", require_source_arrival=True)
        except Exception as exc:
            _raise_stage_failure("feature-build", exc)
        complete_ids = sorted({str(row["race_id"]) for row in training_rows})
        fingerprint = hashlib.sha256(("|".join(complete_ids) + "|" + now.isoformat()).encode()).hexdigest()[:8]
        model_id = f"boat-win-logistic-{today:%Y%m%d}-{fingerprint}"
        prefix = f"learning-candidates/{today.isoformat()}/{model_id}/"
        from edgelab.learning import guarded_candidate
        import tempfile
        with tempfile.TemporaryDirectory(prefix="edgelab-normal-candidate-") as directory:
            base = Path(directory) / "candidate"
            base.mkdir()
            incumbent_dir = Path(directory) / "incumbents"
            incumbent_dir.mkdir()
            state_path = Path(directory) / "learning-state.json"
            checkpoint = await _load_normal_learning_state(db)
            state_path.write_text(json.dumps(checkpoint, separators=(",", ":")), encoding="utf-8")
            try:
                result = guarded_candidate(normal_store, training_rows, model_id=model_id,
                    authoritative_model_ids=set(), artifact_dir=base, learning_state_path=state_path,
                    incumbent_artifact_dir=incumbent_dir, estimator_backend="numpy-logistic")
            except Exception as exc:
                _raise_stage_failure("fit", exc)
            next_state = None
            if result.get("status") == "candidate":
                _mark_normal_candidate_not_promotable(base, model_id, result)
                try:
                    await _persist_normal_candidate(base, model_id, prefix, archive_bucket)
                except Exception as exc:
                    _raise_stage_failure("persist-candidate", exc)
                next_state = {"version": 1, "trainedRaceIds": complete_ids[-MAX_RACES:]}
                status = "candidate"
                artifact_created = True
                reason = "no_eligible_pre_holdout_incumbent"
            elif result.get("status") in {"skipped", "untrained", "rejected"}:
                status = "insufficient_data"
                artifact_created = False
                reason = _normal_learning_reason(result)
            else:
                raise ValueError("normal_candidate_result_invalid")

            # Race identifiers and local artifact paths stay out of the API/R2 report.
            normal_summary = {
                "status": status, "reason": reason,
                "completeRaces": len(complete_ids),
                "newRaces": _safe_nonnegative_int(result.get("newRaces")),
                "holdoutStart": _safe_day(result.get("holdoutStart")),
                "holdoutEnd": _safe_day(result.get("holdoutEnd")),
                "candidateMetrics": result.get("candidateMetrics"),
                "comparison": result.get("comparison"),
                "promotionEligible": False,
                "promotionReason": reason,
            }
            report = {
                "id": model_id, "status": status, "reason": reason,
                "artifactCreated": artifact_created, "candidatePrefix": prefix,
                "candidateOnly": True, "registered": False, "promoted": False,
                "promotionEligible": False, "promotionReason": reason,
                "inputCounts": counts,
                "inputSelection": "most-recent-bounded-real-cohort",
                "inputSelectionTruncation": "reported-count-is-a-lower-bound",
                "runtimePackages": _runtime_package_versions(),
                "normalLearning": normal_summary,
            }
            try:
                await archive_bucket.put(prefix + "report.json", json.dumps(report, separators=(",", ":")))
            except Exception as exc:
                _raise_stage_failure("persist-report", exc)
            if next_state is not None:
                await db.prepare("""
                  INSERT INTO settings(key,value) VALUES(?,?)
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value
                """).bind("native_normal_learning_state",
                          json.dumps(next_state, separators=(",", ":"))).run()
                keep_lease = True
            return report
    finally:
        if not keep_lease:
            await db.prepare("DELETE FROM settings WHERE key=? AND value=?").bind(lease_key, lease_value).run()


async def _load_normal_learning_state(db: Any) -> dict[str, Any]:
    rows = await _query(db, "SELECT value FROM settings WHERE key=?", "native_normal_learning_state")
    if not rows:
        return {"version": 1, "trainedRaceIds": []}
    try:
        state = json.loads(rows[0].get("value", ""))
    except (TypeError, ValueError):
        raise ValueError("normal_learning_state_invalid")
    ids = state.get("trainedRaceIds") if isinstance(state, dict) else None
    if (set(state) != {"version", "trainedRaceIds"} or state.get("version") != 1
            or not isinstance(ids, list) or len(ids) > MAX_RACES
            or any(not isinstance(race_id, str) or not _NORMAL_RACE_ID.fullmatch(race_id) for race_id in ids)
            or len(ids) != len(set(ids))):
        raise ValueError("normal_learning_state_invalid")
    return state


def _normal_learning_reason(result: dict[str, Any]) -> str:
    reasons = {
        "no complete real outcome cohorts": "no_complete_real_outcomes",
        "insufficient temporal dates for untouched holdout": "insufficient_temporal_dates",
        "insufficient total complete real races": "insufficient_total_races",
        "not enough new completed real races": "insufficient_new_races",
        "candidate validation overlaps untouched holdout": "holdout_overlap",
    }
    value = result.get("reason")
    if value in reasons:
        return reasons[value]
    return "trainer_unavailable_or_candidate_not_eligible"


def _safe_nonnegative_int(value: Any) -> int:
    return value if type(value) is int and value >= 0 else 0


def _safe_day(value: Any) -> str | None:
    if isinstance(value, str) and _DAY.fullmatch(value):
        try:
            return date.fromisoformat(value).isoformat()
        except ValueError:
            return None
    return None


def _mark_normal_candidate_not_promotable(base: Path, model_id: str, result: dict[str, Any]) -> None:
    metadata_path = base / f"{model_id}.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("id") != model_id or metadata.get("status") != "candidate":
        raise ValueError("normal_candidate_metadata_invalid")
    metadata["candidateOnly"] = True
    metrics = metadata.get("metrics")
    if not isinstance(metrics, dict):
        metrics = {}
    metrics["promotionEligible"] = False
    metrics["promotionReason"] = "no eligible authoritative incumbent comparison"
    metadata["metrics"] = metrics
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                             encoding="utf-8")
    result["promotionEligible"] = False


async def _persist_normal_candidate(base: Path, model_id: str, prefix: str, bucket: Any) -> None:
    names = (f"{model_id}.pkl", f"{model_id}.json")
    records = {}
    for name in names:
        path = base / name
        if not path.is_file():
            raise ValueError("normal_candidate_artifact_incomplete")
        content = path.read_bytes()
        records[name] = {"sha256": hashlib.sha256(content).hexdigest(), "sizeBytes": len(content)}
    manifest = {"schema": "roi-plus-normal-candidate-v1", "modelId": model_id,
                "candidateOnly": True, "registered": False, "promoted": False,
                "promotionEligible": False, "files": records}
    manifest_name = f"normal-candidate-{model_id}.manifest.json"
    for name in names:
        await bucket.put(prefix + name, (base / name).read_bytes())
    await bucket.put(prefix + manifest_name, json.dumps(manifest, separators=(",", ":")))


def _runtime_package_versions() -> dict[str, str]:
    from importlib.metadata import version
    versions = {}
    for package in ("numpy", "scipy", "scikit-learn", "lightgbm"):
        try:
            versions[package] = version(package)
        except Exception:
            versions[package] = "unavailable"
    return versions


_FAILURE_STAGES = frozenset({
    "request-json", "experimental-learn", "normal-learn", "lease", "load-cohort",
    "feature-build", "fit", "persist-candidate", "persist-report", "response",
})
_ERROR_CLASSES = frozenset({
    "AssertionError", "AttributeError", "FileNotFoundError", "ImportError",
    "FloatingPointError", "IndexError", "IsADirectoryError", "KeyError", "LinAlgError", "MemoryError",
    "ModuleNotFoundError", "NotADirectoryError", "NotImplementedError",
    "OSError", "OverflowError", "PermissionError", "RuntimeError",
    "StopIteration", "TimeoutError", "TypeError", "ValueError", "ZeroDivisionError",
    "ZoneInfoNotFoundError",
})


def _safe_failure_diagnostic(stage: str, error: BaseException) -> dict[str, str]:
    safe_stage = stage if stage in _FAILURE_STAGES else "response"
    error_name = type(error).__name__
    safe_error = error_name if error_name in _ERROR_CLASSES else "OtherError"
    return {"stage": safe_stage, "errorClass": safe_error}


def _log_safe_failure(stage: str, error: BaseException) -> None:
    """Emit fixed diagnostic labels only; never log exception text or request data."""
    labels = _safe_failure_diagnostic(stage, error)
    print(json.dumps({"event": "learner_failure", **labels}, separators=(",", ":")))


def _internal_error_response(stage: str, error: BaseException):
    labels = _safe_failure_diagnostic(stage, error)
    _log_safe_failure(stage, error)
    return _json_response({"status": "failed", "reason": "learner_internal_error",
                           "diagnostic": labels}, 503)


class _WorkerStageFailure(RuntimeError):
    def __init__(self, stage: str, original: BaseException):
        self.stage = stage if stage in _FAILURE_STAGES else "response"
        self.original = original


def _raise_stage_failure(stage: str, error: BaseException) -> None:
    raise _WorkerStageFailure(stage, error) from None


try:  # Cloudflare Workers runtime imports are unavailable in ordinary CPython.
    from workers import WorkerEntrypoint

    class Default(WorkerEntrypoint):
        async def fetch(self, request):
            path = str(request.url).split("?", 1)[0].rstrip("/")
            if request.method != "POST" or not (path.endswith("/learn") or path.endswith("/learn/normal")):
                return _json_response({"error": "not_found"}, 404)
            stage = "request-json"
            try:
                body = await request.json()
                converter = getattr(body, "to_py", None)
                if callable(converter):
                    body = converter()
                if path.endswith("/learn/normal"):
                    stage = "normal-learn"
                    result = await handle_normal_learning(self.env.DB, self.env.TRIFECTA_ARCHIVE, body)
                else:
                    stage = "experimental-learn"
                    result = await handle_learning(self.env.DB, self.env.TRIFECTA_ARCHIVE, body)
                stage = "response"
                return _json_response(result)
            except ValueError as exc:
                failure_stage = exc.stage if isinstance(exc, _WorkerStageFailure) else stage
                failure_error = exc.original if isinstance(exc, _WorkerStageFailure) else exc
                _log_safe_failure(failure_stage, failure_error)
                reason = str(exc) if str(exc) in {"input_limit_exceeded"} else "training_input_invalid"
                return _json_response({"status": "rejected", "reason": reason}, 422)
            except Exception as exc:
                # Never emit SQL, records, object keys from exceptions, or request data.
                failure_stage = exc.stage if isinstance(exc, _WorkerStageFailure) else stage
                failure_error = exc.original if isinstance(exc, _WorkerStageFailure) else exc
                return _internal_error_response(failure_stage, failure_error)
except ImportError:  # importable for unit tests outside Pyodide
    Default = None
