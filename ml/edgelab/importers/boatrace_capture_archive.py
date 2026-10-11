"""Verify and import compact BOAT RACE capture archives into the local store.

Archive odds remain in a local-only table; only authentic beforeinfo rows use
the existing observation schema consumed by offline features and training.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import date, datetime
from typing import Any, Mapping, Sequence


ARCHIVE_EXPORT_SCHEMA = "boat-prerace-capture-export-v1"
ARCHIVE_SCHEMA = "boat-prerace-capture-v1"
TRUSTED_CUTOFF_SOURCE = "boatrace-racelist-cutoff-v1"
BEFOREINFO_PARSER = "boatrace-beforeinfo-v1"
ODDS_PARSER = "boatrace-trifecta-odds-v1"
ODDS_SOURCE = "boatrace-trifecta-official-v1"
ODDS_QUALITY = "verified-complete-v1"
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_RACE_ID = re.compile(r"^boat-(\d{8})-(\d{2})-(\d{2})$")
_EXPECTED_SELECTIONS = {f"{a}-{b}-{c}" for a in range(1, 7)
                        for b in range(1, 7) for c in range(1, 7)
                        if len({a, b, c}) == 3}
_EXHIBITION_FIELDS = {
    "exhibitionTime": "exhibition_time", "tilt": "tilt", "weight": "weight",
    "startCourse": "start_exhibition_course", "startTime": "start_exhibition",
    "falseStart": "start_exhibition_false_start",
}
_WEATHER_FIELDS = {
    "windSpeed": "wind_speed", "waveHeight": "wave_height",
    "windDirection": "wind_direction", "windDirectionClass": "wind_direction_class",
    "airTemperature": "air_temperature", "waterTemperature": "water_temperature",
    "weather": "weather",
}


def _timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("timestamp_missing")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp_timezone_missing")
    return parsed


def _source_url(kind: str, race: Mapping[str, Any]) -> str:
    day = str(race["date"]).replace("-", "")
    venue = str(race["venueCode"])
    race_no = int(race["raceNo"])
    if kind == "beforeinfo":
        return ("https://www.boatrace.jp/owpc/pc/race/beforeinfo?"
                f"hd={day}&jcd={venue}&rno={race_no}")
    return ("https://www.boatrace.jp/owpc/pc/race/odds3t?"
            f"rno={race_no}&jcd={venue}&hd={day}")


def _real_race(store: Mapping[str, Any], race_id: str, archive_race: Mapping[str, Any], day: str):
    match = _RACE_ID.fullmatch(race_id)
    if not match:
        return None
    race = next((row for row in store.get("races", [])
                 if row.get("id") == race_id and row.get("sport") == "boat"
                 and row.get("data_origin") == "real"), None)
    if not race:
        return None
    try:
        venue = str(race.get("venue_id"))
        race_no = int(race.get("race_no"))
    except (TypeError, ValueError):
        return None
    if (race.get("race_date") != day or match.group(1) != day.replace("-", "")
            or match.group(2) != venue or match.group(3) != f"{race_no:02d}"
            or not 1 <= race_no <= 12
            or archive_race.get("id") != race_id or archive_race.get("date") != day
            or str(archive_race.get("venueCode")) != venue
            or archive_race.get("raceNo") != race_no
            or archive_race.get("lanes") != [1, 2, 3, 4, 5, 6]):
        return None
    lanes = {row.get("number") for row in store.get("entries", [])
             if row.get("race_id") == race_id and row.get("data_origin") == "real"}
    if lanes != set(range(1, 7)):
        return None
    return race


def _validate_archive(wrapper: Mapping[str, Any], requested_date: str,
                      store: Mapping[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    raw = wrapper.get("archiveJson")
    digest = wrapper.get("archiveSha256")
    if not isinstance(raw, str) or not isinstance(digest, str) or not _SHA256.fullmatch(digest):
        raise ValueError("archive_checksum_missing")
    if hashlib.sha256(raw.encode("utf-8")).hexdigest() != digest:
        raise ValueError("archive_checksum_mismatch")
    try:
        archive = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("archive_json_invalid") from exc
    if not isinstance(archive, dict) or archive.get("schema") != ARCHIVE_SCHEMA:
        raise ValueError("archive_schema_invalid")
    race_payload = archive.get("race")
    if not isinstance(race_payload, dict):
        raise ValueError("archive_race_invalid")
    race_id = wrapper.get("raceId")
    day = wrapper.get("raceDate")
    if (not isinstance(race_id, str) or day != requested_date
            or wrapper.get("date") not in (None, requested_date)):
        raise ValueError("archive_date_mismatch")
    if (type(race_payload.get("raceNo")) is not int
            or not isinstance(race_payload.get("venueCode"), str)):
        raise ValueError("archive_race_invalid")
    race = _real_race(store, race_id, race_payload, requested_date)
    if not race:
        raise ValueError("race_identity_or_real_race_missing")
    if wrapper.get("id") != f"{race_id}:capture:{int(_timestamp(wrapper.get('capturedAt')).timestamp() * 1000):013d}":
        raise ValueError("archive_id_mismatch")

    before = archive.get("beforeinfo")
    odds = archive.get("trifectaOdds")
    if not isinstance(before, dict) or not isinstance(odds, dict):
        raise ValueError("archive_sources_missing")
    if before.get("parserVersion") != BEFOREINFO_PARSER or odds.get("parserVersion") != ODDS_PARSER:
        raise ValueError("archive_parser_version_unsupported")
    if (before.get("url") != _source_url("beforeinfo", race_payload)
            or odds.get("url") != _source_url("odds", race_payload)):
        raise ValueError("archive_source_identity_mismatch")
    if (not _SHA256.fullmatch(str(before.get("sha256", "")))
            or not _SHA256.fullmatch(str(odds.get("sha256", "")))):
        raise ValueError("source_checksum_invalid")
    before_at = _timestamp(before.get("capturedAt"))
    odds_at = _timestamp(odds.get("capturedAt"))
    archived_at = _timestamp(wrapper.get("capturedAt"))
    archive_root_at = _timestamp(archive.get("capturedAt"))
    cutoff_at = _timestamp(before.get("cutoffAt"))
    if (odds_at != archived_at or archive_root_at != archived_at
            or before_at > cutoff_at or odds_at > cutoff_at
            or cutoff_at.date().isoformat() != requested_date):
        raise ValueError("archive_capture_or_cutoff_order_invalid")
    if odds.get("qualityStatus") != ODDS_QUALITY or odds.get("final") is not False:
        raise ValueError("odds_market_not_verified_nonfinal")
    if not isinstance(before.get("exhibitions"), list) or len(before["exhibitions"]) > 6:
        raise ValueError("exhibition_lanes_incomplete")
    exhibits_by_lane: dict[int, Mapping[str, Any]] = {}
    for row in before["exhibitions"]:
        if not isinstance(row, dict) or type(row.get("lane")) is not int or row["lane"] not in range(1, 7):
            raise ValueError("exhibition_lane_invalid")
        if row["lane"] in exhibits_by_lane:
            raise ValueError("exhibition_lane_duplicate")
        for field in _EXHIBITION_FIELDS:
            value = row.get(field)
            if field == "falseStart":
                if value is not None and type(value) is not bool:
                    raise ValueError("exhibition_value_invalid")
            elif value is not None and (isinstance(value, bool) or not _finite(value)):
                raise ValueError("exhibition_value_invalid")
        exhibits_by_lane[row["lane"]] = row
    weather_at = before.get("weatherObservedAt")
    if weather_at is not None:
        if _timestamp(weather_at) > before_at:
            raise ValueError("weather_observation_after_capture")
    weather_label = before.get("weatherObservationLabel")
    if weather_label is not None and not isinstance(weather_label, str):
        raise ValueError("weather_label_invalid")
    weather_values = before.get("weather")
    if not isinstance(weath