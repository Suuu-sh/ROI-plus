"""Low-frequency official Boatrace win-odds collector."""
from __future__ import annotations

import re
import time
from datetime import date, datetime
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from . import boatrace

BASE_URL = "https://www.boatrace.jp/owpc/pc/race/oddstf"
USER_AGENT = "EdgeLab/0.1 (polite official Boatrace odds collector)"


class _OddsParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.values: list[str] = []
        self.final = False
        self._inside = False
        self._text = ""
        self._tag = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "oddsPoint" in attrs.get("class", "").split():
            self._inside, self._text, self._tag = True, "", tag

    def handle_data(self, data):
        if self._inside:
            self._text += data
        if "締切時オッズ" in data:
            self.final = True

    def handle_endtag(self, tag):
        if self._inside and tag == self._tag:
            self.values.append(self._text.strip())
            self._inside = False


def parse_win_odds(html: str) -> dict:
    parser = _OddsParser()
    parser.feed(html)
    values = parser.values[:6]
    odds = {}
    for n in range(1, 7):
        raw = values[n - 1] if n <= len(values) else ""
        match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*", raw)
        odds[n] = float(match.group(1)) if match else None
    return {"final": parser.final, "odds": odds}


def odds_url(race_no: int, venue_code: str, target_date: str | date) -> str:
    day = date.fromisoformat(target_date) if isinstance(target_date, str) else target_date
    return f"{BASE_URL}?rno={int(race_no)}&jcd={venue_code}&hd={day:%Y%m%d}"


def fetch_win_odds(race_no: int, venue_code: str, target_date: str | date, *, retries: int = 3,
                   timeout: float = 20.0) -> str | None:
    request = Request(odds_url(race_no, venue_code, target_date), headers={"User-Agent": USER_AGENT})
    for attempt in range(retries + 1):
        boatrace._wait_for_slot()
        try:
            with urlopen(request, timeout=timeout) as response:
                body = response.read()
            return body.decode("utf-8", "replace") if body else None
        except HTTPError as exc:
            if exc.code == 404:
                return None
            if exc.code < 500 and exc.code not in (408, 425, 429):
                raise
            error = exc
        except (URLError, TimeoutError, OSError) as exc:
            error = exc
        if attempt < retries:
            time.sleep(min(2 ** attempt, 30))
    raise RuntimeError("failed to fetch Boatrace odds") from error


def make_snapshot_rows(race_id: str, parsed: dict, captured_at: str) -> list[dict]:
    source = "boatrace-odds-tf-final" if parsed["final"] else "boatrace-odds-tf"
    return [{"id": f"{race_id}:win:{n}:{captured_at}", "race_id": race_id,
             "bet_type": "win", "selection": str(n), "odds": odds,
             "captured_at": captured_at, "source": source, "data_origin": "real"}
            for n, odds in parsed["odds"].items() if odds is not None]
