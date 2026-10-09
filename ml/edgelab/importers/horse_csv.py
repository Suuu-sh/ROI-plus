"""Import a user-supplied horse CSV (keiba-data-interface-style columns).

This module only reads local CSV content and performs no network access. It
returns normalized records rather than inserting directly into a database.
Unknown columns are retained in ``source`` for caller-side extensions.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any, Iterable, TextIO


ALIASES = {
    "race_date": ("race_date", "date", "年月日", "開催日"),
    "race_id": ("race_id", "raceid", "レースid", "レースＩＤ"),
    "venue": ("venue", "course", "競馬場", "場名"),
    "race_no": ("race_no", "race_number", "raceno", "レース番号"),
    "horse_number": ("horse_number", "number", "馬番"),
    "frame": ("frame", "枠", "枠番"),
    "horse_id": ("horse_id", "horseid", "馬id", "馬ＩＤ"),
    "horse_name": ("horse_name", "name", "馬名"),
    "jockey": ("jockey", "騎手"), "trainer": ("trainer", "調教師"),
    "age": ("age", "年齢", "馬齢"), "sex": ("sex", "性別"),
    "distance": ("distance", "距離"), "surface": ("surface", "芝・ダ", "コース"),
    "track_condition": ("track_condition", "馬場状態"),
    "weather": ("weather", "天候"),
    "weight_carried": ("weight_carried", "carried_weight", "斤量"),
    "horse_weight": ("horse_weight", "body_weight", "馬体重"),
    "odds": ("odds", "win_odds", "単勝オッズ"),
    "popularity": ("popularity", "人気"), "finish_order": ("finish_order", "着順"),
    "available_at": ("available_at", "取得日時", "availableat"),
}


def _key(value: str) -> str:
    return "".join(str(value).strip().lower().replace("　", " ").split())


def _value(row: dict[str, str], aliases: tuple[str, ...]) -> str | None:
    keys = {_key(k): v for k, v in row.items() if k is not None}
    for alias in aliases:
        value = keys.get(_key(alias))
        if value is not None and value.strip() != "":
            return value.strip()
    return None


def _int(value: str | None) -> int | None:
    try: return int(float(value)) if value is not None else None
    except (ValueError, TypeError): return None


def _float(value: str | None) -> float | None:
    try: return float(value.replace(",", "")) if value is not None else None
    except (ValueError, TypeError): return None


def import_horse_csv(source: str | Path | TextIO, *, encoding: str = "utf-8-sig") -> list[dict[str, Any]]:
    """Read supplied CSV rows and normalize one row per horse entry.

    Accepts a local path or an already-open text stream. Requires race date,
    horse number, and horse name; missing numeric measurements remain ``None``.
    Does not invent race IDs, odds, results, or availability timestamps.
    """
    close = False
    if hasattr(source, "read"):
        stream = source  # type: ignore[assignment]
    else:
        stream = Path(source).open("r", encoding=encoding, newline="")
        close = True
    try:
        rows = []
        for line_no, raw in enumerate(csv.DictReader(stream), start=2):
            normalized = {name: _value(raw, aliases) for name, aliases in ALIASES.items()}
            missing = [name for name in ("race_date", "horse_number", "horse_name") if not normalized[name]]
            if missing:
                raise ValueError(f"CSV line {line_no}: required column value missing: {', '.join(missing)}")
            date_str = normalized["race_date"] or ""
            if len(date_str) == 8 and date_str.isdigit():
                date_str = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
            # Validate rather than silently guessing locale-specific dates.
            from datetime import date
            date.fromisoformat(date_str)
            row = {
                "race_date": date_str, "race_id": normalized["race_id"], "venue": normalized["venue"],
                "race_no": _int(normalized["race_no"]), "number": _int(normalized["horse_number"]),
                "frame": _int(normalized["frame"]),
                "horse_id": normalized["horse_id"], "horse_name": normalized["horse_name"],
                "jockey": normalized["jockey"], "trainer": normalized["trainer"],
                "age": _int(normalized["age"]), "sex": normalized["sex"],
                "distance": _int(normalized["distance"]), "surface": normalized["surface"],
                "track_condition": normalized["track_condition"], "weather": normalized["weather"],
                "weight_carried": _float(normalized["weight_carried"]),
                "horse_weight": _int(normalized["horse_weight"]), "odds": _float(normalized["odds"]),
                "popularity": _int(normalized["popularity"]), "finish_order": _int(normalized["finish_order"]),
                "available_at": normalized["available_at"], "data_origin": "real", "source": raw,
            }
            rows.append(row)
        return rows
    finally:
        if close:
            stream.close()


def import_horse_csv_rows(source: str | Path | TextIO, *, encoding: str = "utf-8-sig") -> dict[str, list[dict[str, Any]]]:
    """Return user CSV data grouped as SPEC D1 table row arrays.

    Unknown/missing venue IDs remain as supplied text. Odds snapshots are only
    emitted when an explicit ``available_at`` timestamp exists.
    """
    rows = import_horse_csv(source, encoding=encoding)
    races: dict[str, dict[str, Any]] = {}
    entries, results, odds = [], [], []
    for row in rows:
        venue = str(row.get("venue") or "unknown")
        race_no = row.get("race_no")
        race_id = row.get("race_id") or f"horse-{row['race_date'].replace('-', '')}-{venue}-{int(race_no or 0):02d}"
        row["race_id"] = race_id
        races.setdefault(race_id, {
            "id": race_id, "sport": "horse", "venue_id": venue,
            "race_date": row["race_date"], "race_no": race_no or 0,
            "name": None, "distance": row.get("distance"), "surface": row.get("surface"),
            "track_condition": row.get("track_condition"), "weather": row.get("weather"),
            "wind_speed": None, "wave_height": None, "post_time": None,
            "status": "finished" if row.get("finish_order") is not None else "scheduled",
            "data_origin": "real",
        })
        number = int(row["number"])
        entry = {
            "id": f"{race_id}-{number}", "race_id": race_id, "number": number,
            "frame": row.get("frame"), "name": row["horse_name"], "jockey": row.get("jockey"),
            "trainer": row.get("trainer"), "weight_carried": row.get("weight_carried"),
            "horse_weight": row.get("horse_weight"), "racer_class": None,
            "national_win_rate": None, "local_win_rate": None, "motor_no": None,
            "motor_2rate": None, "boat_no": None, "boat_2rate": None,
            "exhibition_time": None, "start_exhibition": None,
            "features_json": json.dumps({"horse_id": row.get("horse_id"), "age": row.get("age"),
                "sex": row.get("sex"), "odds_win": row.get("odds"),
                "popularity": row.get("popularity")}, ensure_ascii=False),
            "available_at": row.get("available_at"), "data_origin": "real",
        }
        entries.append(entry)
        if row.get("finish_order") is not None:
            results.append({"race_id": race_id, "number": number,
                            "finish_order": row["finish_order"], "data_origin": "real"})
        if row.get("odds") is not None and row.get("available_at"):
            odds.append({"race_id": race_id, "bet_type": "win", "selection": str(number),
                         "odds": row["odds"], "captured_at": row["available_at"],
                         "source": "user_csv", "data_origin": "real"})
    return {"races": list(races.values()), "entries": entries, "results": results,
            "odds_snapshots": odds}
