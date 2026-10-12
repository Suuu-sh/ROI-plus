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
    if not isinstance(weather_values, dict):
        raise ValueError("weather_values_invalid")
    mapped_weather: dict[str, Any] = {}
    for source, value in weather_values.items():
        if source not in _WEATHER_FIELDS:
            raise ValueError("weather_field_unsupported")
        if value is not None and not (isinstance(value, str) or _finite(value)):
            raise ValueError("weather_value_invalid")
        mapped_weather[_WEATHER_FIELDS[source]] = value

    odds_rows = odds.get("odds")
    if not isinstance(odds_rows, list) or len(odds_rows) != 120:
        raise ValueError("odds_market_incomplete")
    odds_by_selection: dict[str, float] = {}
    for row in odds_rows:
        if not isinstance(row, dict):
            raise ValueError("odds_row_invalid")
        selection = row.get("selection")
        price = row.get("odds")
        if selection not in _EXPECTED_SELECTIONS or selection in odds_by_selection or not _finite(price) or float(price) <= 0:
            raise ValueError("odds_row_invalid")
        odds_by_selection[selection] = float(price)
    if set(odds_by_selection) != _EXPECTED_SELECTIONS:
        raise ValueError("odds_market_incomplete")

    captured_at = str(wrapper["capturedAt"])
    observations = []
    for lane, item in sorted(exhibits_by_lane.items()):
        values = {_EXHIBITION_FIELDS[key]: item.get(key) for key in _EXHIBITION_FIELDS}
        observations.append({
            "id": f"{wrapper['id']}:exhibition:{lane}", "race_id": race_id,
            "kind": "exhibition", "entry_number": lane,
            "source_url": before["url"], "source_sha256": before["sha256"],
            "source_observed_at": None, "source_observation_label": None,
            "fetched_at": str(before["capturedAt"]), "available_at": str(before["capturedAt"]),
            "values_json": json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            "data_origin": "real",
        })
    if mapped_weather or weather_at is not None or weather_label is not None:
        observations.append({
            "id": f"{wrapper['id']}:weather", "race_id": race_id,
            "kind": "weather", "entry_number": 0,
            "source_url": before["url"], "source_sha256": before["sha256"],
            "source_observed_at": weather_at, "source_observation_label": weather_label,
            "fetched_at": str(before["capturedAt"]), "available_at": str(before["capturedAt"]),
            "values_json": json.dumps(mapped_weather, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            "data_origin": "real",
        })
    market = [{
        "race_id": race_id, "bet_type": "trifecta", "selection": selection, "odds": price,
        "captured_at": captured_at, "source": ODDS_SOURCE, "data_origin": "real",
        "source_url": odds["url"], "source_sha256": odds["sha256"],
        "quality_status": ODDS_QUALITY, "archive_id": wrapper["id"],
    } for selection, price in sorted(odds_by_selection.items())]
    manifest = {"id": wrapper["id"], "archive_sha256": digest, "race_id": race_id,
                "race_date": requested_date, "captured_at": captured_at,
                "schema": ARCHIVE_SCHEMA, "beforeinfo_captured_at": str(before["capturedAt"])}
    manifest["_cutoff_at"] = str(before["cutoffAt"])
    manifest["_cutoff_observed_at"] = str(before["capturedAt"])
    return manifest, observations, market


def _finite(value: Any) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(float(value)))


def _row_map(rows: list[dict[str, Any]], keys: Sequence[str]):
    return {tuple(row.get(key) for key in keys): row for row in rows}


def import_capture_archives(store: dict[str, list[dict[str, Any]]], pages: Sequence[Mapping[str, Any]],
                            requested_date: str) -> dict[str, Any]:
    """Validate one-day export pages and append only immutable local evidence."""
    try:
        if date.fromisoformat(requested_date).isoformat() != requested_date:
            raise ValueError
    except (TypeError, ValueError) as exc:
        raise ValueError("archive import date must be YYYY-MM-DD") from exc
    for table in ("prerace_observations", "prerace_capture_archive_manifest", "prerace_capture_odds"):
        store.setdefault(table, [])
    exclusion_counts: dict[str, int] = {}
    imported = already = excluded = observation_count = odds_count = 0
    cutoff_evidence_updated = cutoff_evidence_preserved = 0
    manifests = _row_map(store["prerace_capture_archive_manifest"], ("id",))
    observations = _row_map(store["prerace_observations"], ("race_id", "kind", "entry_number", "fetched_at"))
    markets = _row_map(store["prerace_capture_odds"], ("race_id", "bet_type", "selection", "captured_at"))
    for page in pages:
        if (not isinstance(page, Mapping) or page.get("schema") != ARCHIVE_EXPORT_SCHEMA
                or page.get("date") != requested_date or page.get("limit") != 25
                or not isinstance(page.get("archives"), list) or len(page["archives"]) > 25
                or page.get("nextCursor") is not None and not isinstance(page.get("nextCursor"), str)):
            exclusion_counts["export_page_invalid"] = exclusion_counts.get("export_page_invalid", 0) + 1
            continue
        for wrapper in page["archives"]:
            if not isinstance(wrapper, Mapping):
                reason = "archive_wrapper_invalid"
                exclusion_counts[reason] = exclusion_counts.get(reason, 0) + 1
                excluded += 1
                continue
            archive_id = wrapper.get("id")
            known = manifests.get((archive_id,)) if isinstance(archive_id, str) else None
            digest = wrapper.get("archiveSha256")
            try:
                manifest, new_observations, new_odds = _validate_archive(wrapper, requested_date, store)
            except (KeyError, TypeError, ValueError, OverflowError) as exc:
                reason = str(exc) if str(exc) else type(exc).__name__
                exclusion_counts[reason] = exclusion_counts.get(reason, 0) + 1
                excluded += 1
                continue
            if known:
                if known.get("archive_sha256") == digest:
                    already += 1
                    continue
                reason = "archive_id_checksum_conflict"
                exclusion_counts[reason] = exclusion_counts.get(reason, 0) + 1
                excluded += 1
                continue

            race = next(row for row in store["races"] if row.get("id") == manifest["race_id"])
            cutoff_text, observed_text = manifest.pop("_cutoff_at"), manifest.pop("_cutoff_observed_at")
            existing_cutoff = race.get("betting_cutoff_at")
            existing_source = race.get("betting_cutoff_source")
            existing_observed = race.get("betting_cutoff_observed_at")
            cutoff_update = None
            cutoff_preserved = False
            if existing_cutoff is None and existing_source is None and existing_observed is None:
                cutoff_update = {"betting_cutoff_at": cutoff_text,
                                 "betting_cutoff_source": TRUSTED_CUTOFF_SOURCE,
                                 "betting_cutoff_observed_at": observed_text}
            elif existing_source == TRUSTED_CUTOFF_SOURCE and existing_cutoff == cutoff_text and existing_observed:
                try:
                    prior_dt, archive_dt = _timestamp(existing_observed), _timestamp(observed_text)
                except ValueError:
                    reason = "cutoff_evidence_invalid"
                    exclusion_counts[reason] = exclusion_counts.get(reason, 0) + 1
                    excluded += 1
                    continue
                if archive_dt < prior_dt:
                    cutoff_update = {"betting_cutoff_observed_at": observed_text}
                else:
                    cutoff_preserved = True
            else:
                reason = "cutoff_evidence_conflict"
                exclusion_counts[reason] = exclusion_counts.get(reason, 0) + 1
                excluded += 1
                continue

            collision = False
            for row in new_observations:
                key = tuple(row.get(k) for k in ("race_id", "kind", "entry_number", "fetched_at"))
                old = observations.get(key)
                if old and any(old.get(field) != row.get(field) for field in
                               ("source_url", "source_sha256", "available_at", "values_json")):
                    collision = True
                    break
            for row in new_odds:
                key = tuple(row.get(k) for k in ("race_id", "bet_type", "selection", "captured_at"))
                old = markets.get(key)
                if old and any(old.get(field) != row.get(field) for field in
                               ("odds", "source_sha256", "source_url", "quality_status")):
                    collision = True
                    break
            if collision:
                reason = "immutable_capture_key_conflict"
                exclusion_counts[reason] = exclusion_counts.get(reason, 0) + 1
                excluded += 1
                continue
            if cutoff_update:
                race.update(cutoff_update)
                cutoff_evidence_updated += 1
            elif cutoff_preserved:
                cutoff_evidence_preserved += 1
            for row in new_observations:
                key = tuple(row.get(k) for k in ("race_id", "kind", "entry_number", "fetched_at"))
                if key not in observations:
                    store["prerace_observations"].append(row)
                    observations[key] = row
                    observation_count += 1
            for row in new_odds:
                key = tuple(row.get(k) for k in ("race_id", "bet_type", "selection", "captured_at"))
                if key not in markets:
                    store["prerace_capture_odds"].append(row)
                    markets[key] = row
                    odds_count += 1
            store["prerace_capture_archive_manifest"].append(manifest)
            manifests[(manifest["id"],)] = manifest
            imported += 1
    return {
        "status": ("partial" if imported and excluded else "imported" if imported
                   else "excluded" if excluded else "no_new_archives"),
        "date": requested_date, "importedArchives": imported, "alreadyImportedArchives": already,
        "excludedArchives": excluded, "exclusionCounts": exclusion_counts,
        "observationsAdded": observation_count, "oddsRowsAdded": odds_count,
        "cutoffEvidenceUpdated": cutoff_evidence_updated,
        "cutoffEvidencePreserved": cutoff_evidence_preserved,
        "oddsStorage": "local_only_prerace_capture_odds",
    }
