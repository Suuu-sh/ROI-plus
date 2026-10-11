from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import re
from zoneinfo import ZoneInfo

from edgelab.cli import _make_training_rows
from edgelab.collectors.boatrace_beforeinfo import collect_beforeinfo
from edgelab.features.boat import (PRERACE_V2_FEATURE_COLUMNS, PRERACE_V2_SCHEMA,
    build_boat_prerace_v2_features, completed_racer_history)
from edgelab.parsers.boatrace_beforeinfo import (beforeinfo_url, parse_beforeinfo,
    parse_beforeinfo_cutoff)

JST = ZoneInfo("Asia/Tokyo")


def _page(day: str, *, ambiguous_weather: bool = False, cutoff1: str | None = None,
          race_no: int = 1) -> str:
    # Sanitized from the official page's current DOM shape, including tab3
    # identity links, official cutoff schedule, split header, and real ST rows.
    fixture = (Path(__file__).parent / "fixtures" / "boatrace_beforeinfo_actual_fragment.html").read_text(encoding="utf-8")
    fixture = fixture.replace("20261011", day.replace("-", ""))
    fixture = fixture.replace("rno=1", f"rno={race_no}")
    if cutoff1:
        fixture = fixture.replace("15:19", cutoff1)
    if ambiguous_weather:
        fixture = fixture.replace("20:49現在", "11R時点")
    return fixture


def _observation(race_id: str, kind: str, lane: int, fetched_at: str, values: dict,
                 *, source_observed_at: str | None = None, source_url: str | None = None):
    day, venue, race_no = race_id.split("-")[1:]
    return {"id": f"{race_id}:{kind}:{lane}:{fetched_at}", "race_id": race_id,
        "kind": kind, "entry_number": lane, "source_url": source_url or
        f"https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd={day}&jcd={venue}&rno={int(race_no)}",
        "source_sha256": "a" * 64, "source_observed_at": source_observed_at,
        "source_observation_label": None, "fetched_at": fetched_at, "available_at": fetched_at,
        "values_json": json.dumps(values), "data_origin": "real"}


def test_beforeinfo_parser_keeps_real_source_times_and_false_start_marker():
    day = "2026-10-11"
    race_id = "boat-20261011-01-01"
    url = beforeinfo_url(1, "01", day)
    fetched_at = "2026-10-11T12:00:00+00:00"
    rows = parse_beforeinfo(_page(day), race_id=race_id, source_url=url,
                           source_sha256=hashlib.sha256(b"fixture").hexdigest(), fetched_at=fetched_at)
    exhibit = next(row for row in rows if row["kind"] == "exhibition" and row["entry_number"] == 1)
    values = json.loads(exhibit["values_json"])
    assert values == {"exhibition_time": 6.78, "tilt": -0.5, "weight": 53.3,
                      "start_exhibition": 0.11, "start_exhibition_false_start": False,
                      "start_exhibition_course": 1.0}
    starts = {row["entry_number"]: json.loads(row["values_json"]) for row in rows
              if row["kind"] == "exhibition"}
    assert [starts[lane]["start_exhibition"] for lane in range(1, 7)] == [0.11, 0.09, 0.04, 0.06, 0.02, 0.07]
    assert all(starts[lane]["start_exhibition_false_start"] is False for lane in range(1, 6))
    assert starts[6]["start_exhibition_false_start"] is True
    weather = next(row for row in rows if row["kind"] == "weather")
    assert weather["source_observed_at"] == "2026-10-11T20:49+09:00"
    assert weather["source_observation_label"] == "20:49現在"
    weather_values = json.loads(weather["values_json"])
    assert weather_values["wind_direction"] == "北"
    assert weather_values["wind_direction_class"] == "is-wind12"
    assert weather_values["wind_speed"] == 1.0
    assert weather_values["wave_height"] == 1.0
    assert weather["fetched_at"] == weather["available_at"] == fetched_at
    assert all(row["source_sha256"] == hashlib.sha256(b"fixture").hexdigest() for row in rows)
    race = {"id": race_id, "sport": "boat", "venue_id": "01", "race_no": 1,
            "race_date": day, "data_origin": "real"}
    entries = [{"race_id": race_id, "number": lane, "data_origin": "real",
        "available_at": "2026-10-11T11:00:00+09:00", "features_json": "{}"} for lane in range(1, 7)]
    features = build_boat_prerace_v2_features(entries, race=race, predicted_at="2026-10-11T21:05:00+09:00",
                                               observations=rows)
    assert all(row["lane_wind_y"] is not None for row in features)
    assert features[0]["lane_wind_y"] == -2.5


def test_beforeinfo_keeps_non_clock_weather_label_without_inventing_a_time():
    race_id = "boat-20261011-01-01"
    rows = parse_beforeinfo(_page("2026-10-11", ambiguous_weather=True), race_id=race_id,
        source_url=beforeinfo_url(1, "01", "2026-10-11"), source_sha256="b" * 64,
        fetched_at="2026-10-11T12:00:00+00:00")
    weather = next(row for row in rows if row["kind"] == "weather")
    assert weather["source_observed_at"] is None
    assert weather["source_observation_label"] == "11R時点"


def test_beforeinfo_rejects_wrong_official_page_identity():
    try:
        parse_beforeinfo(_page("2026-10-11"), race_id="boat-20261011-01-01",
            source_url=beforeinfo_url(2, "01", "2026-10-11"), source_sha256="c" * 64,
            fetched_at="2026-10-11T12:00:00+00:00")
    except ValueError as exc:
        assert "identity" in str(exc)
    else:
        raise AssertionError("source race mismatch must fail closed")


def test_beforeinfo_cutoff_parser_uses_exact_labeled_schedule_and_page_race_identity():
    day = "2026-10-11"
    race1 = "boat-20261011-01-01"
    race12 = "boat-20261011-01-12"
    assert parse_beforeinfo_cutoff(_page(day), race_id=race1,
        source_url=beforeinfo_url(1, "01", day)) == "2026-10-11T15:19:00+09:00"
    assert parse_beforeinfo_cutoff(_page(day, race_no=12), race_id=race12,
        source_url=beforeinfo_url(12, "01", day)) == "2026-10-11T20:45:00+09:00"
    with_replaced_link = _page(day).replace("raceresult?rno=1", "raceresult?rno=2")
    try:
        parse_beforeinfo_cutoff(with_replaced_link, race_id=race1,
            source_url=beforeinfo_url(1, "01", day))
    except ValueError as exc:
        assert "identity" in str(exc)
    else:
        raise AssertionError("conflicting page race identity must fail closed")
    incomplete = _page(day).replace("<td>20:45</td>", "<td>later</td>")
    try:
        parse_beforeinfo_cutoff(incomplete, race_id=race1,
            source_url=beforeinfo_url(1, "01", day))
    except ValueError as exc:
        assert "ambiguous" in str(exc)
    else:
        raise AssertionError("incomplete cutoff schedule must fail closed")


def test_start_exhibition_course_comes_from_row_order_not_boat_number():
    html = _page("2026-10-11")
    rows = re.findall(r'<tr><td colspan="3">[\s\S]*?</tr>', html)
    assert len(rows) == 6
    reordered = html.replace(rows[0], "__first_start_row__", 1).replace(rows[1], rows[0], 1)
    reordered = reordered.replace("__first_start_row__", rows[1], 1)
    observations = parse_beforeinfo(reordered, race_id="boat-20261011-01-01",
        source_url=beforeinfo_url(1, "01", "2026-10-11"), source_sha256="d" * 64,
        fetched_at="2026-10-11T12:00:00+00:00")
    starts = {row["entry_number"]: json.loads(row["values_json"]) for row in observations
              if row["kind"] == "exhibition"}
    assert starts[1]["start_exhibition_course"] == 2.0
    assert starts[2]["start_exhibition_course"] == 1.0


def test_collector_is_current_day_bounded_and_stamps_fetch_availability():
    now = datetime.now(JST)
    day = now.date().isoformat()
    race_id = f"boat-{day.replace('-', '')}-01-01"
    cutoff = now.replace(second=0, microsecond=0) + timedelta(minutes=10)
    race = {"id": race_id, "sport": "boat", "venue_id": "01", "race_no": 1,
            "race_date": day, "status": "scheduled", "data_origin": "real",
            "post_time": cutoff.isoformat()}
    old = {**race, "id": f"boat-{(now.date() - timedelta(days=1)).strftime('%Y%m%d')}-01-01",
           "race_date": (now.date() - timedelta(days=1)).isoformat()}
    late = {**race, "id": f"boat-{day.replace('-', '')}-01-02", "race_no": 2,
            "post_time": (now + timedelta(minutes=40)).isoformat()}
    store = {"races": [race, old, late], "prerace_observations": []}
    urls, waits = [], []
    def fetch(url):
        urls.append(url)
        return _page(day, ambiguous_weather=True, cutoff1=cutoff.strftime("%H:%M")), hashlib.sha256(url.encode()).hexdigest()
    result = collect_beforeinfo(store, now=now, max_requests=1, fetcher=fetch,
                                wait_for_slot=lambda: waits.append(True))
    assert result["status"] == "success"
    assert result["targets"] == result["requests"] == 1
    assert result["observations"] == 7
    assert result["cutoffs_updated"] == 1
    assert race["betting_cutoff_at"] == cutoff.isoformat()
    assert race["betting_cutoff_source"] == "boatrace-racelist-cutoff-v1"
    observed = datetime.fromisoformat(race["betting_cutoff_observed_at"])
    assert observed <= datetime.now(ZoneInfo("UTC")) + timedelta(seconds=5)
    assert len(urls) == len(waits) == 1
    assert "rno=1" in urls[0]
    assert {row["race_id"] for row in store["prerace_observations"]} == {race_id}
    assert all(row["available_at"] == row["fetched_at"] for row in store["prerace_observations"])


def test_collector_preserves_conflicting_trusted_cutoff_and_reports_unavailability():
    now = datetime.now(JST).replace(second=0, microsecond=0)
    day = now.date().isoformat()
    race_id = f"boat-{day.replace('-', '')}-01-01"
    existing = now + timedelta(minutes=10)
    page_cutoff = existing + timedelta(minutes=1)
    race = {"id": race_id, "sport": "boat", "venue_id": "01", "race_no": 1,
            "race_date": day, "status": "scheduled", "data_origin": "real",
            "post_time": existing.isoformat(), "betting_cutoff_at": existing.isoformat(),
            "betting_cutoff_source": "boatrace-racelist-cutoff-v1",
            "betting_cutoff_observed_at": now.isoformat()}
    store = {"races": [race], "prerace_observations": []}
    result = collect_beforeinfo(store, now=now, max_requests=1,
        fetcher=lambda url: (_page(day, cutoff1=page_cutoff.strftime("%H:%M")), "e" * 64),
        wait_for_slot=lambda: None)
    assert result["cutoff_conflicts"] == 1
    assert result["cutoffs_updated"] == 0
    assert result["cutoff_unavailable"][0]["reason"] == "trusted cutoff conflicts with official page"
    assert race["betting_cutoff_at"] == existing.isoformat()
    assert race["betting_cutoff_observed_at"] == now.isoformat()


def test_prerace_v2_uses_only_prior_available_racer_history_and_matching_timely_observations():
    race_id = "boat-20261011-01-01"
    cutoff = "2026-10-11T11:59:00+09:00"
    race = {"id": race_id, "sport": "boat", "venue_id": "01", "race_no": 1,
            "race_date": "2026-10-11", "data_origin": "real"}
    entries = [{"race_id": race_id, "number": lane, "data_origin": "real",
        "available_at": "2026-10-11T08:00:00+09:00", "national_win_rate": 5.0,
        "exhibition_time": 99.0, "wind_speed": 99.0,
        "features_json": json.dumps({"racer_id": f"{1233 + lane}", "pre_race_available_at": "2099-01-01T00:00:00Z"})}
        for lane in range(1, 7)]
    history = [
        {"racer_id": "1234", "race_date": "2026-10-10", "finish_order": 1,
         "available_at": "2026-10-10T20:00:00+09:00"},
        {"racer_id": "1234", "race_date": "2026-10-11", "finish_order": 1,
         "available_at": "2026-10-11T10:00:00+09:00"},
        {"racer_id": "1234", "race_date": "2026-10-09", "finish_order": 1,
         "available_at": "2026-10-11T12:00:00+09:00"},
    ]
    fetched = "2026-10-11T11:50:00+09:00"
    url = "https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=20261011&jcd=01&rno=1"
    observations = [_observation(race_id, "exhibition", lane, fetched,
        {"exhibition_time": 6.7 + lane / 100, "start_exhibition": 0.08,
         "start_exhibition_false_start": lane == 1}) for lane in range(1, 7)]
    observations.extend([
        _observation(race_id, "weather", 0, fetched,
            {"wind_speed": 2.0, "wind_direction": "東", "wave_height": 4.0}),
        {**_observation(race_id, "weather", 0, fetched,
            {"wind_speed": 9.0, "wind_direction": "南", "wave_height": 20.0}),
         "source_observation_label": "11R時点"},
        _observation(race_id, "exhibition", 2, "2026-10-11T12:00:00+09:00",
            {"exhibition_time": 6.0}),
        _observation(race_id, "exhibition", 3, fetched, {"exhibition_time": 6.0}, source_url=url.replace("rno=1", "rno=2")),
    ])
    features = build_boat_prerace_v2_features(entries, race=race, predicted_at=cutoff,
                                               history=history, observations=observations)
    by_lane = {int(row["lane"]): row for row in features}
    assert tuple(features[0]) == PRERACE_V2_FEATURE_COLUMNS
    assert features[0]["racer_history_starts"] == 1
    assert features[0]["racer_history_wins"] == 1
    assert features[0]["racer_history_win_rate"] == 1
    assert by_lane[1]["exhibition_time"] == 6.71
    assert by_lane[1]["start_exhibition_false_start"] == 1.0
    # The later stale row cannot overwrite the earlier valid pre-cutoff row.
    assert by_lane[2]["exhibition_time"] == 6.72
    assert by_lane[3]["exhibition_time"] == 6.73
    assert by_lane[1]["lane_wind_x"] == -5.0
    assert by_lane[6]["lane_wind_x"] == 5.0
    assert by_lane[1]["lane_wave_height"] == -10.0
    assert by_lane[6]["lane_wave_height"] == 10.0
    assert "pre_race_available_at" not in features[0]


def test_ambiguous_current_race_weather_label_is_preserved_but_not_used_as_a_feature():
    race_id = "boat-20261011-01-01"
    race = {"id": race_id, "sport": "boat", "venue_id": "01", "race_no": 1,
            "race_date": "2026-10-11", "data_origin": "real"}
    entries = [{"race_id": race_id, "number": lane, "data_origin": "real",
        "available_at": "2026-10-11T08:00:00+09:00", "features_json": "{}"}
        for lane in range(1, 7)]
    weather = {**_observation(race_id, "weather", 0, "2026-10-11T11:50:00+09:00",
        {"wind_speed": 9.0, "wind_direction": "南", "wave_height": 20.0}),
        "source_observation_label": "11R時点"}
    features = build_boat_prerace_v2_features(entries, race=race,
        predicted_at="2026-10-11T11:59:00+09:00", observations=[weather])
    assert all(row["lane_wind_x"] is None and row["lane_wave_height"] is None for row in features)


def test_completed_racer_history_requires_six_real_observed_outcomes():
    race_id = "boat-20261010-01-01"
    race = {"id": race_id, "sport": "boat", "race_date": "2026-10-10",
            "status": "finished", "data_origin": "real"}
    entries = [{"race_id": race_id, "number": lane, "data_origin": "real",
                "available_at": "2026-10-10T00:00:00+09:00",
                "features_json": json.dumps({"racer_id": str(1233 + lane)})}
               for lane in range(1, 7)]
    results = [{"race_id": race_id, "number": lane, "finish_order": lane,
                "available_at": "2026-10-10T20:00:00+09:00", "data_origin": "real"}
               for lane in range(1, 7)]
    incomplete = {**race, "id": "boat-20261009-01-01", "race_date": "2026-10-09"}
    rows = completed_racer_history({"races": [race, incomplete], "entries": entries,
                                    "results": results[:-1]})
    assert len(rows) == 0
    rows = completed_racer_history({"races": [race], "entries": entries, "results": results})
    assert len(rows) == 6
    assert rows[0]["racer_id"] == "1234"
    rows = completed_racer_history({"races": [race], "entries": [
        {key: value for key, value in entry.items() if key != "available_at"} for entry in entries],
        "results": results})
    assert rows == []


def test_v2_training_uses_only_races_with_real_racelist_cutoff():
    def cohort(race_id: str, day: str, cutoff: str | None):
        race = {"id": race_id, "sport": "boat", "venue_id": "01", "race_no": 1,
            "race_date": day, "status": "finished", "data_origin": "real",
            "post_time": f"{day}T13:00:00+09:00"}
        if cutoff:
            race.update(betting_cutoff_at=cutoff, betting_cutoff_source="boatrace-racelist-cutoff-v1",
                        betting_cutoff_observed_at=f"{day}T12:57:00+09:00")
        entries = [{"race_id": race_id, "number": lane, "data_origin": "real",
            "available_at": f"{day}T00:00:00+09:00", "national_win_rate": 5,
            "features_json": json.dumps({"racer_id": str(1233 + lane)})}
            for lane in range(1, 7)]
        results = [{"race_id": race_id, "number": lane, "finish_order": lane,
            "data_origin": "real", "available_at": f"{day}T14:00:00+09:00"} for lane in range(1, 7)]
        return race, entries, results
    cutoff = "2026-10-10T12:59:00+09:00"
    good = cohort("boat-20261010-01-01", "2026-10-10", cutoff)
    missing = cohort("boat-20261009-01-01", "2026-10-09", None)
    late_cutoff = cohort("boat-20261008-01-01", "2026-10-08", "2026-10-08T12:59:00+09:00")
    late_cutoff[0]["betting_cutoff_observed_at"] = "2026-10-08T12:58:30+09:00"
    store = {"races": [good[0], missing[0], late_cutoff[0]],
             "entries": good[1] + missing[1] + late_cutoff[1],
             "results": good[2] + missing[2] + late_cutoff[2], "payouts": [], "prerace_observations": [
                _observation(good[0]["id"], "exhibition", 1, "2026-10-10T12:57:30+09:00",
                             {"exhibition_time": 6.71}),
                # Available at T-30, after the T-60 model input boundary.
                _observation(good[0]["id"], "exhibition", 1, "2026-10-10T12:58:30+09:00",
                             {"exhibition_time": 6.99})]}
    rows = _make_training_rows(store, "boat", feature_schema=PRERACE_V2_SCHEMA)
    assert len(rows) == 6
    assert {row["race_id"] for row in rows} == {good[0]["id"]}
    assert {row["predicted_at"] for row in rows} == {"2026-10-10T12:58:00+09:00"}
    assert rows[0]["exhibition_time"] == 6.71
    assert len(_make_training_rows(store, "boat")) == 18
