import json

from edgelab.native_forecast_input_export import build_history_snapshot, _feature_replay_input


def _finished_race(race_id, date, available_at, *, first_winner="1234"):
    races = [{"id": race_id, "sport": "boat", "data_origin": "real",
              "status": "finished", "race_date": date}]
    entries, results = [], []
    for lane in range(1, 7):
        racer_id = first_winner if lane == 1 else f"{2000 + lane}"
        entries.append({"race_id": race_id, "number": lane, "data_origin": "real",
                        "available_at": available_at,
                        "features_json": f'{{"racer_id":"{racer_id}"}}'})
        results.append({"race_id": race_id, "number": lane, "data_origin": "real",
                        "available_at": available_at, "finish_order": lane})
    return races, entries, results


def test_history_snapshot_is_pit_filtered_aggregated_and_bounded():
    prior = _finished_race("prior", "2026-10-15", "2026-10-15T12:00:00Z")
    today = _finished_race("same-day", "2026-10-16", "2026-10-16T02:00:00Z")
    future_available = _finished_race("late", "2026-10-14", "2026-10-16T03:00:00Z")
    store = {"races": prior[0] + today[0] + future_available[0],
             "entries": prior[1] + today[1] + future_available[1],
             "results": prior[2] + today[2] + future_available[2]}
    snapshot = build_history_snapshot(store, today="2026-10-16", as_of="2026-10-16T02:30:00Z")
    assert snapshot["schema"] == "native-racer-history-v1"
    assert snapshot["throughRaceDate"] == "2026-10-15"
    assert snapshot["asOf"] == "2026-10-16T02:30:00Z"
    assert snapshot["totals"]["1234"] == {"starts": 1, "wins": 1}
    assert set(snapshot) == {"schema", "asOf", "throughRaceDate", "totals"}
    assert "late" not in str(snapshot)


def test_feature_replay_input_contains_only_current_race_facts():
    replay = _feature_replay_input(
        {"id": "boat-public-race", "race_date": "2026-10-16", "venue_id": "21",
         "race_no": 5, "data_origin": "real", "secretish_extra": "drop"},
        [{"race_id": "boat-public-race", "number": 1, "data_origin": "real",
          "available_at": "2026-10-16T01:00:00Z", "national_win_rate": 6.2,
          "features_json": json.dumps({"racer_id": "1234", "age": 30,
                                        "national_2rate": 44.0, "extra": "drop"}),
          "other": "drop"}],
        [{"race_id": "boat-public-race", "kind": "exhibition", "entry_number": 1,
          "data_origin": "real", "fetched_at": "2026-10-16T01:00:00Z",
          "available_at": "2026-10-16T01:00:00Z", "source_sha256": "a" * 64,
          "source_url": "https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=20261016&jcd=21&rno=5",
          "values_json": json.dumps({"exhibition_time": 6.8, "weather": "drop"}),
          "other": "drop"}], "2026-10-16T01:01:00Z")
    assert replay["historyRaces"] == []
    assert replay["race"] == {"id": "boat-public-race", "race_date": "2026-10-16",
                               "venue_id": "21", "race_no": 5, "data_origin": "real"}
    assert json.loads(replay["entries"][0]["features_json"]) == {
        "racer_id": "1234", "age": 30, "national_2rate": 44.0}
    assert json.loads(replay["observations"][0]["values_json"]) == {"exhibition_time": 6.8}
    assert "other" not in replay["entries"][0] and "secretish_extra" not in replay["race"]
