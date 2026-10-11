"""Boat-race entry features using only pre-race and point-in-time-safe data."""
from __future__ import annotations

from collections.abc import Iterable, Mapping
import math
import json
import re
from urllib.parse import parse_qs, urlparse
from typing import Any

from edgelab.normalization.availability import available_by, assert_available, filter_historical, parse_datetime


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

# Versioned candidate schema. It cannot be confused with or passed into the
# older boat-base-v1 / ticket model artifacts.
PRERACE_V2_SCHEMA = "boat-prerace-v2"
PRERACE_V2_FEATURE_COLUMNS = (
    "lane", "national_win_rate", "local_win_rate", "motor_2rate", "boat_2rate",
    "national_2rate", "local_2rate", "age", "weight_carried", "racer_class_code",
    "racer_history_starts", "racer_history_wins", "racer_history_win_rate",
    "exhibition_time", "tilt", "observed_weight", "start_exhibition",
    "start_exhibition_course", "start_exhibition_false_start",
    "lane_wind_x", "lane_wind_y", "lane_wave_height",
)
_BEFOREINFO_URL = "https://www.boatrace.jp/owpc/pc/race/beforeinfo"
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


def completed_racer_history(store: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Join racer identities to only complete, observed real race outcomes."""
    races = {str(row.get("id")): row for row in store.get("races", [])
             if row.get("sport") == "boat" and row.get("data_origin") == "real"
             and row.get("status") == "finished"}
    entries_by_race: dict[str, list[Mapping[str, Any]]] = {}
    for entry in store.get("entries", []):
        if entry.get("data_origin") == "real":
            entries_by_race.setdefault(str(entry.get("race_id")), []).append(entry)
    results_by_race: dict[str, list[Mapping[str, Any]]] = {}
    for result in store.get("results", []):
        if result.get("data_origin") == "real":
            results_by_race.setdefault(str(result.get("race_id")), []).append(result)
    history: list[dict[str, Any]] = []
    for race_id, race in races.items():
        entries = entries_by_race.get(race_id, [])
        results = results_by_race.get(race_id, [])
        by_number = {str(row.get("number")): row for row in results}
        try:
            orders = [int(row.get("finish_order")) for row in results]
        except (TypeError, ValueError):
            continue
        if (len(entries) != 6 or {str(row.get("number")) for row in entries} != {"1", "2", "3", "4", "5", "6"}
                or len(results) != 6 or set(by_number) != {"1", "2", "3", "4", "5", "6"}
                or sorted(orders) != [1, 2, 3, 4, 5, 6]):
            continue
        for entry in entries:
            try:
                extra = json.loads(entry.get("features_json") or "{}")
            except (TypeError, ValueError):
                continue
            racer_id = extra.get("racer_id")
            if not isinstance(racer_id, str) or not re.fullmatch(r"\d{4,5}", racer_id):
                continue
            result = by_number[str(entry.get("number"))]
            # Both the racer identity and the result need an explicit local
            # availability timestamp. Old cache rows without either stamp may
            # still support settlement, never point-in-time form features.
            if not entry.get("available_at") or not result.get("available_at"):
                continue
            try:
                identity_available = parse_datetime(entry.get("available_at"))
                result_available = parse_datetime(result.get("available_at"))
            except (TypeError, ValueError):
                continue
            available_at = max(identity_available, result_available).isoformat()
            history.append({"racer_id": racer_id, "race_date": race.get("race_date"),
                            "number": result.get("number"), "finish_order": result.get("finish_order"),
                            "available_at": available_at})
    return history


def _observation_values(observation: Mapping[str, Any], race: Mapping[str, Any], cutoff: Any) -> dict[str, Any] | None:
    if observation.get("race_id") != race.get("id") or observation.get("data_origin") != "real":
        return None
    if observation.get("kind") not in {"exhibition", "weather"} or not _SHA256.fullmatch(str(observation.get("source_sha256", ""))):
        return None
    try:
        url = urlparse(str(observation.get("source_url", "")))
        query = parse_qs(url.query)
        expected = (str(race.get("race_date", "")).replace("-", ""), str(race.get("venue_id", "")), str(race.get("race_no", "")))
        actual = (query.get("hd", [""])[0], query.get("jcd", [""])[0], query.get("rno", [""])[0])
        if (url.scheme != "https" or url.netloc != "www.boatrace.jp" or url.path != "/owpc/pc/race/beforeinfo"
                or actual != expected):
            return None
        fetched = parse_datetime(observation.get("fetched_at"))
        available = parse_datetime(observation.get("available_at"))
        if fetched != available or not available_by(observation, cutoff):
            return None
        source_observed = observation.get("source_observed_at")
        # Some BOAT RACE pages label the displayed weather only as, for
        # example, "11R時点". Keep that label for audit, but do not let an
        # unknown source time enter a point-in-time feature vector.
        if (observation.get("kind") == "weather"
                and observation.get("source_observation_label")
                and source_observed is None):
            return None
        if source_observed is not None and parse_datetime(source_observed) > parse_datetime(cutoff):
            return None
        if (parse_datetime(cutoff) - fetched).total_seconds() > 30 * 60:
            return None
        value = json.loads(str(observation.get("values_json", "{}")))
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def build_boat_prerace_v2_features(entries: Iterable[Mapping[str, Any]], *, race: Mapping[str, Any],
                                   predicted_at: Any, history: Iterable[Mapping[str, Any]] = (),
                                   observations: Iterable[Mapping[str, Any]] = ()) -> list[dict[str, Any]]:
    """Build a new, provenance-gated feature set from B facts and live observations.

    No K-file exhibit/weather values are read here. Weather is interacted with
    lane position so race-wide constants do not cancel in pairwise comparisons.
    """
    entries = list(entries)
    base = build_boat_features(entries, race_date=race.get("race_date"), predicted_at=predicted_at)
    prior = filter_historical(history, race_date=race.get("race_date"), p