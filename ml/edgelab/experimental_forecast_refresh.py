"""Refresh current-day verified PIT archives immediately before experiment forecasts."""
from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from edgelab.importers.boatrace_capture_archive import import_capture_archives
from edgelab.storage import DEFAULT_STORE, load_rows, save_rows
from edgelab.sync import fetch_prerace_capture_archives


ARCHIVE_EXCLUSION_REASONS = (
    "export_page_invalid", "archive_wrapper_invalid", "timestamp_missing",
    "timestamp_timezone_missing", "archive_checksum_missing", "archive_checksum_mismatch",
    "archive_json_invalid", "archive_schema_invalid", "archive_race_invalid",
    "archive_date_mismatch", "race_identity_or_real_race_missing", "archive_id_mismatch",
    "archive_sources_missing", "archive_parser_version_unsupported", "archive_source_identity_mismatch",
    "source_checksum_invalid", "racelist_beforeinfo_cutoff_mismatch",
    "archive_capture_or_cutoff_order_invalid", "odds_market_not_verified_nonfinal",
    "exhibition_lanes_incomplete", "exhibition_lane_invalid", "exhibition_lane_duplicate",
    "exhibition_value_invalid", "weather_observation_after_capture", "weather_observation_missing",
    "weather_label_invalid", "weather_values_invalid", "weather_field_unsupported",
    "weather_value_invalid", "racelist_entries_incomplete", "racelist_cached_entries_incomplete",
    "racelist_entry_invalid", "racelist_entry_duplicate", "racelist_entry_identity_mismatch",
    "odds_market_incomplete", "odds_row_invalid", "archive_id_checksum_conflict",
    "cutoff_evidence_invalid", "cutoff_evidence_conflict", "immutable_capture_key_conflict",
    "other",
)


def _safe_exclusion_counts(value: Any) -> dict[str, int]:
    counts = {reason: 0 for reason in ARCHIVE_EXCLUSION_REASONS}
    if isinstance(value, dict):
        for reason, count in value.items():
            safe_reason = reason if reason in counts else "other"
            if type(count) is int and count >= 0:
                counts[safe_reason] += count
    return counts


def refresh_current_day_archives(target_date: str, *, store_path: str | Path = str(DEFAULT_STORE),
                                 base_url: str, token: str) -> dict[str, Any]:
    """Import only newly exported source-verified captures for the actual JST day.

    Archive timestamps and hashes are validated by the normal importer and are
    never reconstructed or assigned by this refresh step.
    """
    try:
        parsed = date.fromisoformat(target_date)
        if parsed.isoformat() != target_date or parsed != datetime.now(ZoneInfo("Asia/Tokyo")).date():
            return {"status": "skipped", "reason": "not_current_jst_date", "importedArchives": 0}
        if not base_url or not token:
            return {"status": "unavailable", "reason": "credentials_unavailable", "importedArchives": 0}
        rows = load_rows(store_path)
        pages = fetch_prerace_capture_archives(target_date, base_url=base_url, token=token)
        imported = import_capture_archives(rows, pages, target_date, allow_missing_weather=True)
        count = int(imported.get("importedArchives", 0))
        if count:
            save_rows(rows, store_path)
        return {"status": "refreshed" if count else "no_new_archives",
                "date": target_date, "archiveDates": 1,
                "importedArchives": count,
                "weatherMissingArchivesImported": int(imported.get("weatherMissingArchivesImported", 0)),
                "excludedArchives": int(imported.get("excludedArchives", 0)),
                "exclusionCounts": _safe_exclusion_counts(imported.get("exclusionCounts"))}
    except Exception as exc:
        allowed = {"ValueError", "TypeError", "KeyError", "AttributeError", "IndexError",
                   "RuntimeError", "OSError", "ImportError", "TimeoutError"}
        exception_class = type(exc).__name__
        return {"status": "unavailable", "reason": "archive_refresh_failed",
                "exceptionClass": exception_class if exception_class in allowed else "OtherError",
                "importedArchives": 0}
