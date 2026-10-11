import hashlib
import json
from datetime import datetime, timedelta
from io import BytesIO
from urllib.request import Request

from edgelab.features.boat import build_boat_prerace_v2_features
from edgelab.importers.boatrace_capture_archive import import_capture_archives
from edgelab.sync import fetch_prerace_capture_archives
from edgelab.cli import _make_training_rows


DAY = "2026-10-11"
RACE_ID = "boat-20261011-01-01"
EXPECTED = [f"{a}-{b}-{c}" for a in range(1, 7) for b in range(1, 7)
            for c in range(1, 7) if len({a, b, c}) == 3]


def _millis(value):
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def _archive(captured_at, exhibit_time, odds_price=20.0):
    dt = datetime.fromisoformat(captured_at)
    before_dt = dt.replace(second=max(0, dt.second - 3))
    before_at = before_dt.isoformat()
    archive = {
        "schema": "boat-prerace-capture-v1",
        "race": {"id": RACE_ID, "date": DAY, "venueCode": "01", "raceNo": 1,
                 "lanes": [1, 2, 3, 4, 5, 6]},
        "capturedAt": captured_at,
        "archivedAt": (dt + timedelta(seconds=2)).isoformat(),
        "beforeinfo": {
            "url": "https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=20261011&jcd=01&rno=1",
            "sha256": "a" * 64, "capturedAt": before_at,
            "parserVersion": "boatrace-beforeinfo-v1", "cutoffAt": "2026-10-11T15:19:00+09:00",
            "exhibitions": [{"lane": lane, "exhibitionTime": exhibit_time, "tilt": -0.5,
                             "weight": 53.3, "startCourse": lane, "startTime": 0.11,
                             "falseStart": False} for lane in range(1, 7)],
            "weather": {"windSpeed": 3, "waveHeight": 4, "windDirection": "北"},
            "weatherObservedAt": (before_dt - timedelta(minutes=1)).isoformat(),
            "weatherObservationLabel": (before_dt - timedelta(minutes=1)).strftime("%H:%M現在"),
        },
        "trifectaOdds": {
            "url": "https://www.boatrace.jp/owpc/pc/race/odds3t?rno=1&jcd=01&hd=20261011",
            "sha256": "b" * 64, "capturedAt": captured_at,
            "parserVersion": "boatrace-trifecta-odds-v1", "qualityStatus": "verified-complete-v1",
            "final": False, "odds": [{"selection": selection, "odds": odds_price} for selection in EXPECTED],
        },
    }
    raw = json.dumps(archive, ensure_ascii=False, separators=(",", ":"))
    return {"id": f"{RACE_ID}:capture:{_millis(captured_at):013d}", "raceId": RACE_ID,
            "raceDate": DAY, "capturedAt": captured_at,
            "archiveSha256": hashlib.sha256(raw.encode()).hexdigest(), "archiveJson": raw}


def _page(*wrappers):
    return {"schema": "boat-prerace-capture-export-v1", "date": DAY, "limit": 25,
            "archives": list(wrappers), "nextCursor": None}


def _store():
    return {"races": [{"id": RACE_ID, "sport": "boat", "venue_id": "01", "race_date": DAY,
                        "race_no": 1, "data_origin": "real", "post_time": "2026-10-11T15:20:00+09:00"}],
            "entries": [{"race_id": RACE_ID, "number": lane, "data_origin": "real",
                         "available_at": "2026-10-11T00:00:00+09:00", "national_win_rate": 0.2,
                         "local_win_rate": 0.2, "motor_2rate": 30, "boat_2rate": 30}
                        for lane in range(1, 7)],
            "prerace_observations": [], "prerace_capture_archive_manifest": [],
            "prerace_capture_odds": [], "odds_snapshots": [], "results": [], "payouts": []}


def test_archive_import_is_checksum_verified_local_only_and_idempotent():
    newer = _archive("2026-10-11T15:18:03+09:00", 6.90)
    older = _archive("2026-10-11T15:17:03+09:00", 6.78)
    store = _store()
    result = import_capture_archives(store, [_page(newer), _page(older)], DAY)
    assert result["status"] == "imported"
    assert result["importedArchives"] == 2
    assert result["observationsAdded"] == 14 and result["oddsRowsAdded"] == 240
    assert result["cutoffEvidenceUpdated"] == 2
    assert store["races"][0]["betting_cutoff_source"] == "boatrace-racelist-cutoff-v1"
    assert store["races"][0]["betting_cutoff_observed_at"] == "2026-10-11T15:17:00+09:00"
    assert store["odds_snapshots"] == []  # archive quotes never enter the synced/runtime odds table
    assert import_capture_archives(store, [_page(newer), _page(older)], DAY)["alreadyImportedArchives"] == 2
    assert len(store["prerace_capture_archive_manifest"]) == 2
    assert len(store["prerace_observations"]) == 14
    assert len(store["prerace_capture_odds"]) == 240


def test_bad_checksum_and_wrong_day_are_explicitly_excluded_without_mutation():
    store = _store()
    bad = _archive("2026-10-11T15:17:03+09:00", 6.78)
    bad["archiveSha256"] = "0" * 64
    result = import_capture_archives(store, [_page(bad)], DAY)
    assert result["excludedArchives"] == 1
    assert result["exclusionCounts"] == {"archive_checksum_mismatch": 1}
    assert not store["prerace_capture_archive_manifest"]
    wrong_day = dict(_page(_archive("2026-10-11T15:17:03+09:00", 6.78)), date="2026-10-12")
    result = import_capture_archives(store, [wrong_day], DAY)
    assert result["exclusionCounts"]["export_page_invalid"] == 1
    assert not store["races"][0].get("betting_cutoff_at")


def test_partial_exhibition_capture_does_not_discard_verified_complete_odds():
    wrapper = _archive("2026-10-11T15:17:03+09:00", 6.78)
    archive = json.loads(wrapper["archiveJson"])
    archive["beforeinfo"]["exhibitions"] = archive["beforeinfo"]["exhibitions"][:2]
    wrapper["archiveJson"] = json.dumps(archive, ensure_ascii=False, separators=(",", ":"))
    wrapper["archiveSha256"] = hashlib.sha256(wrapper["archiveJson"].encode()).hexdigest()
    store = _store()
    result = import_capture_archives(store, [_page(wrapper)], DAY)
    assert result["importedArchives"] == 1 and result["excludedArchives"] == 0
    assert result["oddsRowsAdded"] == 120 and result["observationsAdded"] == 3


def test_existing_earlier_cutoff_observation_survives_later_archive_import():
    store = _store()
    store["races"][0].update({"betting_cutoff_at": "2026-10-11T15:19:00+09:00",
        "betting_cutoff_source": "boatrace-racelist-cutoff-v1",
        "betting_cutoff_observed_at": "2026-10-11T03:30:00+09:00"})
    result = import_capture_archives(store, [_page(_archive("2026-10-11T15:18:03+09:00", 6.90))], DAY)
    assert result["cutoffEvidencePreserved"] == 1
    assert store["races"][0]["betting_cutoff_observed_at"] == "2026-10-11T03:30:00+09:00"


def test_features_choose_latest_eligible_archive_observation_by_timestamp_not_row_order():
    store = _store()
    first = _archive("2026-10-11T15:17:03+09:00", 6.78)
    second = _archive("2026-10-11T15:18:03+09:00", 6.90)
    import_capture_archives(store, [_page(first, second)], DAY)
    race = store["races"][0]
    early = build_boat_prerace_v2_features(store["entries"], race=race,
        predicted_at="2026-10-11T15:17:30+09:00", observations=store["prerace_observations"])
    assert early[0]["exhibition_time"] == 6.78
    later_forward = build_boat_prerace_v2_features(store["entries"], race=race,
        predicted_at="2026-10-11T15:19:00+09:00", observations=store["prerace_observations"])
    later_reverse = build_boat_prerace_v2_features(store["entries"], race=race,
        predicted_at="2026-10-11T15:19:00+09:00", observations=list(reversed(store["prerace_observations"])))
    assert later_forward[0]["exhibition_time"] == later_reverse[0]["exhibition_time"] == 6.90
    same_capture = [row for row in store["prerace_observations"]
                    if row["kind"] == "exhibition" and row["entry_number"] == 1][-1]
    conflict = {**same_capture, "values_json": json.dumps({"exhibition_time": 6.95})}
    forward = build_boat_prerace_v2_features(store["entries"], race=race,
        predicted_at="2026-10-11T15:19:00+09:00", observations=[same_capture, conflict])
    reverse = build_boat_prerace_v2_features(store["entries"], race=race,
     