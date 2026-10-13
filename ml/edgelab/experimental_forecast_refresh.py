"""Refresh current-day verified PIT archives immediately before experiment forecasts."""
from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from edgelab.importers.boatrace_capture_archive import import_capture_archives
from edgelab.storage import DEFAULT_STORE, load_rows, save_rows
from edgelab.sync import fetch_prerace_capture_archives


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
                "excludedArchives": int(imported.get("excludedArchives", 0))}
    except Exception as exc:
        allowed = {"ValueError", "TypeError", "KeyError", "AttributeError", "IndexError",
                   "RuntimeError", "OSError", "ImportError", "TimeoutError"}
        exception_class = type(exc).__name__
        return {"status": "unavailable", "reason": "archive_refresh_failed",
                "exceptionClass": exception_class if exception_class in allowed else "OtherError",
                "importedArchives": 0}
