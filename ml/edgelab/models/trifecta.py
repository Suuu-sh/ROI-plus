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
import pickle
import random
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from edgelab.features.boat import BASE_FEATURE_COLUMNS
from edgelab.models.compare import temporal_split
from edgelab.normalization.availability import available_by

TICKET_SCHEMA = "ticket-selection-v1"
PREDICTION_SEMANTICS = "exact-selection-probability-v1"


def _group_races(rows: Sequence[Mapping[str, Any]]) -> list[list[dict[str, Any]]]:
    by_race: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_race[str(row["race_id"])].append(dict(row))
    return [by_race[key] for key in sorted(by_race)]


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


def active_ticket_predictions(store: Mapping[str, Any], *, model_row: Mapping[str, Any],
                              artifact: Mapping[str, Any], model_id: str, cutoff: str,
                              artifact_sha256: str) -> list[dict[str, Any]]:
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
    if (model_row.get("status") != "active"
            or metrics.get("ticketModelSchemaVersion") != TICKET_SCHEMA
            or metrics.get("ticketPredictionSemantics") != PREDICTION_SEMANTICS
            or metrics.get("ticketBetType") != "trifecta"
            or metrics.get("promotionEligible") is not True
            or metrics.get("ticketArtifactSha256") != artifact_sha256
            or meta.get("id") != model_id
            or meta.get("ticketModelSchemaVersion") != TICKET_SCHEMA
            or meta.get("ticketPredictionSemantics") != PREDICTION_SEMANTICS
            or meta.get("ticketBetType") != "trifecta"
            or any(column not in BASE_FEATURE_COLUMNS for column in artifact.get("columns", []))
            or not artifact.get("model")):
        raise ValueError("active trifecta model lacks validated matching schema/semantics/artifact evidence")
    cutoff_dt = datetime.fromisoformat(cutoff.replace("Z", "+00:00"))
    trained_at = meta.get("trainedAt")
    if not trained_at or datetime.fromisoformat(str(trained_at).replace("Z", "+00:00")) >= cutoff_dt:
        raise ValueError("artifact was not trained strictly before prediction cutoff")
    races = {r.get("id"): r for r in store.get("races", [])
             if r.get("sport") == "boat" and r.get("data_origin") == "real"
             and r.get("status") not in {"finished", "cancelled"}}
    by_race: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in store.get("entries", []):
        rid = str(entry.get("race_id"))
        race = races.get(rid)
        if (race and entry.get("data_origin") == "real" and race.get("post_time")
                and datetime.fromisoformat(str(race["post_time"]).replace("Z", "+00:00")) > cutoff_dt
                and available_by(entry, cutoff)):
            by_race[rid].append(dict(entry))
    records = []
    for race_id, entries in by_race.items():
        if len(entries) != 6 or len({str(e.get("number")) for e in entries}) != 6:
            continue
        date = races[race_id].get("race_date")
        features = build_boat_features(entries, race_date=date, predicted_at=cutoff)
        group = [{**{key: value for key, value in entry.items() if key not in BASE_FEATURE_COLUMNS}, **feature}
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
    losses, briers, calibration = [], [], []
    top_calibration = []
    for group, probs in zip(groups, distributions):
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
            "raceLogLosses": losses}


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
    from datetime import datetime
    cutoff = datetime.fromisoformat(predicted_at.replace("Z", "+00:00"))
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
    for row in store.get("odds_snapshots", []):
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
        if captured.tzinfo is None or cutoff.tzinfo is None or deadline.tzinfo is None:
            continue
        if captured > cutoff or captured >= deadline or not math.isfinite(odds) or odds <= 0:
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


def _select_conservative_ticket(probabilities: Mapping[str, float], deviations: Mapping[str, float],
                                odds: Mapping[str, float], *, max_std: float = 0.05,
                                min_conservative_roi: float = 0.05):
    """Mirror the current one-ticket-per-race virtual choice rule."""
    candidates = []
    for selection, probability in probabilities.items():
        std, price = deviations.get(selection), odds.get(selection)
        if std is None or not _finite(std) or price is None or not _finite(price):
            continue
        if std > max_std:
            continue
        conservative_roi = (float(probability) - float(std)) * float(price) - 1
        if conservative_roi >= min_conservative_roi:
            candidates.append((selection, float(probability), float(std), float(price), conservative_roi))
    return max(candidates, key=lambda item: (item[4], item[1], item[0])) if candidates else None


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


def _replay(store: Mapping[str, Any], test_groups: Sequence[Sequence[Mapping[str, Any]]],
            artifact: Mapping[str, Any]) -> dict[str, Any]:
    selected, skipped = [], defaultdict(int)
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
        selected_ticket = _select_conservative_ticket(probs, deviations, odds)
        if not selected_ticket:
            skipped["no_positive_expected_value_tickets"] += 1
            continue
        actual = _actual_selection(group)
        payout = _consistent_payout(store.get("payouts", []), race_id, actual)
        if payout is None:
            skipped["missing_or_inconsistent_trifecta_payout_vs_finish_order"] += 1
            continue
        selection, _, _, _, conservative_roi = selected_ticket
        stake = 100
        returned = payout if selection == actual else 0.0
        selected.append({"race_id": race_id, "tickets": 1, "selection": selection, "stake": stake,
                         "payout": returned, "conservativeExpectedRoi": conservative_roi})
    stake = sum(r["stake"] for r in selected)
    payout = sum(r["payout"] for r in selected)
    return {"status": "evaluated" if selected else "insufficient_odds_or_payout_data",
            "races": len(selected), "stake": stake, "payout": payout,
            "roi": payout / stake - 1 if stake else None,
            "meanSelectedConservativeExpectedRoi": (sum(r["conservativeExpectedRoi"] for r in selected) / len(selected)
                                         if selected else None),
            "strategy": "one 100-yen trifecta per race: highest conservative expected ROI; not a cross-bet-type policy validation",
            "skippedRaces": dict(skipped),
            "warning": "Retrospective hypothetical replay only; not actual purchases or evidence of profitability."}


def train_trifecta(rows: Sequence[Mapping[str, Any]], store: Mapping[str, Any], *,
                   model_id: str, artifact_dir: str | Path = "ml/artifacts",
                   min_train_races: int = 300) -> dict[str, Any]:
    """Train and chronologically evaluate an immutable candidate artifact."""
    safe_rows = [dict(r) for r in rows if r.get("data_origin") == "real"
                 and r.get("race_id") and r.get("race_date")
                 and r.get("predicted_at") and available_by(r, r["predicted_at"])]
    complete = [g for g in _group_races(safe_rows) if _complete_race(g)]
    complete_rows = [r for g in complete for r in g]
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
                "nTrainRaces": len(train_groups), "nValidRaces": len(valid_groups), "nTestRaces": len(test_groups)}
    columns = list(BASE_FEATURE_COLUMNS)
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
    top_one = sum(max(probabilities, key=probabilities.get) == _actual_selection(group)
                  for (_, probabilities), group in zip(score_rows, test_groups))
    replay = _replay(store, test_groups, artifact_for_eval)
    meta = {"id": model_id, "sport": "boat", "betType": "trifecta", "status": "candidate",
            "algorithm": "five-fit race-bootstrap pairwise logistic ranking + Plackett-Luce exact-order distribution",
            "ticketModelSchemaVersion": TICKET_SCHEMA,
            "ticketPredictionSemantics": PREDICTION_SEMANTICS,
            "ticketBetType": "trifecta", "featureColumns": columns,
            "trainFrom": dates(train_groups)[0], "trainTo": dates(train_groups)[-1],
            "validFrom": dates(valid_groups)[0], "validTo": dates(valid_groups)[-1],
            "testFrom": dates(test_groups)[0], "testTo": dates(test_groups)[-1],
            "nTrainRaces": len(train_groups), "nValidRaces": len(valid_groups), "nTestRaces": len(test_groups),
            "temperature": temperature, "calibration": "validation exact-order log loss",
            "metrics": {"exactOrderLogLoss": sum(losses) / len(losses),
                        "uniformBaseline": {key: value for key, value in uniform_metrics.items() if key != "raceLogLosses"},
                        "laneOrderBaseline": {key: value for key, value in lane_metrics.items() if key != "raceLogLosses"},
                        "laneBaselineSmoothingAlpha": alpha,
                        "candidateVsLaneDateClusterInterval": _date_cluster_interval(
                            test_groups, candidate_metrics["raceLogLosses"], lane_metrics["raceLogLosses"]),
                        "multiclassBrier": candidate_metrics["multiclassBrier"],
                        "ticketEventPooledEce": candidate_metrics["ticketEventPooledEce"],
                        "nTicketEventRows": candidate_metrics["nTicketEventRows"],
                        "calibrationDates": candidate_metrics["nDates"],
                        "topTicketEce": candidate_metrics["topTicketEce"],
                        "topTicketCalibration": candidate_metrics["topTicketCalibration"],
                        "exactTop3HitRate": top_one / len(test_groups),
                        "payoutReplay": replay,
                        "profitabilityProven": False,
                        "promotionEligible": False,
                        "promotionReason": "candidate-only: B-file point-in-time availability and positive expected value are not proven",
                        "ticketModelSchemaVersion": TICKET_SCHEMA,
                        "ticketPredictionSemantics": PREDICTION_SEMANTICS,
                        "ticketBetType": "trifecta"},
            "trainedAt": datetime.now(timezone.utc).isoformat(),
            "nBootstrapModels": len(bootstrap_models),
            "notes": "Candidate-only temporal evaluation; prob_std is between-fit SD (null unless five fits); no automatic promotion or prediction sync.",
            "availableAtAssumption": "Historical B-file available_at is synthesized at local race-day midnight; actual publication timing is not verified."}
    artifact = {"metadata": meta, "model": model, "bootstrap_models": bootstrap_models,
                "columns": columns, "temperature": temperature}
    with pkl_path.open("wb") as stream:
        pickle.dump(artifact, stream, protocol=pickle.HIGHEST_PROTOCOL)
    meta["ticketArtifactSha256"] = hashlib.sha256(pkl_path.read_bytes()).hexdigest()
    json_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return meta
