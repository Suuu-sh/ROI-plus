"""Opt-in offline calibration experiment. Never register, promote, or infer live.

Usage: python -m edgelab.models.trifecta_calibration_candidate --rows ROWS.json
       --store STORE.json --report REPORT.json --enable-experimental-candidate
Inputs must be explicit local non-secret data exports. Odds are eligibility
checks only; neither odds nor test outcomes are calibration inputs.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from edgelab.features.boat import TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS
from edgelab.models.trifecta import (
    _actual_selection, _eligible_experimental_training_groups, _fit,
    _proper_ticket_metrics, ensemble_ordered_triples,
)

# Fixed before looking at calibration/test outcomes. Includes sharper AND flatter
# distributions: longshot overestimation alone does not identify the right scale.
TEMPERATURES = (0.4, 0.55, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0, 3.0)


def _split_dates(groups):
    dates = sorted({str(group[0]["race_date"]) for group in groups})
    train_end, calibration_end = int(len(dates) * .6), int(len(dates) * .8)
    return tuple([g for g in groups if str(g[0]["race_date"]) in set(part)]
                 for part in (dates[:train_end], dates[train_end:calibration_end], dates[calibration_end:]))


def _tail_summary(groups, distributions, baseline_distributions):
    # Fixed model-probability bin, NOT an odds-selected longshot cohort.
    selected = [(p, float(key == _actual_selection(group)))
                for group, probabilities, baseline in zip(groups, distributions, baseline_distributions)
                for key, p in probabilities.items() if baseline[key] <= .01]
    return {"definition": "uncalibrated_ticket_probability_lte_0.01; fixed baseline cohort; not odds-selected",
            "nTicketEvents": len(selected), "nRaces": len(groups),
            "meanPredicted": sum(p for p, _ in selected) / len(selected) if selected else None,
            "observedFrequency": sum(y for _, y in selected) / len(selected) if selected else None,
            "interpretation": "descriptive dependent ticket events; not independent sample size"}


def evaluate_calibration_candidate(rows: Sequence[Mapping[str, Any]], store: Mapping[str, Any], *,
                                   enabled: bool = False) -> dict[str, Any]:
    """Compare calibrated vs uncalibrated SAME train-only ensemble on later test.

    No artifact is persisted or returned. Even a positive descriptive test result
    remains unqualified; independent validation and model-risk review are separate.
    """
    report: dict[str, Any] = {
        "schema": "trifecta-ensemble-calibration-candidate-v1", "candidateOnly": True,
        "promotionEligible": False, "evaluationQualified": False, "profitabilityProven": False,
        "artifactCreated": False, "temperatureGrid": list(TEMPERATURES),
        "uncertaintyInterpretation": "between-fit spread only; excludes structural bias and calibration error",
    }
    if not enabled:
        return {**report, "status": "disabled", "reason": "explicit_opt_in_required"}
    groups, coverage, _ = _eligible_experimental_training_groups(rows, store)
    train, calibration, test = _split_dates(groups)
    report.update({"coverage": coverage, "splitUnit": "whole_race_date",
                   "partitions": {name: {"nRaces": len(part),
                       "dates": sorted({str(g[0]["race_date"]) for g in part})}
                       for name, part in zip(("train", "calibration", "test"), (train, calibration, test))}})
    # Fixed conservative research floors, not a profitability/sample-power claim.
    if any(len(part) < floor or len({g[0]["race_date"] for g in part}) < 2
           for part, floor in zip((train, calibration, test), (300, 100, 100))):
        return {**report, "status": "insufficient_data", "reason": "requires_300_train_100_calibration_100_test_and_two_dates_each"}
    columns = list(TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS)
    flat = [row for group in train for row in group]
    model = _fit(flat, columns)
    rng = np.random.default_rng(17)
    bootstraps = []
    for replicate in range(4):
        sampled = rng.integers(0, len(train), size=len(train))
        sample_rows = [{**row, "race_id": f"candidate-{replicate}-{i}"}
                       for i, index in enumerate(sampled) for row in train[int(index)]]
        bootstraps.append(_fit(sample_rows, columns))
    artifact = {"model": model, "bootstrap_models": bootstraps, "temperature": 1.0}
    # Calibrate the actual ensemble, unlike calibrating primary fit alone then
    # applying its temperature to bootstrap fits. Test is never passed here.
    losses = []
    for temperature in TEMPERATURES:
        candidate = {**artifact, "temperature": temperature}
        loss = sum(-math.log(max(1e-15, ensemble_ordered_triples(candidate, group)[0][
            _actual_selection(group)])) for group in calibration) / len(calibration)
        losses.append((loss, abs(temperature - 1.0), temperature))
    temperature = min(losses)[2]
    baseline_distributions = [ensemble_ordered_triples(artifact, g)[0] for g in test]
    candidate_distributions = [ensemble_ordered_triples(
        {**artifact, "temperature": temperature}, g)[0] for g in test]
    baseline = _proper_ticket_metrics(test, baseline_distributions)
    calibrated = _proper_ticket_metrics(test, candidate_distributions)
    keys = ("exactOrderLogLoss", "multiclassBrier", "topTicketEce", "nRaces")
    improved = (calibrated["exactOrderLogLoss"] < baseline["exactOrderLogLoss"]
                and calibrated["multiclassBrier"] < baseline["multiclassBrier"]
                and calibrated["topTicketEce"] <= baseline["topTicketEce"])
    return {**report, "status": "evaluated_unqualified", "temperature": temperature,
            "uncalibratedTest": {k: baseline[k] for k in keys},
            "calibratedTest": {k: calibrated[k] for k in keys},
            "descriptiveTestGatePassed": improved,
            "lowProbabilityTestBin": {"uncalibrated": _tail_summary(test, baseline_distributions, baseline_distributions),
                                      "calibrated": _tail_summary(test, candidate_distributions, baseline_distributions)},
            "interpretation": "single untouched temporal test; not independent validation, longshot-specific proof, or profit proof"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=Path, required=True)
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--enable-experimental-candidate", action="store_true")
    args = parser.parse_args()
    if not args.enable_experimental_candidate:
        parser.error("--enable-experimental-candidate is required; no inputs read")
    report = evaluate_calibration_candidate(json.loads(args.rows.read_text()),
        json.loads(args.store.read_text()), enabled=True)
    args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
