"""Boat-race entry features using only pre-race and point-in-time-safe data."""
from __future__ import annotations

from collections.abc import Iterable, Mapping
import math
import json
from typing import Any

from edgelab.normalization.availability import assert_available, filter_historical


# Only these values may cross the feature-builder/model boundary.  Keep this
# explicit: source rows contain labels and settlement/result fields alongside
# features, and future parser fields must not silently become model inputs.
RESULT_COLUMNS = frozenset({
    "finish_order", "finish_code", "won", "winner", "target", "result",
    "status", "payout", "final_payout", "refund", "refund_amount",
    "odds", "popularity", "rank", "race_result", "result_json",
    "race_start_timing", "entry_course", "race_time", "finish_time",
})

BASE_FEATURE_COLUMNS = (
    "lane", "national_win_rate", "local_win_rate", "motor_2rate", "boat_2rate",
    "national_2rate", "local_2rate", "age", "weight_carried", "racer_class_code",
    "history_starts", "history_wins", "history_win_rate",
)
PRE_RACE_FEATURE_COLUMNS = (
    "wind_speed", "wave_height", "wind_direction_code", "exhibition_time",
    "start_exhibition", "national_win_rate_race_z", "local_win_rate_race_z",
    "motor_2rate_race_z", "boat_2rate_race_z", "national_2rate_race_z",
    "local_2rate_race_z", "age_race_z", "weight_carried_race_z",
    "exhibition_time_race_z", "start_exhibition_race_z", "exhibition_rank",
    "exhibition_mean_diff",
)
FEATURE_COLUMNS = BASE_FEATURE_COLUMNS + PRE_RACE_FEATURE_COLUMNS


def build_boat_features(entries: Iterable[Mapping[str, Any]], *, race_date: Any,
                        predicted_at: Any | None = None,
                        history: Iterable[Mapping[str, Any]] = (),
                        include_pre_race_info: bool = False) -> list[dict[str, Any]]:
    """Return one numeric feature mapping per boat entry.

    Historical rows should carry ``race_date`` and ``number`` and, when a
    prediction cutoff is supplied, ``available_at``. ``finish_order`` (or
    ``won``) supplies the historical outcome. Same-day rows are never used.
    """
    entries = list(entries)
    if predicted_at is not None:
        assert_available(entries, predicted_at)
    prior = filter_historical(history, race_date=race_date, predicted_at=predicted_at)
    entries = list(entries)
    result: list[dict[str, Any]] = []
    for entry in entries:
        number = entry.get("number", entry.get("boat_number"))
        past = [row for row in prior if str(row.get("number", row.get("boat_number"))) == str(number)]
        wins = [row for row in past if row.get("finish_order") == 1 or row.get("won") is True]
        try:
            extra = json.loads(entry.get("features_json") or "{}")
        except (TypeError, ValueError):
            extra = {}
        def numeric(source: Mapping[str, Any], *keys: str) -> float | None:
            for key in keys:
                value = source.get(key)
                try:
                    if value is not None and value != "":
                        return float(value)
                except (TypeError, ValueError):
                    pass
            return None
        pre_race_features: dict[str, Any] = {
            "lane": numeric(entry, "number", "boat_number"),
            "national_win_rate": numeric(entry, "national_win_rate"),
            "local_win_rate": numeric(entry, "local_win_rate"),
            "motor_2rate": numeric(entry, "motor_2rate", "motor2_rate"),
            "boat_2rate": numeric(entry, "boat_2rate", "boat2_rate"),
            "national_2rate": numeric(extra, "national_2rate"),
            "local_2rate": numeric(extra, "local_2rate"),
            "age": numeric(extra, "age"),
            "wind_speed": numeric(entry, "wind_speed", "windSpeed"),
            "wave_height": numeric(entry, "wave_height", "waveHeight"),
            "wind_direction_code": {"北": 1.0, "北東": 2.0, "東": 3.0, "南東": 4.0,
                                    "南": 5.0, "南西": 6.0, "西": 7.0, "北西": 8.0}.get(
                str(extra.get("wind_direction") or "")),
            "weight_carried": numeric(entry, "weight_carried"),
            "exhibition_time": numeric(entry, "exhibition_time"),
            "start_exhibition": numeric(entry, "start_exhibition"),
            "racer_class": entry.get("racer_class"),
            "racer_class_code": {"A1": 4.0, "A2": 3.0, "B1": 2.0, "B2": 1.0}.get(
                str(entry.get("racer_class") or "").upper()),
            "history_starts": float(len(past)),
            "history_wins": float(len(wins)),
            "history_win_rate": (len(wins) / len(past)) if past else None,
        }
        # B-file runner/motor statistics and historical aggregates are
        # available before the race. K-file exhibition and weather values are
        # opt-in because the official download is only published afterward.
        safe_features = {key: pre_race_features[key] for key in BASE_FEATURE_COLUMNS}
        features = ({**safe_features,
                     **{key: value for key, value in pre_race_features.items()
                        if key in PRE_RACE_FEATURE_COLUMNS}}
                    if include_pre_race_info else safe_features)
        # Defensive even if the source schema evolves: labels/results can never
        # be returned as model features.
        features = {key: value for key, value in features.items()
                    if key in FEATURE_COLUMNS and key not in RESULT_COLUMNS}
        result.append(features)
    # Race-relative signals are calculated from available entries only.
    relative = ("national_win_rate", "local_win_rate", "motor_2rate", "boat_2rate",
                "national_2rate", "local_2rate", "age", "weight_carried",
                "exhibition_time", "start_exhibition")
    for key in relative if include_pre_race_info else ():
        values = [row[key] for row in result if isinstance(row.get(key), (int, float))]
        mean = sum(values) / len(values) if values else None
        std = math.sqrt(sum((value - mean) ** 2 for value in values) / len(values)) if values else None
        for row in result:
            value = row.get(key)
            row[f"{key}_race_z"] = ((value - mean) / std if std else 0.0) if value is not None else None
            if key == "exhibition_time":
                row["exhibition_rank"] = (1 + sum(other < value for other in values)) if value is not None else None
                row["exhibition_mean_diff"] = value - mean if value is not None and mean is not None else None
    return result
