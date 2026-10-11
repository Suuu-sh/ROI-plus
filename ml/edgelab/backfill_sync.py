"""Preview historical D1 backfill payloads; remote historical writes are disabled.

Daily D1 capacity is reserved for current/previous results, payouts, entries,
and active predictions. A future historical backfill requires a separate
explicit operator decision and is not enabled by this command.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from edgelab.storage import load_rows

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
    if not dry_run:
        return {"skipped": True,
                "reason": "remote historical D1 backfill is disabled; only --dry-run is available",
                "sent_days": [], "remaining_days": len(days),
                "next_day": next(iter(days), None)}

    available = min(max(0, budget), MAX_BACKFILL_BUDGET)
    used = 0
    sent: list[str] = []
    for day, rows in days.items():
        cost = estimate_writes(rows)
        if used + cost > available:
            break
        used += cost
        sent.append(day)
    remaining = [d for d in days if d not in sent]
    result = {"sent_days": sent, "estimated_rows_written": used, "backfill_budget": available,
              "remaining_days": len(remaining), "next_day": remaining[0] if remaining else None,
              "dry_run": True, "remote_sync_performed": False}
    return result
