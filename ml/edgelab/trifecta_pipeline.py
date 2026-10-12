"""Bounded archive sync and fail-closed trifecta coverage/training runner.

This pipeline only reads the authenticated archive export and trains a local
candidate. It never collects from race sites or promotes/syncs model state.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from edgelab.importers.boatrace_capture_archive import import_capture_archives
from edgelab.storage import DEFAULT_STORE, load_rows, save_rows


def fetch_archive_pages(day: str, *, base_url: str, token: str) -> list[dict]:
    """Fetch one date of export pages. Never include response bodies in errors."""
    cursor = ""
    pages = []
    while True:
        query = {"date": day, "limit": "25"}
        if cursor:
            query["cursor"] = cursor
        request = Request(f"{base_url.rstrip('/')}/api/ingest/prerace-capture-archives?{urlencode(query)}",
                          headers={"Authorization": f"Bearer {token}", "Accept": "application/json",
                                   "User-Agent": "EdgeLab-ML/0.1"}, method="GET")
        try:
            with urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise RuntimeError(f"archive_export_http_{exc.code}") from None
        except (URLError, TimeoutError, ValueError, OSError):
            raise RuntimeError("archive_export_transport_or_json_error") from None
        if (not isinstance(payload, dict) or payload.get("schema") != "boat-prerace-capture-export-v1"
                or payload.get("date") != day or payload.get("limit") != 25
                or not isinstance(payload.get("archives"), list)):
            raise RuntimeError("archive_export_response_invalid")
        pages.append(payload)
        cursor = payload.get("nextCursor")
        if cursor is None:
            return pages
        if not isinstance(cursor, str) or not re.fullmatch(r"boat-\d{8}-\d{2}-\d{2}:capture:\d{13}", cursor):
            raise RuntimeError("archive_export_cursor_invalid")


def run(*, since: str, until: str, store_path: str = str(DEFAULT_STORE),
        report_path: str = "ml/data/learning/trifecta-pipeline-report.json",
        train: bool = True) -> dict:
    start, end = date.fromisoformat(since), date.fromisoformat(until)
    if end < start or (end - start).days > 31:
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
    from edgelab.models.trifecta_coverage import audit_trifecta_coverage
    training_rows = _make_training_rows(rows, "boat", feature_schema=PRERACE_V2_SCHEMA)
    coverage = audit_trifecta_coverage(rows, training_rows)
    report["coverage"] = {key: coverage[key] for key in (
        "status", "finishedRealBoatRaces", "distinctRaceDates", "completeEvidenceRaces",
        "trainingRaceIdsPresentInStore", "counts", "exclusions")}
    # The trainer owns its hard temporal/holdout qualification checks; do not
    # relax them here. Only attempt once the immutable PIT feature pipeline has
    # built enough eligible races for its documented 300-race floor.
    report["training"]["eligibleRealRaceCount"] = coverage["trainingRaceIdsPresentInStore"]
    if train and coverage["trainingRaceIdsPresentInStore"] >= 300:
        output = Path(report_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run([sys.executable, "-m", "edgelab", "train-trifecta",
                               "--min-train-races", "300", "--output", str(output)],
                              env={**os.environ, "PYTHONPATH": str(Path("ml").resolve())},
                              text=True, capture_output=True, check=False)
        if proc.returncode == 0:
            report["training"] = {"status": "completed", "report": str(output)}
        else:
            report["training"] = {"status": "not_qualified_or_failed", "exitCode": proc.returncode}
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
    result = run(since=args.since, until=args.until, store_path=args.store,
                 report_path=args.report, train=not args.no_train)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["training"]["status"] in {"completed", "insufficient_pit_evidence", "not_attempted"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
