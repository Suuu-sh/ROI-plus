"""Candidate-only rolling-window reader for immutable real BOAT T-60 archives.

The R2 archive is the feature/prediction evidence; result labels are exported
separately after official verification. This module never updates the model
registry or live artifacts.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import itertools
import io
import json
import math
import os
import re
import zlib
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from edgelab.features.boat import BASE_FEATURE_COLUMNS

ARCHIVE_SCHEMA = "roi-plus-trifecta-observation-v1"
INDEX_SCHEMA = "roi-plus-trifecta-archive-index-v1"
LABEL_SCHEMA = "roi-plus-trifecta-label-export-v1"
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_RACE_ID = re.compile(r"^boat-(\d{8})-(\d{2})-(\d{2})$")
_KEY = re.compile(r"^historical-trifecta/v1/real/(\d{4}-\d{2}-\d{2})/(\d{2})/(\d{1,2})/([A-Za-z0-9._-]{1,160})/t-60\.json\.gz$")
_TICKETS = tuple(f"{a}-{b}-{c}" for a, b, c in itertools.permutations(range(1, 7), 3))
_MAX_INDEX_BYTES = 512 * 1024
_MAX_ARCHIVE_GZIP_BYTES = 2 * 1024 * 1024
_MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
_MAX_LABEL_BYTES = 512 * 1024
_MAX_WINDOW_INDEX_ITEMS = 30_000
_MAX_WINDOW_ARCHIVE_WIRE_BYTES = 512 * 1024 * 1024
_MAX_WINDOW_ARCHIVE_BYTES = 512 * 1024 * 1024
_PINNED_MODEL_ID = "boat-trifecta-historical-base-20261014"
_PINNED_MODEL_SHA256 = "b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a"
_PINNED_MODEL_VERSION = "2026-10-14.1"


def _aware(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("timestamp_missing")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp_timezone_missing")
    return parsed.astimezone(timezone.utc)


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


@lru_cache(maxsize=1)
def _pinned_model_metadata() -> dict[str, Any]:
    """Read and validate the bundled five-fit runtime model metadata."""
    model_path = Path(__file__).resolve().parents[2] / "apps/api/src/models/boat-trifecta-historical-base-20261014.json"
    try:
        metadata = json.loads(model_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise RuntimeError("pinned_model_metadata_unavailable") from None
    if (not isinstance(metadata, dict) or metadata.get("schema") != "roi-historical-trifecta-worker-model-v1"
            or metadata.get("modelId") != _PINNED_MODEL_ID
            or metadata.get("immutableVersion") != _PINNED_MODEL_VERSION
            or metadata.get("sourceArtifactSha256") != _PINNED_MODEL_SHA256
            or metadata.get("featureSchemaVersion") != "boat-base-v1"
            or metadata.get("featureColumns") != list(BASE_FEATURE_COLUMNS)
            or metadata.get("fitCount") != 5 or not isinstance(metadata.get("fits"), list)
            or len(metadata["fits"]) != 5):
        raise RuntimeError("pinned_model_metadata_invalid")
    try:
        metadata["_trainedAt"] = _aware(metadata.get("trainedAt"))
    except (TypeError, ValueError):
        raise RuntimeError("pinned_model_training_time_invalid") from None
    return metadata


def rolling_window(as_of: date) -> tuple[date, date]:
    """Return inclusive JST calendar-month start and exclusive as-of date.

    For example, 2026-10-14 means [2026-07-14, 2026-10-14). The as-of day is
    excluded as a race-date block so partial same-day outcomes cannot leak in.
    """
    month_index = as_of.year * 12 + (as_of.month - 1) - 3
    year, month0 = divmod(month_index, 12)
    month = month0 + 1
    day = min(as_of.day, (date(year + (month == 12), month % 12 + 1, 1) - date.resolution).day)
    return date(year, month, day), as_of


def _validate_archive(archive: Any, *, expected_key: str, expected_race_id: str,
                      lower: date, upper_exclusive: date, now: datetime
                      ) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(archive, Mapping) or archive.get("schema") != ARCHIVE_SCHEMA:
        return None, "archive_schema_invalid"
    race = archive.get("race")
    model = archive.get("model")
    timing = archive.get("timing")
    inputs = archive.get("input")
    predictions = archive.get("predictions")
    odds = archive.get("odds")
    archive_evidence = archive.get("archiveEvidence")
    if not all(isinstance(x, Mapping) for x in (race, model, timing, archive_evidence, inputs, predictions, odds)):
        return None, "archive_envelope_invalid"
    race_id = race.get("id")
    match = _RACE_ID.fullmatch(race_id) if isinstance(race_id, str) else None
    race_no = race.get("raceNo")
    if (archive.get("dataOrigin") != "real" or race_id != expected_race_id or not match
            or type(race_no) is not int or not 1 <= race_no <= 12
            or race.get("raceDate") != f"{match.group(1)[:4]}-{match.group(1)[4:6]}-{match.group(1)[6:8]}"
            or match.group(2) != race.get("venueId") or match.group(3) != f"{race_no:02d}"):
        return None, "race_identity_invalid"
    try:
        race_date = date.fromisoformat(str(race.get("raceDate")))
        predicted_at = _aware(timing.get("predictedAt"))
        cutoff_at = _aware(timing.get("cutoffAt"))
        target_at = _aware(timing.get("targetAt"))
        observed_at = _aware(timing.get("observedAt"))
        cutoff_observed_at = _aware(timing.get("cutoffObservedAt"))
    except (TypeError, ValueError, OverflowError):
        return None, "archive_time_invalid"
    if race_date < lower or race_date >= upper_exclusive:
        return None, "outside_window"
    if (timing.get("phase") != "t60" or timing.get("cutoffSource") != "boatrace-racelist-cutoff-v1"
            or predicted_at > now or observed_at > now or observed_at < predicted_at or target_at >= cutoff_at
            or cutoff_observed_at > predicted_at or cutoff_observed_at > target_at):
        return None, "archive_time_future_or_target_invalid"
    try:
        expected_target = cutoff_at.timestamp() - 60
    except (OverflowError, OSError):
        return None, "archive_time_invalid"
    if abs(target_at.timestamp() - expected_target) > 1:
        return None, "t60_target_mismatch"
    if predicted_at < target_at - timedelta(seconds=10) or predicted_at > target_at + timedelta(seconds=10):
        return None, "prediction_outside_t60_evaluation_window"
    try:
        pinned = _pinned_model_metadata()
    except RuntimeError as exc:
        return None, str(exc)
    try:
        model_trained_at = _aware(model.get("trainedAt"))
    except (TypeError, ValueError):
        return None, "model_training_time_invalid"
    if (model.get("id") != _PINNED_MODEL_ID
            or model.get("immutableVersion") != _PINNED_MODEL_VERSION
            or model.get("sourceArtifactSha256") != _PINNED_MODEL_SHA256
            or model.get("featureColumns") != pinned.get("featureColumns")
            or model_trained_at != pinned["_trainedAt"]):
        return None, "pinned_model_identity_mismatch"
    if model_trained_at > predicted_at:
        return None, "model_trained_after_prediction"
    if model.get("featureSchemaVersion") != "boat-base-v1" or model.get("featureColumns") != list(BASE_FEATURE_COLUMNS):
        return None, "feature_schema_unsupported"
    if (not isinstance(model.get("id"), str) or not model.get("immutableVersion")
            or not _SHA256.fullmatch(str(model.get("sourceArtifactSha256", "")))):
        return None, "model_source_proof_invalid"
    try:
        archive_evidence_at = _aware(archive_evidence.get("capturedAt"))
    except (TypeError, ValueError):
        return None, "archive_source_time_invalid"
    if (archive_evidence.get("status") != "verified" or not isinstance(archive_evidence.get("id"), str)
            or not _SHA256.fullmatch(str(archive_evidence.get("raceListSha256", "")))
            or archive_evidence_at > target_at or archive_evidence_at < target_at - timedelta(minutes=10)):
        return None, "archive_roster_proof_invalid"
    key_match = _KEY.fullmatch(expected_key)
    if (not key_match or key_match.group(1) != race_date.isoformat()
            or key_match.group(2) != str(race.get("venueId"))
            or int(key_match.group(3)) != race_no or key_match.group(4) != model.get("id")):
        return None, "archive_key_identity_mismatch"
    if inputs.get("status") != "complete" or predictions.get("status") != "complete" or odds.get("status") != "complete":
        return None, "incomplete_archive"

    rows = inputs.get("rows")
    if not isinstance(rows, list) or len(rows) != 6:
        return None, "input_roster_incomplete"
    input_by_lane: dict[int, Mapping[str, Any]] = {}
    input_hashes: set[str] = set()
    expected_b_url = (f"https://www1.mbrace.or.jp/od2/B/{race_date:%Y%m}/"
                      f"b{race_date:%y%m%d}.lzh")
    for row in rows:
        if not isinstance(row, Mapping) or type(row.get("lane")) is not int or row["lane"] not in range(1, 7):
            return None, "input_roster_invalid"
        lane = row["lane"]
        if lane in input_by_lane:
            return None, "input_roster_duplicate"
        source, features = row.get("source"), row.get("features")
        if not isinstance(source, Mapping) or not isinstance(features, Mapping):
            return None, "input_source_proof_missing"
        if (not _SHA256.fullmatch(str(source.get("sha256", "")))
                or source.get("url") != expected_b_url
                or source.get("kind") != "official-daily-b-file"):
            return None, "input_source_proof_invalid"
        try:
            available_at = _aware(row.get("availableAt"))
        except (TypeError, ValueError):
            return None, "input_availability_invalid"
        if available_at > predicted_at or source.get("availableAt") != row.get("availableAt"):
            return None, "input_after_prediction"
        input_hashes.add(str(source["sha256"]))
        if set(features) != set(BASE_FEATURE_COLUMNS) or not _finite(features.get("lane")) or int(features["lane"]) != lane:
            return None, "input_feature_schema_invalid"
        if any(value is not None and not _finite(value) for value in features.values()):
            return None, "input_feature_value_invalid"
        input_by_lane[lane] = row
    if set(input_by_lane) != set(range(1, 7)):
        return None, "input_roster_incomplete"
    if len(input_hashes) != 1:
        return None, "input_source_hash_mismatch"

    def market_rows(container: Mapping[str, Any], field: str, value_name: str) -> dict[str, Any] | None:
        records = container.get(field)
        if not isinstance(records, list) or len(records) != 120:
            return None
        found: dict[str, Any] = {}
        for record in records:
            if not isinstance(record, Mapping) or record.get("selection") not in _TICKETS:
                return None
            selection = record["selection"]
            value = record.get(value_name)
            if selection in found or not _finite(value):
                return None
            found[selection] = value
        return found if set(found) == set(_TICKETS) else None

    probs = market_rows(predictions, "rows", "probability")
    if probs is None or any(value < 0 or value > 1 for value in probs.values()) or abs(sum(probs.values()) - 1) > 1e-6:
        return None, "prediction_market_invalid"
    stds = {row["selection"]: row.get("probStd") for row in predictions["rows"]}
    if any(value is not None and (not _finite(value) or value < 0) for value in stds.values()):
        return None, "prediction_std_invalid"
    odds_values = market_rows(odds, "rows", "odds")
    if odds_values is None or any(value <= 0 for value in odds_values.values()):
        return None, "odds_market_invalid"
    if odds.get("qualityStatus") != "verified-complete-v1" or not _SHA256.fullmatch(str(odds.get("sha256", ""))):
        return None, "odds_source_proof_invalid"
    try:
        odds_at = _aware(odds.get("capturedAt"))
        odds_requested_at = _aware(odds.get("requestedAt"))
    except (TypeError, ValueError):
        return None, "odds_time_invalid"
    if (odds_requested_at > odds_at or odds_at > observed_at
            or odds_at < target_at - timedelta(seconds=10)
            or odds_at > target_at + timedelta(seconds=10)):
        return None, "odds_outside_t60_capture_window"
    expected_odds_url = ("https://www.boatrace.jp/owpc/pc/race/odds3t?"
                         f"rno={race_no}&jcd={race['venueId']}&hd={race_date:%Y%m%d}")
    if odds.get("sourceUrl") != expected_odds_url:
        return None, "odds_source_proof_invalid"

    return ({"key": expected_key, "archive": dict(archive), "race": dict(race),
             "raceId": race_id, "raceDate": race_date.isoformat(), "predictedAt": predicted_at.isoformat(),
             "features": [dict(input_by_lane[lane]["features"]) for lane in range(1, 7)],
             "probabilities": probs, "probStd": stds, "odds": odds_values,
             "oddsCapturedAt": odds_at.isoformat(), "archiveSha256": hashlib.sha256(
                 json.dumps(archive, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                           allow_nan=False).encode("utf-8")).hexdigest()}, None)


def _validate_label(label: Any, archive: Mapping[str, Any], now: datetime) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(label, Mapping):
        return None, "label_invalid"
    race = archive["race"]
    if (label.get("archiveKey") != archive["key"] or label.get("raceId") != race.get("id")
            or label.get("raceDate") != race.get("raceDate") or label.get("venueId") != race.get("venueId")
            or type(label.get("raceNo")) is not int or label.get("raceNo") != race.get("raceNo")):
        return None, "label_archive_identity_mismatch"
    source = label.get("source")
    expected_result_url = ("https://www.boatrace.jp/owpc/pc/race/raceresult?"
                           f"rno={race['raceNo']}&jcd={race['venueId']}&hd={str(race['raceDate']).replace('-', '')}")
    if (not isinstance(source, Mapping) or source.get("quality") != "verified-official-outcome-v2"
            or not _SHA256.fullmatch(str(source.get("sha256", "")))
            or source.get("url") != expected_result_url):
        return None, "label_source_proof_invalid"
    try:
        available_at = _aware(label.get("availableAt"))
    except (TypeError, ValueError):
        return None, "label_time_invalid"
    if (available_at > now or available_at < _aware(archive["archive"]["timing"]["cutoffAt"])
            or available_at <= _aware(archive["archive"]["timing"]["predictedAt"])
            or source.get("availableAt") != label.get("availableAt")):
        return None, "label_not_later_than_prediction"
    results = label.get("results")
    if not isinstance(results, list) or len(results) != 6:
        return None, "result_incomplete"
    by_number = {}
    for row in results:
        if (not isinstance(row, Mapping) or type(row.get("number")) is not int
                or row["number"] not in range(1, 7) or type(row.get("finishOrder")) is not int
                or row["finishOrder"] not in range(1, 7) or row["number"] in by_number):
            return None, "result_invalid"
        by_number[row["number"]] = row["finishOrder"]
    if sorted(by_number.values()) != list(range(1, 7)):
        return None, "result_incomplete"
    actual = "-".join(str(number) for number, _ in sorted(by_number.items(), key=lambda item: item[1])[:3])
    payout = label.get("trifectaPayout")
    if (not isinstance(payout, Mapping) or payout.get("selection") != actual
            or type(payout.get("payoutYen")) is not int or payout.get("payoutYen") <= 0):
        return None, "exact_trifecta_payout_invalid"
    return ({"raceId": race["id"], "raceDate": race["raceDate"], "finishOrder": by_number,
             "winningSelection": actual, "payoutYen": payout["payoutYen"],
             "availableAt": available_at.isoformat(), "source": dict(source)}, None)


def _read_json_response(url: str, token: str, *, limit: int, opener=urlopen) -> dict[str, Any]:
    request = Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json",
                                    "User-Agent": "ROI-Plus-HistoricalTrifecta/1.0"}, method="GET")
    try:
        with opener(request, timeout=30) as response:
            body = response.read(limit + 1)
        if not body or len(body) > limit:
            raise RuntimeError("response_size_invalid")
        payload = json.loads(body.decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"http_{exc.code}") from None
    except (URLError, TimeoutError, OSError):
        raise RuntimeError("transport_error") from None
    except (ValueError, UnicodeDecodeError):
        raise RuntimeError("invalid_json") from None
    if not isinstance(payload, dict):
        raise RuntimeError("invalid_envelope")
    return payload


def fetch_date_coverage(day: date, *, base_url: str, token: str, opener=urlopen) -> dict[str, Any]:
    """Read the independent expected-vs-stored archive coverage audit."""
    payload = _read_json_response(f"{base_url}/api/ingest/historical-trifecta-coverage?{urlencode({'date': day.isoformat()})}",
                                  token, limit=_MAX_INDEX_BYTES, opener=opener)
    if (payload.get("schema") != "roi-plus-trifecta-archive-coverage-v1"
            or payload.get("date") != day.isoformat()
            or any(type(payload.get(key)) is not int or payload[key] < 0
                   for key in ("expected", "complete", "incomplete", "missing", "failed"))
            or payload["complete"] + payload["incomplete"] + payload["missing"] + payload["failed"] > payload["expected"]
            or not isinstance(payload.get("entries"), list) or len(payload["entries"]) > 400):
        raise RuntimeError("invalid_archive_coverage")
    return {"date": day.isoformat(), "expected": payload["expected"], "complete": payload["complete"],
            "incomplete": payload["incomplete"], "missing": payload["missing"], "failed": payload["failed"],
            "truncated": bool(payload.get("truncated"))}


def iter_date_archives(day: date, *, base_url: str, token: str,
                       coverage: Counter[str], opener=urlopen) -> Iterator[tuple[dict[str, Any], bytes]]:
    """Yield one verified-size archive at a time; never retain a whole date in memory."""
    cursor = None
    seen_cursors: set[str] = set()
    seen: set[str] = set()
    for _ in range(401):
        query = {"date": day.isoformat(), "limit": 25}
        if cursor:
            query["cursor"] = cursor
        payload = _read_json_response(f"{base_url}/api/ingest/historical-trifecta-archives?{urlencode(query)}",
                                     token, limit=_MAX_INDEX_BYTES, opener=opener)
        if (payload.get("schema") != INDEX_SCHEMA or payload.get("date") != day.isoformat()
                or payload.get("limit") != 25 or not isinstance(payload.get("archives"), list)
                or len(payload["archives"]) > 25):
            raise RuntimeError("invalid_archive_index")
        for item in payload["archives"]:
            if not isinstance(item, Mapping):
                coverage["index_item_invalid"] += 1
                continue
            status = item.get("status")
            coverage["indexed"] += 1
            if coverage["indexed"] > _MAX_WINDOW_INDEX_ITEMS:
                raise RuntimeError("window_archive_limit_exceeded")
            if status != "complete":
                coverage[f"status_{status}" if status in {"incomplete", "missed"} else "status_unknown"] += 1
                continue
            key, race_id = item.get("key"), item.get("raceId")
            if not isinstance(key, str) or not _KEY.fullmatch(key) or not isinstance(race_id, str):
                coverage["index_identity_invalid"] += 1
                continue
            if key in seen:
                coverage["duplicate_key"] += 1
                continue
            seen.add(key)
            obj_query = urlencode({"key": key})
            request = Request(f"{base_url}/api/ingest/historical-trifecta-archive?{obj_query}",
                              headers={"Authorization": f"Bearer {token}", "Accept": "application/gzip",
                                       "User-Agent": "ROI-Plus-HistoricalTrifecta/1.0"}, method="GET")
            try:
                with opener(request, timeout=30) as response:
                    compressed = response.read(_MAX_ARCHIVE_GZIP_BYTES + 1)
                if not compressed or len(compressed) > _MAX_ARCHIVE_GZIP_BYTES:
                    coverage["archive_oversized"] += 1
                    continue
                coverage["archiveWireBytes"] += len(compressed)
                if coverage["archiveWireBytes"] > _MAX_WINDOW_ARCHIVE_WIRE_BYTES:
                    raise RuntimeError("window_archive_size_limit_exceeded")
                with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as stream:
                    decompressed = stream.read(_MAX_ARCHIVE_BYTES + 1)
                if len(decompressed) > _MAX_ARCHIVE_BYTES:
                    coverage["archive_oversized"] += 1
                    continue
                coverage["archiveBytes"] += len(decompressed)
                if coverage["archiveBytes"] > _MAX_WINDOW_ARCHIVE_BYTES:
                    raise RuntimeError("window_archive_decompressed_size_limit_exceeded")
            except HTTPError as exc:
                coverage[f"archive_http_{exc.code}"] += 1
                continue
            except (URLError, TimeoutError, OSError, EOFError, gzip.BadGzipFile, zlib.error):
                coverage["archive_read_invalid"] += 1
                continue
            yield dict(item), decompressed
            coverage["archive_bodies_downloaded"] += 1
        next_cursor = payload.get("nextCursor")
        if next_cursor is None:
            return
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors:
            raise RuntimeError("invalid_archive_cursor")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    raise RuntimeError("archive_page_limit_exceeded")


def iter_date_labels(day: date, *, base_url: str, token: str, opener=urlopen) -> Iterator[dict[str, Any]]:
    """Yield verified-envelope label records a bounded page at a time."""
    cursor = None
    seen_cursors: set[str] = set()
    for _ in range(401):
        query = {"date": day.isoformat(), "limit": 5}
        if cursor:
            query["cursor"] = cursor
        payload = _read_json_response(f"{base_url}/api/ingest/historical-trifecta-labels?{urlencode(query)}",
                                     token, limit=_MAX_LABEL_BYTES, opener=opener)
        if (payload.get("schema") != LABEL_SCHEMA or payload.get("date") != day.isoformat()
                or not isinstance(payload.get("labels"), list) or len(payload["labels"]) > 5):
            raise RuntimeError("invalid_label_export")
        for label in payload["labels"]:
            yield label
        next_cursor = payload.get("nextCursor")
        if next_cursor is None:
            return
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors:
            raise RuntimeError("invalid_label_cursor")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    raise RuntimeError("label_page_limit_exceeded")


def archived_metrics(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Score probabilities saved before outcomes were exported, not a replayed model."""
    losses, briers, lane_losses, hit = [], [], [], 0
    expected = set(_TICKETS)
    for record in records:
        probs = record.get("probabilities")
        actual = record.get("winningSelection")
        if not isinstance(probs, Mapping) or set(probs) != expected or actual not in expected:
            continue
        normalized = {key: max(0.0, float(value)) for key, value in probs.items()}
        total = sum(normalized.values())
        if total <= 0:
            continue
        p = normalized[actual] / total
        losses.append(-math.log(max(1e-15, p)))
        briers.append(sum((normalized[key] / total - (key == actual)) ** 2 for key in _TICKETS))
        # Weak lane baseline: uniform over exact orders, independently fixed.
        lane_losses.append(math.log(120))
        hit += max(normalized, key=normalized.get) == actual
    n = len(losses)
    return {"nRaces": n, "exactOrderLogLoss": sum(losses) / n if n else None,
            "multiclassBrier": sum(briers) / n if n else None,
            "uniformBaselineLogLoss": sum(lane_losses) / n if n else None,
            "topTicketHitRate": hit / n if n else None,
            "profitability": "not_evaluated_here"}


def _load_cache(cache_dir: Path) -> dict[str, Any]:
    manifest = cache_dir / "manifest.json"
    if not manifest.is_file():
        return {"archives": {}, "labels": {}}
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise RuntimeError("local_manifest_invalid") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("archives"), dict) or not isinstance(payload.get("labels"), dict):
        raise RuntimeError("local_manifest_invalid")
    return payload


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def _training_rows(validated: Sequence[Mapping[str, Any]], labels_by_key: Mapping[str, Mapping[str, Any]]
                   ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Make one race group per real archived race; never duplicate model captures."""
    by_race: dict[str, Mapping[str, Any]] = {}
    duplicate_archives = 0
    for record in validated:
        race_id = str(record["raceId"])
        prior = by_race.get(race_id)
        if prior is not None:
            duplicate_archives += 1
        if prior is None or (record["predictedAt"], record["archive"]["model"]["id"]) > (
                prior["predictedAt"], prior["archive"]["model"]["id"]):
            by_race[race_id] = record
    rows: list[dict[str, Any]] = []
    selected: list[dict[str, Any]] = []
    store: dict[str, list[dict[str, Any]]] = {key: [] for key in ("races", "odds_snapshots", "payouts")}
    skipped_no_label = 0
    for race_id, record in sorted(by_race.items(), key=lambda pair: (pair[1]["raceDate"], pair[0])):
        label = labels_by_key.get(record["key"])
        if not label:
            skipped_no_label += 1
            continue
        selected.append({"raceId": race_id, "raceDate": record["raceDate"], "archiveKey": record["key"],
                         "archiveSha256": record["archiveSha256"], "predictedAt": record["predictedAt"],
                         "cutoffAt": record["archive"]["timing"]["cutoffAt"],
                         "targetAt": record["archive"]["timing"]["targetAt"],
                         "archiveEvidenceStatus": record["archive"]["archiveEvidence"]["status"],
                         "archiveEvidenceId": record["archive"]["archiveEvidence"]["id"],
                         "archiveEvidenceCapturedAt": record["archive"]["archiveEvidence"]["capturedAt"],
                         "raceListSha256": record["archive"]["archiveEvidence"]["raceListSha256"],
                         "inputSources": [{"lane": row["lane"], "availableAt": row["availableAt"],
                             "sourceAvailableAt": row["source"]["availableAt"],
                             "sourceUrl": row["source"]["url"], "sourceSha256": row["source"]["sha256"]}
                             for row in sorted(record["archive"]["input"]["rows"], key=lambda x: x["lane"])],
                         "oddsRequestedAt": record["archive"]["odds"]["requestedAt"],
                         "oddsCapturedAt": record["oddsCapturedAt"],
                         "oddsSourceUrl": record["archive"]["odds"]["sourceUrl"],
                         "labelAvailableAt": label["availableAt"],
                         "resultSourceUrl": label["source"]["url"],
                         "resultSourceSha256": label["source"]["sha256"],
                         "archivedModelId": record["archive"]["model"]["id"],
                         "archivedModelVersion": record["archive"]["model"]["immutableVersion"],
                         "archivedModelTrainedAt": record["archive"]["model"]["trainedAt"],
                         "archivedModelArtifactSha256": record["archive"]["model"]["sourceArtifactSha256"]})
        race = record["race"]
        label_orders = label["finishOrder"]
        input_rows = record["archive"]["input"]["rows"]
        for item in sorted(input_rows, key=lambda row: row["lane"]):
            lane = int(item["lane"])
            row = {**item["features"], "race_id": race_id, "race_date": record["raceDate"],
                   "number": lane, "finish_order": label_orders[lane], "data_origin": "real",
                   "predicted_at": record["predictedAt"], "available_at": item["availableAt"],
                   "source_available_at": item["availableAt"], "source_observed_at": item["availableAt"],
                   "source_sha256": item["source"]["sha256"], "source_url": item["source"]["url"]}
            rows.append(row)
        timing = record["archive"]["timing"]
        odds = record["archive"]["odds"]
        store["races"].append({"id": race_id, "sport": "boat", "data_origin": "real",
                               "race_date": record["raceDate"], "race_no": race["raceNo"],
                               "venue_id": race["venueId"], "post_time": timing["cutoffAt"]})
        for selection, value in record["odds"].items():
            store["odds_snapshots"].append({"race_id": race_id, "bet_type": "trifecta", "selection": selection,
                "odds": value, "captured_at": record["oddsCapturedAt"], "source": "boatrace-trifecta-official-v1",
                "source_url": odds["sourceUrl"], "source_sha256": odds["sha256"],
                "quality_status": odds["qualityStatus"], "data_origin": "real"})
        store["payouts"].append({"race_id": race_id, "bet_type": "trifecta",
                                 "selection": label["winningSelection"], "payout": label["payoutYen"],
                                 "data_origin": "real", "source_url": label["source"]["url"],
                                 "source_sha256": label["source"]["sha256"],
                                 "available_at": label["availableAt"]})
    return rows, {"selectedArchives": selected, "store": store,
                  "duplicateRaceArchivesExcluded": duplicate_archives,
                  "racesWithoutVerifiedOutcomeLabel": skipped_no_label}


def run(*, as_of: str | None = None, cache_dir: str = "ml/data/historical-trifecta",
        report_path: str = "ml/data/learning/historical-trifecta-report.json",
        artifact_dir: str = "ml/artifacts/historical-trifecta") -> dict[str, Any]:
    """Read the JST trailing three calendar months and create an isolated candidate."""
    as_of_date = date.fromisoformat(as_of) if as_of else datetime.now(ZoneInfo("Asia/Tokyo")).date()
    if as_of and as_of_date.isoformat() != as_of:
        raise ValueError("as-of date must be YYYY-MM-DD")
    lower, upper = rolling_window(as_of_date)
    base_url = os.environ.get("EDGELAB_API_URL", "").rstrip("/")
    token = os.environ.get("INGEST_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError("historical archive reader configuration unavailable")
    root = Path(cache_dir)
    root.mkdir(parents=True, exist_ok=True)
    state = _load_cache(root)
    index: dict[str, dict[str, Any]] = state["archives"]
    cached_labels: dict[str, dict[str, Any]] = state["labels"]
    fresh_labels: dict[str, dict[str, Any]] = {}
    now = datetime.now(timezone.utc)
    counters: Counter[str] = Counter()
    verified_by_key: dict[str, dict[str, Any]] = {}
    coverage_by_date: list[dict[str, Any]] = []
    day = lower
    while day < upper:
        try:
            coverage_by_date.append(fetch_date_coverage(day, base_url=base_url, token=token))
        except RuntimeError:
            coverage_by_date.append({"date": day.isoformat(), "status": "unavailable"})
        for item, body in iter_date_archives(day, base_url=base_url, token=token, coverage=counters):
            if item.get("raceDate") != day.isoformat() or not isinstance(item.get("key"), str):
                counters["index_date_or_key_mismatch"] += 1
                continue
            try:
                archive = json.loads(body.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                counters["archive_json_invalid"] += 1
                continue
            record, reason = _validate_archive(archive, expected_key=item["key"],
                                               expected_race_id=item.get("raceId", ""),
                                               lower=lower, upper_exclusive=upper, now=now)
            if reason:
                counters[f"excluded_{reason}"] += 1
                continue
            archive_hash = hashlib.sha256(body).hexdigest()
            if item.get("etag") is not None and (not isinstance(item.get("etag"), str) or len(item["etag"]) > 256):
                counters["index_etag_invalid"] += 1
                continue
            filename = hashlib.sha256(item["key"].encode("utf-8")).hexdigest() + ".json"
            destination = root / "archives" / filename
            _atomic_json(destination, archive)
            index[item["key"]] = {"etag": item.get("etag"), "sha256": archive_hash,
                                   "file": str(destination.relative_to(root)),
                                   "raceId": item["raceId"], "raceDate": item["raceDate"],
                                   "predictedAt": record["predictedAt"]}
            verified_by_key[item["key"]] = {"key": item["key"], "raceId": item["raceId"],
                "raceDate": item["raceDate"], "predictedAt": record["predictedAt"],
                "archiveSha256": archive_hash, "file": str(destination.relative_to(root))}
            counters["archive_valid"] += 1
        day += date.resolution
    # Read labels separately; their availability timestamps are post-prediction
    # and they do not alter the immutable observation documents.
    day = lower
    while day < upper:
        for label in iter_date_labels(day, base_url=base_url, token=token):
            counters["labelExported"] += 1
            if counters["labelExported"] > _MAX_WINDOW_INDEX_ITEMS:
                raise RuntimeError("window_label_limit_exceeded")
            if not isinstance(label, Mapping) or not isinstance(label.get("archiveKey"), str):
                counters["label_invalid"] += 1
                continue
            key = label["archiveKey"]
            meta = verified_by_key.get(key)
            if not meta:
                counters["label_without_archive"] += 1
                continue
            try:
                archive = json.loads((root / meta["file"]).read_text(encoding="utf-8"))
                record, reason = _validate_archive(archive, expected_key=key, expected_race_id=meta["raceId"],
                                                   lower=lower, upper_exclusive=upper, now=now)
            except (OSError, ValueError, KeyError):
                record, reason = None, "cached_archive_invalid"
            if reason or record is None:
                counters[f"excluded_{reason or 'cached_archive_invalid'}"] += 1
                continue
            record["archiveSha256"] = meta["archiveSha256"]
            parsed, reason = _validate_label(label, record, now)
            if reason or parsed is None:
                counters[f"excluded_{reason or 'label_invalid'}"] += 1
                continue
            # First verified label is immutable. Conflicting later source data
            # remains visible in the exclusion counter rather than rewriting.
            prior = cached_labels.get(key)
            normalized = {**parsed, "labelSha256": hashlib.sha256(json.dumps(
                label, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                allow_nan=False).encode("utf-8")).hexdigest()}
            if prior and (prior.get("winningSelection"), prior.get("payoutYen"), prior.get("finishOrder")) != (
                    normalized["winningSelection"], normalized["payoutYen"], normalized["finishOrder"]):
                counters["label_conflict"] += 1
                continue
            cached_labels[key] = normalized
            fresh_labels[key] = normalized
            counters["label_valid"] += 1
        day += date.resolution
    labeled_archives: list[dict[str, Any]] = []
    for key, label in fresh_labels.items():
        meta = verified_by_key.get(key)
        if not meta:
            continue
        try:
            archive = json.loads((root / meta["file"]).read_text(encoding="utf-8"))
            record, reason = _validate_archive(archive, expected_key=key, expected_race_id=meta["raceId"],
                                               lower=lower, upper_exclusive=upper, now=now)
        except (OSError, ValueError, KeyError):
            record, reason = None, "cached_archive_invalid"
        if reason or record is None:
            counters[f"excluded_{reason or 'cached_archive_invalid'}"] += 1
            continue
        record["archiveSha256"] = meta["archiveSha256"]
        labeled_archives.append(record)
    rows, details = _training_rows(labeled_archives, fresh_labels)
    fit_groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        fit_groups.setdefault(row["race_id"], []).append(row)
    groups = [fit_groups[key] for key in sorted(fit_groups)]
    # Canonical snapshot hashes freeze exact included source evidence and labels.
    selected = details["selectedArchives"]
    source_manifest = {"schema": "roi-plus-historical-trifecta-training-manifest-v1",
        "window": {"sinceInclusive": lower.isoformat(), "asOfDateExclusive": upper.isoformat(),
                   "timezone": "Asia/Tokyo", "calendarMonths": 3},
        "raceArchives": selected,
        "dailyArchiveCoverage": coverage_by_date,
        "excludedCounts": dict(sorted(counters.items())),
        "duplicateRaceArchivesExcluded": details["duplicateRaceArchivesExcluded"],
        "racesWithoutVerifiedOutcomeLabel": details["racesWithoutVerifiedOutcomeLabel"]}
    source_manifest_bytes = json.dumps(source_manifest, sort_keys=True, separators=(",", ":"),
                                       ensure_ascii=False, allow_nan=False).encode("utf-8")
    source_manifest_sha = hashlib.sha256(source_manifest_bytes).hexdigest()
    dataset_snapshot_sha = hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":"),
        ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()
    coverage_scope_complete = bool(coverage_by_date) and all(
        item.get("status") != "unavailable" and not item.get("truncated")
        and item.get("expected") == sum(item.get(k, 0) for k in ("complete", "incomplete", "missing", "failed"))
        for item in coverage_by_date)
    coverage_expected = sum(item.get("expected", 0) for item in coverage_by_date
                            if isinstance(item.get("expected"), int))
    coverage_complete = sum(item.get("complete", 0) for item in coverage_by_date
                            if isinstance(item.get("complete"), int))
    report: dict[str, Any] = {"schema": "roi-plus-historical-trifecta-candidate-v1",
        "status": "insufficient_data", "window": source_manifest["window"],
        "archiveCoverage": dict(sorted(counters.items())),
        "dailyArchiveCoverage": coverage_by_date,
        "archiveCoverageComplete": coverage_scope_complete,
        "archiveCompletenessRate": (coverage_complete / coverage_expected
                                     if coverage_scope_complete and coverage_expected else None),
        "archiveCompletenessRateScope": "only reported when every window date coverage page is complete",
        "verifiedUniqueRaceCount": len(groups), "sourceManifestSha256": source_manifest_sha,
        "trainingSnapshotSha256": dataset_snapshot_sha,
        "promotionEligible": False, "promotion": "not_performed",
        "registryWrite": "not_performed", "predictionSync": "not_performed",
        "profitabilityProven": False}
    _atomic_json(root / "labels.json", cached_labels)
    _atomic_json(root / "manifest.json", {"archives": index, "labels": cached_labels})
    _atomic_json(root / "training-source-manifest.json", source_manifest)
    if len(groups) < 300:
        report["reason"] = "fewer_than_300_unique_labeled_races_in_three_calendar_months"
        report["candidate"] = {"status": "unqualified", "promotionEligible": False}
    else:
        from edgelab.models.compare import temporal_split
        from edgelab.models.trifecta import (TICKET_SCHEMA, PREDICTION_SEMANTICS,
            _actual_selection, _group_races, _lane_order_model, _proper_ticket_metrics,
            train_trifecta)
        flat = [row for group in groups for row in group]
        train, valid, test = temporal_split(flat)
        train_groups = [group for group in _group_races(train)]
        valid_groups = [group for group in _group_races(valid)]
        test_groups = [group for group in _group_races(test)]
        report["split"] = {"method": "chronological race-date blocks; train/calibration/test",
            "trainRaces": len(train_groups), "calibrationRaces": len(valid_groups),
            "testRaces": len(test_groups),
            "trainDates": sorted({str(g[0]["race_date"]) for g in train_groups}),
            "calibrationDates": sorted({str(g[0]["race_date"]) for g in valid_groups}),
            "testDates": sorted({str(g[0]["race_date"]) for g in test_groups})}
        if not train_groups or not valid_groups or not test_groups:
            report["reason"] = "chronological_date_blocks_unavailable"
        else:
            candidate_id = f"boat-trifecta-r2-candidate-{source_manifest_sha[:12]}"
            candidate_dir = Path(artifact_dir)
            pkl_path, metadata_path = (candidate_dir / f"{candidate_id}.pkl",
                                       candidate_dir / f"{candidate_id}.json")
            if pkl_path.exists() or metadata_path.exists():
                if not pkl_path.is_file() or not metadata_path.is_file():
                    raise RuntimeError("candidate_artifact_pair_incomplete")
                try:
                    fit = json.loads(metadata_path.read_text(encoding="utf-8"))
                    artifact_hash = hashlib.sha256(pkl_path.read_bytes()).hexdigest()
                except (OSError, ValueError):
                    raise RuntimeError("candidate_artifact_integrity_unavailable") from None
                if fit.get("id") != candidate_id or fit.get("ticketArtifactSha256") != artifact_hash:
                    raise RuntimeError("candidate_artifact_integrity_mismatch")
            else:
                fit = train_trifecta(flat, details["store"], model_id=candidate_id,
                                     artifact_dir=artifact_dir, min_train_races=300)
            report["candidate"] = {"id": candidate_id, "status": fit.get("status"),
                "reason": fit.get("reason"), "trainRaces": fit.get("nTrainRaces"),
                "calibrationRaces": fit.get("nValidRaces"), "testRaces": fit.get("nTestRaces"),
                "metrics": fit.get("metrics"), "artifactSha256": fit.get("ticketArtifactSha256"),
                "artifactFiles": ([f"{candidate_id}.pkl", f"{candidate_id}.json"]
                                  if fit.get("ticketArtifactSha256") else []),
                "ticketModelSchemaVersion": TICKET_SCHEMA,
                "ticketPredictionSemantics": PREDICTION_SEMANTICS,
                "promotionEligible": False}
            if fit.get("ticketArtifactSha256"):
                alpha = fit.get("metrics", {}).get("laneBaselineSmoothingAlpha", 1.0)
                lane_probs = _lane_order_model(train_groups, float(alpha))
                holdout_races = {str(group[0]["race_id"]) for group in test_groups}
                original = []
                for race_id, record in ((rid, next(r for r in labeled_archives if r["key"] == key)) for rid, key in
                                        ((str(r["raceId"]), str(r["archiveKey"])) for r in selected)):
                    if race_id not in holdout_races:
                        continue
                    label = fresh_labels.get(record["key"])
                    if label:
                        original.append({"race_id": race_id, "probabilities": record["probabilities"],
                                         "winningSelection": label["winningSelection"]})
                archived = archived_metrics(original)
                if original:
                    lane_groups = []
                    for group in test_groups:
                        if str(group[0]["race_id"]) in {r["race_id"] for r in original}:
                            lane_groups.append(group)
                    lane_metrics = _proper_ticket_metrics(lane_groups, [lane_probs] * len(lane_groups)) if lane_groups else {}
                    archived["laneOrderBaselineLogLoss"] = lane_metrics.get("exactOrderLogLoss")
                    if archived["exactOrderLogLoss"] is not None and archived["laneOrderBaselineLogLoss"] is not None:
                        archived["archivedMinusLaneLogLoss"] = archived["exactOrderLogLoss"] - archived["laneOrderBaselineLogLoss"]
                report["archivedOriginalProbabilitiesOnSameHoldout"] = archived
                report["status"] = "candidate_created_unqualified" if not fit.get("metrics", {}).get("evaluationQualified") else "candidate_created"
                report["candidate"]["evaluationQualified"] = bool(fit.get("metrics", {}).get("evaluationQualified"))
            else:
                report["reason"] = fit.get("reason", "candidate_not_created")
    _atomic_json(Path(report_path), report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Build an isolated candidate from recent immutable BOAT R2 archives")
    parser.add_argument("--as-of", help="exclusive JST as-of race date, YYYY-MM-DD")
    parser.add_argument("--cache-dir", default="ml/data/historical-trifecta")
    parser.add_argument("--report", default="ml/data/learning/historical-trifecta-report.json")
    parser.add_argument("--artifact-dir", default="ml/artifacts/historical-trifecta")
    args = parser.parse_args()
    result = run(as_of=args.as_of, cache_dir=args.cache_dir, report_path=args.report,
                 artifact_dir=args.artifact_dir)
    print(json.dumps({key: result.get(key) for key in ("status", "reason", "window",
        "verifiedUniqueRaceCount", "sourceManifestSha256", "trainingSnapshotSha256",
        "promotion", "registryWrite", "predictionSync")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

