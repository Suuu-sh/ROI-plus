"""Evidence audit and qualification policy for exact-order trifecta candidates.

This module intentionally uses only the standard library plus the existing
point-in-time observation validator, so coverage can be inspected even when
the optional model-training dependencies are unavailable.
"""
from __future__ import annotations

import argparse
import itertools
import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo

from edgelab.features.boat import classify_prerace_observation

TRUSTED_CUTOFF_SOURCE = "boatrace-racelist-cutoff-v1"
OFFICIAL_ODDS_SOURCE = "boatrace-trifecta-official-v1"
OFFICIAL_ODDS_QUALITY = "verified-complete-v1"
QUALIFICATION_POLICY_VERSION = "trifecta-temporal-quality-v1"
EXPECTED_TRIFECTA_SELECTIONS = frozenset(
    f"{a}-{b}-{c}" for a, b, c in itertools.permutations(range(1, 7), 3)
)
SHA256 = re.compile(r"^[a-f0-9]{64}$")
RACE_ID = re.compile(r"^boat-(\d{8})-(\d{2})-(\d{2})$")

MIN_TRAIN_RACES = 300
MIN_HOLDOUT_RACES = 400
MIN_HOLDOUT_DATES = 7
MAX_TOP_TICKET_ECE = 0.05
MIN_REPLAY_RACES = 30


def validate_ticket_probabilities(probabilities: Mapping[str, Any], *, tolerance: float = 1e-6) -> dict[str, float]:
    """Require every legal ordered ticket exactly once as a normalized distribution."""
    if not isinstance(probabilities, Mapping) or set(probabilities) != EXPECTED_TRIFECTA_SELECTIONS:
        raise ValueError("exactly 120 distinct legal trifecta selections are required")
    result: dict[str, float] = {}
    for selection, raw in probabilities.items():
        if isinstance(raw, bool):
            raise ValueError("trifecta probabilities must be finite numbers in [0, 1]")
        try:
            value = float(raw)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError("trifecta probabilities must be finite numbers in [0, 1]") from exc
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError("trifecta probabilities must be finite numbers in [0, 1]")
        result[str(selection)] = value
    if abs(sum(result.values()) - 1.0) > tolerance:
        raise ValueError("120-ticket trifecta probabilities must sum to one")
    return result


def _aware_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if result.tzinfo is None or result.utcoffset() is None:
        return None
    return result.astimezone(timezone.utc)


def _race_identity(race: Mapping[str, Any]) -> tuple[str, str, int] | None:
    race_id = str(race.get("id") or "")
    match = RACE_ID.fullmatch(race_id)
    try:
        day = str(race.get("race_date") or "")
        venue = str(race.get("venue_id") or (match.group(2) if match else ""))
        race_no = int(race.get("race_no"))
    except (TypeError, ValueError):
        return None
    if (not match or match.group(1) != day.replace("-", "") or match.group(2) != venue
            or match.group(3) != f"{race_no:02d}" or not 1 <= race_no <= 12):
        return None
    return day.replace("-", ""), venue, race_no


def _t60_cutoff(race: Mapping[str, Any]) -> tuple[datetime | None, str | None]:
    if race.get("betting_cutoff_source") != TRUSTED_CUTOFF_SOURCE:
        return None, "missing_verified_cutoff"
    cutoff = _aware_datetime(race.get("betting_cutoff_at"))
    observed = _aware_datetime(race.get("betting_cutoff_observed_at"))
    post = _aware_datetime(race.get("post_time"))
    identity = _race_identity(race)
    if cutoff is None or observed is None or post is None or identity is None:
        return None, "invalid_cutoff_evidence"
    if cutoff.astimezone(ZoneInfo("Asia/Tokyo")).date().strftime("%Y%m%d") != identity[0]:
        return None, "cutoff_race_date_mismatch"
    if cutoff > post:
        return None, "cutoff_after_post_time"
    target = cutoff - timedelta(seconds=60)
    if observed > target:
        return None, "cutoff_observed_after_t60"
    return target, None


def _entry_coverage(entries: Sequence[Mapping[str, Any]], cutoff: datetime) -> tuple[bool, bool, str | None]:
    if (len(entries) != 6 or {str(row.get("number")) for row in entries} != {"1", "2", "3", "4", "5", "6"}
            or any(row.get("data_origin") != "real" for row in entries)):
        return False, False, "incomplete_real_entries"
    available = [_aware_datetime(row.get("available_at")) for row in entries]
    if any(value is None or value > cutoff for value in available):
        return False, False, "entry_missing_or_late_available_at"
    # Parser-generated race-day midnight is an assumption, not source-arrival
    # evidence. Promotion needs a timestamp and hash tied to the source row.
    source_evidence = []
    for row in entries:
        observed = _aware_datetime(row.get("source_available_at") or row.get("source_observed_at"))
        digest = str(row.get("source_sha256") or row.get("source_file_sha256") or "")
        source_evidence.append(observed is not None and observed <= cutoff and SHA256.fullmatch(digest))
    return True, all(source_evidence), (None if all(source_evidence) else "source_arrival_evidence_missing")


def _complete_result(entries: Sequence[Mapping[str, Any]], results: Sequence[Mapping[str, Any]]) -> bool:
    if len(entries) != 6 or len(results) != 6:
        return False
    if any(row.get("data_origin") != "real" for row in results):
        return False
    try:
        entry_numbers = [int(row.get("number")) for row in entries]
        result_numbers = [int(row.get("number")) for row in results]
        orders = [int(row.get("finish_order")) for row in results]
    except (TypeError, ValueError):
        return False
    return (sorted(entry_numbers) == [1, 2, 3, 4, 5, 6]
            and sorted(result_numbers) == [1, 2, 3, 4, 5, 6]
            and sorted(orders) == [1, 2, 3, 4, 5, 6])


def _actual_selection(results: Sequence[Mapping[str, Any]]) -> str | None:
    try:
        top = sorted(results, key=lambda row: int(row.get("finish_order")))[:3]
        return "-".join(str(int(row.get("number"))) for row in top)
    except (TypeError, ValueError):
        return None


def _has_complete_market(store: Mapping[str, Any], race: Mapping[str, Any], cutoff: datetime) -> bool:
    identity = _race_identity(race)
    post = _aware_datetime(race.get("post_time"))
    if identity is None or post is None:
        return False
    day, venue, race_no = identity
    expected_url = ("https://www.boatrace.jp/owpc/pc/race/odds3t?"
                    f"rno={race_no}&jcd={venue}&hd={day}")
    floor = cutoff - timedelta(minutes=10)
    cohorts: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    invalid_cohorts: set[tuple[str, str, str]] = set()
    for row in [*store.get("odds_snapshots", []), *store.get("prerace_capture_odds", [])]:
        if (row.get("data_origin") != "real" or row.get("race_id") != race.get("id")
                or row.get("bet_type") != "trifecta" or row.get("source") != OFFICIAL_ODDS_SOURCE
                or row.get("source_url") != expected_url or row.get("quality_status") != OFFICIAL_ODDS_QUALITY):
            continue
        digest = str(row.get("source_sha256") or "")
        captured_text = row.get("captured_at")
        captured = _aware_datetime(captured_text)
        try:
            odds = float(row.get("odds"))
        except (TypeError, ValueError):
            continue
        if (not SHA256.fullmatch(digest) or captured is None or captured < floor or captured > cutoff
                or captured >= post or not math.isfinite(odds) or odds <= 0):
            continue
        selection = str(row.get("selection") or "")
        if selection not in EXPECTED_TRIFECTA_SELECTIONS:
            continue
        key = (str(captured_text), expected_url, digest)
        if selection in cohorts[key]:
            invalid_cohorts.add(key)
        cohorts[key].add(selection)
    return any(set(EXPECTED_TRIFECTA_SELECTIONS) == values and key not in invalid_cohorts
               for key, values in cohorts.items())


def _has_consistent_payout(payouts: Sequence[Mapping[str, Any]], race_id: str, actual: str | None) -> bool:
    if not actual:
        return False
    positive = []
    for row in payouts:
        if row.get("race_id") != race_id or row.get("data_origin") != "real" or row.get("bet_type") != "trifecta":
            continue
        try:
            amount = float(row.get("payout"))
        except (TypeError, ValueError):
            continue
        if math.isfinite(amount) and amount > 0:
            positive.append((str(row.get("selection") or ""), amount))
    return len(positive) == 1 and positive[0][0] == actual


def audit_trifecta_coverage(store: Mapping[str, Any], training_rows: Sequence[Mapping[str, Any]] = (),
                           *, include_races: bool = False) -> dict[str, Any]:
    """Report the full real-race denominator and each missing evidence class."""
    races = [row for row in store.get("races", []) if row.get("sport") == "boat"
             and row.get("data_origin") == "real" and row.get("status") == "finished"]
    entries_by_race: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    results_by_race: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in store.get("entries", []):
        if row.get("data_origin") == "real":
            entries_by_race[str(row.get("race_id"))].append(row)
    for row in store.get("results", []):
        if row.get("data_origin") == "real":
            results_by_race[str(row.get("race_id"))].append(row)
    observations_by_race: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in store.get("prerace_observations", []):
        if row.get("data_origin") == "real":
            observations_by_race[str(row.get("race_id"))].append(row)
    training_race_ids = {str(row.get("race_id")) for row in training_rows if row.get("data_origin") == "real"}

    counts = Counter()
    excluded: Counter[str] = Counter()
    race_details = []
    for race in sorted(races, key=lambda row: (str(row.get("race_date")), str(row.get("id")))):
        race_id = str(race.get("id"))
        entries, results = entries_by_race.get(race_id, []), results_by_race.get(race_id, [])
        complete_result = _complete_result(entries, results)
        if complete_result:
            counts["complete_real_six_boat_results"] += 1
        else:
            excluded["incomplete_real_six_boat_results"] += 1
        cutoff, cutoff_error = _t60_cutoff(race)
        if cutoff is not None:
            counts["verified_cutoff_observed_by_t60"] += 1
        else:
            excluded[cutoff_error or "invalid_cutoff_evidence"] += 1

        entries_available = source_arrival = False
        if cutoff:
            entries_available, source_arrival, entry_error = _entry_coverage(entries, cutoff)
            if entries_available:
                counts["six_real_entries_available_by_t60"] += 1
            else:
                excluded[entry_error or "incomplete_real_entries"] += 1
            if source_arrival:
                counts["source_arrival_hash_bound_before_t60"] += 1
            else:
                excluded[entry_error or "source_arrival_evidence_missing"] += 1

        fresh_exhibitions: set[int] = set()
        fresh_weather = False
        stale_or_late = 0
        invalid_observations = 0
        if cutoff:
            for observation in observations_by_race.get(race_id, []):
                values, reason = classify_prerace_observation(observation, race, cutoff)
                if values is None:
                    if reason == "stale_observation":
                        stale_or_late += 1
                    elif reason == "observation_after_cutoff":
                        stale_or_late += 1
                    elif reason == "source_observation_after_cutoff":
                        stale_or_late += 1
                    else:
                        invalid_observations += 1
                        excluded[f"invalid_observation:{reason or 'unknown'}"] += 1
                    continue
                if observation.get("kind") == "weather" and observation.get("entry_number") == 0:
                    fresh_weather = True
                elif observation.get("kind") == "exhibition":
                    try:
                        lane = int(observation.get("entry_number"))
                    except (TypeError, ValueError):
                        continue
                    if lane in range(1, 7):
                        fresh_exhibitions.add(lane)
            counts[f"fresh_exhibition_lanes_{len(fresh_exhibitions)}"] += 1
            if len(fresh_exhibitions) == 6:
                counts["all_six_fresh_exhibition_lanes"] += 1
            else:
                excluded["missing_or_stale_exhibition_lanes"] += 1
            if fresh_weather:
                counts["fresh_weather_observation"] += 1
            else:
                excluded["missing_or_stale_weather_observation"] += 1
            counts["stale_or_late_observation_rows"] += stale_or_late
            counts["invalid_provenance_observation_rows"] += invalid_observations

        odds_complete = _has_complete_market(store, race, cutoff) if cutoff else False
        if odds_complete:
            counts["complete_t60_official_120_odds"] += 1
        else:
            excluded["missing_stale_or_incomplete_t60_odds"] += 1
        actual = _actual_selection(results) if complete_result else None
        payout_complete = _has_consistent_payout(store.get("payouts", []), race_id, actual)
        if payout_complete:
            counts["consistent_real_trifecta_payout"] += 1
        else:
            excluded["missing_or_inconsistent_trifecta_payout"] += 1

        if race_id in training_race_ids:
            counts["included_in_training_rows"] += 1
        evidence_complete = (complete_result and cutoff is not None and entries_available and source_arrival
                            and len(fresh_exhibitions) == 6 and fresh_weather and odds_complete and payout_complete)
        if evidence_complete:
            counts["complete_real_point_in_time_evaluation_races"] += 1
        race_details.append({"raceId": race_id, "raceDate": race.get("race_date"),
                             "completeResult": complete_result, "verifiedT60Cutoff": cutoff is not None,
                             "sixEntryAvailability": entries_available,
                             "sourceArrivalVerified": source_arrival,
                             "freshExhibitionLanes": sorted(fresh_exhibitions),
                             "freshWeather": fresh_weather, "completeT60Odds": odds_complete,
                             "consistentPayout": payout_complete,
                             "inTrainingRows": race_id in training_race_ids,
                             "completeEvidence": evidence_complete})

    finished_count = len(races)
    complete_count = counts["complete_real_six_boat_results"]
    complete_evidence_count = counts["complete_real_point_in_time_evaluation_races"]
    dates = len({str(row.get("race_date")) for row in races if row.get("race_date")})
    report = {
        "schema": "trifecta-data-coverage-v1",
        "status": ("no_real_data" if finished_count == 0 else
                   "complete" if finished_count == complete_evidence_count else "incomplete"),
        "dataOrigin": "real_only",
        "finishedRealBoatRaces": finished_count,
        "distinctRaceDates": dates,
        "completeSixBoatResultRaces": complete_count,
        "completeEvidenceRaces": complete_evidence_count,
        "trainingRaceIdsPresentInStore": counts["included_in_training_rows"],
        "completeEvidenceCoverage": (complete_evidence_count / finished_count if finished_count else None),
        "counts": dict(sorted(counts.items())),
        "exclusions": dict(sorted(excluded.items())),
        "promotionEvidenceComplete": finished_count > 0 and complete_count == finished_count
            and complete_evidence_count == finished_count,
        "requirements": {
            "cutoff": "official verified cutoff observed no later than cutoff minus 60 seconds",
            "sourceArrival": "six entry-source timestamps and SHA-256 hashes observed by T-60",
            "features": "six fresh lane exhibition observations and one fresh weather observation by T-60",
            "odds": "one coherent official non-final 120-ticket market captured within the 10-minute freshness window by T-60",
            "payout": "one positive real trifecta payout matching the exact K-file top-three order",
        },
    }
    if include_races:
        report["races"] = race_details
    return report


def _upper_ci_pass(interval: Any) -> bool:
    ci = interval.get("ci95") if isinstance(interval, Mapping) else None
    return (isinstance(ci, Sequence) and not isinstance(ci, (str, bytes)) and len(ci) == 2
            and all(isinstance(value, (int, float)) and math.isfinite(float(value)) for value in ci)
            and float(ci[1]) < 0)


def evaluate_candidate_qualification(metrics: Mapping[str, Any], coverage: Mapping[str, Any]) -> dict[str, Any]:
    """Apply the fixed OOS score, evidence, calibration, and replay gates.

    This only reports offline eligibility. Production ticket promotion still
    requires the API's separate, recent artifact-bound independent review.
    """
    checks: dict[str, bool] = {}
    checks["real_data_only"] = metrics.get("dataOrigin") == "real_only"
    checks["safe_prerace_v2_feature_schema"] = metrics.get("boatFeatureSchemaVersion") == "boat-prerace-v2"
    checks["minimum_training_races"] = int(metrics.get("nTrainRaces") or 0) >= MIN_TRAIN_RACES
    checks["minimum_holdout_races"] = int(metrics.get("nTestRaces") or 0) >= MIN_HOLDOUT_RACES
    checks["minimum_holdout_dates"] = int(metrics.get("nTestDates") or 0) >= MIN_HOLDOUT_DATES
    try:
        ece = float(metrics.get("topTicketEce"))
    except (TypeError, ValueError):
        ece = math.inf
    checks["top_ticket_ece_at_most_0_05"] = math.isfinite(ece) and ece <= MAX_TOP_TICKET_ECE
    checks["complete_120_probability_coverage"] = metrics.get("completeCombinationCoverage") is True
    checks["race_bootstrap_logloss_improvement"] = _upper_ci_pass(metrics.get("candidateVsLaneLogLossRaceBootstrap"))
    checks["date_bootstrap_logloss_improvement"] = _upper_ci_pass(metrics.get("candidateVsLaneLogLossDateCluster"))
    checks["race_bootstrap_brier_improvement"] = _upper_ci_pass(metrics.get("candidateVsLaneBrierRaceBootstrap"))
    checks["date_bootstrap_brier_improvement"] = _upper_ci_pass(metrics.get("candidateVsLaneBrierDateCluster"))
    replay = metrics.get("payoutReplay") if isinstance(metrics.get("payoutReplay"), Mapping) else {}
    try:
        replay_races = int(replay.get("racesWithPicks") or 0)
        roi_ci = replay.get("roiInterval95")
        roi_lower = float(roi_ci[0]) if isinstance(roi_ci, Sequence) and len(roi_ci) == 2 else math.nan
    except (TypeError, ValueError):
        replay_races, roi_lower = 0, math.nan
    checks["at_least_30_real_replay_races"] = replay_races >= MIN_REPLAY_RACES
    checks["positive_replay_roi_lower_95"] = math.isfinite(roi_lower) and roi_lower > 0
    try:
        date_ci = replay.get("roiDateClusterInterval95")
        date_lower = float(date_ci[0]) if isinstance(date_ci, Sequence) and len(date_ci) == 2 else math.nan
    except (TypeError, ValueError):
        date_lower = math.nan
    checks["positive_replay_date_cluster_roi_lower_95"] = math.isfinite(date_lower) and date_lower > 0
    checks["complete_real_point_in_time_coverage"] = coverage.get("promotionEvidenceComplete") is True
    checks["coverage_source_is_real"] = coverage.get("dataOrigin") == "real_only"
    passed = all(checks.values())
    failures = [key for key, result in checks.items() if not result]
    # Do not manufacture the API's independent review receipt from a local
    # training run. A candidate can be evaluated here, never activated here.
    return {
        "policyVersion": QUALIFICATION_POLICY_VERSION,
        "evaluationQualified": passed,
        "promotionEligible": False,
        "checks": checks,
        "failedChecks": failures,
        "promotionBlockers": ["independent_artifact_bound_ticket_review_required"],
        "thresholds": {"minTrainRaces": MIN_TRAIN_RACES,
                       "minHoldoutRaces": MIN_HOLDOUT_RACES,
                       "minHoldoutDates": MIN_HOLDOUT_DATES,
                       "maxTopTicketEce": MAX_TOP_TICKET_ECE,
                       "minReplayRaces": MIN_REPLAY_RACES,
                       "confidenceIntervals": "95% upper bound below zero for race- and date-cluster LogLoss and Brier deltas"},
        "reason": ("offline criteria passed; separate independent ticket validation is still required"
                   if passed else "offline qualification evidence is incomplete or below fixed criteria"),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Audit real BOAT RACE trifecta evidence coverage without network access")
    parser.add_argument("--store", default="ml/data/rows.json", help="local normalized JSON store")
    parser.add_argument("--output", help="optional new JSON report path; existing files are not overwritten")
    parser.add_argument("--details", action="store_true", help="include a per-race evidence and exclusion table")
    args = parser.parse_args(argv)
    from edgelab.storage import load_rows
    report = audit_trifecta_coverage(load_rows(args.store), include_races=args.details)
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        target = Path(args.output)
        if target.exists():
            parser.error("--output must name a new file")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0 if report["promotionEvidenceComplete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
