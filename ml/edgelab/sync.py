"""Send normalized D1 rows to the EdgeLab ingest API."""
from __future__ import annotations

import json
import os
import socket
import time
from datetime import date
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from typing import Any, Mapping


ENDPOINTS = {
    "venues": "venues",
    "races": "races",
    "entries": "entries",
    "odds_snapshots": "odds",
    "results": "results",
    "payouts": "payouts",
    "predictions": "predictions",
    "ticket_predictions": "ticket-predictions",
    "prerace_observations": "prerace-observations",
    "models": "models",
    "collection_runs": "collection-runs",
}
# Keep required current-day facts ahead of optional payloads. Parent rows are
# first, and model lifecycle state must arrive before predictions.
SEND_ORDER = ("venues", "races", "prerace_observations", "models", "results", "payouts", "entries",
              "predictions", "ticket_predictions", "odds_snapshots", "collection_runs")


class WriteBudgetRefused(RuntimeError):
    """The API refused a write because shared UTC-day budget is unavailable."""


_SAFE_INGEST_ERROR_CODES = {
    "d1_write_budget_unavailable", "d1_write_budget_exhausted", "historical_ingest_disabled",
}
_MAX_CAPTURE_EXPORT_PAGE_BYTES = 2 * 1024 * 1024
_MAX_CAPTURE_EXPORT_PAGES = 1000


def _safe_ingest_error_code(exc: HTTPError) -> str | None:
    """Return only known, non-sensitive API error codes from a bounded body."""
    try:
        payload = json.loads(exc.read(4096).decode("utf-8", "replace"))
    except (OSError, ValueError):
        return None
    code = payload.get("code") if isinstance(payload, dict) else None
    return code if isinstance(code, str) and code in _SAFE_INGEST_ERROR_CODES else None


def fetch_write_budget(*, base_url: str | None = None, token: str | None = None) -> dict[str, Any]:
    """Read the API's authoritative ROI+ daily write budget.

    The response is deliberately treated as untrusted: missing or malformed
    metrics are not replaced with a local estimate.
    """
    base_url = (base_url or os.environ.get("EDGELAB_API_URL", "")).rstrip("/")
    token = token or os.environ.get("INGEST_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError("EDGELAB_API_URL and INGEST_TOKEN are required")
    req = Request(f"{base_url}/api/ingest/write-budget", headers={
        "Authorization": f"Bearer {token}", "Accept": "application/json",
        "User-Agent": "EdgeLab-ML/0.1"}, method="GET")
    try:
        with urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"write budget read failed: HTTP {exc.code}") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        raise RuntimeError(f"write budget read failed: {type(exc).__name__}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("write budget response is invalid")
    state = payload.get("state")
    if state not in {"known", "exhausted", "missing", "invalid"}:
        raise RuntimeError("write budget response is invalid")
    day = payload.get("date")
    try:
        if not isinstance(day, str) or date.fromisoformat(day).isoformat() != day:
            raise ValueError
    except ValueError as exc:
        raise RuntimeError("write budget response has an invalid UTC date") from exc
    for key in ("limit", "reserved", "remaining"):
        value = payload.get(key)
        if value is not None and (not isinstance(value, int) or isinstance(value, bool) or value < 0):
            raise RuntimeError("write budget response is invalid")
    if state in {"known", "exhausted"}:
        limit, reserved, remaining = (payload.get(key) for key in ("limit", "reserved", "remaining"))
        if limit is None or reserved is None or remaining is None or limit <= 0 or reserved > limit:
            raise RuntimeError("write budget response is incomplete")
        if remaining != limit - reserved or (state == "known" and remaining == 0) or (state == "exhausted" and remaining != 0):
            raise RuntimeError("write budget response is inconsistent")
    return payload


def fetch_model_registry(*, base_url: str | None = None, token: str | None = None) -> list[dict[str, Any]]:
    """Read authoritative model lifecycle state; this never writes remote data."""
    base_url = (base_url or os.environ.get("EDGELAB_API_URL", "")).rstrip("/")
    token = token or os.environ.get("INGEST_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError("EDGELAB_API_URL and INGEST_TOKEN are required")
    req = Request(f"{base_url}/api/ingest/models", headers={
        "Authorization": f"Bearer {token}", "Accept": "application/json",
        "User-Agent": "EdgeLab-ML/0.1"}, method="GET")
    try:
        with urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        raise RuntimeError(f"model registry read failed: {type(exc).__name__}") from exc
    models = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(models, list):
        raise RuntimeError("model registry response has no models array")
    return [row for row in models if isinstance(row, dict)]


def fetch_prerace_capture_archives(target_date: str, *, base_url: str | None = None,
                                   token: str | None = None, opener=None) -> list[dict[str, Any]]:
    """Read one bounded date of immutable archive exports with existing ingest auth."""
    try:
        if date.fromisoformat(target_date).isoformat() != target_date:
            raise ValueError
    except (TypeError, ValueError) as exc:
        raise ValueError("archive export date must be YYYY-MM-DD") from exc
    base_url = (base_url or os.environ.get("EDGELAB_API_URL", "")).rstrip("/")
    token = token or os.environ.get("INGEST_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError("EDGELAB_API_URL and INGEST_TOKEN are required")
    open_request = opener or urlopen
    pages, seen_cursors = [], set()
    cursor = None
    for _ in range(_MAX_CAPTURE_EXPORT_PAGES):
        params = {"date": target_date, "limit": "25"}
        if cursor:
            params["cursor"] = cursor
        request = Request(f"{base_url}/api/ingest/prerace-capture-archives?{urlencode(params)}", headers={
            "Authorization": f"Bearer {token}", "Accept": "application/json",
            "User-Agent": "EdgeLab-ML/0.1"}, method="GET")
        try:
            with open_request(request, timeout=30) as response:
                body = response.read(_MAX_CAPTURE_EXPORT_PAGE_BYTES + 1)
            if not body or len(body) > _MAX_CAPTURE_EXPORT_PAGE_BYTES:
                raise RuntimeError("archive export page is empty or oversized")
            payload = json.loads(body.decode("utf-8"))
        except HTTPError as exc:
            raise RuntimeError(f"archive export read failed: HTTP {exc.code}") from exc
        except (URLError, TimeoutError, ValueError, UnicodeDecodeError) as exc:
            raise RuntimeError(f"archive export read failed: {type(exc).__name__}") from exc
        if (not isinstance(payload, dict) or payload.get("schema") != "boat-prerace-capture-export-v1"
                or payload.get("date") != target_date or payload.get("limit") != 25
                or not isinstance(payload.get("archives"), list)
                or len(payload["archives"]) > 25):
            raise RuntimeError("archive export page has an invalid envelope")
        pages.append(payload)
        next_cursor = payload.get("nextCursor")
        if next_cursor is None:
            return pages
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors:
            raise RuntimeError("archive export pagination cursor is invalid or repeated")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    raise RuntimeError("archive export exceeded the page safety limit")


def sync_rows(rows: Mapping[str, list[dict[str, Any]]], *, dry_run: bool = False,
              output_dir: str | Path = "ml/outbox", base_url: str | None = None,
              token: str | None = None) -> dict[str, Any]:
    """POST each non-empty table list; dry-run writes a faithful JSON outbox."""
    if dry_run:
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        files = []
        for table in sorted(rows, key=lambda name: SEND_ORDER.index(name) if name in SEND_ORDER else len(SEND_ORDER)):
            values = rows[table]
            if table not in ENDPOINTS:
                raise ValueError(f"unsupported ingest table: {table}")
            chunks = [values[i:i + 500] for i in range(0, len(values), 500)] or [[]]
            for index, chunk in enumerate(chunks):
                suffix = f"-{index + 1}" if len(chunks) > 1 else ""
                path = out / f"{ENDPOINTS[table]}{suffix}.json"
                path.write_text(json.dumps(chunk, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                files.append(str(path))
        return {"dry_run": True, "files": files}

    base_url = (base_url or os.environ.get("EDGELAB_API_URL", "")).rstrip("/")
    token = token or os.environ.get("INGEST_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError("EDGELAB_API_URL and INGEST_TOKEN are required")
    result: dict[str, Any] = {}
    for table in sorted(rows, key=lambda name: SEND_ORDER.index(name) if name in SEND_ORDER else len(SEND_ORDER)):
        values = rows[table]
        if table not in ENDPOINTS:
            raise ValueError(f"unsupported ingest table: {table}")
        if not values:
            continue
        responses = []
        # These endpoints perform several sequential D1 lookups per row. Keep
        # their chunks small to bound lookup, batch, and D1 write amplification.
        row_checked_tables = {"races", "results", "payouts", "entries", "odds_snapshots",
                              "predictions", "ticket_predictions", "prerace_observations"}
        chunk_size = 10 if table in {"races", "payouts", "entries"} else 50 if table in row_checked_tables else 500
        for start in range(0, len(values), chunk_size):
            payload = json.dumps(values[start:start + chunk_size], ensure_ascii=False).encode("utf-8")
            req = Request(f"{base_url}/api/ingest/{ENDPOINTS[table]}", data=payload,
                          headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                                   "User-Agent": "EdgeLab-ML/0.1"}, method="POST")
            for attempt in range(2):
                try:
                    with urlopen(req, timeout=30) as response:
                        body = response.read().decode("utf-8", "replace")
                        try:
                            data = json.loads(body)
                        except ValueError as exc:
                            raise RuntimeError(f"ingest {table} returned invalid JSON") from exc
                        upserted = data.get("upserted") if isinstance(data, dict) else None
                        if not isinstance(data, dict) or not isinstance(upserted, int) or isinstance(upserted, bool) or upserted < 0:
                            raise RuntimeError(f"ingest {table} returned an invalid result")
                        # A 200 response with zero changed rows is an explicit no-op,
                        # not evidence that this request changed D1.
                        changed = data.get("changed")
                        if not isinstance(changed, int) or isinstance(changed, bool) or changed < 0:
                            raise RuntimeError(f"ingest {table} returned an invalid result")
                        responses.append({"status": response.status, "upserted": upserted,
                                          "changed": changed, "noop": changed == 0})
                    break
                except HTTPError as exc:
                    safe_code = _safe_ingest_error_code(exc)
                    if exc.code == 429:
                        # Never retry blindly: the reservation status may have
                        # changed and a partial prior sync must remain visible.
                        raise WriteBudgetRefused(
                            f"ingest {table} refused: daily D1 write budget unavailable or exhausted (HTTP 429)") from exc
                    if attempt == 0 and exc.code in {500, 502, 503, 504}:
                        # Natural-key upserts make a replay safe if the Worker
                        # committed before an upstream service error was returned.
                        time.sleep(2)
                        continue
                    suffix = f" (code: {safe_code})" if safe_code else ""
                    raise RuntimeError(f"ingest {table} failed: HTTP {exc.code}{suffix}") from exc
                except (URLError, TimeoutError) as exc:
                    reason = exc.reason if isinstance(exc, URLError) else exc
                    transient_timeout = isinstance(reason, (TimeoutError, socket.timeout))
                    if attempt == 0 and transient_timeout:
                        # The request may have committed before its response timed
                        # out. The same natural-key payload is safe to replay: the
                        # API upserts idempotently and reserves only changed rows.
                        time.sleep(2)
                        continue
                    raise RuntimeError(f"ingest {table} failed: {type(exc).__name__}") from exc
        if responses:
            result[table] = responses[0] if len(responses) == 1 else responses
    return result
