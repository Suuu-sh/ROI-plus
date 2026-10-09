"""Throttled backfill of historical rows into production D1.

D1's free plan allows 100k rows written per day, and each upsert writes more
than one row because of indexes. This module sends whole race days, oldest
first, while the measured ``rows_written_24h`` plus an estimate stays under a
budget. Progress is stored locally so it can be resumed by a daily job.
"""
from __future__ import annotations

import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any

from edgelab.storage import load_rows
from edgelab.sync import sync_rows
from edgelab.venues import venue_rows

STATE_PATH = Path("ml/data/backfill_state.json")
# Measured on roi-plus: 53,302 write statements produced 130,506 rows written.
WRITE_AMPLIFICATION = 2.6
# D1 の書き込み上限（10万行/日）はアカウント内の全 DB 合計。ROI+ は最大約3.5万行/日に抑え、
# 他の DB（reysonai など）に余裕を残す。指標が読めないときは使用済みをこの値と仮定する。
ASSUMED_USAGE_WITHOUT_METRICS = 20_000
RACE_TABLES = ("entries", "results", "payouts", "predictions")


def rows_written_24h(database: str, cwd: str = "apps/api") -> int:
    """Return D1's rolling 24h rows-written counter via wrangler."""
    out = subprocess.run(["npx", "wrangler", "d1", "info", database], cwd=cwd,
                         capture_output=True, text=True, check=True).stdout
    match = re.search(r"rows_written_24h\s*│\s*([\d,]+)", out)
    if not match:
        raise RuntimeError("rows_written_24h not found in wrangler output")
    return int(match.group(1).replace(",", ""))


def group_by_date(store: dict[str, list[dict[str, Any]]], since: str, until: str | None):
    races = [r for r in store["races"] if r["race_date"] >= since and (until is None or r["race_date"] <= until)]
    date_of = {r["id"]: r["race_date"] for r in races}
    days: dict[str, dict[str, list]] = defaultdict(lambda: {t: [] for t in ("races", *RACE_TABLES)})
    for race in races:
        days[race["race_date"]]["races"].append(race)
    for table in RACE_TABLES:
        for row in store.get(table, []):
            day = date_of.get(row["race_id"])
            if day:
                days[day][table].append(row)
    return dict(sorted(days.items()))


def estimate_writes(day_rows: dict[str, list]) -> int:
    statements = sum(len(v) for v in day_rows.values()) + len(day_rows["races"])  # + finished updates
    return int(statements * WRITE_AMPLIFICATION)


def run(*, since: str, until: str | None, budget: int, database: str,
        state_path: Path = STATE_PATH, dry_run: bool = False) -> dict[str, Any]:
    state = json.loads(state_path.read_text()) if state_path.exists() else {"done": []}
    done = set(state["done"])
    days = {d: rows for d, rows in group_by_date(load_rows(), since, until).items() if d not in done}
    if dry_run:
        used = 0
    else:
        try:
            used = rows_written_24h(database)
        except Exception:  # wrangler/API token unavailable (e.g. CI without CLOUDFLARE_API_TOKEN)
            # Conservative assumption: daily delta + odds + another run today already used this much.
            used = ASSUMED_USAGE_WITHOUT_METRICS
    sent: list[str] = []
    first = True
    for day, rows in days.items():
        cost = estimate_writes(rows)
        if used + cost > budget:
            break
        payload: dict[str, list] = dict(rows)
        if first:  # master rows once per run (idempotent upserts)
            payload["venues"] = venue_rows()
            payload["models"] = load_rows().get("models", [])
            first = False
        if not dry_run:
            sync_rows(payload)
            done.add(day)
            state["done"] = sorted(done)
            state_path.parent.mkdir(parents=True, exist_ok=True)
            state_path.write_text(json.dumps(state, indent=2) + "\n")
        used += cost
        sent.append(day)
    remaining = [d for d in days if d not in sent]
    return {"sent_days": sent, "estimated_rows_written_24h": used, "remaining_days": len(remaining),
            "next_day": remaining[0] if remaining else None}
