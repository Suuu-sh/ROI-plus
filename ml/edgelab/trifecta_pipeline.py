"""Bounded archive sync and fail-closed trifecta coverage/training runner.

This pipeline only reads the authenticated archive export and trains a local
candidate. It never collects from race sites or promotes/syncs model state.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

from edgelab.importers.boatrace_capture_archive import import_capture_archives
from edgelab.sync import fetch_prerace_capture_archives
from edgelab.storage import DEFAULT_STORE, load_rows, save_rows

SAFE_ARCHIVE_EXCLUSION_REASONS = frozenset({
    "export_page_invalid", "archive_wrapper_invalid", "archive_checksum_missing",
    "archive_checksum_mismatch", "archive_json_invalid", "archive_schema_invalid",
    "timestamp_missing", "timestamp_timezone_missing",
    "archive_race_invalid", "archive_date_mismatch", "race_identity_or_real_race_missing",
    "archive_id_mismatch", "archive_sources_missing", "archive_parser_version_unsupported",
    "archive_source_identity_mismatch", "source_checksum_invalid",
    "racelist_beforeinfo_cutoff_mismatch", "archive_capture_or_cutoff_order_invalid",
    "odds_market_not_verified_nonfinal", "exhibition_lanes_incomplete", "exhibition_lane_invalid",
    "exhibition_lane_duplicate", "exhibition_value_invalid", "weather_observation_after_capture",
    "weather_observation_missing", "weather_label_invalid", "weather_values_invalid",
    "weather_field_unsupported", "weather_value_invalid", "racelist_entries_incomplete",
    "racelist_cached_entries_incomplete", "racelist_entry_invalid", "racelist_entry_duplicate",
    "racelist_entry_identity_mismatch", "odds_market_incomplete", "odds_row_invalid",
    "cutoff_evidence_invalid", "cutoff_evidence_conflict", "immutable_capture_key_conflict",
})


def _safe_exclusion_counts(value: object) -> dict[str, int]:
    """Expose fixed parser reason codes only, never arbitrary exception text."""
    if not isinstance(value, dict):
        return {}
    counts: dict[str, int] = {}
    unknown = 0
    for reason, count in value.items():
        amount = count if type(count) is int and count > 0 else 0
        if reason in SAFE_ARCHIVE_EXCLUSION_REASONS:
            if amount:
                counts[reason] = counts.get(reason, 0) + amount
        else:
            unknown += amount
    if unknown:
        counts["other"] = unknown
    return counts


def fetch_archive_pages(day: str, *, base_url: str, token: str) -> list[dict]:
    """Reuse the bounded, authenticated export reader used by the sync layer."""
    return fetch_prerace_capture_archives(day, base_url=base_url, token=token)


def run(*, since: str, until: str, store_path: str = str(DEFAULT_STORE),
        report_path: str = "ml/data/learning/trifecta-pipeline-report.json",
        train: bool = True) -> dict:
    start, end = date.fromisoformat(since), date.fromisoformat(until)
    if (start.isoformat() != since or end.isoformat() != until
            or end < start or (end - start).days > 31):
        raise ValueError("date range must be ordered and at most 32 days")
    base_url, token = os.environ.get("EDGELAB_API_URL", "").rstrip("/"), os.environ.get("INGEST_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError("archive_export_credentials_unavailable")
    rows = load_rows(store_path)
    report: dict = {"schema": "trifecta-candidate-pipeline-v1", "range": {"since": since, "until": until},
                    "archiveDates": 0, "importedArchives": 0, "excludedArchives": 0,
                    "archiveExclusionCounts": {},
                    "archiveExclusionCountsByDate": {},
                    "training": {"status": "not_attempted"}, "promotion": "not_performed"}
    day = start
    while day <= end:
        day_text = day.isoformat()
        pages = fetch_archive_pages(day_text, base_url=base_url, token=token)
        imported = import_capture_archives(rows, pages, day_text)
        report["archiveDates"] += 1
        report["importedArchives"] += imported["importedArchives"]
        report["excludedArchives"] += imported["excludedArchives"]
        safe_counts = _safe_exclusion_counts(imported.get("exclusionCounts"))
        report["archiveExclusionCountsByDate"][day_text] = safe_counts
        for reason, count in safe_counts.items():
            report["archiveExclusionCounts"][reason] = report["archiveExclusionCounts"].get(reason, 0) + count
        day += timedelta(days=1)
    if report["importedArchives"]:
        save_rows(rows, store_path)

    from edgelab.cli import _make_training_rows
    from edgelab.features.boat import PRERACE_V2_SCHEMA
    from edgelab.models.trifecta_coverage import audit_trifecta_coverage
    all_training_rows = _make_training_rows(rows, "boat", feature_schema=PRERACE_V2_SCHEMA)
    training_rows = _make_training_rows(rows, "boat", feature_schema=PRERACE_V2_SCHEMA,
                                        require_source_arrival=True)
    coverage = audit_trifecta_coverage(rows, training_rows)
    training_race_ids = {str(item.get("race_id")) for item in training_rows if item.get("race_id")}
    all_training_race_ids = {str(item.get("race_id")) for item in all_training_rows if item.get("race_id")}
    report["coverage"] = {key: coverage[key] for key in (
        "status", "finishedRealBoatRaces", "distinctRaceDates", "completeEvidenceRaces",
        "trainingRaceIdsPresentInStore", "promotionEvidenceComplete", "counts", "exclusions")}
    # The trainer owns its hard temporal/holdout qualification checks; do not
    # relax them here. Only attempt once the immutable PIT feature pipeline has
    # built enough eligible races for its documented 300-race floor.
    report["training"]["eligibleRealRaceCount"] = len(training_race_ids)
    report["training"]["unprovenRealRaceCount"] = len(all_training_race_ids - training_race_ids)
    if train and len(training_race_ids) >= 300:
        cohort_payload = json.dumps(training_rows, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), default=str, allow_nan=False)
        digest = hashlib.sha256(cohort_payload.encode()).hexdigest()[:16]
        candidate_id = f"boat-trifecta-lgbm-pit-{digest}"
        report["training"]["candidateId"] = candidate_id
        artifact_dir = Path("ml/artifacts")
        existing_candidate = (any(str(model.get("id")) == candidate_id for model in rows.get("models", []))
                              or (artifact_dir / f"{candidate_id}.pkl").exists()
                              or (artifact_dir / f"{candidate_id}.json").exists())
        if existing_candidate:
            report["training"]["status"] = "candidate_already_exists_for_cohort"
            target = Path(report_path).with_name("trifecta-pipeline-summary.json")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            return report
        output = Path(report_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run([sys.executable, "-m", "edgelab", "train-trifecta",
                               "--min-train-races", "300", "--model-id", candidate_id,
                               "--store", str(store_path), "--output", str(output)],
                              env={**os.environ, "PYTHONPATH": str(Path("ml").resolve())},
                              text=True, capture_output=True, check=False)
        if proc.returncode == 0:
            report["training"].update({"status": "completed", "report": str(output)})
        else:
            report["training"].update({"status": "not_qualified_or_failed", "exitCode": proc.returncode})
    elif train:
        report["training"]["status"] = "insufficient_pit_evidence"
    target = Path(report_path).with_name("trifecta-pipeline-summary.json")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True)
    parser.add_argument("--until", required=True)
    parser.add_argument("--store", default=str(DEFAULT_STORE))
    parser.add_argument("--report", default="ml/data/learning/trifecta-report.json")
    parser.add_argument("--no-train", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = run(since=args.since, until=args.until, store_path=args.store,
                     report_path=args.report, train=not args.no_train)
    except Exception as exc:
        # Keep machine-readable, low-sensitivity failure evidence for Actions;
        # do not print API response bodies, URLs, secrets, or tracebacks.
        category = ("invalid_date_range" if isinstance(exc, ValueError) else
                    "archive_or_training_pipeline_error" if isinstance(exc, RuntimeError) else
                    "local_pipeline_error")
        result = {"schema": "trifecta-candidate-pipeline-v1", "training": {"status": "not_attempted"},
                  "promotion": "not_performed", "archiveExclusionCounts": {},
                  "archiveExclusionCountsByDate": {}, "error": category}
        target = Path(args.report).with_name("trifecta-pipeline-summary.json")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["training"]["status"] in {
        "completed", "insufficient_pit_evidence", "not_attempted", "candidate_already_exists_for_cohort"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
