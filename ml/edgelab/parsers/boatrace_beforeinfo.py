"""Parser for the official, race-specific BOAT RACE pre-race page.

Rows emitted here carry both source observation metadata and local fetch
availability. The parser deliberately does not read the K-file or infer an
observation time from a neighboring race label.
"""
from __future__ import annotations

from datetime import date, datetime
from html.parser import HTMLParser
import json
import re
from typing import Any
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
OFFICIAL_HOST = "www.boatrace.jp"
BEFOREINFO_PATH = "/owpc/pc/race/beforeinfo"


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[tuple[str, str]]]] = []
        self._table_stack: list[list[list[tuple[str, str]]]] = []
        self._row: list[tuple[str, str]] | None = None
        self._cell_kind: str | None = None
        self._cell: list[str] = []
        self.text: list[str] = []
        self._ignored = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = {key: value or "" for key, value in attrs}
        if tag in {"script", "style"}:
            self._ignored += 1
        if self._ignored:
            return
        if tag == "table":
            table: list[list[tuple[str, str]]] = []
            self._table_stack.append(table)
            self.tables.append(table)
        elif tag == "tr" and self._table_stack:
            self._row = []
        elif tag in {"th", "td"} and self._row is not None:
            self._cell_kind, self._cell = tag, []
        elif tag == "img":
            value = attrs_map.get("alt") or attrs_map.get("title")
            if value:
                if self._cell_kind is not None:
                    self._cell.append(value)
                self.text.append(value)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self._ignored:
            self._ignored -= 1
            return
        if self._ignored:
            return
        if tag in {"th", "td"} and self._row is not None and self._cell_kind is not None:
            self._row.append((self._cell_kind, " ".join(self._cell).strip()))
            self._cell_kind, self._cell = None, []
        elif tag == "tr" and self._row is not None:
            if self._table_stack:
                self._table_stack[-1].append(self._row)
            self._row = None
        elif tag == "table" and self._table_stack:
            self._table_stack.pop()

    def handle_data(self, data: str) -> None:
        if self._ignored:
            return
        value = data.strip()
        if value:
            self.text.append(value)
        if self._cell_kind is not None and data.strip():
            self._cell.append(data.strip())


def beforeinfo_url(race_no: int, venue_code: str, target_date: str | date) -> str:
    day = date.fromisoformat(target_date) if isinstance(target_date, str) else target_date
    if not (1 <= int(race_no) <= 12 and str(venue_code).isdigit() and len(str(venue_code)) == 2):
        raise ValueError("invalid BOAT RACE venue or race number")
    return (f"https://{OFFICIAL_HOST}{BEFOREINFO_PATH}?hd={day:%Y%m%d}"
            f"&jcd={venue_code}&rno={int(race_no)}")


def _identity_from_url(url: str, race_id: str) -> tuple[str, str, int]:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    if parsed.scheme != "https" or parsed.hostname != OFFICIAL_HOST or parsed.path != BEFOREINFO_PATH:
        raise ValueError("pre-race source must be the official race-specific beforeinfo page")
    day = query.get("hd", [""])[0]
    venue = query.get("jcd", [""])[0]
    race_no = query.get("rno", [""])[0]
    match = re.fullmatch(r"boat-(\d{8})-(\d{2})-(\d{2})", race_id)
    if not match or (day, venue, race_no.zfill(2)) != (match.group(1), match.group(2), match.group(3)):
        raise ValueError("pre-race source identity does not match race_id")
    return day, venue, int(race_no)


def _number(value: str) -> float | None:
    normalized = value.strip().replace(",", "")
    if normalized[:1].upper() == "F":
        normalized = normalized[1:]
    match = re.search(r"[-+]?(?:\d+(?:\.\d+)?|\.\d+)", normalized)
    if not match:
        return None
    try:
        number = float(match.group())
        return number if number == number and abs(number) != float("inf") else None
    except ValueError:
        return None


def _header_index(headers: list[str], *needles: str) -> int | None:
    for index, label in enumerate(headers):
        if any(needle in label for needle in needles):
            return index
    return None


def _lane(value: str) -> int | None:
    match = re.search(r"(?:^|\D)([1-6])(?:\D|$)", value.strip())
    return int(match.group(1)) if match else None


def _tables(html: str) -> tuple[list[list[list[tuple[str, str]]]], str]:
    parser = _PageParser()
    parser.feed(html)
    return parser.tables, " ".join(parser.text)


def _weather(text: str, day: str) -> tuple[dict[str, Any], str | None, str | None]:
    # Exact clock readings become timestamps in the race's local timezone.
    # Labels such as "11R時点" remain labels and never acquire a guessed time.
    exact = re.search(r"(?:水面)?気象情報\s*(\d{1,2}:\d{2})\s*現在", text)
    label_match = re.search(r"(\d{1,2}:\d{2}\s*現在|\d{1,2}R時点)", text)
    observed_at = None
    label = label_match.group(1).replace(" ", "") if label_match else None
    if exact:
        hour, minute = (int(part) for part in exact.group(1).split(":"))
        observed_at = datetime.strptime(day, "%Y%m%d").replace(
            hour=hour, minute=minute, tzinfo=JST).isoformat(timespec="minutes")
    values: dict[str, Any] = {}
    matchers = {
        "wind_speed": r"風速\s*[:：]?\s*([-+]?\d+(?:\.\d+)?)\s*m",
        "wave_height": r"波高\s*[:：]?\s*([-+]?\d+(?:\.\d+)?)\s*cm",
        "air_temperature": r"気温\s*[:：]?\s*([-+]?\d+(?:\.\d+)?)\s*℃",
        "water_temperature": r"水温\s*[:：]?\s*([-+]?\d+(?:\.\d+)?)\s*℃",
    }
    for key, pattern in matchers.items():
        found = re.search(pattern, text)
        if found:
            values[key] = float(found.group(1))
    direction = re.search(r"風向\s*[:：]?\s*(北東|北西|南東|南西|北|東|南|西)", text)
    if direction:
        values["wind_direction"] = direction.group(1)
    weather = re.search(r"天候\s*[:：]?\s*(晴れ?|曇り?|雨|雪)", text)
    if weather:
        values["weather"] = weather.group(1)
    return values, observed_at, label


def parse_beforeinfo(html: str, *, race_id: str, source_url: str, source_sha256: str,
                     fetched_at: str) -> list[dict[str, Any]]:
    """Extract authentic exhibition, start-exhibition and page-weather values."""
    day, _, _ = _identity_from_url(source_url, race_id)
    if not re.fullmatch(r"[a-f0-9]{64}", source_sha256):
        raise ValueError("source SHA256 is required")
    fetched = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    if fetched.tzinfo is None:
        raise ValueError("fetched_at must have a timezone")
    tables, text = _tables(html)
    observations: list[dict[str, Any]] = []
    exhibition: dict[int, dict[str, Any]] = {}
    for table in tables:
        for header_row, cells in enumerate(table):
            headers = [value.replace("\u3000", " ").strip() for _, value in cells]
            lane_idx = _header_index(headers, "枠", "艇")
            exhibit_idx = _header_index(headers, "展示タイム")
            tilt_idx = _header_index(headers, "チルト")
            if lane_idx is None or exhibit_idx is None:
                continue
            weight_idx = _header_index(headers, "体重")
            for row in table[header_row + 1:]:
                values = [value for _, value in row]
                if max(lane_idx, exhibit_idx) >= len(values):
                    continue
                lane = _lane(values[lane_idx])
                if lane is None:
                    continue
                item: dict[str, Any] = {}
                display_time = _number(values[exhibit_idx])
                if display_time is not None:
                    item["exhibition_time"] = display_time
                if tilt_idx is not None and tilt_idx < len(values):
                    tilt = _number(values[tilt_idx])
                    if tilt is not None:
                        item["tilt"] = tilt
                if weight_idx is not None and weight_idx < len(values):
                    weight = _number(values[weight_idx])
                    if weight is not None:
                        item["weight"] = weight
                if item:
                    exhibition[lane] = item
            break

    for table in tables:
        for header_row, cells in enumerate(table):
            headers = [value.strip().upper() for _, value in cells]
            course_idx = _header_index(headers, "コース")
            st_idx = _header_index(headers, "ST")
            if course_idx is None or st_idx is None:
                continue
            for row in table[header_row + 1:]:
                values = [value for _, value in row]
                if max(course_idx, st_idx) >= len(values):
                    continue
                lane = _lane(values[course_idx])
                if lane is None:
                    continue
                raw = values[st_idx].strip()
                number = _number(raw)
                item = exhibition.setdefault(lane, {})
                if number is not None:
                    item["start_exhibition"] = number
                if "F" in raw.upper():
                    item["start_exhibition_false_start"] = True
                else:
                    item.setdefault("start_exhibition_false_start", False)
                item["start_exhibition_course"] = float(lane)
            break

    for lane, values in sorted(exhibition.items()):
        observations.append({"id": f"{race_id}:exhibition:{lane}:{fetched.isoformat()}",
            "race_id": race_id, "kind": "exhibition", "entry_number": lane,
            "source_url": source_url, "source_sha256": source_sha256,
            "source_observed_at": None, "source_observation_label": None,
            "fetched_at": fetched.isoformat(), "available_at": fetched.isoformat(),
            "values_json": json.dumps(values, ensure_ascii=False, separators=(",", ":")),
            "data_origin": "real"})

    weather, observed_at, label = _weather(text, day)
    if weather:
        observations.append({"id": f"{race_id}:weather:0:{fetched.isoformat()}",
            "race_id": race_id, "kind": "weather", "entry_number": 0,
            "source_url": source_url, "source_sha256": source_sha256,
            "source_observed_at": observed_at, "source_observation_label": label,
            "fetched_at": fetched.isoformat(), "available_at": fetched.isoformat(),
            "values_json": json.dumps(weather, ensure_ascii=False, separators=(",", ":")),
            "data_origin": "real"})
    if not observations:
        raise ValueError("official beforeinfo page contained no recognized exhibition or weather values")
    return observations
