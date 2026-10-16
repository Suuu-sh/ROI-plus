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
    claimed = await db.prepare("""
      INSERT INTO settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
      WHERE julianday(json_extract(settings.value,'$.until'))<=julianday(?)
    """).bind(lease_key, lease_value, now.isoformat()).run()
    if not bool(getattr(getattr(claimed, "meta", None), "changes", 0)):
        return {"status": "skipped", "reason": "daily_lease_active", "candidateOnly": True}
    keep_lease = False
    try:
        store, counts = await load_training_store(db, today=today)
        from edgelab.cli import _make_training_rows
        from edgelab.features.boat import TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA
        rows = _make_training_rows(store, "boat", feature_schema=TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA,
                                   require_source_arrival=True)
        model_id = "worker-experimental-" + now.strftime("%Y%m%dT%H%M%SZ")
        # Isolate local temporary files; candidate bytes are copied to R2 only after
        # the existing learner succeeds and remain outside every registry path.
        import tempfile
        from edgelab.models.trifecta import train_trifecta_experimental
        with tempfile.TemporaryDirectory(prefix="edgelab-candidate-") as directory:
            report = train_trifecta_experimental(rows, store, model_id=model_id,
                artifact_dir=Path(directory) / "candidate")
            report.pop("artifactManifest", None)
            report.pop("artifactManifestData", None)
            report = {**report, "inputCounts": counts,
                      "inputSelection": "most-recent-bounded-real-cohort",
                      "candidateOnly": True, "registered": False, "promoted": False,
                      "runtimePackages": _runtime_package_versions()}
            prefix = f"learning-candidates/{today.isoformat()}/{model_id}/"
            if report.get("artifactCreated"):
                base = Path(directory) / "candidate"
                await persist_candidate_artifacts(base, model_id, prefix, archive_bucket)
            await archive_bucket.put(prefix + "report.json", json.dumps(report, separators=(",", ":")))
            report["candidatePrefix"] = prefix
            keep_lease = report.get("status") != "insufficient_data"
        return report
    finally:
        if not keep_lease:
            await db.prepare("DELETE FROM settings WHERE key=? AND value=?").bind(lease_key, lease_value).run()


def _runtime_package_versions() -> dict[str, str]:
    from importlib.metadata import version
    versions = {}
    for package in ("numpy", "scipy", "scikit-learn"):
        try:
            versions[package] = version(package)
        except Exception:
            versions[package] = "unavailable"
    return versions


try:  # Cloudflare Workers runtime imports are unavailable in ordinary CPython.
    from workers import WorkerEntrypoint

    class Default(WorkerEntrypoint):
        async def fetch(self, request):
            path = str(request.url).split("?", 1)[0].rstrip("/")
            if request.method != "POST" or not path.endswith("/learn"):
                return _json_response({"error": "not_found"}, 404)
            try:
                body = await request.json()
                converter = getattr(body, "to_py", None)
                if callable(converter):
                    body = converter()
                result = await handle_learning(self.env.DB, self.env.TRIFECTA_ARCHIVE, body)
                return _json_response(result)
            except ValueError as exc:
                reason = str(exc) if str(exc) in {"input_limit_exceeded"} else "training_input_invalid"
                return _json_response({"status": "rejected", "reason": reason}, 422)
            except Exception:
                # Never emit SQL, records, object keys from exceptions, or request data.
                return _json_response({"status": "failed", "reason": "learner_internal_error"}, 503)
except ImportError:  # importable for unit tests outside Pyodide
    Default = None
