"""Send normalized D1 rows to the EdgeLab ingest API."""
from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path
from urllib.error import HTTPError, URLError
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
    "models": "models",
    "collection_runs": "collection-runs",
}
# Keep required current-day facts ahead of optional payloads. Parent rows are
# first, and model lifecycle state must arrive before predictions.
SEND_ORDER = ("venues", "races", "models", "results", "payouts", "entries",
              "predictions", "ticket_predictions", "odds_snapshots", "collection_runs")


class WriteBudgetRefused(RuntimeError):
    """The API refused a write because shared UTC-day budget is unavailable."""


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
        # These race-related ingests perform per-row existing-record checks;
        # keep client batches small to stay within the 30-second timeout.
        row_checked_tables = {"races", "results", "payouts", "entries", "odds_snapshots",
                              "predictions", "ticket_predictions"}
        chunk_size = 50 if table in row_checked_tables else 500
        for start in range(0, len(values), chunk_size):
            payload = json.dumps(values[start:start + chunk_size], ensure_ascii=False).encode("utf-8")
            req = Request(f"{base_url}/api/ingest/{ENDPOINTS[table]}", data=payload,
                          headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                                   "User-Agent": "EdgeLab-ML/0.1"}, method="POST")
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
            except HTTPError as exc:
                if exc.code == 429:
                    # Never retry blindly: the reservation status may have
                    # changed and a partial prior sync must remain visible.
                    raise WriteBudgetRefused(
                        f"ingest {table} refused: daily D1 write budget unavailable or exhausted (HTTP 429)") from exc
                raise RuntimeError(f"ingest {table} failed: HTTP {exc.code}") from exc
            except (URLError, TimeoutError) as exc:
                raise RuntimeError(f"ingest {table} failed: {type(exc).__name__}") from exc
        if responses:
            result[table] = responses[0] if len(responses) == 1 else responses
    return result
