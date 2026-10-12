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
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from edgelab.importers.boatrace_capture_archive import import_capture_archives
from edgelab.sync import fetch_prerace_capture_archives
from edgelab.storage import DEFAULT_STORE, load_rows, save_rows


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
                    "training": {"status": "not_attempted"}, "promotion": "not_performed"}
    day = start
    while day <= end:
        day_text = day.isoformat()
        pages = fetch_archive_pages(day_text, base_url=base_url, token=token)
        imported = import_capture_archives(rows, pages, day_text)
        report["archiveDates"] += 1
        report["importedArchives"] += imported["importedArchives"]
        report["excludedArchives"] += imported["excludedArchives"]
        day += timedelta(days=1)
    if report["importedArchives"]:
        save_rows(rows, store_path)

    from edgelab.cli import _make_training_rows
    from edgelab.features.boat import PRERACE_V2_SCHEMA
    from edgelab.models.trifecta_coverage import _entry_coverage, _t60_cutoff, audit_trifecta_coverage
    training_rows = _make_training_rows(rows, "boat", feature_schema=PRERACE_V2_SCHEMA)
    coverage = audit_trifecta_coverage(rows, training_rows)
    training_race_ids = {str(item.get("race_id")) for item in training_rows if item.get("race_id")}
    race_by_id = {str(item.get("id")): item for item in rows.get("races", [])}
    entries_by_race: dict[str, list[dict]] = {}
    for item in rows.get("entries", []):
        entries_by_race.setdefault(str(item.get("race_id")), []).append(item)
    source_proven_races = set()
    for race_id in training_race_ids:
        race = race_by_id.get(race_id)
        cutoff, _ = _t60_cutoff(race or {})
        if cutoff is None:
            continue
        available, source_arrival, _ = _entry_coverage(entries_by_race.get(race_id, []), cutoff)
        if available and source_arrival:
            source_proven_races.add(race_id)
    source_arrival_complete_for_training = bool(training_race_ids) and source_proven_races == training_race_ids
    report["coverage"] = {key: coverage[key] for key in (
        "status", "finishedRealBoatRaces", "distinctRaceDates", "completeEvidenceRaces",
        "trainingRaceIdsPresentInStore", "promotionEvidenceComplete", "counts", "exclusions")}
    # The trainer owns its hard temporal/holdout qualification checks; do not
    # relax them here. Only attempt once the immutable PIT feature pipeline has
    # built enough eligible races for its documented 300-race floor.
    report["training"]["eligibleRealRaceCount"] = len(source_proven_races)
    report["training"]["unprovenRealRaceCount"] = len(training_race_ids - source_proven_races)
    if train and source_arrival_complete_for_training and len(source_proven_races) >= 300:
        digest = hashlib.sha256("|".join(sorted(training_race_ids)).encode()).hexdigest()[:8]
        candidate_id = f"boat-trifecta-lgbm-{datetime.now(timezone.utc):%Y%m%d}-{digest}"
        report["training"]["candidateId"] = candidate_id
        existing_candidate = any(str(model.get("id")) == candidate_id for model in rows.get("models", []))
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
                  "promotion": "not_performed", "error": category}
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
