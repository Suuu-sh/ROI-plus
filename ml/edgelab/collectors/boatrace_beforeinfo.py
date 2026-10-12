"""Bounded collector for current-day official BOAT RACE pre-race observations."""
from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Mapping
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from edgelab.collectors.boatrace import USER_AGENT, _wait_for_slot
from edgelab.parsers.boatrace_beforeinfo import (beforeinfo_url, parse_beforeinfo,
    parse_beforeinfo_cutoff)
from edgelab.storage import merge_rows

JST = ZoneInfo("Asia/Tokyo")
MAX_PAGE_BYTES = 512 * 1024
TRUSTED_CUTOFF_SOURCE = "boatrace-racelist-cutoff-v1"


def select_beforeinfo_targets(races: list[Mapping[str, Any]], *, now: datetime,
                              window_min: int = 25) -> list[Mapping[str, Any]]:
    """Select current-JST-day real scheduled races inside a bounded start window."""
    current = now.astimezone(JST) if now.tzinfo else now.replace(tzinfo=JST)
    selected = []
    for race in races:
        if (race.get("sport") != "boat" or race.get("data_origin") != "real"
                or race.get("status") != "scheduled" or race.get("race_date") != current.date().isoformat()):
            continue
        raw_time = race.get("betting_cutoff_at") or race.get("post_time")
        try:
            target = datetime.fromisoformat(str(raw_time).replace("Z", "+00:00"))
            if target.tzinfo is None:
                target = target.replace(tzinfo=JST)
            minutes = (target.astimezone(JST) - current).total_seconds() / 60
        except (TypeError, ValueError):
            continue
        if 0 <= minutes <= window_min:
            selected.append(race)
    return sorted(selected, key=lambda race: (str(race.get("betting_cutoff_at") or race.get("post_time")),
                                              int(race.get("race_no") or 0)))


def fetch_beforeinfo(url: str, *, timeout: float = 15.0) -> tuple[str, str]:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with urlopen(request, timeout=timeout) as response:
        final_url = response.geturl()
        if final_url != url:
            raise ValueError("official beforeinfo request redirected")
        payload = response.read(MAX_PAGE_BYTES + 1)
        if not payload or len(payload) > MAX_PAGE_BYTES:
            raise ValueError("official beforeinfo page missing or oversized")
        content_type = response.headers.get("Content-Type", "")
    charset = "cp932" if "shift_jis" in content_type.lower() or "sjis" in content_type.lower() else "utf-8"
    try:
        html = payload.decode(charset)
    except UnicodeDecodeError:
        html = payload.decode("cp932")
    return html, hashlib.sha256(payload).hexdigest()


def collect_beforeinfo(store: dict[str, list[dict[str, Any]]], *, now: datetime,
                       window_min: int = 25, max_requests: int = 8,
                       fetcher: Callable[[str], tuple[str, str]] | None = None,
                       wait_for_slot: Callable[[], None] | None = None) -> dict[str, Any]:
    """Persist only observations fetched now from matching official pages.

    This is an ordinary near-race collector, not a deadline scheduler. Its
    timestamp is the real fetch time; it never backfills a planned timestamp.
    """
    if window_min < 0 or max_requests < 0:
        raise ValueError("window and request limit must be non-negative")
    current = now.astimezone(JST) if now.tzinfo else now.replace(tzinfo=JST)
    races = [race for race in store.get("races", []) if race.get("race_date") == current.date().isoformat()]
    targets = select_beforeinfo_targets(races, now=current, window_min=window_min)[:min(30, max_requests)]
    fetch = fetcher or (lambda url: fetch_beforeinfo(url))
    pace = wait_for_slot or _wait_for_slot
    observations: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    cutoff_unavailable: list[dict[str, str]] = []
    cutoffs_updated = 0
    cutoff_conflicts = 0
    for race in targets:
        try:
            race_no, venue = int(race["race_no"]), str(race["venue_id"])
            url = beforeinfo_url(race_no, venue, str(race["race_date"]))
            pace()
            html, digest = fetch(url)
            fetched_dt = datetime.now(timezone.utc)
            fetched = fetched_dt.isoformat(timespec="milliseconds")
            observations.extend(parse_beforeinfo(html, race_id=str(race["id"]), source_url=url,
                                                  source_sha256=digest, fetched_at=fetched))
            try:
                cutoff_at = parse_beforeinfo_cutoff(html, race_id=str(race["id"]), source_url=url)
                cutoff_dt = datetime.fromisoformat(cutoff_at)
                actual_now = datetime.now(timezone.utc)
                if fetched_dt > actual_now + timedelta(seconds=5):
                    raise ValueError("future capture timestamp")
                if cutoff_dt <= fetched_dt.astimezone(JST):
                    raise ValueError("official cutoff has expired")
                existing_cutoff = race.get("betting_cutoff_at")
                if race.get("betting_cutoff_source") == TRUSTED_CUTOFF_SOURCE and existing_cutoff:
                    try:
                        same_cutoff = datetime.fromisoformat(str(existing_cutoff).replace("Z", "+00:00")) == cutoff_dt
                    except ValueError:
                        same_cutoff = False
                    if not same_cutoff:
                        cutoff_conflicts += 1
                        cutoff_unavailable.append({"raceId": str(race.get("id", "")),
                                                   "reason": "trusted cutoff conflicts with official page"})
                        continue
                race.update({"betting_cutoff_at": cutoff_at,
                             "betting_cutoff_source": TRUSTED_CUTOFF_SOURCE,
                             "betting_cutoff_observed_at": fetched})
                cutoffs_updated += 1
            except (TypeError, ValueError) as exc:
                cutoff_unavailable.append({"raceId": str(race.get("id", "")),
                                           "reason": str(exc) or type(exc).__name__})
        except Exception as exc:
            failures.append({"raceId": str(race.get("id", "")), "reason": type(exc).__name__})
    merge_rows(store, {"prerace_observations": observations})
    return {"status": "partial" if failures and observations else "failed" if failures else "success" if observations else "skipped",
            "targets": len(targets), "requests": len(targets), "observations": len(observations),
            "cutoffs_updated": cutoffs_updated, "cutoff_conflicts": cutoff_conflicts,
            "cutoff_unavailable": cutoff_unavailable, "failures": failures}
