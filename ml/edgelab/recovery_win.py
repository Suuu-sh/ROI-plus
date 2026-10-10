"""One-shot, dispatch-only candidate recovery from a pinned local raw-data cache."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from edgelab.baseline_validation import _canonical_sha256, validate_initial_baseline
from edgelab.cli import _make_training_rows, preview_boat_cache
from edgelab.models.train import candidate_version, train_model
from edgelab.sync import fetch_model_registry, sync_rows


MODEL_ID_PREFIX = "boat-win-lgbm"
BOOTSTRAP_CACHE_KEY = "daily-Linux-2026-10-10-38045849740"
FIXED_SPLIT = ("2026-07-01", "2026-09-10", "2026-09-11", "2026-09-25", "2026-09-26", "2026-10-09")
FIXED_COHORT_START = FIXED_SPLIT[0]
FIXED_COHORT_END = FIXED_SPLIT[-1]


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                    encoding="utf-8")


def _fixed_window_store(store: dict[str, list[dict[str, Any]]]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    """Restrict every race-linked table to the reviewed Jul 1-Oct 9 cohort."""
    kept_races = []
    kept_ids: set[str] = set()
    excluded_dates: set[str] = set()
    for race in store.get("races", []):
        race_date = str(race.get("race_date") or "")[:10]
        if FIXED_COHORT_START <= race_date <= FIXED_COHORT_END:
            kept_races.append(race)
            kept_ids.add(str(race.get("id")))
        elif race_date:
            excluded_dates.add(race_date)
    filtered = dict(store)
    filtered["races"] = kept_races
    for table in ("entries", "results", "payouts", "odds_snapshots"):
        filtered[table] = [row for row in store.get(table, [])
                           if str(row.get("race_id")) in kept_ids]
    return filtered, {
        "from": FIXED_COHORT_START,
        "to": FIXED_COHORT_END,
        "raceCount": len(kept_races),
        "excludedRaceCount": len(store.get("races", [])) - len(kept_races),
        "excludedDates": sorted(excluded_dates),
        "excludesRaceLinkedTables": ["entries", "results", "payouts", "odds_snapshots"],
    }


def _candidate_row(metadata: dict[str, Any], artifact_path: Path, *,
                   validation: dict[str, Any] | None = None) -> dict[str, Any]:
    artifact_sha = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    metrics = dict(metadata.get("metrics") or {})
    metrics.update({
        "boatFeatureSchemaVersion": "boat-base-v1",
        "boatArtifactSha256": artifact_sha,
        "boatVenueSchemaVersion": metadata["boatVenueSchemaVersion"],
        "correctedTrainingDataSha256": metadata["correctedTrainingDataSha256"],
        "promotionEligible": False,
        "promotionReason": "recovery candidates remain candidate-only; explicit human promotion is required",
    })
    if validation is not None:
        metrics["initialBaselineEligible"] = bool(validation.get("initialBaselineEligible"))
        metrics["initialBaselineReason"] = validation.get("initialBaselineReason")
        metrics["initialBaselineValidation"] = validation
    return {
        "id": metadata["id"], "sport": "boat", "bet_type": "win",
        "version": metadata["version"], "algorithm": metadata["algorithm"],
        "status": "candidate", "train_from": metadata.get("trainFrom"),
        "train_to": metadata.get("trainTo"), "valid_from": metadata.get("validFrom"),
        "valid_to": metadata.get("validTo"), "test_from": metadata.get("testFrom"),
        "test_to": metadata.get("testTo"), "n_train": metadata.get("nTrain"),
        "trained_at": metadata.get("trainedAt"),
        "metrics_json": json.dumps(metrics, ensure_ascii=False, allow_nan=False),
        "notes": "Offline corrected-cache candidate; not active; profitability unproven.",
    }


def recover_candidate(*, raw_dir: str | Path = "data/raw/boatrace",
                      snapshot_path: str | Path = "ml/data/learning/recovery-clean-store.json",
                      artifact_dir: str | Path = "ml/artifacts",
                      report_path: str | Path = "ml/data/learning/recovery-win-validation.json",
                      cache_key: str, run_id: str,
                      base_url: str | None = None, token: str | None = None) -> dict[str, Any]:
    """Prepare, register as candidate, validate against registry, and update candidate evidence only."""
    if cache_key != BOOTSTRAP_CACHE_KEY:
        raise RuntimeError("recovery must use the exact reviewed daily cache key; no fallback is allowed")
    if not run_id or not run_id.isdigit():
        raise ValueError("a GitHub Actions run ID is required to create a unique immutable candidate")
    snapshot_path, report_path, artifact_dir = Path(snapshot_path), Path(report_path), Path(artifact_dir)
    if snapshot_path.exists() or report_path.exists():
        raise FileExistsError("refusing to overwrite existing recovery snapshot/report")

    # Raw LZH files are read locally only. The normalized cache, API, and legacy
    # artifacts are never used as model-training input.
    preview_boat_cache(raw_dir, snapshot_path)
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    if snapshot.get("unpairedFileCount"):
        raise RuntimeError("pinned raw cache contains unpaired B/K files; refusing a partial recovery cohort")
    full_snapshot_store = snapshot["rows"]
    store, analysis_cohort = _fixed_window_store(full_snapshot_store)
    training_rows = _make_training_rows(store, "boat")
    if not training_rows:
        raise RuntimeError("the pinned raw cache has no complete real boat training cohorts")
    source_sha = hashlib.sha256(snapshot_path.read_bytes()).hexdigest()
    run_suffix = hashlib.sha256(f"{source_sha}:{run_id}".encode()).hexdigest()[:8]
    date_stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    model_id = f"{MODEL_ID_PREFIX}-{date_stamp}-{run_suffix}"

    registry_before = fetch_model_registry(base_url=base_url, token=token)
    if any(row.get("id") == model_id for row in registry_before):
        raise RuntimeError("the immutable recovery candidate ID already exists in the authenticated registry")
    active_boat_win = [row for row in registry_before if row.get("sport") == "boat"
                       and row.get("bet_type") == "win" and row.get("status") == "active"]
    if active_boat_win:
        raise RuntimeError("recovery candidate registration requires the boat-win production pause (no active model)")

    metadata = train_model(
        training_rows, model_id=model_id, version=candidate_version(model_id), sport="boat", bet_type="win",
        artifact_dir=artifact_dir, valid_fraction=.15, test_fraction=.14,
        boat_venue_schema_version="boat-venue-v2", corrected_training_data_sha256=source_sha,
    )
    if metadata.get("status") != "candidate":
        raise RuntimeError(f"safe candidate training failed: {metadata.get('reason') or metadata.get('status')}")
    actual_split = (metadata.get("trainFrom"), metadata.get("trainTo"),
                    metadata.get("validFrom"), metadata.get("validTo"),
                    metadata.get("testFrom"), metadata.get("testTo"))
    if actual_split != FIXED_SPLIT:
        raise RuntimeError(f"candidate split differs from reviewed fixed window: {actual_split}")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as stream:
            stream.write(f"candidate_id={model_id}\n")
    artifact_path = artifact_dir / f"{model_id}.pkl"
    candidate = _candidate_row(metadata, artifact_path)
    # This is the only first write: one candidate model row, never active models,
    # race data, results, odds, or predictions.
    sync_rows({"models": [candidate]}, base_url=base_url, token=token)

    registry_after = fetch_model_registry(base_url=base_url, token=token)
    report = validate_initial_baseline(store, model_id=model_id, artifact_dir=artifact_dir,
                                       registry=registry_after, valid_fraction=.15, test_fraction=.14)
    report.update({
        "sourceSnapshot": str(snapshot_path), "sourceSnapshotSha256": source_sha,
        "sourceFileManifest": snapshot.get("sourceFiles") or [],
        "sourcePairedDays": len(snapshot.get("pairedDays") or []), "sourceNetworkAccess": False,
        "sourceSnapshotMayContainDatesOutsideAnalysisCohort": True,
        "analysisCohort": analysis_cohort,
        "existingNormalizedStoreModified": False, "boatVenueSchemaVersion": "boat-venue-v2",
        "correctedTrainingDataSha256": source_sha,
        "cacheKey": cache_key, "workflowRunId": run_id,
        "limitations": list(report.get("limitations") or []) + [
            "Candidate is not evidence of positive EV or profitability.",
            "B-file availability uses synthesized race-day midnight rather than measured publication time.",
            "This retrospective holdout is not a prospective saved-forecast virtual run.",
        ],
        "promotionEligible": False, "manualPromotionApprovalRequired": True,
    })
    fingerprint_payload = {key: value for key, value in report.items()
                           if key not in {"fingerprint", "validatedAt", "initialBaselineEligible", "initialBaselineReason"}}
    report["fingerprint"] = _canonical_sha256(fingerprint_payload)
    _write_json(report_path, report)

    if (report.get("modelEvidenceEligible") and report.get("initialBaselineEligible")
            and report.get("candidateRegistryIdentity", {}).get("status") == "candidate"):
        candidate = _candidate_row(metadata, artifact_path, validation=report)
        sync_rows({"models": [candidate]}, base_url=base_url, token=token)
        # Confirm only the same candidate remained a candidate. Never activate or
        # change lifecycle status here.
        registry_final = fetch_model_registry(base_url=base_url, token=token)
        final_row = next((row for row in registry_final if row.get("id") == model_id), None)
        if (not final_row or final_row.get("status") != "candidate"
                or final_row.get("version") != metadata.get("version")):
            raise RuntimeError("candidate lifecycle changed during evidence refresh; refusing further action")
        try:
            final_metrics = json.loads(final_row.get("metrics_json") or "{}")
        except (TypeError, ValueError) as exc:
            raise RuntimeError("final candidate registry metrics could not be verified") from exc
        expected_metrics = json.loads(candidate["metrics_json"])
        if (final_metrics.get("boatArtifactSha256") != expected_metrics.get("boatArtifactSha256")
                or (final_metrics.get("initialBaselineValidation") or {}).get("fingerprint")
                != report["fingerprint"]):
            raise RuntimeError("registry candidate did not retain the exact artifact hash and validation fingerprint")
        if any(row.get("sport") == "boat" and row.get("bet_type") == "win" and row.get("status") == "active"
               for row in registry_final):
            raise RuntimeError("an active boat-win row appeared during recovery; no automatic activation was attempted")
    else:
        raise RuntimeError("candidate evidence did not pass registry-bound baseline validation; candidate remains candidate")

    # GitHub Actions output is used only to name the exact immutable artifact.
    return {"modelId": model_id, "report": str(report_path), "sourceSnapshotSha256": source_sha,
            "artifactSha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
            "validationFingerprint": report["fingerprint"],
            "modelEvidenceEligible": report["modelEvidenceEligible"],
            "initialBaselineEligible": report["initialBaselineEligible"],
            "promotionEligible": False}


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", default="data/raw/boatrace")
    parser.add_argument("--snapshot", default="ml/data/learning/recovery-clean-store.json")
    parser.add_argument("--artifact-dir", default="ml/artifacts")
    parser.add_argument("--report", default="ml/data/learning/recovery-win-validation.json")
    parser.add_argument("--cache-key", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    print(json.dumps(recover_candidate(raw_dir=args.raw, snapshot_path=args.snapshot,
        artifact_dir=args.artifact_dir, report_path=args.report,
        cache_key=args.cache_key, run_id=args.run_id), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
