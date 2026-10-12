"""Boat-race entry features using only pre-race and point-in-time-safe data."""
from __future__ import annotations

from collections.abc import Iterable, Mapping
import math
import json
import re
from urllib.parse import parse_qs, urlparse
from datetime import datetime
from typing import Any

from edgelab.normalization.availability import assert_available, filter_historical, parse_datetime


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


def classify_prerace_observation(observation: Mapping[str, Any], race: Mapping[str, Any],
                                 cutoff: Any) -> tuple[dict[str, Any] | None, str | None]:
    """Validate one archived observation and explain any fail-closed exclusion.

    Capture/availability timestamps must be timezone-aware, tied to the exact
    official race URL, and no more than 30 minutes old at the feature cutoff.
    This is shared by feature selection and the all-race coverage report.
    """
    if (observation.get("fixture") or observation.get("data_origin") != "real"
            or race.get("data_origin") != "real"):
        return None, "synthetic_fixture_or_non_real_origin"
    if observation.get("race_id") != race.get("id"):
        return None, "race_or_origin_mismatch"
    if observation.get("kind") not in {"exhibition", "weather"}:
        return None, "observation_kind_invalid"
    if not _SHA256.fullmatch(str(observation.get("source_sha256", ""))):
        return None, "observation_sha256_invalid"
    try:
        url = urlparse(str(observation.get("source_url", "")))
        query = parse_qs(url.query)
        expected = (str(race.get("race_date", "")).replace("-", ""),
                    str(race.get("venue_id", "")), str(race.get("race_no", "")))
        actual = (query.get("hd", [""])[0], query.get("jcd", [""])[0], query.get("rno", [""])[0])
        if (url.scheme != "https" or url.netloc != "www.boatrace.jp"
                or url.path != "/owpc/pc/race/beforeinfo" or actual != expected):
            return None, "official_race_url_mismatch"
        fetched = parse_datetime(observation.get("fetched_at"))
        available = parse_datetime(observation.get("available_at"))
        target = parse_datetime(cutoff)
        # Do not interpret naive source timestamps as UTC evidence.
        for raw in (observation.get("fetched_at"), observation.get("available_at"), cutoff):
            if isinstance(raw, str):
                parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            elif isinstance(raw, datetime):
                parsed = raw
            else:
                continue
            if parsed.tzinfo is None or parsed.utcoffset() is None:
                return None, "observation_timezone_missing"
        if target.tzinfo is None or target.utcoffset() is None:
            return None, "cutoff_timezone_missing"
        if fetched != available:
            return None, "capture_availability_mismatch"
        if fetched > target:
            return None, "observation_after_cutoff"
        source_observed = observation.get("source_observed_at")
        # Some BOAT RACE pages label displayed weather only as, for example,
        # "11R時点". Retain the label for audit, but do not use it when the
        # exact source observation time is unavailable.
        source_label_reason = _weather_source_time_reason(
            observation.get("kind"), observation.get("source_observation_label"), source_observed)
        if source_label_reason:
            return None, source_label_reason
        if source_observed is not None:
            source_reason = _source_observation_time_reason(source_observed, target, fetched_at=fetched)
            if source_reason:
                return None, source_reason
        freshness_reason = _observation_freshness_reason(fetched, target)
        if freshness_reason:
            return None, freshness_reason
        value = json.loads(str(observation.get("values_json", "{}")))
    except (TypeError, ValueError, json.JSONDecodeError, OverflowError):
        return None, "observation_timestamp_or_values_invalid"
    if not isinstance(value, dict):
        return None, "observation_values_invalid"
    return value, None


def _source_observation_time_reason(source_observed: Any, cutoff: datetime, *,
                                    fetched_at: datetime | None = None) -> str | None:
    """Fail closed when the source's displayed observation time is unknown or late."""
    try:
        observed = parse_datetime(source_observed)
        if isinstance(source_observed, str):
            parsed = datetime.fromisoformat(source_observed.replace("Z", "+00:00"))
        elif isinstance(source_observed, datetime):
            parsed = source_observed
        else:
            return "source_observation_timestamp_invalid"
    except (TypeError, ValueError, OverflowError):
        return "source_observation_timestamp_invalid"
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return "source_observation_timezone_missing"
    if cutoff.tzinfo is None or cutoff.utcoffset() is None:
        return "cutoff_timezone_missing"
    if observed > cutoff:
        return "source_observation_after_cutoff"
    if fetched_at is not None and observed > fetched_at:
        return "source_observation_after_capture"
    return None


def _weather_source_time_reason(kind: Any, source_observation_label: Any,
                                source_observed: Any) -> str | None:
    if kind == "weather" and source_observation_label and source_observed is None:
        return "weather_source_time_unknown"
    return None


def _observation_freshness_reason(fetched: datetime, cutoff: datetime, *, max_age_seconds: int = 30 * 60) -> str | None:
    """Shared cutoff/freshness classification for point-in-time observations."""
    if fetched > cutoff:
        return "observation_after_cutoff"
    if (cutoff - fetched).total_seconds() > max_age_seconds:
        return "stale_observation"
    return None


def _observation_selection_key(observation: Mapping[str, Any], values: Mapping[str, Any]):
    """Stable latest-wins key after provenance and freshness validation."""
    captured = parse_datetime(observation.get("fetched_at"))
    digest = str(observation.get("source_sha256") or "")
    fingerprint = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return captured, digest, fingerprint


def _observation_values(observation: Mapping[str, Any], race: Mapping[str, Any], cutoff: Any) -> dict[str, Any] | None:
    """Compatibility wrapper for callers interested only in usable values."""
    value, _ = classify_prerace_observation(observation, race, cutoff)
    return value


def build_boat_prerace_v2_features(entries: Iterable[Mapping[str, Any]], *, race: Mapping[str, Any],
                                   predicted_at: Any, history: Iterable[Mapping[str, Any]] = (),
                                   observations: Iterable[Mapping[str, Any]] = ()) -> list[dict[str, Any]]:
    """Build a new, provenance-gated feature set from B facts and live observations.

    No K-file exhibit/weather values are read here. Weather is interacted with
    lane position so race-wide constants do not cancel in pairwise comparisons.
    """
    entries = list(entries)
    base = build_boat_features(entries, race_date=race.get("race_date"), predicted_at=predicted_at)
    prior = filter_historical(history, race_date=race.get("race_date"), predicted_at=predicted_at)
    by_racer: dict[str, list[Mapping[str, Any]]] = {}
    for row in prior:
        racer_id = row.get("racer_id")
        if isinstance(racer_id, str):
            by_racer.setdefault(racer_id, []).append(row)
    exhibition: dict[int, tuple[Any, str, str, dict[str, Any]]] = {}
    weather: tuple[Any, str, str, dict[str, Any]] | None = None
    for observation in observations:
        values = _observation_values(observation, race, predicted_at)
        if not values:
            continue
        try:
            key = _observation_selection_key(observation, values)
        except (TypeError, ValueError):
            continue
        # The store's arrival order can differ after archive import or replay.
        # Timestamp wins; source hash and canonical values break same-time ties.
        try:
            entry_number = int(observation.get("entry_number", -1))
        except (TypeError, ValueError):
            continue
        if observation.get("kind") == "weather" and entry_number == 0:
            if weather is None or key > (weather[0], weather[1], weather[2]):
                weather = (*key, values)
        elif observation.get("kind") == "exhibition":
            lane = entry_number
            if 1 <= lane <= 6:
                if lane not in exhibition or key > (exhibition[lane][0], exhibition[lane][1], exhibition[lane][2]):
                    exhibition[lane] = (*key, values)
    weather_values = weather[3] if weather else {}
    direction = {"北": 0.0, "北東": 45.0, "東": 90.0, "南東": 135.0,
                 "南": 180.0, "南西": 225.0, "西": 270.0, "北西": 315.0}.get(weather_values.get("wind_direction"))
    wind_speed = _safe_number(weather_values.get("wind_speed"))
    wave_height = _safe_number(weather_values.get("wave_height"))
    wind_x = wind_speed * math.sin(math.radians(direction)) if wind_speed is not None and direction is not None else None
    wind_y = wind_speed * math.cos(math.radians(direction)) if wind_speed is not None and direction is not None else None
    output = []
    for entry, legacy in zip(entries, base):
        number = int(entry.get("number", 0) or 0)
        try:
            extra = json.loads(entry.get("features_json") or "{}")
        except (TypeError, ValueError):
            extra = {}
        racer_id = extra.get("racer_id")
        past = by_racer.get(racer_id, []) if isinstance(racer_id, str) else []
        wins = sum(1 for row in past if row.get("finish_order") == 1 or str(row.get("finish_order")) == "1")
        obs = exhibition.get(number, (None, "", "", {}))[3]
        values = {key: legacy.get(key) for key in PRERACE_V2_FEATURE_COLUMNS
                  if key in legacy and key not in {"history_starts", "history_wins", "history_win_rate"}}
        values.update({
            "racer_history_starts": float(len(past)),
            "racer_history_wins": float(wins),
            "racer_history_win_rate": wins / len(past) if past else None,
            "exhibition_time": _safe_number(obs.get("exhibition_time")),
            "tilt": _safe_number(obs.get("tilt")),
            "observed_weight": _safe_number(obs.get("weight")),
            "start_exhibition": _safe_number(obs.get("start_exhibition")),
            "start_exhibition_course": _safe_number(obs.get("start_exhibition_course")),
            "start_exhibition_false_start": (1.0 if obs.get("start_exhibition_false_start") is True else
                                               0.0 if obs.get("start_exhibition_false_start") is False else None),
            "lane_wind_x": wind_x * (number - 3.5) if wind_x is not None else None,
            "lane_wind_y": wind_y * (number - 3.5) if wind_y is not None else None,
            "lane_wave_height": wave_height * (number - 3.5) if wave_height is not None else None,
        })
        output.append({key: values.get(key) for key in PRERACE_V2_FEATURE_COLUMNS})
    return output


def _safe_number(value: Any) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


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
                row["exhibiti