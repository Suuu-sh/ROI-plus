from edgelab.native_forecast_input_export import build_history_snapshot


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
