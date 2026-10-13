"""Read immutable PIT archives from the API and fit an isolated paper model.

This workflow never collects race-site data, promotes a model, or writes model
or prediction rows to the normal registry. Historical completed K records must
already be present in the restored daily local cache.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from edgelab.importers.boatrace_capture_archive import import_capture_archives
from edgelab.importers.experimental_result_labels import (experimental_training_store_projection,
                                                           import_experimental_result_labels)
from edgelab.storage import DEFAULT_STORE, load_rows, save_rows
from edgelab.sync import (collect_experimental_training_results,
                          fetch_experimental_training_result_labels,
                          fetch_prerace_capture_archives)

_SAFE_EXCEPTION_CLASSES = {"ValueError", "TypeError", "KeyError", "AttributeError", "IndexError", "NameError",
                           "OverflowError", "OSError", "RuntimeError", "ImportError", "AssertionError",
                           "ExperimentalLabelExportError"}
_SAFE_STAGES = {"input_validation", "credentials", "load_local_cache", "archive_export",
                "archive_import", "save_local_cache", "training_row_build", "coverage_audit",
                "model_fit", "report_write", "official_result_collection", "result_label_export",
                "result_label_import"}


class PipelineStageFailure(Exception):
    """Sanitized failure carrying only a fixed stage and allowlisted class name."""

    def __init__(self, stage: str, exception_class: str, failure_category: str | None = None):
        self.stage = stage if stage in _SAFE_STAGES else "unknown_stage"
        self.exception_class = (exception_class if exception_class in _SAFE_EXCEPTION_CLASSES
                                else "OtherError")
        allowed = {"http_401", "http_403", "http_404", "http_429", "http_5xx",
                   "http_other", "transport_error", "invalid_json", "oversized_page",
                   "invalid_envelope", "invalid_cursor", "page_limit_exceeded"}
        self.failure_category = failure_category if failure_category in allowed else None


def _stage_call(stage: str, callback, *args, **kwargs):
    try:
        return callback(*args, **kwargs)
    except Exception as exc:
        if isinstance(exc, PipelineStageFailure):
            raise
        raise PipelineStageFailure(stage, type(exc).__name__,
                                   getattr(exc, "failure_category", None)) from None


def _refresh_same_day_k(rows: dict[str, list[dict[str, Any]]], day: date,
                        cache_dir: str | Path = "data/raw/boatrace") -> dict[str, Any]:
    """Fetch today's official K once, only when today's completed K is absent.

    K publication time is an outcome-label timestamp, never a feature arrival
    timestamp. Existing B entry provenance is untouched by this merge.
    """
    if datetime.now(ZoneInfo("Asia/Tokyo")).date() != day:
        return {"status": "skipped_not_today", "completedRaces": 0}
    race_ids = {str(race.get("id")) for race in rows.get("races", [])
                if race.get("sport") == "boat" and race.get("race_date") == day.isoformat()}
    existing = {str(row.get("race_id")) for row in rows.get("results", [])
                if row.get("data_origin") == "real" and row.get("finish_order") is not None
                and str(row.get("race_id")) in race_ids}
    if existing:
        return {"status": "already_present", "completedRaces": len(existing)}

    from edgelab.collectors.boatrace import fetch_boatrace_file, read_lzh, read_source_file_metadata
    from edgelab.parsers.boatrace_k import parse_k
    from edgelab.storage import merge_rows

    def validate(text: str) -> None:
        parsed = parse_k(text, race_date=day)
        if not parsed["races"] or any(race.get("race_date") != day.isoformat()
                                      for race in parsed["races"]):
            raise ValueError("official_k_date_mismatch")
        if not parsed["results"]:
            raise ValueError("official_k_results_unavailable")

    path = fetch_boatrace_file("K", day, cache_dir=cache_dir, retries=0,
                               refresh=True, validator=validate)
    if path is None:
        return {"status": "official_k_unavailable", "completedRaces": 0}
    source = read_source_file_metadata(path, "K", day)
    if not source:
        return {"status": "official_k_source_metadata_invalid", "completedRaces": 0}
    parsed = parse_k(read_lzh(path), race_date=day)
    if (not parsed["results"] or any(race.get("race_date") != day.isoformat()
                                    for race in parsed["races"])):
        return {"status": "official_k_results_unavailable", "completedRaces": 0}
    observed_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    for result in parsed["results"]:
        result["available_at"] = observed_at
    # K is post-race. Import only labels/payouts from it: its entry stats and
    # schedule must never overwrite or masquerade as pre-race B features.
    merge_rows(rows, {"results": parsed["results"], "payouts": parsed["payouts"]})
    completed = {str(row.get("race_id")) for row in parsed["results"]
                 if row.get("data_origin") == "real" and row.get("finish_order") is not None}
    return {"status": "fetched_and_validated", "completedRaces": len(completed),
            "sourceVerified": True}


def run(*, since: str, until: str, store_path: str = str(DEFAULT_STORE),
        report_path: str = "ml/data/learning/trifecta-experimental-report.json",
        artifact_dir: str = "ml/artifacts") -> dict[str, Any]:
    start, end = _stage_call("input_validation", lambda: (date.fromisoformat(since), date.fromisoformat(until)))
    if (start.isoformat() != since or end.isoformat() != until or end < start
            or (end - start).days > 31):
        raise PipelineStageFailure("input_validation", "ValueError")
    base_url, token = os.environ.get("EDGELAB_API_URL", "").rstrip("/"), os.environ.get("INGEST_TOKEN", "")
    if not base_url or not token:
        raise PipelineStageFailure("credentials", "RuntimeError")
    rows = _stage_call("load_local_cache", load_rows, store_path)
    report: dict[str, Any] = {"schema": "trifecta-experimental-pipeline-v1",
        "range": {"since": since, "until": until}, "archiveDates": 0,
        "importedArchives": 0, "excludedArchives": 0,
        "coverage": {}, "training": {"status": "not_attempted"},
        "promotion": "not_performed", "normalRegistrySync": "not_performed",
        "virtualPurchase": "not_performed"}
    day = start
    while day <= end:
        day_text = day.isoformat()
        pages = _stage_call("archive_export", fetch_prerace_capture_archives,
                            day_text, base_url=base_url, token=token)
        imported = _stage_call("archive_import", import_capture_archives,
                               rows, pages, day_text, allow_missing_weather=True)
        report["archiveDates"] += 1
        report["importedArchives"] += int(imported.get("importedArchives", 0))
        report["excludedArchives"] += int(imported.get("excludedArchives", 0))
        report["weatherMissingArchivesImported"] = report.get("weatherMissingArchivesImported", 0) + int(
            imported.get("weatherMissingArchivesImported", 0))
        day += timedelta(days=1)
    if report["importedArchives"]:
        _stage_call("save_local_cache", save_rows, rows, store_path)

    # Results may be published after the daily cache was restored. Refresh only
    # today's official K file, and only when no same-day completed result is in
    # the cache. This is one bounded request; no historical K data is retimed.
    if end == datetime.now(ZoneInfo("Asia/Tokyo")).date():
        collection = None
        try:
            k_refresh = _refresh_same_day_k(rows, end)
        except Exception:
            k_refresh = {"status": "official_k_fetch_or_validation_failed", "completedRaces": 0}
        report["sameDayKCollection"] = k_refresh
        if k_refresh.get("status") == "fetched_and_validated":
            _stage_call("save_local_cache", save_rows, rows, store_path)

        # Ask the result worker for a small, label-only pass, then import only
        # rows whose official source hash/time and race identity validate. This
        # never changes or retimestamps pre-race features. The worker itself
        # limits targets to races with verified archived T-60 evidence.
        try:
            collection = _stage_call("official_result_collection", collect_experimental_training_results)
            pages = _stage_call("result_label_export", fetch_experimental_training_result_labels,
                                end.isoformat())
            label_import = _stage_call("result_label_import", import_experimental_result_labels,
                                       rows, pages, end.isoformat())
            report["sameDayOfficialResultLabels"] = {
                **collection,
                "status": "imported" if label_import["importedLabels"] else "no_verified_labels",
                "importedLabels": label_import["importedLabels"],
                "excludedLabels": label_import["excludedLabels"],
                "exclusions": label_import["exclusions"],
                "featureRowsModified": 0,
            }
            if label_import["importedLabels"]:
                _stage_call("save_local_cache", save_rows, rows, store_path)
        except PipelineStageFailure as exc:
            report["sameDayOfficialResultLabels"] = {
                "status": "unavailable", "failureStage": exc.stage,
                "exceptionClass": exc.exception_class,
                **({"failureCategory": exc.failure_category} if exc.failure_category else {}),
                **({"collectorStatus": collection.get("collectorStatus"),
                    "targets": collection.get("targets", 0), "verified": collection.get("verified", 0),
                    "attempted": collection.get("attempted", 0)} if collection else {}),
                "featureRowsModified": 0,
            }

    from edgelab.cli import _make_training_rows
    from edgelab.features.boat import TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA
    from edgelab.models.trifecta import train_trifecta_experimental
    from edgelab.models.trifecta_coverage import audit_trifecta_coverage

    # This count explicitly proves whether cached real K outcomes exist. B-only
    # history and today's not-yet-finished races are never given labels.
    complete_k_count = sum(1 for row in rows.get("results", []) if row.get("data_origin") == "real"
                           and row.get("finish_order") is not None)
    # Exported official K labels prove completion even if B-file rows retain
    # their original scheduled state. Use an ephemeral race-status projection
    # for training/coverage; never persist or rewrite race/feature records.
    training_store = _stage_call("training_row_build", experimental_training_store_projection, rows)
    training_rows = _stage_call("training_row_build", _make_training_rows, training_store, "boat",
        feature_schema=TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA, require_source_arrival=True)
    coverage = _stage_call("coverage_audit", audit_trifecta_coverage, training_store, training_rows)
    report["coverage"] = {key: coverage.get(key) for key in (
        "finishedRealBoatRaces", "distinctRaceDates", "completeSixBoatResultRaces",
        "completeEvidenceRaces", "trainingRaceIdsPresentInStore", "counts", "exclusions")}
    eligible_race_ids = sorted({str(row.get("race_id")) for row in training_rows if row.get("race_id")})
    report["training"].update({"status": "insufficient_pit_evidence",
        "availableRealKResultRows": complete_k_count,
        "eligibleBeforeEvidenceAuditRaceCount": len(eligible_race_ids),
        "actualTrainingSource": "restored local normalized real B/K cache plus official archived T-60 captures",
        "trainingMode": "experimental", "experimentalOnly": True})
    if not eligible_race_ids:
        report["training"]["reason"] = ("no_completed_real_K_results" if complete_k_count == 0
                                           else "no_complete_t60_training_cohort")
    else:
        cohort_hash = hashlib.sha256("|".join(eligible_race_ids).encode("utf-8")).hexdigest()[:12]
        model_id = f"boat-trifecta-exp-noweather-{end:%Y%m%d}-{cohort_hash}"
        report["training"]["modelId"] = model_id
        existing = any(str(model.get("id")) == model_id for model in rows.get("models", []))
        if existing or (Path(artifact_dir) / f"{model_id}.pkl").exists():
            report["training"]["status"] = "artifact_already_exists_for_cohort"
        else:
            result = _stage_call("model_fit", train_trifecta_experimental, training_rows, training_store,
                                 model_id=model_id, artifact_dir=artifact_dir)
            report["training"].update({key: result.get(key) for key in (
                "status", "reason", "nTrainRaces", "trainFrom", "trainTo", "trainedAt",
                "ticketArtifactSha256", "artifactManifest", "artifactManifestSha256",
                "artifactManifestData", "artifactCreated", "trainingEvidence", "metrics",
                "status", "trainingMode", "experimentalOnly", "ticketModelSchemaVersion",
                "ticketPredictionSemantics", "ticketBetType", "boatFeatureSchemaVersion",
                "featureColumns", "algorithm", "trainedAt") if key in result})
            if result.get("artifactCreated"):
                report["training"]["modelMetadata"] = {key: value for key, value in result.items()
                    if key not in {"coverage", "artifactManifest", "artifactManifestData", "artifactCreated"}}
            if result.get("artifactCreated"):
                report["training"]["status"] = "completed_experimental_only"
                report["training"]["independentValidationPerformed"] = False
                report["training"]["evaluationQualified"] = False
                report["training"]["profitabilityProven"] = False
                report["training"]["artifactFiles"] = [
                    f"{model_id}.pkl", f"{model_id}.json",
                    f"experimental-trifecta-{model_id}.manifest.json"]
    target = Path(report_path)
    _stage_call("report_write", target.parent.mkdir, parents=True, exist_ok=True)
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"
    _stage_call("report_write", target.write_text, rendered, encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True)
    parser.add_argument("--until", required=True)
    parser.add_argument("--store", default=str(DEFAULT_STORE))
    parser.add_argument("--report", default="ml/data/learning/trifecta-experimental-report.json")
    parser.add_argument("--artifact-dir", default="ml/artifacts")
    args = parser.parse_args(argv)
    try:
        report = run(since=args.since, until=args.until, store_path=args.store,
                     report_path=args.report, artifact_dir=args.artifact_dir)
    except PipelineStageFailure as exc:
        # Never expose remote response bodies, URLs, credential values, messages or traces.
        report = {"schema": "trifecta-experimental-pipeline-v1",
            "training": {"status": "failed", "error": "pipeline_stage_failed",
                         "failureStage": exc.stage, "exceptionClass": exc.exception_class},
            "promotion": "not_performed", "normalRegistrySync": "not_performed",
            "virtualPurchase": "not_performed"}
        target = Path(args.report)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                          encoding="utf-8")
    except Exception as exc:
        # Only fixed validation/credential classes are categorized; never expose exception text.
        report = {"schema": "trifecta-experimental-pipeline-v1",
            "training": {"status": "failed", "error": (
                "invalid_date_range" if isinstance(exc, ValueError) else
                "archive_export_unavailable" if isinstance(exc, RuntimeError) else "local_pipeline_error")},
            "promotion": "not_performed", "normalRegistrySync": "not_performed",
            "virtualPurchase": "not_performed"}
        target = Path(args.report)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                          encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report.get("training", {}).get("status") in {
        "completed_experimental_only", "insufficient_pit_evidence", "artifact_already_exists_for_cohort"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
