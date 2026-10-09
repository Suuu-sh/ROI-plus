"""Parser for official Boatrace K (race result) text files."""
from __future__ import annotations

import re
import json
from datetime import date
from typing import Any

from .boatrace_b import VENUES, _date_from_text, _number, _text, _venue_from_line

_RESULT_RE = re.compile(
    r"^\s*(\d{2}|[A-Z]\d|F|L|K\d?|欠場|欠|失格|転覆|妨害|落水|エンスト|不完走)\s+([1-6])\s+(\d{4})\s+(.+?)\s+"
    r"(\d{1,3})\s+(\d{1,3})\s+(\d\.\d{2}|K\s*\.|\.)\s+"
    r"([1-6]|K\s*\.|\.)\s+(?:F)?([+-]?\d\.\d{2}|K\s*\.|\.)"
)
_PAYOUT_TYPES = {
    "単勝": "win", "複勝": "place", "2連複": "quinella", "2連単": "exacta",
    "拡連複": "wide", "3連複": "trio", "3連単": "trifecta",
}


def parse_k(source: str | bytes, race_date: str | date | None = None,
            venue_code: str | None = None) -> dict[str, list[dict[str, Any]]]:
    """Parse a K file into D1-shaped race, entry, result and payout rows.

    Disqualified/scratched rows (for example ``S1``) have no numeric finish
    order in the source and are therefore retained as entry features but
    omitted from ``results``. Only payout kinds represented by the shared
    ``BetType`` enum are emitted; extended quinella is intentionally ignored.
    """
    text = _text(source)
    date_value = _date_from_text(text, race_date)
    if date_value is None:
        raise ValueError("K file does not include a usable race date")

    races: list[dict[str, Any]] = []
    entries: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    payouts: list[dict[str, Any]] = []
    current_venue = venue_code
    current_race: dict[str, Any] | None = None
    in_race_detail = False
    for line in text.splitlines():
        header_code = re.match(r"^\s*(\d{2})KBGN\b", line)
        if header_code:
            current_venue = header_code[1]
        detected = _venue_from_line(line)
        if detected:
            current_venue = detected

        heading = re.match(r"^\s*(\d{1,2})\s*R\b(.*)$", line)
        if heading:
            # The file begins with a compact all-races payout summary such as
            # ``1R 3-5-2 4520 ...``. Those are not race section headings.
            if re.match(r"\s*\d+(?:-\d+){1,2}\b", heading.group(2)):
                continue
            if not current_venue:
                current_race = None
                in_race_detail = False
                continue
            race_no = int(heading.group(1))
            tail = heading.group(2)
            distance = re.search(r"H\s*(\d{3,4})\s*m", tail, re.I)
            weather = re.search(r"H\s*\d{3,4}\s*m\s*(\S+?)\s+風", tail)
            wind = re.search(r"風\s*\S*\s*(\d+)\s*m", tail)
            wind_direction = re.search(r"風\s*([^\d\s]+)", tail)
            wave = re.search(r"波\s*(\d+)\s*cm", tail)
            current_race = {
                "id": f"boat-{date_value.replace('-', '')}-{current_venue}-{race_no:02d}",
                "sport": "boat", "venue_id": current_venue, "race_date": date_value,
                "race_no": race_no,
                "name": re.split(r"\s+H\s*\d", tail, maxsplit=1)[0].strip() or None,
                "distance": int(distance[1]) if distance else None,
                "surface": None, "track_condition": None,
                "weather": weather[1].strip() if weather else None,
                "_wind_direction": wind_direction[1].strip() if wind_direction else None,
                "wind_speed": float(wind[1]) if wind else None,
                "wave_height": float(wave[1]) if wave else None,
                "post_time": None, "status": "finished", "data_origin": "real",
            }
            races.append(current_race)
            in_race_detail = True
            continue
        if not current_race or not in_race_detail:
            continue

        conditions = re.search(
            r"H\s*(\d{3,4})\s*m\s*(\S+)\s+風\s*(.*?)\s*(\d+)\s*m\s+波\s*(\d+)\s*cm",
            line,
        )
        if conditions:
            current_race["distance"] = int(conditions[1])
            current_race["weather"] = conditions[2]
            current_race["_wind_direction"] = re.sub(r"\s+", "", conditions[3]) or None
            current_race["wind_speed"] = float(conditions[4])
            current_race["wave_height"] = float(conditions[5])
            continue

        payout_match = re.match(r"^\s*(単勝|複勝|2連複|2連単|拡連複|3連複|3連単)\s+(.+?)\s*$", line)
        if payout_match:
            bet_type, rest = payout_match.groups()
            # Detailed K rows use one or more selection/payout pairs, optionally
            # followed by a popularity label.
            pair_re = re.compile(
                r"(?<!\d)(\d+(?:-\d+){0,2})\s+(\d+)"
                r"(?:\s+人気\s+(\d+))?"
            )
            for pair in pair_re.finditer(rest):
                selection, amount_text, popularity_text = pair.groups()
                payouts.append({
                    "race_id": current_race["id"], "bet_type": _PAYOUT_TYPES[bet_type],
                    "selection": selection, "payout": int(amount_text),
                    "popularity": int(popularity_text) if popularity_text else None,
                    "data_origin": "real",
                })
            continue

        row = _RESULT_RE.match(line)
        if not row:
            continue
        finish_text, number, racer_id, source_name, motor_no, boat_no, exhibition, start_lane, start = row.groups()
        finish_order = int(finish_text) if finish_text.isdigit() and int(finish_text) > 0 else None
        name = re.sub(r"\s+", "", source_name).strip() or racer_id
        entry_id = f"{current_race['id']}-{int(number)}"
        entries.append({
            "id": entry_id, "race_id": current_race["id"],
            "number": int(number),
            "frame": int(start_lane) if start_lane.isdigit() else None, "name": name,
            "jockey": None, "trainer": None, "weight_carried": None,
            "horse_weight": None, "racer_class": None,
            "national_win_rate": None, "local_win_rate": None,
            "motor_no": motor_no, "motor_2rate": None,
            "boat_no": boat_no, "boat_2rate": None,
            # K files are published after the race. The final column is the
            # race's actual ST result, not a pre-race start exhibition value.
            "exhibition_time": _number(exhibition), "start_exhibition": None,
            "features_json": json.dumps({
                "racer_id": racer_id,
                "finish_code": finish_text if finish_order is None else None,
                "wind_direction": current_race.get("_wind_direction"),
                "race_start_timing": _number(start),
                "entry_course": int(start_lane) if start_lane.isdigit() else None,
            }, ensure_ascii=False, separators=(",", ":")),
            "available_at": f"{date_value}T00:00:00+09:00",
            "data_origin": "real",
        })
        if finish_order is not None:
            results.append({
                "race_id": current_race["id"], "finish_order": finish_order,
                "number": int(number), "data_origin": "real",
            })
    for race in races:
        race.pop("_wind_direction", None)  # D1 race columns do not include wind direction.
    return {"races": races, "entries": entries, "results": results, "payouts": payouts}


parse = parse_k
