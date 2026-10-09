"""Temporal evaluation and race-level probability metrics for EdgeLab models."""
from __future__ import annotations

import math
import random
from collections import defaultdict
from typing import Any, Iterable, Mapping, Sequence


def _clip(p: float, eps: float = 1e-15) -> float:
    return min(1.0 - eps, max(eps, float(p)))


def race_log_loss(rows: Sequence[Mapping[str, Any]]) -> float | None:
    """Mean winner cross-entropy, with probabilities normalized per race."""
    groups: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[str(row["race_id"])].append(row)
    losses = []
    for group in groups.values():
        winners = [r for r in group if bool(r.get("winner", r.get("target", False)))]
        if len(winners) != 1:
            continue
        p = _clip(float(winners[0].get("probability", 0.0)))
        losses.append(-math.log(p))
    return sum(losses) / len(losses) if losses else None


def compute_metrics(rows: Sequence[Mapping[str, Any]], baseline_log_loss: float | None = None) -> dict[str, Any]:
    """Compute proper race-level metrics and simple calibration diagnostics."""
    groups: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[str(row["race_id"])].append(row)
    race_losses: list[float] = []
    baseline_losses: list[float] = []
    briers: list[float] = []
    calibration: list[tuple[float, float]] = []
    n = 0
    for group in groups.values():
        winners = [r for r in group if bool(r.get("winner", r.get("target", False)))]
        if len(winners) != 1:
            continue
        ps = [max(0.0, float(r.get("probability", 0.0))) for r in group]
        total = sum(ps)
        if total <= 0:
            continue
        ps = [p / total for p in ps]
        winner_idx = next(i for i, r in enumerate(group) if bool(r.get("winner", r.get("target", False))))
        race_losses.append(-math.log(_clip(ps[winner_idx])))
        baseline_losses.append(math.log(len(group)))
        briers.append(sum((p - (i == winner_idx)) ** 2 for i, p in enumerate(ps)))
        calibration.extend((p, float(i == winner_idx)) for i, p in enumerate(ps))
        n += 1
    if not n:
        return {"nRaces": 0, "logLoss": None, "brier": None, "ece": None,
                "baselineLogLoss": baseline_log_loss}
    bins = [[] for _ in range(10)]
    for p, y in calibration:
        bins[min(9, int(p * 10))].append((p, y))
    ece = sum(len(bucket) / len(calibration) * abs(
        sum(p for p, _ in bucket) / len(bucket) - sum(y for _, y in bucket) / len(bucket)
    ) for bucket in bins if bucket)
    return {"nRaces": n, "logLoss": sum(race_losses) / n,
            "brier": sum(briers) / n, "ece": ece,
            "baselineLogLoss": (baseline_log_loss if baseline_log_loss is not None
                                else sum(baseline_losses) / n)}


def bootstrap_std(values: Sequence[float], *, samples: int = 500, seed: int = 17) -> float | None:
    """Bootstrap standard deviation of the sample mean; deterministic by default."""
    if len(values) < 2:
        return None
    rng = random.Random(seed)
    means = [sum(rng.choices(values, k=len(values))) / len(values) for _ in range(samples)]
    mean = sum(means) / len(means)
    return math.sqrt(sum((x - mean) ** 2 for x in means) / max(1, len(means) - 1))


def temporal_split(rows: Sequence[Mapping[str, Any]], valid_fraction: float = .15,
                   test_fraction: float = .15) -> tuple[list[dict], list[dict], list[dict]]:
    """Split whole race dates chronologically; never split a race across sets."""
    dates = sorted({str(r.get("race_date") or r.get("date") or "") for r in rows})
    dates = [d for d in dates if d]
    if len(dates) < 3:
        return [], [], []
    n_test = max(1, round(len(dates) * test_fraction))
    n_valid = max(1, round(len(dates) * valid_fraction))
    if n_test + n_valid >= len(dates):
        n_test = n_valid = 1
    train_dates = set(dates[:len(dates) - n_test - n_valid])
    valid_dates = set(dates[len(dates) - n_test - n_valid:len(dates) - n_test])
    test_dates = set(dates[len(dates) - n_test:])
    date_of = lambda r: str(r.get("race_date") or r.get("date") or "")
    return ([dict(r) for r in rows if date_of(r) in train_dates],
            [dict(r) for r in rows if date_of(r) in valid_dates],
            [dict(r) for r in rows if date_of(r) in test_dates])


def compare_models(current: Mapping[str, Any], candidate: Mapping[str, Any]) -> dict[str, Any]:
    """Recommend candidate only when proper scores improve and ECE does not.

    Inputs may be D1 model rows (``metrics_json``) or metadata mappings with
    a ``metrics`` object. This function never mutates/promotes either model.
    """
    def metrics(row: Mapping[str, Any]) -> Mapping[str, Any]:
        value = row.get("metrics", row.get("metrics_json", {}))
        if isinstance(value, str):
            import json
            try:
                value = json.loads(value)
            except (ValueError, TypeError):
                value = {}
        return value if isinstance(value, Mapping) else {}

    old, new = metrics(current), metrics(candidate)
    fields = {"logloss": ("logLoss", "logloss"), "brier": ("brier",),
              "ece": ("ece",), "roi": ("roi", "expectedRoi"),
              "maxdd": ("maxDrawdown", "maxdd")}
    values: dict[str, dict[str, float | None]] = {}
    for label, aliases in fields.items():
        values[label] = {
            "current": next((float(old[k]) for k in aliases if old.get(k) is not None), None),
            "candidate": next((float(new[k]) for k in aliases if new.get(k) is not None), None),
        }
    a, b = values["logloss"], values["brier"]
    e = values["ece"]
    eligible = (a["current"] is not None and a["candidate"] is not None
                and b["current"] is not None and b["candidate"] is not None
                and e["current"] is not None and e["candidate"] is not None
                and a["candidate"] < a["current"] and b["candidate"] < b["current"]
                and e["candidate"] <= e["current"])
    return {"candidate": bool(eligible), "auto_promote": False,
            "reason": "logloss and brier improved without ECE regression" if eligible
                      else "required proper-score improvements not satisfied",
            "metrics": values}


compare = compare_models
