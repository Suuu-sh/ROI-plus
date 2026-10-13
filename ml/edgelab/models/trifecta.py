"""Candidate-only exact-order trifecta model and temporal evaluation.

The model learns pairwise finish preferences from complete K-file orders, then
uses a Plackett-Luce ranking distribution to emit normalized exact top-three
order probabilities. This is deliberately separate from the win model: it
never multiplies three marginal win probabilities.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
import pickle
import random
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from edgelab.features.boat import (BASE_FEATURE_COLUMNS, PRERACE_V2_FEATURE_COLUMNS,
                                   PRERACE_V2_SCHEMA, TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA,
                                   TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS,
                                   build_boat_prerace_v2_features,
                                   completed_racer_history)
from edgelab.models.compare import temporal_split
from edgelab.models.trifecta_coverage import (audit_trifecta_coverage,
                                               evaluate_candidate_qualification,
                                               validate_ticket_probabilities)
from edgelab.normalization.availability import available_by

TICKET_SCHEMA = "ticket-selection-v1"
PREDICTION_SEMANTICS = "exact-selection-probability-v1"
REPLAY_SELECTION_POLICY = "trifecta-runtime-ev-multipick-v1"


def _group_races(rows: Sequence[Mapping[str, Any]]) -> list[list[dict[str, Any]]]:
    by_race: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_race[str(row["race_id"])].append(dict(row))
    return [by_race[key] for key in sorted(by_race)]


def compute_training_cohort_fingerprint(rows: Sequence[Mapping[str, Any]],
                                       store: Mapping[str, Any],
                                       race_ids: set[str] | None = None) -> str:
    """Canonical digest of eligible features/outcomes plus their source evidence."""
    def canonical_value(value: Any) -> Any:
        if isinstance(value, Mapping):
            return {str(key): canonical_value(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [canonical_value(item) for item in value]
        if isinstance(value, (float, np.floating)):
            return float(value) if math.isfinite(float(value)) else None
        if isinstance(value, np.integer):
            return int(value)
        return value

    ids = race_ids or {str(row.get("race_id")) for row in rows if row.get("race_id")}
    tables = ("races", "entries", "prerace_observations", "results", "payouts",
              "prerace_capture_odds", "odds_snapshots")
    evidence = {}
    for table in tables:
        selected = [canonical_value(row) for row in store.get(table, [])
                    if str(row.get("race_id") or row.get("id") or "") in ids
                    and (table != "prerace_observations" or row.get("kind") == "exhibition")]
        evidence[table] = sorted(selected, key=lambda row: json.dumps(
            row, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str))
    payload = {"fingerprintSchema": "trifecta-experimental-training-cohort-v2",
               "featuresAndOutcomes": sorted((canonical_value(dict(row)) for row in rows
                                                if str(row.get("race_id") or "") in ids), key=lambda row: (
                   str(row.get("race_id")), str(row.get("number")))),
               "sourceEvidence": evidence}
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":"), allow_nan=False, default=str).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _eligible_experimental_training_groups(rows: Sequence[Mapping[str, Any]],
                                           store: Mapping[str, Any]):
    """Return exactly the verified race groups eligible for experimental fit."""
    safe_rows = [dict(row) for row in rows if row.get("data_origin") == "real"
                 and row.get("race_id") and row.get("race_date") and row.get("predicted_at")
                 and available_by(row, row["predicted_at"])]
    complete = [group for group in _group_races(safe_rows) if _complete_race(group)]
    complete_rows = [row for group in complete for row in group]
    coverage = audit_trifecta_coverage(store, complete_rows, include_races=True)
    from edgelab.importers.experimental_result_labels import verified_experimental_result_race_ids
    verified_result_ids = verified_experimental_result_race_ids(store)
    evidence_by_id = {str(race["raceId"]): race for race in coverage.get("races", [])
                      if isinstance(race, Mapping) and race.get("raceId")}
    eligible_ids = {race_id for race_id, evidence in evidence_by_id.items()
                    if race_id in verified_result_ids
                    and evidence.get("completeResult") is True
                    and evidence.get("verifiedT60Cutoff") is True
                    and evidence.get("sixEntryAvailability") is True
                    and evidence.get("sourceArrivalVerified") is True
                    and evidence.get("freshExhibitionLanes") == [1, 2, 3, 4, 5, 6]
                    and evidence.get("completeT60Odds") is True
                    and evidence.get("consistentPayout") is True}
    groups = [group for group in complete if str(group[0].get("race_id")) in eligible_ids]
    coverage.pop("races", None)
    return groups, coverage, evidence_by_id


def _complete_race(group: Sequence[Mapping[str, Any]]) -> bool:
    """Require real-data lanes 1..6 and an exact, unique K finish order."""
    try:
        numbers = [int(row["number"]) for row in group]
        orders = [int(row["finish_order"]) for row in group]
    except (KeyError, TypeError, ValueError):
        return False
    return (len(group) == 6 and sorted(numbers) == [1, 2, 3, 4, 5, 6]
            and sorted(orders) == [1, 2, 3, 4, 5, 6])


def _matrix(rows: Sequence[Mapping[str, Any]], columns: Sequence[str],
            medians: np.ndarray | None = None, means: np.ndarray | None = None,
            scales: np.ndarray | None = None):
    values = np.array([[float(row[c]) if row.get(c) is not None and _finite(row.get(c)) else np.nan
                        for c in columns] for row in rows], dtype=float)
    if values.shape[1] == 0:
        raise ValueError("no pre-race features available")
    if medians is None:
        medians = np.array([float(np.median(column[np.isfinite(column)]))
                            if np.isfinite(column).any() else 0.0 for column in values.T])
    values = np.where(np.isfinite(values), values, medians)
    if means is None:
        means = values.mean(axis=0)
    if scales is None:
        scales = values.std(axis=0)
        scales[scales < 1e-9] = 1.0
    return (values - means) / scales, medians, means, scales


def _finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def _fit(rows: Sequence[Mapping[str, Any]], columns: Sequence[str]):
    """Fit pairwise logistic preference from *complete* ordered races."""
    complete = [g for g in _group_races(rows) if _complete_race(g)]
    flat = [r for g in complete for r in g]
    x, medians, means, scales = _matrix(flat, columns)
    cursor, pair_x, labels = 0, [], []
    for group in complete:
        group_x = x[cursor:cursor + len(group)]
        cursor += len(group)
        ordered = sorted(range(len(group)), key=lambda i: int(group[i]["finish_order"]))
        for ahead_pos, ahead in enumerate(ordered):
            for behind in ordered[ahead_pos + 1:]:
                pair_x.append(group_x[ahead] - group_x[behind])
                labels.append(1)
                pair_x.append(group_x[behind] - group_x[ahead])
                labels.append(0)
    if not complete or len(pair_x) == 0:
        raise ValueError("no complete six-boat finish-order races")
    from sklearn.linear_model import LogisticRegression
    estimator = LogisticRegression(C=0.25, fit_intercept=False, max_iter=1000,
                                   solver="lbfgs", random_state=17)
    estimator.fit(np.asarray(pair_x), np.asarray(labels))
    return {"estimator": estimator, "columns": list(columns), "medians": medians,
            "means": means, "scales": scales, "trainRaces": len(complete)}


def _scores(model: Mapping[str, Any], group: Sequence[Mapping[str, Any]]) -> np.ndarray:
    x, _, _, _ = _matrix(group, model["columns"], model["medians"], model["means"], model["scales"])
    return x @ np.asarray(model["estimator"].coef_[0], dtype=float)


def ordered_triple_probabilities(model: Mapping[str, Any], group: Sequence[Mapping[str, Any]],
                                 temperature: float = 1.0) -> dict[str, float]:
    """Return normalized P(first-second-third exact order) for every ticket."""
    try:
        legal_numbers = [int(r["number"]) for r in group]
    except (KeyError, TypeError, ValueError):
        raise ValueError("entries must use legal boat numbers 1 through 6")
    if len(group) != 6 or sorted(legal_numbers) != [1, 2, 3, 4, 5, 6]:
        raise ValueError("exactly the six legal boat numbers are required")
    scores = _scores(model, group) / max(0.05, float(temperature))
    numbers = [str(int(row["number"])) for row in group]
    result: dict[str, float] = {}
    for a, b, c in itertools.permutations(range(6), 3):
        first_den = _logsumexp(scores)
        remaining = [i for i in range(6) if i != a]
        second_den = _logsumexp(scores[remaining])
        third = [i for i in remaining if i != b]
        third_den = _logsumexp(scores[third])
        p = math.exp(scores[a] - first_den + scores[b] - second_den + scores[c] - third_den)
        result[f"{numbers[a]}-{numbers[b]}-{numbers[c]}"] = p
    total = sum(result.values())
    if not math.isfinite(total) or total <= 0:
        raise ValueError("model produced invalid exact-order distribution")
    return {selection: probability / total for selection, probability in result.items()}


def ensemble_ordered_triples(artifact: Mapping[str, Any], group: Sequence[Mapping[str, Any]]):
    """Return mean exact-ticket probabilities and between-fit population std."""
    models = [artifact["model"], *artifact.get("bootstrap_models", [])]
    temperature = float(artifact.get("temperature", 1.0))
    members = [ordered_triple_probabilities(model, group, temperature) for model in models]
    keys = members[0].keys()
    mean = {key: sum(member[key] for member in members) / len(members) for key in keys}
    std = ({key: float(np.std([member[key] for member in members])) for key in keys}
           if len(members) >= 5 else {key: None for key in keys})
    return mean, std


def _has_recent_independent_ticket_validation(metrics: Mapping[str, Any], artifact_sha256: str) -> bool:
    """Mirror the API's artifact-bound validation gate before local inference."""
    validation = metrics.get("ticketValidation")
    if not isinstance(validation, Mapping) or validation.get("fixture") is True:
        return False
    if (validation.get("status") != "independently_validated"
            or validation.get("policyVersion") != TICKET_SCHEMA
            or validation.get("betType") != "trifecta"
            or validation.get("artifactSha256") != artifact_sha256
            or validation.get("dataOrigin") != "real"
            or validation.get("completeCombinationCoverage") is not True
            or validation.get("probabilitiesNormalized") is not True
            or validation.get("outOfSampleValidated") is not True
            or validation.get("pointInTimeSafe") is not True
            or not isinstance(validation.get("independentReviewId"), str)
            or not validation.get("independentReviewId")
            or not re.fullmatch(r"[a-f0-9]{64}", str(validation.get("reportSha256") or ""))):
        return False
    validated_at = validation.get("validatedAt")
    try:
        stamp = datetime.fromisoformat(str(validated_at).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    if stamp.tzinfo is None or stamp.utcoffset() is None:
        return False
    now = datetime.now(timezone.utc)
    stamp = stamp.astimezone(timezone.utc)
    return stamp <= now and now - stamp <= timedelta(days=30)


def active_ticket_predictions(store: Mapping[str, Any], *, model_row: Mapping[str, Any],
                              artifact: Mapping[str, Any], model_id: str, cutoff: str,
                              artifact_sha256: str, race_date: str | None = None,
                              require_verified_cutoff: bool = False) -> list[dict[str, Any]]:
    """Build exact-order records only for an explicitly active, validated model."""
    from datetime import datetime, timedelta
    from edgelab.features.boat import build_boat_features
    from edgelab.normalization.availability import available_by

    metrics = model_row.get("metrics")
    if not isinstance(metrics, Mapping):
        try:
            metrics = json.loads(model_row.get("metrics_json") or "{}")
        except (TypeError, ValueError):
            metrics = {}
    meta = artifact.get("metadata") or {}
    feature_schema = metrics.get("boatFeatureSchemaVersion") or meta.get("boatFeatureSchemaVersion") or "boat-base-v1"
    allowed_columns = (BASE_FEATURE_COLUMNS if feature_schema == "boat-base-v1"
                       else PRERACE_V2_FEATURE_COLUMNS if feature_schema == PRERACE_V2_SCHEMA else ())
    if (model_row.get("status") != "active"
            or metrics.get("ticketModelSchemaVersion") != TICKET_SCHEMA
            or metrics.get("ticketPredictionSemantics") != PREDICTION_SEMANTICS
            or metrics.get("ticketBetType") != "trifecta"
            or metrics.get("promotionEligible") is not True
            or metrics.get("ticketArtifactSha256") != artifact_sha256
            or not _has_recent_independent_ticket_validation(metrics, artifact_sha256)
            or meta.get("id") != model_id
            or meta.get("ticketModelSchemaVersion") != TICKET_SCHEMA
            or meta.get("ticketPredictionSemantics") != PREDICTION_SEMANTICS
            or meta.get("ticketBetType") != "trifecta"
            or meta.get("boatFeatureSchemaVersion", "boat-base-v1") != feature_schema
            or not artifact.get("columns")
            or any(column not in allowed_columns for column in artifact.get("columns", []))
            or not artifact.get("model")):
        raise ValueError("active trifecta model lacks validated matching schema/semantics/artifact evidence")
    cutoff_dt = datetime.fromisoformat(cutoff.replace("Z", "+00:00"))
    if cutoff_dt.tzinfo is None:
        raise ValueError("prediction cutoff must include a timezone")
    trained_at = meta.get("trainedAt")
    if not trained_at or datetime.fromisoformat(str(trained_at).replace("Z", "+00:00")) >= cutoff_dt:
        raise ValueError("artifact was not trained strictly before prediction cutoff")
    races = {r.get("id"): r for r in store.get("races", [])
             if r.get("sport") == "boat" and r.get("data_origin") == "real"
             and r.get("status") not in {"finished", "cancelled"}
             and (race_date is None or r.get("race_date") == race_date)}
    by_race: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in store.get("entries", []):
        rid = str(entry.get("race_id"))
        race = races.get(rid)
        if not (race and entry.get("data_origin") == "real" and race.get("post_time")
                and datetime.fromisoformat(str(race["post_time"]).replace("Z", "+00:00")) > cutoff_dt
                and available_by(entry, cutoff)):
            continue
        if require_verified_cutoff:
            if race.get("betting_cutoff_source") != "boatrace-racelist-cutoff-v1" or not race.get("betting_cutoff_at"):
                continue
            try:
                target_as_of = datetime.fromisoformat(str(race["betting_cutoff_at"]).replace("Z", "+00:00")) - timedelta(seconds=60)
                cutoff_observed_at = datetime.fromisoformat(str(race.get("betting_cutoff_observed_at", "")).replace("Z", "+00:00"))
            except (TypeError, ValueError):
                continue
            if (target_as_of.tzinfo is None or cutoff_observed_at.tzinfo is None
                    or target_as_of <= cutoff_dt or cutoff_observed_at > cutoff_dt
                    or cutoff_observed_at > target_as_of):
                # Daily precomputation cannot claim a T-60 forecast after its
                # feature boundary has passed, or use a cutoff fetched only
                # afterward. The next run may use only then-current evidence.
                continue
        by_race[rid].append(dict(entry))
    records = []
    history = completed_racer_history(store) if feature_schema == PRERACE_V2_SCHEMA else []
    for race_id, entries in by_race.items():
        if len(entries) != 6 or len({str(e.get("number")) for e in entries}) != 6:
            continue
        date = races[race_id].get("race_date")
        if feature_schema == PRERACE_V2_SCHEMA:
            features = build_boat_prerace_v2_features(entries, race=races[race_id], predicted_at=cutoff,
                history=history, observations=store.get("prerace_observations", []))
            feature_columns = PRERACE_V2_FEATURE_COLUMNS
        else:
            features = build_boat_features(entries, race_date=date, predicted_at=cutoff)
            feature_columns = BASE_FEATURE_COLUMNS
        group = [{**{key: value for key, value in entry.items() if key not in feature_columns}, **feature}
                 for entry, feature in zip(entries, features)]
        probabilities, deviations = ensemble_ordered_triples(artifact, group)
        for selection, probability in probabilities.items():
            records.append({"id": f"{race_id}:{model_id}:trifecta:{selection}:{cutoff}",
                "race_id": race_id, "model_id": model_id, "bet_type": "trifecta",
                "selection": selection, "probability": probability,
                "prob_std": deviations[selection], "predicted_at": cutoff, "data_origin": "real",
                "feature_schema_version": TICKET_SCHEMA, "artifact_sha256": artifact_sha256})
    return records


def _logsumexp(values: Sequence[float]) -> float:
    peak = max(float(v) for v in values)
    return peak + math.log(sum(math.exp(float(v) - peak) for v in values))


def _actual_selection(group: Sequence[Mapping[str, Any]]) -> str:
    top = sorted(group, key=lambda r: int(r["finish_order"]))[:3]
    return "-".join(str(int(row["number"])) for row in top)


def _lane_order_model(groups: Sequence[Sequence[Mapping[str, Any]]], alpha: float):
    counts: dict[str, int] = defaultdict(int)
    for group in groups:
        counts[_actual_selection(group)] += 1
    total = len(groups)
    denominator = total + alpha * 120
    return {f"{a}-{b}-{c}": (counts[f"{a}-{b}-{c}"] + alpha) / denominator
            for a, b, c in itertools.permutations(range(1, 7), 3)}


def _proper_ticket_metrics(groups, distributions):
    if len(groups) != len(distributions):
        raise ValueError("one complete 120-ticket distribution is required per race")
    losses, briers, calibration = [], [], []
    top_calibration = []
    for group, raw_probs in zip(groups, distributions):
        probs = validate_ticket_probabilities(raw_probs)
        actual = _actual_selection(group)
        losses.append(-math.log(max(1e-15, probs[actual])))
        briers.append(sum((prob - (selection == actual)) ** 2
                          for selection, prob in probs.items()))
        calibration.extend((prob, float(selection == actual)) for selection, prob in probs.items())
        top_selection = max(probs, key=probs.get)
        top_calibration.append((probs[top_selection], float(top_selection == actual)))
    bins = [[] for _ in range(10)]
    for probability, actual in calibration:
        bins[min(9, int(probability * 10))].append((probability, actual))
    all_selection_ece = sum(len(bucket) / len(calibration) * abs(
        sum(p for p, _ in bucket) / len(bucket) - sum(y for _, y in bucket) / len(bucket)
    ) for bucket in bins if bucket)
    # A per-race top-ticket calibration view avoids the cancellation that can
    # make a flattened 120-ticket micro-ECE look deceptively close to zero.
    top_bins = [(0.0, .02), (.02, .05), (.05, .1), (.1, .2), (.2, .4), (.4, 1.0000001)]
    top_detail = []
    top_ece = 0.0
    for lower, upper in top_bins:
        bucket = [(p, y) for p, y in top_calibration if lower <= p < upper]
        if not bucket:
            continue
        predicted = sum(p for p, _ in bucket) / len(bucket)
        observed = sum(y for _, y in bucket) / len(bucket)
        top_ece += len(bucket) / len(top_calibration) * abs(predicted - observed)
        top_detail.append({"range": [lower, upper], "nRaces": len(bucket),
                           "meanPredictedTopTicketProbability": predicted,
                           "observedExactTopTicketHitRate": observed})
    return {"exactOrderLogLoss": sum(losses) / len(losses),
            "multiclassBrier": sum(briers) / len(briers),
            "ticketEventPooledEce": all_selection_ece,
            "nRaces": len(groups), "nTicketEventRows": len(calibration),
            "nDates": len({str(group[0].get("race_date")) for group in groups}),
            "topTicketEce": top_ece,
            "topTicketCalibration": top_detail,
            "raceLogLosses": losses,
            "raceBriers": briers}


def _date_cluster_interval(groups, candidate_losses, baseline_losses, *, samples=1000, seed=17):
    by_date: dict[str, list[float]] = defaultdict(list)
    for group, candidate, baseline in zip(groups, candidate_losses, baseline_losses):
        by_date[str(group[0].get("race_date"))].append(candidate - baseline)
    dates = sorted(by_date)
    if len(dates) < 2:
        return {"nDateClusters": len(dates), "meanDeltaLogLossCandidateMinusBaseline": None,
                "ci95": None}
    daily = {day: sum(values) / len(values) for day, values in by_date.items()}
    rng = random.Random(seed)
    means = [sum(daily[day] for day in rng.choices(dates, k=len(dates))) / len(dates)
             for _ in range(samples)]
    means.sort()
    delta = sum(daily.values()) / len(dates)
    return {"nDateClusters": len(dates), "meanDeltaLogLossCandidateMinusBaseline": delta,
            "ci95": [means[int(.025 * (samples - 1))], means[int(.975 * (samples - 1))]],
            "interpretation": "negative favors candidate; date-cluster bootstrap, not a profitability interval"}


def _paired_delta_interval(groups, candidate_values, baseline_values, *, cluster="race",
                           samples=1000, seed=17):
    """Paired 95% bootstrap interval for a proper-score delta (negative is better)."""
    if len(groups) != len(candidate_values) or len(groups) != len(baseline_values):
        raise ValueError("paired score vectors must match the race groups")
    by_cluster: dict[str, list[float]] = defaultdict(list)
    for index, (group, candidate, baseline) in enumerate(zip(groups, candidate_values, baseline_values)):
        key = (str(group[0].get("race_date")) if cluster == "date"
               else str(group[0].get("race_id", index)))
        by_cluster[key].append(float(candidate) - float(baseline))
    keys = sorted(by_cluster)
    cluster_values = [sum(by_cluster[key]) / len(by_cluster[key]) for key in keys]
    if len(cluster_values) < 2:
        return {"nClusters": len(cluster_values), "meanDeltaCandidateMinusBaseline": None, "ci95": None,
                "interpretation": "negative favors candidate; bootstrap is unavailable with fewer than two clusters"}
    rng = random.Random(seed)
    means = [sum(rng.choices(cluster_values, k=len(cluster_values))) / len(cluster_values)
             for _ in range(samples)]
    means.sort()
    return {"nClusters": len(cluster_values),
            "meanDeltaCandidateMinusBaseline": sum(cluster_values) / len(cluster_values),
            "ci95": [means[int(.025 * (samples - 1))], means[int(.975 * (samples - 1))]],
            "interpretation": "negative favors candidate; proper-score interval, not a profitability interval"}


def _experimental_temporal_shadow(groups: Sequence[Sequence[Mapping[str, Any]]],
                                  columns: Sequence[str]) -> dict[str, Any]:
    """Score a train-only candidate against a train-only lane prior on later dates.

    This is a shadow development diagnostic: the final artifact is subsequently
    fit on the full cohort, so these scores do not validate that artifact.
    """
    dated = sorted(groups, key=lambda group: (str(group[0].get("race_date")),
                                               str(group[0].get("race_id"))))
    dates = sorted({str(group[0].get("race_date")) for group in dated})
    report: dict[str, Any] = {
        "schema": "experimental-trifecta-shadow-temporal-v1",
        "splitUnit": "race_date_blocks; each race appears in exactly one partition",
        "modelSpecificIndependentValidation": False,
        "promotionEligible": False, "evaluationQualified": False,
        "profitabilityProven": False,
    }
    if len(dates) < 2:
        return {**report, "status": "not_evaluated", "reason": "fewer_than_two_race_dates",
                "trainRaceCount": 0, "holdoutRaceCount": 0, "trainDateCount": len(dates),
                "holdoutDateCount": 0}
    # Hold out the most recent whole date block(s). No race/date can cross the
    # split; there is no tuning against this holdout.
    holdout_date_count = min(len(dates) - 1, max(1, math.ceil(len(dates) * .2)))
    if len(dates) >= 4:
        holdout_date_count = max(2, holdout_date_count)
    holdout_dates = set(dates[-holdout_date_count:])
    train = [group for group in dated if str(group[0].get("race_date")) not in holdout_dates]
    holdout = [group for group in dated if str(group[0].get("race_date")) in holdout_dates]
    report.update({"trainRaceCount": len(train), "holdoutRaceCount": len(holdout),
                   "trainDateCount": len({str(g[0].get("race_date")) for g in train}),
                   "holdoutDateCount": len({str(g[0].get("race_date")) for g in holdout}),
                   "trainRaceIds": sorted(str(g[0].get("race_id")) for g in train),
                   "holdoutRaceIds": sorted(str(g[0].get("race_id")) for g in holdout),
                   "holdoutDates": sorted(holdout_dates)})
    if not train or not holdout:
        return {**report, "status": "not_evaluated", "reason": "empty_temporal_partition"}
    train_rows = [row for group in train for row in group]
    candidate = _fit(train_rows, columns)
    candidate_distributions = [ordered_triple_probabilities(candidate, group) for group in holdout]
    baseline_distribution = _lane_order_model(train, alpha=1.0)
    baseline_distributions = [baseline_distribution for _ in holdout]
    candidate_metrics = _proper_ticket_metrics(holdout, candidate_distributions)
    baseline_metrics = _proper_ticket_metrics(holdout, baseline_distributions)
    report.update({"status": "shadow_scores_insufficient_sample",
                   "reason": "sample_or_date_spread_insufficient_for_independent_validation",
                   "candidate": {key: candidate_metrics[key] for key in
                                 ("exactOrderLogLoss", "multiclassBrier", "topTicketEce", "nRaces")},
                   "trainOnlyLaneOrderBaseline": {key: baseline_metrics[key] for key in
                                 ("exactOrderLogLoss", "multiclassBrier", "topTicketEce", "nRaces")},
                   "deltaCandidateMinusBaseline": {
                       "exactOrderLogLoss": candidate_metrics["exactOrderLogLoss"] - baseline_metrics["exactOrderLogLoss"],
                       "multiclassBrier": candidate_metrics["multiclassBrier"] - baseline_metrics["multiclassBrier"]},
                   "improvementAssessment": (
                       "candidate_lower_shadow_logloss" if candidate_metrics["exactOrderLogLoss"] < baseline_metrics["exactOrderLogLoss"]
                       else "baseline_lower_or_tied_shadow_logloss"),
                   "raceBootstrapLogLossDelta": _paired_delta_interval(
                       holdout, candidate_metrics["raceLogLosses"], baseline_metrics["raceLogLosses"], cluster="race"),
                   "interpretation": "descriptive shadow temporal scores only; final artifact is fit on the full cohort"})
    if (len(train) >= 5 and len(holdout) >= 5
            and len({str(g[0].get("race_date")) for g in train}) >= 2
            and len({str(g[0].get("race_date")) for g in holdout}) >= 2):
        report["status"] = "shadow_temporal_comparison"
        report["reason"] = "still_not_independent_validation_of_full_cohort_artifact"
    return report


def _temperature(valid: Sequence[Mapping[str, Any]], model: Mapping[str, Any]) -> float:
    if not valid:
        return 1.0
    candidates = (0.4, 0.55, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0, 3.0)
    groups = [g for g in _group_races(valid) if _complete_race(g)]
    losses = []
    for temp in candidates:
        values = []
        for group in groups:
            p = ordered_triple_probabilities(model, group, temp).get(_actual_selection(group), 0.0)
            values.append(-math.log(max(1e-15, p)))
        if values:
            losses.append((sum(values) / len(values), temp))
    return min(losses)[1] if losses else 1.0


def _captured_odds(store: Mapping[str, Any], race_id: str, predicted_at: str,
                   post_time: str) -> dict[str, float]:
    """Use one coherent official, non-final, complete 120-ticket market."""
    from datetime import datetime, timedelta
    as_of = datetime.fromisoformat(predicted_at.replace("Z", "+00:00"))
    fresh_after = as_of - timedelta(minutes=10)
    deadline = datetime.fromisoformat(post_time.replace("Z", "+00:00"))
    race = next((r for r in store.get("races", []) if str(r.get("id")) == race_id), None)
    if not race:
        return {}
    race_parts = race_id.split("-")
    venue = str(race.get("venue_id") or (race_parts[2] if len(race_parts) >= 4 else ""))
    race_date = str(race.get("race_date") or "").replace("-", "")
    race_no = race.get("race_no")
    if not (venue.isdigit() and len(venue) == 2 and race_date.isdigit()
            and len(race_date) == 8 and race_no):
        return {}
    expected_url = ("https://www.boatrace.jp/owpc/pc/race/odds3t?"
                    f"rno={race_no}&jcd={venue}&hd={race_date}")
    expected = {f"{a}-{b}-{c}" for a, b, c in itertools.permutations(range(1, 7), 3)}
    cohorts: dict[tuple[str, str, str], dict[str, tuple[datetime, float]]] = defaultdict(dict)
    for row in [*store.get("odds_snapshots", []), *store.get("prerace_capture_odds", [])]:
        if (row.get("data_origin") != "real" or row.get("race_id") != race_id
                or row.get("bet_type") != "trifecta" or not row.get("captured_at")
                or row.get("source") != "boatrace-trifecta-official-v1"
                or row.get("source_url") != expected_url
                or row.get("quality_status") != "verified-complete-v1"):
            continue
        digest = str(row.get("source_sha256") or "")
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            continue
        try:
            captured = datetime.fromisoformat(str(row["captured_at"]).replace("Z", "+00:00"))
            odds = float(row.get("odds"))
        except (TypeError, ValueError):
            continue
        if captured.tzinfo is None or as_of.tzinfo is None or deadline.tzinfo is None:
            continue
        if (captured < fresh_after or captured > as_of or captured >= deadline
                or not math.isfinite(odds) or odds <= 0):
            continue
        selection = str(row.get("selection") or "")
        if selection not in expected:
            continue
        key = (str(row["captured_at"]), expected_url, digest)
        cohorts[key][selection] = (captured, odds)
    complete = [(max(rows[0] for rows in cohort.values()), cohort)
                for cohort in cohorts.values() if set(cohort) == expected]
    if not complete:
        return {}
    _, latest = max(complete, key=lambda item: item[0])
    return {selection: value[1] for selection, value in latest.items()}


def _select_runtime_like_tickets(probabilities: Mapping[str, float], deviations: Mapping[str, float],
                                 odds: Mapping[str, float], *, max_std: float = 0.05,
                                 min_expected_roi: float = 0.05,
                                 min_conservative_roi: float = 0.05,
                                 max_picks: int = 6, race_budget: int = 100):
    """Mirror the runtime's EV rank, conservative-edge gate, cap, and stake split."""
    if (not isinstance(max_picks, int) or isinstance(max_picks, bool) or not 1 <= max_picks <= 6
            or not isinstance(race_budget, int) or isinstance(race_budget, bool)
            or not 1 <= race_budget <= 2_147_483_647
            or not _finite(max_std) or float(max_std) < 0
            or not _finite(min_expected_roi) or not _finite(min_conservative_roi)):
        raise ValueError("invalid replay policy configuration")
    candidates = []
    for selection, probability in probabilities.items():
        std, price = deviations.get(selection), odds.get(selection)
        if (not re.fullmatch(r"[1-6]-[1-6]-[1-6]", str(selection))
                or len(set(str(selection).split("-"))) != 3
                or not _finite(probability) or not 0 <= float(probability) <= 1
                or std is None or not _finite(std) or float(std) < 0
                or price is None or not _finite(price) or float(price) <= 0):
            continue
        if float(std) > float(max_std):
            continue
        expected_roi = float(probability) * float(price) - 1
        conservative_roi = (float(probability) - float(std)) * float(price) - 1
        # Runtime ranks by expected ROI, then applies its conservative edge label.
        if expected_roi >= min_expected_roi and conservative_roi >= min_conservative_roi:
            candidates.append({"selection": str(selection), "probability": float(probability),
                               "probStd": float(std), "odds": float(price),
                               "expectedRoi": expected_roi, "conservativeRoi": conservative_roi})
    ranked = sorted(candidates, key=lambda item: (-item["expectedRoi"], item["selection"]))
    selected = ranked[:min(max_picks, 6, race_budget)]
    if not selected:
        return []
    base_stake, remainder = divmod(race_budget, len(selected))
    for index, item in enumerate(selected):
        item["stake"] = base_stake + (1 if index < remainder else 0)
    return selected


def _consistent_payout(rows: Sequence[Mapping[str, Any]], race_id: str, actual: str):
    """Require a single positive exact trifecta payout matching the K top three."""
    race_rows = [r for r in rows if str(r.get("race_id")) == race_id
                 and r.get("data_origin") == "real" and r.get("bet_type") == "trifecta"]
    positive = []
    for row in race_rows:
        try:
            amount = float(row.get("payout"))
        except (TypeError, ValueError):
            continue
        if math.isfinite(amount) and amount > 0:
            positive.append((str(row.get("selection") or ""), amount))
    matching = [amount for selection, amount in positive if selection == actual]
    if len(matching) != 1 or len(positive) != 1:
        return None
    return matching[0]


def _replay_roi_intervals(rows: Sequence[Mapping[str, Any]], *, samples: int = 2000,
                          seed: int = 17) -> tuple[list[float] | None, list[float] | None]:
    """Bootstrap race and date-cluster ROI for actually observed payouts only."""
    selected = [row for row in rows if int(row.get("stake") or 0) > 0]
    if len(selected) < 2:
        return None, None
    rng = random.Random(seed)

    def roi(sampled):
        stake = sum(int(row["stake"]) for row in sampled)
        payout = sum(int(row["payout"]) for row in sampled)
        return payout / stake - 1 if stake else 0.0

    race_samples = sorted(roi(rng.choices(selected, k=len(selected))) for _ in range(samples))
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in selected:
        by_date[str(row.get("race_date") or "")].append(dict(row))
    dates = sorted(key for key in by_date if key)
    if len(dates) < 2:
        return ([race_samples[int(.025 * (samples - 1))], race_samples[int(.975 * (samples - 1))]], None)
    date_samples = []
    for _ in range(samples):
        chosen = rng.choices(dates, k=len(dates))
        date_samples.append(roi([row for day in chosen for row in by_date[day]]))
    date_samples.sort()
    return ([race_samples[int(.025 * (samples - 1))], race_samples[int(.975 * (samples - 1))]],
            [date_samples[int(.025 * (samples - 1))], date_samples[int(.975 * (samples - 1))]])


def _replay(store: Mapping[str, Any], test_groups: Sequence[Sequence[Mapping[str, Any]]],
            artifact: Mapping[str, Any], *, max_picks: int = 1, race_budget: int = 100,
            min_expected_roi: float = 0.05, max_std: float = 0.05,
            min_conservative_roi: float = 0.05) -> dict[str, Any]:
    _select_runtime_like_tickets({}, {}, {}, max_std=max_std,
        min_expected_roi=min_expected_roi, min_conservative_roi=min_conservative_roi,
        max_picks=max_picks, race_budget=race_budget)
    selected, skipped, selected_ticket_rois = [], defaultdict(int), []
    for group in test_groups:
        race_id = str(group[0].get("race_id"))
        race = next((r for r in store.get("races", []) if r.get("id") == race_id), {})
        post = race.get("post_time")
        predicted_at = group[0].get("predicted_at")
        if not post or not predicted_at:
            skipped["missing_prediction_cutoff_or_post_time"] += 1
            continue
        odds = _captured_odds(store, race_id, str(predicted_at), str(post))
        if not odds:
            skipped["missing_official_verified_complete_pre_cutoff_market"] += 1
            continue
        probs, deviations = ensemble_ordered_triples(artifact, group)
        if any(deviations.get(selection) is None or not _finite(deviations[selection])
               for selection in odds):
            skipped["missing_ensemble_probability_std"] += 1
            continue
        actual = _actual_selection(group)
        payout = _consistent_payout(store.get("payouts", []), race_id, actual)
        if payout is None:
            skipped["missing_or_inconsistent_trifecta_payout_vs_finish_order"] += 1
            continue
        picked = _select_runtime_like_tickets(probs, deviations, odds, max_std=max_std,
            min_expected_roi=min_expected_roi, min_conservative_roi=min_conservative_roi,
            max_picks=max_picks, race_budget=race_budget)
        returned = sum(math.floor(ticket["stake"] * payout / 100)
                       for ticket in picked if ticket["selection"] == actual)
        stake = sum(ticket["stake"] for ticket in picked)
        selected_ticket_rois.extend(ticket["conservativeRoi"] for ticket in picked)
        selected.append({"race_id": race_id, "race_date": group[0].get("race_date"), "tickets": len(picked),
                         "selections": [ticket["selection"] for ticket in picked],
                         "stake": stake, "payout": returned,
                         "conservativeExpectedRois": [ticket["conservativeRoi"] for ticket in picked],
                         "selectionPolicyVersion": REPLAY_SELECTION_POLICY})
    stake = sum(r["stake"] for r in selected)
    payout = sum(r["payout"] for r in selected)
    roi_race_ci, roi_date_ci = _replay_roi_intervals(selected)
    return {"status": "evaluated" if selected else "insufficient_odds_or_payout_data",
            "races": len(selected), "stake": stake, "payout": payout,
            "roi": payout / stake - 1 if stake else None,
            "racesWithPicks": sum(1 for row in selected if row["tickets"]),
            "replayDates": len({str(row.get("race_date")) for row in selected if row["tickets"] and row.get("race_date")}),
            "roiInterval95": roi_race_ci,
            "roiDateClusterInterval95": roi_date_ci,
            "roiIntervalMethod": "nonparametric bootstrap of observed, payout-verified replay races and race-date clusters",
            "ticketCount": sum(row["tickets"] for row in selected),
            "meanSelectedConservativeExpectedRoi": (sum(selected_ticket_rois) / len(selected_ticket_rois)
                                         if selected_ticket_rois else None),
            "selectionPolicyVersion": REPLAY_SELECTION_POLICY,
            "selectionPolicy": {"maxPicks": max_picks, "raceBudget": race_budget,
                                "minExpectedRoi": min_expected_roi, "maxProbStd": max_std,
                                "minConservativeRoi": min_conservative_roi,
                                "tieBreak": "selection_ascending"},
            "strategy": "runtime-like EV-ranked multi-pick exact trifecta replay; not a cross-bet-type policy validation",
            "skippedRaces": dict(skipped),
            "warning": "Retrospective hypothetical replay only; not actual purchases or evidence of profitability."}


def train_trifecta(rows: Sequence[Mapping[str, Any]], store: Mapping[str, Any], *,
                   model_id: str, artifact_dir: str | Path = "ml/artifacts",
                   min_train_races: int = 300,
                   feature_schema_version: str = "boat-base-v1",
                   replay_max_picks: int = 1, replay_race_budget: int = 100) -> dict[str, Any]:
    """Train and chronologically evaluate an immutable candidate artifact."""
    if min_train_races < 300:
        raise ValueError("min_train_races cannot lower the fixed 300-race training floor")
    _select_runtime_like_tickets({}, {}, {}, max_picks=replay_max_picks,
                                 race_budget=replay_race_budget)
    safe_rows = [dict(r) for r in rows if r.get("data_origin") == "real"
                 and r.get("race_id") and r.get("race_date")
                 and r.get("predicted_at") and available_by(r, r["predicted_at"])]
    complete = [g for g in _group_races(safe_rows) if _complete_race(g)]
    complete_rows = [r for g in complete for r in g]
    coverage = audit_trifecta_coverage(store, complete_rows)
    train, valid, test = temporal_split(complete_rows)
    train_groups = [g for g in _group_races(train) if _complete_race(g)]
    valid_groups = [g for g in _group_races(valid) if _complete_race(g)]
    test_groups = [g for g in _group_races(test) if _complete_race(g)]
    out = Path(artifact_dir)
    out.mkdir(parents=True, exist_ok=True)
    pkl_path, json_path = out / f"{model_id}.pkl", out / f"{model_id}.json"
    if pkl_path.exists() or json_path.exists():
        raise FileExistsError(f"candidate artifact ID is immutable and already exists: {model_id}")
    dates = lambda groups: sorted({str(g[0].get("race_date")) for g in groups})
    if len(train_groups) < min_train_races or not valid_groups or not test_groups:
        return {"id": model_id, "status": "untrained", "reason": "insufficient_temporal_data",
                "nTrainRaces": len(train_groups), "nValidRaces": len(valid_groups),
                "nTestRaces": len(test_groups), "coverage": coverage}
    if feature_schema_version not in {"boat-base-v1", PRERACE_V2_SCHEMA}:
        raise ValueError("unsupported boat feature schema version")
    columns = list(PRERACE_V2_FEATURE_COLUMNS if feature_schema_version == PRERACE_V2_SCHEMA
                   else BASE_FEATURE_COLUMNS)
    model = _fit(train, columns)
    valid_flat = [r for g in valid_groups for r in g]
    temperature = _temperature(valid_flat, model)
    alpha_candidates = (0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0)
    alpha = min(alpha_candidates, key=lambda candidate_alpha: _proper_ticket_metrics(
        valid_groups, [_lane_order_model(train_groups, candidate_alpha)] * len(valid_groups))["exactOrderLogLoss"])
    bootstrap_models = []
    rng = random.Random(17)
    for replicate in range(4):
        sampled = [rng.choice(train_groups) for _ in train_groups]
        bootstrap_rows = [{**row, "race_id": f"{row['race_id']}#bootstrap-{replicate}-{i}"}
                          for i, group in enumerate(sampled) for row in group]
        try:
            bootstrap_models.append(_fit(bootstrap_rows, columns))
        except (ValueError, RuntimeError):
            continue
    artifact_for_eval = {"model": model, "bootstrap_models": bootstrap_models,
                         "temperature": temperature}
    score_rows = []
    candidate_distributions = []
    for group in test_groups:
        probabilities, _ = ensemble_ordered_triples(artifact_for_eval, group)
        actual = _actual_selection(group)
        score_rows.append((probabilities.get(actual, 0.0), probabilities))
        candidate_distributions.append(probabilities)
    losses = [-math.log(max(1e-15, p)) for p, _ in score_rows]
    uniform_distribution = {f"{a}-{b}-{c}": 1 / 120 for a, b, c in itertools.permutations(range(1, 7), 3)}
    lane_distribution = _lane_order_model(train_groups, alpha)
    uniform_metrics = _proper_ticket_metrics(test_groups, [uniform_distribution] * len(test_groups))
    lane_metrics = _proper_ticket_metrics(test_groups, [lane_distribution] * len(test_groups))
    candidate_metrics = _proper_ticket_metrics(test_groups, candidate_distributions)
    comparison = {
        "candidateVsLaneLogLossRaceBootstrap": _paired_delta_interval(
            test_groups, candidate_metrics["raceLogLosses"], lane_metrics["raceLogLosses"], cluster="race"),
        "candidateVsLaneLogLossDateCluster": _paired_delta_interval(
            test_groups, candidate_metrics["raceLogLosses"], lane_metrics["raceLogLosses"], cluster="date"),
        "candidateVsLaneBrierRaceBootstrap": _paired_delta_interval(
            test_groups, candidate_metrics["raceBriers"], lane_metrics["raceBriers"], cluster="race"),
        "candidateVsLaneBrierDateCluster": _paired_delta_interval(
            test_groups, candidate_metrics["raceBriers"], lane_metrics["raceBriers"], cluster="date"),
    }
    top_one = sum(max(probabilities, key=probabilities.get) == _actual_selection(group)
                  for (_, probabilities), group in zip(score_rows, test_groups))
    replay = _replay(store, test_groups, artifact_for_eval,
                     max_picks=replay_max_picks, race_budget=replay_race_budget)
    qualification_metrics = {
        "dataOrigin": "real_only" if all(row.get("data_origin") == "real" for row in complete_rows) else "sample_or_mixed",
        "boatFeatureSchemaVersion": feature_schema_version,
        "nTrainRaces": len(train_groups), "nTestRaces": len(test_groups),
        "nTestDates": len(dates(test_groups)), "topTicketEce": candidate_metrics["topTicketEce"],
        "completeCombinationCoverage": candidate_metrics["nTicketEventRows"] == 120 * len(test_groups),
        "payoutReplay": replay, **comparison,
    }
    qualification = evaluate_candidate_qualification(qualification_metrics, coverage)
    promotion_reason = (qualification["reason"] + ": " + ", ".join(qualification["failedChecks"])
                        if qualification["failedChecks"] else
                        "offline qualification passed; independent artifact-bound ticket validation is required")
    meta = {"id": model_id, "sport": "boat", "betType": "trifecta", "status": "candidate",
            "algorithm": "five-fit race-bootstrap pairwise logistic ranking + Plackett-Luce exact-order distribution",
            "ticketModelSchemaVersion": TICKET_SCHEMA,
            "ticketPredictionSemantics": PREDICTION_SEMANTICS,
            "ticketBetType": "trifecta", "boatFeatureSchemaVersion": feature_schema_version,
            "featureColumns": columns,
            "trainFrom": dates(train_groups)[0], "trainTo": dates(train_groups)[-1],
            "validFrom": dates(valid_groups)[0], "validTo": dates(valid_groups)[-1],
            "testFrom": dates(test_groups)[0], "testTo": dates(test_groups)[-1],
            "nTrainRaces": len(train_groups), "nValidRaces": len(valid_groups), "nTestRaces": len(test_groups),
            "temperature": temperature, "calibration": "validation exact-order log loss",
            "metrics": {"exactOrderLogLoss": sum(losses) / len(losses),
                        "uniformBaseline": {key: value for key, value in uniform_metrics.items()
                                            if key not in {"raceLogLosses", "raceBriers"}},
                        "laneOrderBaseline": {key: value for key, value in lane_metrics.items()
                                              if key not in {"raceLogLosses", "raceBriers"}},
                        "laneBaselineSmoothingAlpha": alpha,
                        "candidateVsLaneLogLossRaceBootstrap": comparison["candidateVsLaneLogLossRaceBootstrap"],
                        "candidateVsLaneLogLossDateCluster": comparison["candidateVsLaneLogLossDateCluster"],
                        "candidateVsLaneBrierRaceBootstrap": comparison["candidateVsLaneBrierRaceBootstrap"],
                        "candidateVsLaneBrierDateCluster": comparison["candidateVsLaneBrierDateCluster"],
                        "candidateVsLaneDateClusterInterval": _date_cluster_interval(
                            test_groups, candidate_metrics["raceLogLosses"], lane_metrics["raceLogLosses"]),
                        "multiclassBrier": candidate_metrics["multiclassBrier"],
                        "ticketEventPooledEce": candidate_metrics["ticketEventPooledEce"],
                        "nTicketEventRows": candidate_metrics["nTicketEventRows"],
                        "calibrationDates": candidate_metrics["nDates"],
                        "topTicketEce": candidate_metrics["topTicketEce"],
                        "topTicketCalibration": candidate_metrics["topTicketCalibration"],
                        "exactTop3HitRate": top_one / len(test_groups),
                        "nTestRaces": len(test_groups), "nTestDates": len(dates(test_groups)),
                        "completeCombinationCoverage": candidate_metrics["nTicketEventRows"] == 120 * len(test_groups),
                        "pointInTimeEvidenceComplete": coverage["promotionEvidenceComplete"],
                        "qualification": qualification,
                        "evaluationQualified": qualification["evaluationQualified"],
                        "payoutReplay": replay,
                        "profitabilityProven": False,
                        "promotionEligible": False,
                        "promotionReason": promotion_reason,
                        "ticketModelSchemaVersion": TICKET_SCHEMA,
                        "ticketPredictionSemantics": PREDICTION_SEMANTICS,
                        "ticketBetType": "trifecta",
                        "boatFeatureSchemaVersion": feature_schema_version},
            "trainedAt": datetime.now(timezone.utc).isoformat(),
            "nBootstrapModels": len(bootstrap_models),
            "notes": "Candidate-only temporal evaluation; prob_std is between-fit SD (null unless five fits); no automatic promotion or prediction sync.",
            "coverage": coverage,
            "availableAtAssumption": "B-file available_at is a race-day-midnight assumption unless source_available_at/source_observed_at plus a matching SHA-256 are present; independent arrival evidence is required for qualification."}
    from edgelab.artifact_bundle import candidate_artifact_provenance
    meta["artifactProvenance"] = candidate_artifact_provenance(model_id)
    artifact = {"metadata": meta, "model": model, "bootstrap_models": bootstrap_models,
                "columns": columns, "temperature": temperature}
    with pkl_path.open("wb") as stream:
        pickle.dump(artifact, stream, protocol=pickle.HIGHEST_PROTOCOL)
    meta["ticketArtifactSha256"] = hashlib.sha256(pkl_path.read_bytes()).hexdigest()
    json_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    from edgelab.artifact_bundle import build_candidate_model_bundle
    meta["candidateBundle"] = build_candidate_model_bundle(model_id, out)
    return meta


def train_trifecta_experimental(rows: Sequence[Mapping[str, Any]], store: Mapping[str, Any], *,
                                model_id: str, artifact_dir: str | Path = "ml/artifacts",
                                training_cohort_fingerprint: str | None = None) -> dict[str, Any]:
    """Fit an explicitly experimental, weatherless model without relaxing candidate gates.

    This separate path uses only real, complete outcomes whose own T-60 entry,
    exhibition, odds, cutoff, and payout evidence is present. It deliberately
    makes no independent-validation or profitability claim and never bundles a
    registry candidate.
    """
    if not isinstance(model_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}", model_id):
        raise ValueError("experimental model ID is not a safe artifact filename")
    groups, coverage, evidence_by_id = _eligible_experimental_training_groups(rows, store)
    training_rows = [row for group in groups for row in group]
    out = Path(artifact_dir)
    pkl_path, json_path = out / f"{model_id}.pkl", out / f"{model_id}.json"
    manifest_path = out / f"experimental-trifecta-{model_id}.manifest.json"
    if any(path.exists() for path in (pkl_path, json_path, manifest_path)):
        raise FileExistsError(f"experimental artifact ID is immutable and already exists: {model_id}")
    if not groups:
        return {"id": model_id, "status": "insufficient_data", "trainingMode": "experimental",
                "experimentalOnly": True, "reason": "no_races_with_complete_required_pit_evidence",
                "nTrainRaces": 0, "coverage": coverage, "artifactCreated": False}

    actual_cohort_fingerprint = compute_training_cohort_fingerprint(
        training_rows, store, {str(row["race_id"]) for row in training_rows})
    if training_cohort_fingerprint and training_cohort_fingerprint != actual_cohort_fingerprint:
        raise ValueError("provided training cohort fingerprint does not match eligible fit rows")
    training_cohort_fingerprint = actual_cohort_fingerprint

    columns = list(TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS)
    temporal_shadow = _experimental_temporal_shadow(groups, columns)
    model = _fit(training_rows, columns)
    bootstrap_models = []
    rng = random.Random(17013)
    for replicate in range(4):
        sampled = [rng.choice(groups) for _ in groups]
        bootstrap_rows = [{**row, "race_id": f"{row['race_id']}#experimental-bootstrap-{replicate}-{i}"}
                          for i, group in enumerate(sampled) for row in group]
        try:
            bootstrap_models.append(_fit(bootstrap_rows, columns))
        except (ValueError, RuntimeError):
            continue

    race_ids = sorted({str(row["race_id"]) for row in training_rows})
    dates = sorted({str(row["race_date"]) for row in training_rows})
    training_digest = hashlib.sha256("|".join(race_ids).encode("utf-8")).hexdigest()
    missing_weather = sum(not bool(evidence_by_id[race_id].get("freshWeather")) for race_id in race_ids)
    training_evidence = {
        "trainingRaceCount": len(groups), "trainingDateCount": len(dates),
        "sourceArrivalVerifiedRaceCount": len(groups), "verifiedT60CutoffRaceCount": len(groups),
        "sixFreshExhibitionRaceCount": len(groups), "complete120T60OddsRaceCount": len(groups),
        "consistentPayoutRaceCount": len(groups), "weatherMissingRaceCount": missing_weather,
        "officialOutcomeSourceVerifiedRaceCount": len(groups),
        "raceIdSetSha256": training_digest,
        "trainingCohortFingerprintSha256": training_cohort_fingerprint,
        "requirements": {"realCompletedSixBoatKOrder": True,
            "officialRacelistCutoffObservedByT60": True,
            "sixEntriesHaveArrivalTimestampAndSourceSha256ByT60": True,
            "sixFreshExhibitionLanesByT60": True,
            "coherentOfficial120TicketOddsByT60": True,
            "exactMatchingPositiveTrifectaPayout": True,
            "officialOutcomeSourceHashAndFetchTimeVerified": True,
            "weatherFeaturesUsed": False},
    }
    provenance = {
        "artifactRunId": os.environ.get("GITHUB_RUN_ID") if re.fullmatch(r"[0-9]+", os.environ.get("GITHUB_RUN_ID", "")) else None,
        "artifactRunAttempt": int(os.environ["GITHUB_RUN_ATTEMPT"]) if re.fullmatch(r"[0-9]+", os.environ.get("GITHUB_RUN_ATTEMPT", "")) else None,
        "artifactName": f"experimental-trifecta-model-{model_id}",
        "workflowName": os.environ.get("GITHUB_WORKFLOW") or None,
        "repository": os.environ.get("GITHUB_REPOSITORY") or None,
        "commitSha": os.environ.get("GITHUB_SHA", "").lower() if re.fullmatch(r"[a-fA-F0-9]{40}", os.environ.get("GITHUB_SHA", "")) else None,
    }
    trained_at = datetime.now(timezone.utc).isoformat()
    metadata = {
        "id": model_id, "sport": "boat", "betType": "trifecta", "status": "candidate",
        "trainingMode": "experimental", "experimentalOnly": True,
        "ticketModelSchemaVersion": TICKET_SCHEMA, "ticketPredictionSemantics": PREDICTION_SEMANTICS,
        "ticketBetType": "trifecta", "boatFeatureSchemaVersion": TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA,
        "featureColumns": columns,
        "algorithm": "pairwise logistic ranking + Plackett-Luce exact-order distribution",
        "trainFrom": dates[0], "trainTo": dates[-1], "validFrom": None, "validTo": None,
        "testFrom": None, "testTo": None, "nTrainRaces": len(groups), "nValidRaces": 0,
        "nTestRaces": 0, "temperature": 1.0, "calibration": "none; experimental model",
        "trainedAt": trained_at, "nBootstrapModels": len(bootstrap_models),
        "trainingEvidence": training_evidence,
        "temporalShadowEvaluation": temporal_shadow,
        "metrics": {"independentValidationPerformed": False, "evaluationQualified": False,
                    "promotionEligible": False, "profitabilityProven": False,
                    "pointInTimeEvidenceComplete": True, "ticketModelSchemaVersion": TICKET_SCHEMA,
                    "ticketPredictionSemantics": PREDICTION_SEMANTICS,
                    "ticketBetType": "trifecta", "boatFeatureSchemaVersion": TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA,
                    "trainingEvidence": training_evidence},
        "artifactProvenance": provenance,
        "notes": "Experimental-only low-data model. No independent validation, qualification, or profitability claim. Not eligible for normal candidate promotion.",
    }
    artifact = {"metadata": metadata, "model": model, "bootstrap_models": bootstrap_models,
                "columns": columns, "temperature": 1.0}
    pickle_bytes = pickle.dumps(artifact, protocol=pickle.HIGHEST_PROTOCOL)
    artifact_sha = hashlib.sha256(pickle_bytes).hexdigest()
    metadata["ticketArtifactSha256"] = artifact_sha
    metadata["metrics"]["ticketArtifactSha256"] = artifact_sha
    metadata_bytes = (json.dumps(metadata, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    manifest = {"schema": "edgelab-experimental-trifecta-artifact-v1", "modelId": model_id,
                "trainingMode": "experimental", "experimentalOnly": True,
                "boatFeatureSchemaVersion": TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA,
                "trainingRaceIdSetSha256": training_digest,
                "trainingCohortFingerprintSha256": training_cohort_fingerprint,
                "artifactProvenance": provenance,
                "files": {pkl_path.name: {"sha256": artifact_sha, "sizeBytes": len(pickle_bytes)},
                          json_path.name: {"sha256": hashlib.sha256(metadata_bytes).hexdigest(),
                                           "sizeBytes": len(metadata_bytes)}}}
    manifest_sha = hashlib.sha256(json.dumps(manifest, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    out.mkdir(parents=True, exist_ok=True)
    created: list[Path] = []
    try:
        for path, content in ((pkl_path, pickle_bytes), (json_path, metadata_bytes), (manifest_path, manifest_bytes)):
            with path.open("xb") as stream:
                stream.write(content)
            created.append(path)
    except OSError:
        for path in created:
            path.unlink(missing_ok=True)
        raise
    return {**metadata, "artifactManifest": str(manifest_path), "artifactManifestSha256": manifest_sha,
            "artifactManifestData": manifest, "artifactCreated": True,
            "coverage": coverage}


def _within_experimental_worker_window(as_of: datetime, t60: datetime) -> bool:
    """Match the Worker query's inclusive target-5m through target window."""
    return t60 - timedelta(minutes=5) <= as_of <= t60


def experimental_ticket_predictions(store: Mapping[str, Any], *, artifact: Mapping[str, Any],
                                    model_id: str, cutoff: str, artifact_sha256: str,
                                    race_date: str | None = None) -> dict[str, Any]:
    """Generate isolated paper-only forecasts from a bound experimental artifact.

    No rows are synced or persisted here. Every selected race must have actual
    T-60 cutoff/source evidence, six hash-bound entries, six fresh exhibitions,
    and a coherent 120-row official market already available at ``cutoff``.
    """
    meta = artifact.get("metadata") or {}
    if (meta.get("id") != model_id or meta.get("status") != "candidate"
            or meta.get("trainingMode") != "experimental" or meta.get("experimentalOnly") is not True
            or meta.get("boatFeatureSchemaVersion") != TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA
            or meta.get("ticketModelSchemaVersion") != TICKET_SCHEMA
            or meta.get("ticketPredictionSemantics") != PREDICTION_SEMANTICS
            or meta.get("ticketBetType") != "trifecta"
            or meta.get("metrics", {}).get("promotionEligible") is not False
            or meta.get("metrics", {}).get("profitabilityProven") is not False
            or artifact.get("columns") != list(TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS)
            or not artifact.get("model")):
        raise ValueError("artifact is not a recognized experimental-only trifecta model")
    if not re.fullmatch(r"[a-f0-9]{64}", artifact_sha256):
        raise ValueError("experimental artifact SHA-256 is invalid")
    try:
        as_of = datetime.fromisoformat(cutoff.replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ValueError("prediction cutoff must be ISO-8601") from exc
    if as_of.tzinfo is None or as_of.utcoffset() is None:
        raise ValueError("prediction cutoff must include a timezone")
    as_of = as_of.astimezone(timezone.utc)
    trained_at = datetime.fromisoformat(str(meta.get("trainedAt", "")).replace("Z", "+00:00"))
    if trained_at.tzinfo is None or trained_at.astimezone(timezone.utc) >= as_of:
        raise ValueError("experimental artifact must be trained strictly before forecast cutoff")

    from edgelab.features.boat import classify_prerace_observation
    from edgelab.models.trifecta_coverage import _entry_coverage, _has_complete_market
    races = {str(row.get("id")): row for row in store.get("races", [])
             if row.get("sport") == "boat" and row.get("data_origin") == "real"
             and row.get("status") == "scheduled"
             and (race_date is None or row.get("race_date") == race_date)}
    entries_by_race: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in store.get("entries", []):
        race_id = str(entry.get("race_id"))
        if race_id in races and entry.get("data_origin") == "real":
            entries_by_race[race_id].append(dict(entry))
    observations_by_race: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for observation in store.get("prerace_observations", []):
        if observation.get("data_origin") == "real":
            observations_by_race[str(observation.get("race_id"))].append(observation)

    history = completed_racer_history(store)
    predictions_by_race: list[dict[str, Any]] = []
    for race_id, race in sorted(races.items()):
        try:
            post = datetime.fromisoformat(str(race.get("post_time", "")).replace("Z", "+00:00"))
            official_cutoff = datetime.fromisoformat(str(race.get("betting_cutoff_at", "")).replace("Z", "+00:00"))
            cutoff_observed = datetime.fromisoformat(str(race.get("betting_cutoff_observed_at", "")).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            continue
        if (race.get("betting_cutoff_source") != "boatrace-racelist-cutoff-v1"
                or post.tzinfo is None or official_cutoff.tzinfo is None or cutoff_observed.tzinfo is None):
            continue
        t60 = official_cutoff.astimezone(timezone.utc) - timedelta(seconds=60)
        post = post.astimezone(timezone.utc)
        cutoff_observed = cutoff_observed.astimezone(timezone.utc)
        entries = entries_by_race.get(race_id, [])
        complete, source_proven, _ = _entry_coverage(entries, as_of)
        # Do not generate an earlier snapshot that ingest could persist but
        # the Worker decision query would never consider.
        if (post <= as_of or not _within_experimental_worker_window(as_of, t60)
                or cutoff_observed > as_of or cutoff_observed > t60
                or not complete or not source_proven or not _has_complete_market(store, race, as_of)):
            continue
        fresh_lanes: set[int] = set()
        fresh_observations = []
        for observation in observations_by_race.get(race_id, []):
            values, _reason = classify_prerace_observation(observation, race, t60)
            if not values:
                continue
            try:
                available = datetime.fromisoformat(str(observation.get("available_at", "")).replace("Z", "+00:00"))
                lane = int(observation.get("entry_number", 0))
            except (TypeError, ValueError):
                continue
            if available.tzinfo is None or available.astimezone(timezone.utc) > as_of:
                continue
            source_time = observation.get("source_observed_at") or observation.get("captured_at")
            if source_time:
                try:
                    source_dt = datetime.fromisoformat(str(source_time).replace("Z", "+00:00"))
                except ValueError:
                    continue
                if source_dt.tzinfo is None or source_dt.astimezone(timezone.utc) > as_of:
                    continue
            if observation.get("kind") == "exhibition" and 1 <= lane <= 6:
                fresh_lanes.add(lane)
                fresh_observations.append(observation)
        if fresh_lanes != {1, 2, 3, 4, 5, 6} or len(entries) != 6:
            continue
        features = build_boat_prerace_v2_features(entries, race=race, predicted_at=as_of,
            history=history, observations=observations_by_race.get(race_id, []))
        group = [{**{key: value for key, value in entry.items()
                     if key not in TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS}, **feature}
                 for entry, feature in zip(entries, features)]
        probabilities, deviations = ensemble_ordered_triples(artifact, group)
        validate_ticket_probabilities(probabilities)
        predictions_by_race.append({"raceId": race_id,
            "predictedAt": as_of.isoformat().replace("+00:00", "Z"),
            "predictions": [{"selection": selection, "probability": probability,
                             "prob_std": deviations[selection]}
                            for selection, probability in sorted(probabilities.items())]})
    return {"schema": "edgelab-experimental-trifecta-forecast-v1", "modelId": model_id,
            "artifactSha256": artifact_sha256, "trainingMode": "experimental", "experimentalOnly": True,
            "ticketModelSchemaVersion": TICKET_SCHEMA, "ticketPredictionSemantics": PREDICTION_SEMANTICS,
            "boatFeatureSchemaVersion": TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA,
            "races": predictions_by_race}
