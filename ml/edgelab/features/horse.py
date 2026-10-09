"""Horse-race feature transforms and leak-safe historical aggregates."""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from edgelab.normalization.availability import assert_available, filter_historical


FEATURE_COLUMNS = (
    "horse_number", "age", "weight_carried", "horse_weight", "odds", "popularity",
    "distance", "history_starts", "history_wins", "history_win_rate",
    "recent_finish_mean", "jockey_starts", "jockey_wins", "jockey_win_rate",
)


def build_horse_features(entries: Iterable[Mapping[str, Any]], *, race_date: Any,
                         predicted_at: Any | None = None,
                         history: Iterable[Mapping[str, Any]] = ()) -> list[dict[str, Any]]:
    """Build model-ready, numeric features; never use same-day/future outcomes.

    Entries use normalized names from ``horse_csv``. Historical rows must have
    ``race_date`` and ``horse_id`` or ``horse_name``; outcomes use
    ``finish_order``. The function intentionally does not synthesize odds.
    """
    entries = list(entries)
    if predicted_at is not None:
        assert_available(entries, predicted_at)
    prior = filter_historical(history, race_date=race_date, predicted_at=predicted_at)
    def num(row: Mapping[str, Any], *keys: str) -> float | None:
        for key in keys:
            try:
                val = row.get(key)
                if val is not None and val != "":
                    return float(val)
            except (TypeError, ValueError):
                continue
        return None
    output = []
    for entry in entries:
        identity = entry.get("horse_id") or entry.get("horse_name") or entry.get("name")
        past = [r for r in prior if str(r.get("horse_id") or r.get("horse_name") or r.get("name")) == str(identity)]
        wins = sum(1 for r in past if str(r.get("finish_order", "")) == "1")
        try:
            finishes = [float(r["finish_order"]) for r in past
                        if r.get("finish_order") is not None and str(r.get("finish_order")).replace(".", "", 1).isdigit()]
        except (TypeError, ValueError):
            finishes = []
        jockey = entry.get("jockey")
        jockey_rows = [r for r in prior if jockey and r.get("jockey") == jockey]
        jockey_wins = sum(1 for r in jockey_rows if str(r.get("finish_order", "")) == "1")
        output.append({
            "horse_number": num(entry, "number", "horse_number"),
            "age": num(entry, "age"), "weight_carried": num(entry, "weight_carried", "carried_weight"),
            "horse_weight": num(entry, "horse_weight", "body_weight"),
            "odds": num(entry, "odds"), "popularity": num(entry, "popularity"),
            "distance": num(entry, "distance"),
            "history_starts": float(len(past)), "history_wins": float(wins),
            "history_win_rate": wins / len(past) if past else None,
            "recent_finish_mean": (sum(finishes[-5:]) / len(finishes[-5:])) if finishes else None,
            "jockey_starts": float(len(jockey_rows)), "jockey_wins": float(jockey_wins),
            "jockey_win_rate": jockey_wins / len(jockey_rows) if jockey_rows else None,
        })
    return output
