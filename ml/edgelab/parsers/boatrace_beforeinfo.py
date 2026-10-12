"""Parser for the official, race-specific BOAT RACE pre-race page.

Rows emitted here carry both source observation metadata and local fetch
availability. The parser deliberately does not read the K-file or infer an
observation time from a neighboring race label.
"""
from __future__ import annotations

from datetime import date, datetime
from html import unescape
from html.parser import HTMLParser
import json
import re
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
OFFICIAL_HOST = "www.boatrace.jp"
BEFOREINFO_PATH = "/owpc/pc/race/beforeinfo"
_IDENTITY_PAGE_TYPES = {"racelist", "raceresult", "beforeinfo", "pcexpect", "myexpect"}
_TIME_PATTERN = re.compile(r"(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)")


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[tuple[str, str]]]] = []
        self._table_stack: list[list[list[tuple[str, str]]]] = []
        self._row: list[tuple[str, str]] | None = None
        self._cell_kind: str | None = None
        self._cell: list[str] = []
        self.text: list[str] = []
        self.classes: list[str] = []
        self._ignored = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = {key: value or "" for key, value in attrs}
        self.classes.extend(attrs_map.get("class", "").split())
        if tag in {"script", "style"}:
            self._ignored += 1
        if self._ignored:
            return
        if tag == "br":
            if self._cell_kind is not None:
                self._cell.append(" ")
            self.text.append(" ")
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


class _PageIdentityParser(HTMLParser):
    """Collect race links inside the official page's tab3 navigation block."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.div_depth = 0
        self.tab3_depth: int | None = None
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = dict(attrs)
        if tag == "div":
            next_depth = self.div_depth + 1
            classes = (attrs_map.get("class") or "").split()
            if self.tab3_depth is None and "tab3" in classes:
                self.tab3_depth = next_depth
            self.div_depth = next_depth
        elif tag == "a" and self.tab3_depth is not None and attrs_map.get("href"):
            self.hrefs.append(str(attrs_map["href"]))

    def handle_endtag(self, tag: str) -> None:
        if tag == "div" and self.div_depth:
            if self.tab3_depth == self.div_depth:
                self.tab3_depth = None
            self.div_depth -= 1


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


def _identity_from_page(html: str) -> tuple[str, str, int]:
    """Read the page's selected-race identity from its own tab links."""
    parser = _PageIdentityParser()
    parser.feed(html)
    identities: list[tuple[str, str, int]] = []
    for href in parser.hrefs:
        url = urljoin(f"https://{OFFICIAL_HOST}{BEFOREINFO_PATH}", unescape(href))
        parsed = urlparse(url)
        page_type = parsed.path.rsplit("/", 1)[-1]
        if parsed.scheme != "https" or parsed.hostname != OFFICIAL_HOST or page_type not in _IDENTITY_PAGE_TYPES:
            continue
        query = parse_qs(parsed.query)
        day = query.get("hd", [""])[0]
        venue = query.get("jcd", [""])[0]
        race_text = query.get("rno", [""])[0]
        if not re.fullmatch(r"\d{8}", day) or not re.fullmatch(r"\d{2}", venue) or not race_text.isdigit():
            raise ValueError("malformed official race identity")
        race_no = int(race_text)
        if not 1 <= race_no <= 12:
            raise ValueError("malformed official race identity")
        identities.append((day, venue, race_no))
    if len(identities) < 2:
        raise ValueError("insufficient official race identity evidence")
    if any(identity != identities[0] for identity in identities[1:]):
        raise ValueError("conflicting official race identity evidence")
    return identities[0]


def parse_beforeinfo_cutoff(html: str, *, race_id: str, source_url: str) -> str:
    """Extract only the page-identified, explicitly labelled scheduled cutoff."""
    expected = _identity_from_url(source_url, race_id)
    if _identity_from_page(html) != expected:
        raise ValueError("official beforeinfo page identity mismatch")
    day, _, race_no = expected
    tables, _, _ = _tables(html)
    candidates: list[str] = []
    for table in tables:
        for row in table:
            row_text = " ".join(value for _, value in row)
            if "締切予定時刻" not in row_text:
                continue
            times = [f"{hour.zfill(2)}:{minute}" for hour, minute in _TIME_PATTERN.findall(row_text)]
            if len(times) == 1:
                candidates.append(times[0])
            elif len(times) == 12:
                candidates.append(times[race_no - 1])
            else:
                raise ValueError("official cutoff schedule row is incomplete or ambiguous")
    if not candidates or len(set(candidates)) != 1:
        raise ValueError("explicit official cutoff label/time missing or ambiguous")
    hour, minute = (int(part) for part in candidates[0].split(":"))
    return datetime.strptime(day, "%Y%m%d").replace(hour=hour, minute=minute, tzinfo=JST).isoformat(timespec="seconds")


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


def _span_values(row_html: str, class_name: str) -> list[str]:
    values = []
    for match in re.finditer(r"<span\b([^>]*)>([\s\S]*?)</span>", row_html, flags=re.IGNORECASE):
        classes = re.search(r"\bclass\s*=\s*([\"'])(.*?)\1", match.group(1), flags=re.IGNORECASE)
        if not classes or class_name not in classes.group(2).split():
            continue
        value = unescape(re.sub(r"<[^>]*>", "", match.group(2))).strip()
        values.append(value)
    return values


def _start_exhibition_values(html: str) -> dict[int, dict[str, Any]]:
    """Read boat identity, ST, and course order from official child spans."""
    values_by_lane: dict[int, dict[str, Any]] = {}
    course = 0
    for row_match in re.finditer(r"<tr\b[^>]*>([\s\S]*?)</tr>", html, flags=re.IGNORECASE):
        row = row_match.group(1)
        boats = _span_values(row, "table1_boatImage1Number")
        times = _span_values(row, "table1_boatImage1Time")
        if not boats and not times:
            continue
        if len(boats) != 1 or len(times) != 1:
            raise ValueError("official start-exhibition boat/time spans are ambiguous")
        lane = _lane(boats[0])
        if lane is None or lane in values_by_lane:
            raise ValueError("official start-exhibition boat identity is invalid or duplicated")
        course += 1
        item: dict[str, Any] = {"start_exhibition_course": float(course)}
        timing = times[0]
        start = _number(timing)
        if start is not None:
            item["start_exhibition"] = start
        if timing:
            item["start_exhibition_false_start"] = timing.lstrip().upper().startswith("F")
        values_by_lane[lane] = item
    return values_by_lane


def _tables(html: str) -> tuple[list[list[list[tuple[str, str]]]], str, list[str]]:
    parser = _PageParser()
    parser.feed(html)
    return parser.tables, " ".join(parser.text), parser.classes


def _weather(text: str, day: str, classes: list[str] | None = None) -> tuple[dict[str, Any], str | None, str | None]:
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
    else:
        # The official page renders its wind indicator as a directional CSS
        # class instead of Japanese text. Preserve that source marker and map
        # its 12 compass positions to the closest direction in our feature set.
        wind_class = next((name for name in (classes or [])
                           if re.fullmatch(r"is-wind(?:[1-9]|1[0-2])", name)), None)
        if wind_class:
            hour = int(wind_class.removeprefix("is-wind"))
            direction_by_hour = {12: "北", 1: "北東", 2: "北東", 3: "東",
                4: "南東", 5: "南東", 6: "南", 7: "南西", 8: "南西",
                9: "西", 10: "北西", 11: "北西"}
            values["wind_direction"] = direction_by_hour[hour]
            values["wind_direction_class"] = wind_class
    weather = re.search(r"天候\s*[:：]?\s*(晴れ?|曇り?|雨|雪)", text)
    if weather:
        values["weather"] = weather.group(1)
    return values, observed_at, label


def parse_beforeinfo(html: str, *, race_id: str, source_url: str, source_sha256: str,
                     fetched_at: str) -> list[dict[str, Any]]:
    """Extract authentic exhibition, start-exhibition and page-weather values."""
    expected_identity = _identity_from_url(source_url, race_id)
    if _identity_from_page(html) != expected_identity:
        raise ValueError("official beforeinfo page identity mismatch")
    day, _, _ = expected_identity
    if not re.fullmatch(r"[a-f0-9]{64}", source_sha256):
        raise ValueError("source SHA256 is required")
    fetched = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    if fetched.tzinfo is None:
        raise ValueError("fetched_at must have a timezone")
    tables, text, classes = _tables(html)
    observations: list[dict[str, Any]] = []
    exhibition: dict[int, dict[str, Any]] = {}
    for table in tables:
        for header_row, cells in enumerate(table):
            headers = [re.sub(r"\s+", "", value.replace("\u3000", " ")).strip() for _, value in cells]
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

    for lane, values in _start_exhibition_values(html).items():
        exhibition.setdefault(lane, {}).update(values)

    for lane, values in sorted(exhibition.items()):
        observations.append({"id": f"{race_id}:exhibition:{lane}:{fetched.isoformat()}",
            "race_id": race_id, "kind": "exhibition", "entry_number": lane,
            "source_url": source_url, "source_sha256": source_sha256,
            "source_observed_at": None, "source_observation_label": None,
            "fetched_at": fetched.isoformat(), "available_at": fetched.isoformat(),
            "values_json": json.dumps(values, ensure_ascii=False, separators=(",", ":")),
            "data_origin": "real"})

    weather, observed_at, label = _weather(text, day, classes)
    if observed_at is not None and datetime.fromisoformat(observed_at) > fetched.astimezone(JST):
        # Do not expose a source clock that is ahead of the page capture. The
        # preserved label also keeps this weather out of point-in-time features.
        observed_at = None
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
