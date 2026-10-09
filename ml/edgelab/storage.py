"""Small local JSON row store used between collection, training and sync."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any

DEFAULT_STORE = Path("ml/data/rows.json")

def load_rows(path: str | Path = DEFAULT_STORE) -> dict[str, list[dict[str, Any]]]:
    target = Path(path)
    if not target.exists():
        return {k: [] for k in ("races", "entries", "odds_snapshots", "results", "payouts", "predictions", "models", "collection_runs")}
    return json.loads(target.read_text(encoding="utf-8"))

def save_rows(rows: dict[str, list[dict[str, Any]]], path: str | Path = DEFAULT_STORE) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def merge_rows(target: dict[str, list[dict[str, Any]]], incoming: dict[str, list[dict[str, Any]]]) -> None:
    """Idempotently merge rows using their natural keys from SPEC."""
    keys = {"races": ("id",), "entries": ("race_id", "number"), "results": ("race_id", "number"),
            "payouts": ("race_id", "bet_type", "selection"),
            "odds_snapshots": ("race_id", "bet_type", "selection", "captured_at"),
            "predictions": ("race_id", "model_id", "number", "predicted_at"),
            "models": ("id",), "collection_runs": ("id",)}
    for table, new_rows in incoming.items():
        if table not in keys:
            continue
        existing = target.setdefault(table, [])
        index = {tuple(row.get(k) for k in keys[table]): i for i, row in enumerate(existing)}
        for row in new_rows:
            natural = tuple(row.get(k) for k in keys[table])
            if natural in index:
                previous = existing[index[natural]]
                # K files enrich B rows; preserve fields absent from the newer
                # source rather than erasing prior facts with SQL-style NULLs.
                merged = {**previous, **{key: value for key, value in row.items() if value is not None}}
                if isinstance(previous.get("features_json"), str) and isinstance(row.get("features_json"), str):
                    try:
                        extras = json.loads(previous["features_json"])
                        extras.update(json.loads(row["features_json"]))
                        merged["features_json"] = json.dumps(extras, ensure_ascii=False, separators=(",", ":"))
                    except (ValueError, TypeError):
                        pass
                existing[index[natural]] = merged
            else:
                index[natural] = len(existing)
                existing.append(row)
