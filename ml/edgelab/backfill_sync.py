"""Throttled backfill of historical rows into D1 using the API budget contract.

Historical days are sent oldest-first only after current/previous-day sync has
completed. Progress is stored locally so it can be resumed by a later run.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from edgelab.storage import load_rows
from edgelab.sync import fetch_write_budget, sync_rows
from edgelab.venues import venue_rows

STATE_PATH = Path("ml/data/backfill_state.json")
# Conservative estimate for indexes and trigger/update amplification.
WRITE_AMPLIFICATION = 2.6
# Historical backfill must leave room for other applications on the account.
MAX_BACKFILL_BUDGET = 20_000
RACE_TABLES = ("entries", "results", "payouts", "predictions")


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
                if table == "entries" and not row.get("available_at"):
                    # 既存キャッシュの補修: 番組情報は開催日 0:00 時点で利用可能
                    row = {**row, "available_at": f"{day}T00:00:00+09:00"}
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
    status = None
    if dry_run:
        available = min(max(0, budget), MAX_BACKFILL_BUDGET)
    else:
        try:
            status = fetch_write_budget()
        except Exception as exc:
            return {"skipped": True, "reason": f"write budget unavailable ({type(exc).__name__})",
                    "sent_days": [], "remaining_days": len(days), "next_day": next(iter(days), None)}
        today_utc = datetime.now(timezone.utc).date().isoformat()
        if status.get("date") != today_utc or status.get("state") != "known":
            return {"skipped": True, "reason": "write budget is not known for the current UTC day",
                    "budget_status": status.get("state"), "sent_days": [],
                    "remaining_days": len(days), "next_day": next(iter(days), None)}
        # Do not infer shared usage. The API's `remaining` is authoritative;
        # this client further limits its historical work to 20k rows/day.
        available = min(max(0, budget), MAX_BACKFILL_BUDGET, status["limit"], status["remaining"])
        if status.get("reserved") is not None:
            available = min(available, max(0, status["limit"] - status["reserved"]))
    used = 0
    sent: list[str] = []
    first = True
    for day, rows in days.items():
        cost = estimate_writes(rows)
        if used + cost > available:
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
    result = {"sent_days": sent, "estimated_rows_written": used, "backfill_budget": available,
              "remaining_days": len(remaining), "next_day": remaining[0] if remaining else None}
    if status is not None:
        result["budget_status"] = status.get("state")
    return result
