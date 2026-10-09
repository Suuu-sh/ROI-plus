"""Parser for official Boatrace B (program) text files.

The parser intentionally returns plain D1-shaped dictionaries (snake_case), so
callers can pass each table directly to the ingest API without a second rename
layer.  Missing source values stay ``None``; the source does not supply a
reliable publication timestamp, so ``available_at`` uses the race-day JST
midnight as a conservative day-level approximation.
"""
from __future__ import annotations

import re
import json
import unicodedata
from datetime import date
from typing import Any


VENUES = {
    "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川",
    "06": "浜名湖", "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国",
    "11": "びわこ", "12": "住之江", "13": "尼崎", "14": "鳴門", "15": "丸亀",
    "16": "児島", "17": "宮島", "18": "徳山", "19": "下関", "20": "若松",
    "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村",
}
_VENUE_CODES = {re.sub(r"\s+", "", name): code for code, name in VENUES.items()}
_PREFECTURES = (
    "北海道", "青森", "岩手", "宮城", "秋田", "山形", "福島", "茨城", "栃木", "群馬",
    "埼玉", "千葉", "東京", "神奈川", "新潟", "富山", "石川", "福井", "山梨", "長野",
    "岐阜", "静岡", "愛知", "三重", "滋賀", "京都", "大阪", "兵庫", "奈良", "和歌山",
    "鳥取", "島根", "岡山", "広島", "山口", "徳島", "香川", "愛媛", "高知", "福岡",
    "佐賀", "長崎", "熊本", "大分", "宮崎", "鹿児島", "沖縄",
)
_PREF_RE = "|".join(sorted(_PREFECTURES, key=len, reverse=True))
_NUM = r"(?:\d+(?:\.\d+)?|[-―]+)"
_RATE = r"(?:\d{1,2}\.\d{2}|[-―]+)"
_ENTRY_RE = re.compile(
    rf"^\s*([1-6])\s+(\d{{4}})(.+?)(\d{{2}})({_PREF_RE})(\d{{2}})([A-Z]\d)"
    rf"\s+({_RATE})\s+({_RATE})\s+({_RATE})\s+({_RATE})\s+(\d{{1,2}})\s+({_RATE})"
    # Some venues have 3-digit boat numbers; the source's fixed-width column
    # then touches the preceding motor rate (e.g. ``40.43147``).
    rf"\s*(\d{{1,3}})\s+({_RATE})(?:\s|$)"
)


def _text(source: str | bytes) -> str:
    if isinstance(source, bytes):
        for encoding in ("utf-8-sig", "cp932", "shift_jis"):
            try:
                source = source.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            source = source.decode("cp932", errors="replace")
    return unicodedata.normalize("NFKC", source).replace("\x00", "")


def _number(value: str | None) -> float | None:
    if value is None or not value.strip() or re.fullmatch(r"[-―]+", value.strip()):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _venue_from_line(line: str) -> str | None:
    # Boat/racer rows contain branch names such as 福岡 and 東京; only trust
    # venue names on actual venue headings, not arbitrary source lines.
    compact = re.sub(r"\s+", "", line)
    if "ボートレース" not in compact and "[成績]" not in compact:
        return None
    for name, code in _VENUE_CODES.items():
        if name in compact:
            return code
    return None


def _date_from_text(text: str, fallback: str | date | None) -> str | None:
    match = re.search(r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", text)
    if not match:
        match = re.search(r"(20\d{2})\s*/\s*(\d{1,2})\s*/\s*(\d{1,2})", text)
    if match:
        try:
            return date(int(match[1]), int(match[2]), int(match[3])).isoformat()
        except ValueError:
            pass
    if isinstance(fallback, date):
        return fallback.isoformat()
    if fallback:
        try:
            return date.fromisoformat(str(fallback)).isoformat()
        except ValueError:
            return None
    return None


def parse_b(source: str | bytes, race_date: str | date | None = None,
            venue_code: str | None = None) -> dict[str, list[dict[str, Any]]]:
    """Parse a B file into ``races`` and ``entries`` D1 row arrays.

    B files can contain multiple venues. Venue codes are inferred from the
    official Japanese venue heading; ``venue_code`` is only a fallback for
    source variants whose heading omits that name.
    """
    text = _text(source)
    date_value = _date_from_text(text, race_date)
    if date_value is None:
        raise ValueError("B file does not include a usable race date")

    races: list[dict[str, Any]] = []
    entries: list[dict[str, Any]] = []
    current_venue = venue_code
    current_race: dict[str, Any] | None = None
    for line in text.splitlines():
        header_code = re.match(r"^\s*(\d{2})BBGN\b", line)
        if header_code:
            current_venue = header_code[1]
        detected = _venue_from_line(line)
        if detected:
            current_venue = detected

        heading = re.match(r"^\s*(\d{1,2})\s*R\b(.*)$", line)
        if heading:
            if not current_venue:
                # Ignore prose that happens to resemble a race header until a
                # venue is known rather than inventing an ID.
                current_race = None
                continue
            race_no = int(heading.group(1))
            tail = heading.group(2)
            distance = re.search(r"H\s*(\d{3,4})\s*m", tail, re.I)
            deadline = re.search(r"(\d{1,2})\s*:\s*(\d{2})", tail)
            iso_post_time = (f"{date_value}T{int(deadline[1]):02d}:{deadline[2]}:00+09:00"
                             if deadline else None)
            current_race = {
                "id": f"boat-{date_value.replace('-', '')}-{current_venue}-{race_no:02d}",
                "sport": "boat", "venue_id": current_venue, "race_date": date_value,
                "race_no": race_no,
                "name": re.split(r"\s+H\s*\d", tail, maxsplit=1)[0].strip() or None,
                "distance": int(distance[1]) if distance else None,
                "surface": None, "track_condition": None, "weather": None,
                "wind_speed": None, "wave_height": None, "post_time": iso_post_time,
                "status": "scheduled", "data_origin": "real",
            }
            races.append(current_race)
            continue

        if not current_race:
            continue
        match = _ENTRY_RE.match(line)
        if not match:
            continue
        (number, racer_id, name, age, prefecture, weight, racer_class,
         national_rate, national_2rate, local_rate, local_2rate,
         motor_no, motor_2rate, boat_no, boat_2rate) = match.groups()
        clean_name = re.sub(r"\s+", "", name).strip()
        entries.append({
            "id": f"{current_race['id']}-{int(number)}",
            "race_id": current_race["id"], "number": int(number), "frame": int(number),
            "name": clean_name or racer_id, "jockey": None, "trainer": None,
            "weight_carried": _number(weight), "horse_weight": None,
            "racer_class": racer_class,
            "national_win_rate": _number(national_rate), "local_win_rate": _number(local_rate),
            "motor_no": motor_no, "motor_2rate": _number(motor_2rate),
            "boat_no": boat_no, "boat_2rate": _number(boat_2rate),
            "exhibition_time": None, "start_exhibition": None,
            "features_json": json.dumps({
                "racer_id": racer_id, "age": int(age), "branch": prefecture,
                "national_2rate": _number(national_2rate),
                "local_2rate": _number(local_2rate),
            }, ensure_ascii=False, separators=(",", ":")),
            "available_at": f"{date_value}T00:00:00+09:00",
            "data_origin": "real",
        })
    return {"races": races, "entries": entries}


parse = parse_b
