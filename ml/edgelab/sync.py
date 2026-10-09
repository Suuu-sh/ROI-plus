"""Send normalized D1 rows to the EdgeLab ingest API."""
from __future__ import annotations

import json
import os
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
    "models": "models",
    "collection_runs": "collection-runs",
}
SEND_ORDER = ("venues", "races", "entries", "results", "payouts", "odds_snapshots", "models", "predictions", "collection_runs")


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
        for start in range(0, len(values), 500):
            payload = json.dumps(values[start:start + 500], ensure_ascii=False).encode("utf-8")
            req = Request(f"{base_url}/api/ingest/{ENDPOINTS[table]}", data=payload,
                          headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                                   "User-Agent": "EdgeLab-ML/0.1"}, method="POST")
            try:
                with urlopen(req, timeout=30) as response:
                    responses.append({"status": response.status, "body": response.read().decode("utf-8", "replace")})
            except (HTTPError, URLError, TimeoutError) as exc:
                raise RuntimeError(f"ingest {table} failed: {exc}") from exc
        if responses:
            result[table] = responses[0] if len(responses) == 1 else responses
    return result
