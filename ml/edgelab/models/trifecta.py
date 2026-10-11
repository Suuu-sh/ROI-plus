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
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from edgelab.features.boat import (BASE_FEATURE_COLUMNS, PRERACE_V2_FEATURE_COLUMNS,
                                   PRERACE_V2_SCHEMA, build_boat_prerace_v2_features,
                                   completed_racer_history)
from edgelab.models.compare import temporal_split
from edgelab.normalization.availability import available_by

TICKET_SCHEMA = "ticket-selection-v1"
PREDICTION_SEMANTICS = "exact-selection-probability-v1"
REPLAY_SELECTION_POLICY = "trifecta-runtime-ev-multipick-v1"


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
            or metrics.get("ticketModelSchemaVersion") != TICK