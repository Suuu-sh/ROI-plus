"""Audit selected experimental trifecta tickets against settled outcomes.

Input is the JSON array returned by GET /api/bets/experimental. This deliberately
audits placed tickets only; it cannot establish calibration of the full 120-way
forecast distribution or remove selection bias.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _valid_selection(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parts = value.split("-")
    return len(parts) == 3 and all(part in {"1", "2", "3", "4", "5", "6"} for part in parts) and len(set(parts)) == 3


def _ticket_is_valid(row: dict[str, Any]) -> bool:
    selection = row.get("selection")
    official = row.get("officialSelection")
    return (_valid_selection(selection)
            and _valid_selection(official)
            and _finite(row.get("predictedProb"))
            and 0 <= row["predictedProb"] <= 1
            and _finite(row.get("oddsAtBet")) and row["oddsAtBet"] > 0
            and isinstance(row.get("raceId"), str) and bool(row["raceId"])
            and row.get("status") in ("won", "lost")
            and ((row["selection"] == official) == (row["status"] == "won")))


def _quantile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    vals = sorted(values)
    pos = (len(vals) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(vals) - 1)
    return vals[lo] + (vals[hi] - vals[lo]) * (pos - lo)


def audit(rows: Iterable[dict[str, Any]], *, bootstrap_samples: int = 2000,
          seed: int = 20261017) -> dict[str, Any]:
    """Summarize real, valid placed tickets; CI resamples races, not tickets."""
    counts: dict[str, int] = defaultdict(int)
    valid: list[dict[str, Any]] = []
    seen: set[str] = set()
    invalid_settled_races: set[str] = set()
    invalid_settled_records_per_race: dict[str, int] = defaultdict(int)
    for row in rows:
        counts["records"] += 1
        if not isinstance(row, dict):
            counts["invalid_shape"] += 1
            continue
        if row.get("dataOrigin") != "real":
            counts["non_real"] += 1
            continue
        if row.get("repairReason") or row.get("status") == "void":
            counts["void_or_reconciled"] += 1
            continue
        if row.get("status") == "open":
            counts["open"] += 1
            continue
        if row.get("status") not in ("won", "lost"):
            counts["other_status"] += 1
            continue
        if row.get("recordKind") != "experimental_paper" or row.get("betType") != "trifecta":
            counts["wrong_record_kind"] += 1
            continue
        key = str(row.get("id", ""))
        if not key or key in seen:
            counts["duplicate_or_missing_id"] += 1
            continue
        seen.add(key)
        if not _ticket_is_valid(row):
            counts["invalid_settlement_or_probability"] += 1
            race_id = row.get("raceId")
            if isinstance(race_id, str) and race_id:
                invalid_settled_races.add(race_id)
                invalid_settled_records_per_race[race_id] += 1
            continue
        valid.append(row)
        counts["settled_valid"] += 1

    candidate_by_race: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in valid:
        candidate_by_race[row["raceId"]].append(row)
    duplicate_selection_races = {
        race for race, tickets in candidate_by_race.items()
        if len({x["selection"] for x in tickets}) != len(tickets)
    }
    inconsistent_result_races = {
        race for race, tickets in candidate_by_race.items()
        if len({x["officialSelection"] for x in tickets}) != 1
    }
    overfull_races = {
        race for race, tickets in candidate_by_race.items()
        if sum(float(x["predictedProb"]) for x in tickets) > 1 + 1e-9
    }
    excluded_races = duplicate_selection_races | inconsistent_result_races | overfull_races | invalid_settled_races
    for category, races in (("race_duplicate_selection", duplicate_selection_races),
                            ("race_inconsistent_official_result", inconsistent_result_races),
                            ("incoherent_race_probability_mass", overfull_races)):
        if races:
            counts[category + "_count"] += len(races)
            counts[category + "_tickets"] += sum(len(candidate_by_race[race]) for race in races)
    if invalid_settled_races:
        counts["race_has_invalid_settled_ticket_count"] += len(invalid_settled_races)
        counts["race_has_invalid_settled_ticket_records"] += sum(invalid_settled_records_per_race.values())
        counts["race_has_invalid_settled_ticket_valid_tickets"] += sum(
            len(candidate_by_race.get(race, [])) for race in invalid_settled_races
        )
    if excluded_races:
        removed = sum(len(candidate_by_race.get(race, [])) for race in excluded_races)
        valid = [x for x in valid if x["raceId"] not in excluded_races]
        counts["settled_valid"] -= removed
    max_race_probability_mass = max(
        (sum(float(x["predictedProb"]) for x in tickets) for tickets in candidate_by_race.values()),
        default=0.0,
    )

    if not valid:
        return {"counts": dict(counts), "n": 0, "races": 0, "metrics": None,
                "models": {}, "settledRaceGroupShape": {"maxTickets": 0, "maxCombinedStake": 0,
                                                          "racesOver10Tickets": 0, "racesOver1000Stake": 0},
                "maxSettledRaceSelectedProbabilitySum": max_race_probability_mass,
                "probabilitySemantics": "exact-selection probability for one ordered trifecta",
                "limitations": ["placed-ticket selection bias", "tickets within a race are dependent",
                                "no full 120-selection forecast distribution in this endpoint"]}

    y = [1.0 if x["status"] == "won" else 0.0 for x in valid]
    p = [float(x["predictedProb"]) for x in valid]
    odds = [float(x["oddsAtBet"]) for x in valid]
    n = len(valid)
    observed = sum(y)
    brier = sum((a-b) ** 2 for a, b in zip(p, y)) / n
    clipped = [min(1 - 1e-15, max(1e-15, x)) for x in p]
    logloss = -sum(a * math.log(b) + (1-a) * math.log(1-b) for a, b in zip(y, clipped)) / n

    def reliability(key_fn):
        groups: dict[str, list[int]] = defaultdict(list)
        for i, row in enumerate(valid):
            groups[key_fn(p[i], odds[i])].append(i)
        out = []
        for key in sorted(groups):
            ix = groups[key]
            out.append({"bin": key, "n": len(ix), "meanPredicted": sum(p[i] for i in ix)/len(ix),
                        "observedHitRate": sum(y[i] for i in ix)/len(ix),
                        "meanOdds": sum(odds[i] for i in ix)/len(ix),
                        "meanImpliedProbability": sum(1/odds[i] for i in ix)/len(ix)})
        return out

    by_race: dict[str, list[int]] = defaultdict(list)
    for i, row in enumerate(valid):
        by_race[row["raceId"]].append(i)
    race_ids = list(by_race)
    race_ticket_counts = [len(indices) for indices in by_race.values()]
    race_stakes = [sum(float(valid[i].get("stake", 0)) for i in indices) for indices in by_race.values()]
    rng = random.Random(seed)
    delta_samples = []
    brier_samples = []
    if len(race_ids) > 1 and bootstrap_samples > 0:
        for _ in range(bootstrap_samples):
            sampled = [race_ids[rng.randrange(len(race_ids))] for __ in race_ids]
            ix = [i for race in sampled for i in by_race[race]]
            delta_samples.append(sum(y[i]-p[i] for i in ix)/len(ix))
            brier_samples.append(sum((y[i]-p[i])**2 for i in ix)/len(ix))
    race_ci = None if not delta_samples else {
        "observedMinusPredicted95Percentile": [_quantile(delta_samples, .025), _quantile(delta_samples, .975)],
        "brier95Percentile": [_quantile(brier_samples, .025), _quantile(brier_samples, .975)],
        "method": "percentile bootstrap resampling race clusters with replacement",
        "samples": bootstrap_samples,
    }
    model_groups: dict[str, list[int]] = defaultdict(list)
    for i, row in enumerate(valid):
        model_groups[str(row.get("modelId") or "unknown")].append(i)
    model_metrics = {}
    for model_id, indices in sorted(model_groups.items()):
        model_metrics[model_id] = {
            "tickets": len(indices),
            "races": len({valid[i]["raceId"] for i in indices}),
            "hits": sum(y[i] for i in indices),
            "expectedHits": sum(p[i] for i in indices),
            "meanPredictedProbability": sum(p[i] for i in indices) / len(indices),
            "hitRate": sum(y[i] for i in indices) / len(indices),
        }
    return {"counts": dict(counts), "n": n, "races": len(race_ids),
            "models": model_metrics,
            "settledRaceGroupShape": {
                "maxTickets": max(race_ticket_counts, default=0),
                "maxCombinedStake": max(race_stakes, default=0),
                "racesOver10Tickets": sum(count > 10 for count in race_ticket_counts),
                "racesOver1000Stake": sum(stake > 1000 for stake in race_stakes),
            },
            "maxSettledRaceSelectedProbabilitySum": max_race_probability_mass,
            "metrics": {"hits": observed, "hitRate": observed/n, "meanPredictedProbability": sum(p)/n,
                        "expectedHits": sum(p), "observedMinusPredicted": observed/n-sum(p)/n,
                        "brier": brier, "logLoss": logloss,
                        "meanOdds": sum(odds)/n, "meanBreakEvenProbability": sum(1/x for x in odds)/n},
            "probabilityReliabilityDeciles": reliability(lambda prob, _odds: str(min(9, int(prob*10)))),
            "oddsReliability": reliability(lambda _prob, price: f"{int(math.log2(price)):02d}x"),
            "raceClusterUncertainty": race_ci,
            "probabilitySemantics": "exact-selection probability for one ordered trifecta",
            "limitations": ["placed-ticket selection bias", "tickets within a race are dependent",
                            "no full 120-selection forecast distribution in this endpoint",
                            "odds implied probabilities include market overround and are not calibrated labels"]}


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="JSON array from /api/bets/experimental")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--observed-at", help="ISO timestamp for the read-only API snapshot")
    parser.add_argument("--performance-input", type=Path, help="optional JSON object from /api/performance/experimental")
    args = parser.parse_args()
    input_bytes = args.input.read_bytes()
    result = audit(json.loads(input_bytes))
    provenance = {"betsSha256": hashlib.sha256(input_bytes).hexdigest(),
                  "betsEndpoint": "/api/bets/experimental"}
    if args.observed_at:
        provenance["observedAt"] = args.observed_at
    if args.performance_input:
        performance_bytes = args.performance_input.read_bytes()
        performance = json.loads(performance_bytes)
        provenance["performanceSha256"] = hashlib.sha256(performance_bytes).hexdigest()
        provenance["performanceEndpoint"] = "/api/performance/experimental"
        result["performanceComparison"] = performance.get("comparison")
        result["performanceMetrics"] = performance.get("metrics")
    result["provenance"] = provenance
    rendered = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered)
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
