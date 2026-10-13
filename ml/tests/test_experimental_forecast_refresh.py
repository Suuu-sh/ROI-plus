import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from edgelab.experimental_forecast_refresh import refresh_current_day_archives


def test_refresh_fetches_only_current_jst_date_and_persists_imported_capture_rows(tmp_path, monkeypatch):
    now = datetime.now(ZoneInfo("Asia/Tokyo"))
    today = now.date().isoformat()
    store_path = tmp_path / "rows.json"
    store_path.write_text(json.dumps({"races": [], "entries": [], "results": [],
                                     "prerace_observations": []}), encoding="utf-8")
    calls = []

    def fetch(day, *, base_url, token):
        calls.append((day, base_url, token))
        return [{"schema": "boat-prerace-capture-export-v1", "date": day,
                 "limit": 25, "archives": [], "nextCursor": None}]

    def importer(rows, pages, day, *, allow_missing_weather):
        assert pages[0]["date"] == day
        assert allow_missing_weather is True
        rows["prerace_capture_archive_manifest"].append({"id": "new-capture"})
        return {"importedArchives": 1, "excludedArchives": 0,
                "weatherMissingArchivesImported": 1}

    monkeypatch.setattr("edgelab.experimental_forecast_refresh.fetch_prerace_capture_archives", fetch)
    monkeypatch.setattr("edgelab.experimental_forecast_refresh.import_capture_archives", importer)
    result = refresh_current_day_archives(today, store_path=store_path,
        base_url="https://api.example", token="test-only")
    saved = json.loads(store_path.read_text(encoding="utf-8"))
    assert calls == [(today, "https://api.example", "test-only")]
    assert result == {"status": "refreshed", "date": today, "archiveDates": 1,
                      "importedArchives": 1, "weatherMissingArchivesImported": 1,
                      "excludedArchives": 0}
    assert saved["prerace_capture_archive_manifest"] == [{"id": "new-capture"}]


def test_refresh_never_fetches_a_historical_date(tmp_path, monkeypatch):
    today = datetime.now(ZoneInfo("Asia/Tokyo")).date()
    old_day = (today - timedelta(days=1)).isoformat()
    monkeypatch.setattr("edgelab.experimental_forecast_refresh.fetch_prerace_capture_archives",
                        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not fetch")))
    result = refresh_current_day_archives(old_day, store_path=tmp_path / "rows.json",
        base_url="https://api.example", token="test-only")
    assert result == {"status": "skipped", "reason": "not_current_jst_date", "importedArchives": 0}
    assert not Path(tmp_path / "rows.json").exists()
