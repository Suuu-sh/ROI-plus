"""Read-only verification that one explicitly named real BOAT race is learnable."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from edgelab.historical_trifecta import (
    _PINNED_MODEL_ID,
    _PINNED_MODEL_SHA256,
    _PINNED_MODEL_VERSION,
    _training_rows,
    _validate_archive,
    _validate_label,
    fetch_date_coverage,
    iter_date_archives,
    iter_date_labels,
)
from edgelab.features.boat import BASE_FEATURE_COLUMNS

_RACE_ID = re.compile(r"^boat-(\d{8})-(\d{2})-(\d{2})$")


def _safe_code(value: Any, fallback: str = "verification_error") -> str:
    text = str(value)
    return text if re.fullmatch(r"[a-z0-9_]{1,80}", text) else fallback


def _base_report(day_text: str, race_id: str) -> dict[str, Any]:
    return {
        "schema": "roi-plus-historical-trifecta-race-verification-v1",
        "status": "waiting_archive",
        "raceId": race_id,
        "raceDate": day_text,
        "dataOrigin": "real",
        "readOnly": True,
        "candidateFitPerformed": False,
        "registryWrite": "not_performed",
        "predictionSync": "not_performed",
        "promotion": "not_performed",
        "promotionEligible": False,
    }


def _archive_summary(record: Mapping[str, Any], decompressed_sha256: str) -> dict[str, Any]:
    archive = record["archive"]
    inputs = archive["input"]["rows"]
    features = [row["features"] for row in inputs]
    feature_values = [row[column] for row in features for column in BASE_FEATURE_COLUMNS]
    return {
        "immutableKey": record["key"],
        "decompressedJsonSha256": decompressed_sha256,
        "r2Index": dict(record.get("indexMetadata", {})),
        "raceId": record["raceId"],
        "raceDate": record["raceDate"],
        "cutoffAt": archive["timing"]["cutoffAt"],
        "cutoffSource": archive["timing"]["cutoffSource"],
        "cutoffObservedAt": archive["timing"]["cutoffObservedAt"],
        "targetAt": archive["timing"]["targetAt"],
        "predictedAt": record["predictedAt"],
        "observedAt": archive["timing"]["observedAt"],
        "archiveEvidence": {"capturedAt": archive["archiveEvidence"]["capturedAt"],
                            "raceListSha256": archive["archiveEvidence"]["raceListSha256"]},
        "model": {"id": archive["model"]["id"],
                  "sourceArtifactSha256": archive["model"]["sourceArtifactSha256"],
                  "immutableVersion": archive["model"]["immutableVersion"],
                  "trainedAt": archive["model"]["trainedAt"]},
        "input": {
            "rows": len(inputs),
            "featureColumns": len(BASE_FEATURE_COLUMNS),
            "finiteFeatureValues": sum(value is not None for value in feature_values),
            "nullFeatureValues": sum(value is None for value in feature_values),
            "source": [{"lane": row["lane"], "url": row["source"]["url"],
                        "sha256": row["source"]["sha256"], "availableAt": row["availableAt"],
                        "sourceAvailableAt": row["source"]["availableAt"]}
                       for row in sorted(inputs, key=lambda item: item["lane"])],
        },
        "predictions": {"rows": len(record["probabilities"]),
                        "finiteProbabilityRows": len(record["probabilities"]),
                        "probabilitySum": sum(record["probabilities"].values()),
                        "finiteProbabilityStdRows": sum(value is not None for value in record["probStd"].values()),
                        "nullProbabilityStdRows": sum(value is None for value in record["probStd"].values())},
        "odds": {"rows": len(record["odds"]), "capturedAt": record["oddsCapturedAt"],
                 "requestedAt": archive["odds"]["requestedAt"],
                 "sourceUrl": archive["odds"]["sourceUrl"], "sha256": archive["odds"]["sha256"],
                 "positiveFiniteRows": sum(value > 0 for value in record["odds"].values())},
    }


def verify_race(*, date_text: str, race_id: str, base_url: str, token: str,
                opener=None, now: datetime | None = None) -> dict[str, Any]:
    """Verify only the named race through the same readers used by retraining.

    No archive or label is synthesized. A waiting status is a valid result when
    the real capture or its later verified official outcome is not present yet.
    """
    report = _base_report(date_text, race_id)
    match = _RACE_ID.fullmatch(race_id)
    try:
        day = date.fromisoformat(date_text)
    except (TypeError, ValueError):
        report.update(status="invalid", reason="invalid_date")
        return report
    if (day.isoformat() != date_text or not match
            or f"{match.group(1)[:4]}-{match.group(1)[4:6]}-{match.group(1)[6:8]}" != date_text
            or not 1 <= int(match.group(3)) <= 12):
        report.update(status="invalid", reason="race_identity_invalid")
        return report
    if not base_url or not token:
        report.update(status="waiting_archive", reason="reader_configuration_unavailable")
        return report
    opener = opener or __import__("urllib.request", fromlist=["urlopen"]).urlopen
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        report.update(status="invalid", reason="verification_clock_timezone_missing")
        return report
    now = now.astimezone(timezone.utc)

    try:
        coverage = fetch_date_coverage(day, base_url=base_url, token=token, opener=opener,
                                       expected_race_id=race_id)
        report["coverage"] = coverage.get("targetRace")
    except RuntimeError as exc:
        report["coverage"] = {"status": "unknown", "reason": _safe_code(exc)}

    counters: Counter[str] = Counter()
    record = None
    decompressed_sha256 = None
    archive_read_error = None
    try:
        for item, body in iter_date_archives(day, base_url=base_url, token=token,
                                             coverage=counters, opener=opener,
                                             expected_race_id=race_id,
                                             expected_model_id=_PINNED_MODEL_ID):
            if item.get("raceId") != race_id or item.get("raceDate") != day.isoformat():
                continue
            try:
                archive = json.loads(body.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                report.update(status="invalid", reason="archive_json_invalid")
                return report
            candidate, reason = _validate_archive(
                archive, expected_key=item["key"], expected_race_id=race_id,
                lower=day, upper_exclusive=day + timedelta(days=1), now=now)
            if reason:
                report.update(status="invalid", reason=_safe_code(reason))
                return report
            record = candidate
            decompressed_sha256 = hashlib.sha256(body).hexdigest()
            record["archiveSha256"] = decompressed_sha256
            record["indexMetadata"] = {key: item.get(key) for key in ("etag", "uploadedAt", "size", "status")}
            break
    except RuntimeError as exc:
        archive_read_error = _safe_code(exc)

    if record is None:
        target_coverage = report.get("coverage") or {}
        archive_failures = sum(value for key, value in counters.items()
                               if key.startswith("archive_http_") or key == "archive_read_invalid")
        report["status"] = "waiting_archive"
        report["reason"] = (archive_read_error or ("archive_read_failed" if archive_failures else None)
                            or target_coverage.get("failureReason")
                            or "complete_archive_not_available")
        report["archiveIndex"] = {"matchingCompleteArchives": counters["archive_bodies_downloaded"],
                                  "partialOrMissedItems": counters["status_incomplete"] + counters["status_missed"],
                                  "readFailures": archive_failures}
        return report

    report["archive"] = _archive_summary(record, decompressed_sha256 or "")
    report["status"] = "archive_verified_waiting_label"
    report["reason"] = "verified_official_result_label_not_available"
    label = None
    label_read_error = None
    try:
        for candidate in iter_date_labels(day, base_url=base_url, token=token, opener=opener,
                                          expected_archive_key=record["key"]):
            label, reason = _validate_label(candidate, record, now)
            if reason:
                report.update(status="invalid", reason=_safe_code(reason))
                return report
            break
    except RuntimeError as exc:
        label_read_error = _safe_code(exc)
    if label is None:
        if label_read_error:
            report["reason"] = label_read_error
        return report

    report["label"] = {"availableAt": label["availableAt"],
                       "resultSourceUrl": label["source"]["url"],
                       "resultSourceSha256": label["source"]["sha256"],
                       "winningSelection": label["winningSelection"],
                       "payoutYen": label["payoutYen"]}
    rows, details = _training_rows([record], {record["key"]: label})
    lanes = sorted(row["number"] for row in rows)
    if (len(rows) != 6 or lanes != list(range(1, 7))
            or len({row["race_id"] for row in rows}) != 1
            or {row["race_id"] for row in rows} != {race_id}
            or len(details["store"]["odds_snapshots"]) != 120
            or len(details["store"]["payouts"]) != 1):
        report.update(status="invalid", reason="shared_training_row_builder_incomplete")
        return report
    training_snapshot = json.dumps(rows, sort_keys=True, separators=(",", ":"),
                                   ensure_ascii=False, allow_nan=False).encode("utf-8")
    report["trainingInput"] = {
        "builder": "edgelab.historical_trifecta._training_rows",
        "trainingRows": len(rows),
        "raceGroups": 1,
        "laneNumbers": lanes,
        "featureColumns": len(BASE_FEATURE_COLUMNS),
        "oddsRows": len(details["store"]["odds_snapshots"]),
        "payoutRows": len(details["store"]["payouts"]),
        "trainingSnapshotSha256": hashlib.sha256(training_snapshot).hexdigest(),
        "candidateFitPerformed": False,
    }
    report.update(status="verified", reason=None, labelStatus="verified-official-outcome-v2",
                  modelPin={"id": _PINNED_MODEL_ID, "sourceArtifactSha256": _PINNED_MODEL_SHA256,
                            "immutableVersion": _PINNED_MODEL_VERSION})
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only verification of one real historical trifecta R2 race")
    parser.add_argument("--date", required=True, help="JST race date, YYYY-MM-DD")
    parser.add_argument("--race-id", required=True, help="Exact race identity, e.g. boat-YYYYMMDD-03-01")
    parser.add_argument("--report", default="ml/data/learning/historical-trifecta-race-verification.json")
    args = parser.parse_args()
    result = verify_race(date_text=args.date, race_id=args.race_id,
                         base_url=os.environ.get("EDGELAB_API_URL", "").rstrip("/"),
                         token=os.environ.get("INGEST_TOKEN", ""))
    path = Path(args.report)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({key: result.get(key) for key in
                      ("status", "reason", "raceId", "raceDate", "immutableKey",
                       "trainingInput", "promotion")}, ensure_ascii=False))
    return 1 if result["status"] == "invalid" else 0


if __name__ == "__main__":
    raise SystemExit(main())
