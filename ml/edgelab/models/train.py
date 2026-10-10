"""Leakage-aware LightGBM training for race winner probabilities.

Rows are mappings containing race_id, race_date, number, feature columns and
winner (or target). One observation per entry is expected; winner/target is a
boolean or 0/1. Artifacts are pickle-compatible and accompanied by JSON metadata.
"""
from __future__ import annotations

import hashlib
import json
import math
import pickle
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from .compare import bootstrap_std, compute_metrics, temporal_split
from edgelab.normalization.availability import available_by
from edgelab.features.boat import FEATURE_COLUMNS as BOAT_FEATURE_COLUMNS, RESULT_COLUMNS


def _target(row: Mapping[str, Any]) -> int:
    return int(bool(row.get("winner", row.get("target", False))))


def _features(rows: Sequence[Mapping[str, Any]], columns: Sequence[str]) -> list[list[float]]:
    matrix = []
    for row in rows:
        vals = []
        for column in columns:
            value = row.get(column)
            try:
                number = float(value)
                vals.append(number if math.isfinite(number) else float("nan"))
            except (TypeError, ValueError):
                vals.append(float("nan"))
        matrix.append(vals)
    return matrix


def _race_softmax(scores: Sequence[float], rows: Sequence[Mapping[str, Any]], temperature: float = 1.0) -> list[float]:
    groups: dict[str, list[int]] = {}
    for i, row in enumerate(rows):
        groups.setdefault(str(row["race_id"]), []).append(i)
    probs = [0.0] * len(rows)
    for indices in groups.values():
        scaled = [float(scores[i]) / max(.05, temperature) for i in indices]
        peak = max(scaled)
        exps = [math.exp(max(-700, min(0, value - peak))) for value in scaled]
        total = sum(exps)
        for i, value in zip(indices, exps):
            probs[i] = value / total
    return probs


def _score(model: Any, rows: Sequence[Mapping[str, Any]], columns: Sequence[str]) -> list[float]:
    matrix = _features(rows, columns)
    if hasattr(model, "predict"):
        try:
            raw = model.predict(matrix, raw_score=True)
            return [float(x) for x in raw]
        except (TypeError, ValueError):
            pred = model.predict_proba(matrix)
            return [math.log(max(1e-15, float(x[1])) / max(1e-15, float(x[0]))) for x in pred]
    return [0.0] * len(rows)


def _with_probabilities(rows: Sequence[Mapping[str, Any]], scores: Sequence[float], temp: float) -> list[dict[str, Any]]:
    probabilities = _race_softmax(scores, rows, temp)
    return [{**dict(row), "probability": probabilities[i]} for i, row in enumerate(rows)]


def _choose_temperature(rows: Sequence[Mapping[str, Any]], scores: Sequence[float]) -> float:
    """Choose a single race-wise temperature on validation races only."""
    if len({str(r.get("race_id")) for r in rows}) < 5:
        return 1.0
    candidates = [0.35, 0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0, 3.0]
    scored = [(compute_metrics(_with_probabilities(rows, scores, t))["logLoss"], t) for t in candidates]
    valid = [(loss, temp) for loss, temp in scored if loss is not None]
    return min(valid)[1] if valid else 1.0


def candidate_version(model_id: str) -> str:
    """Return a stable registry-unique version for an immutable candidate ID."""
    match = re.fullmatch(r".*-(\d{8})-([a-fA-F0-9]{8,64})", model_id)
    if match:
        return f"candidate-{match.group(1)}-{match.group(2).lower()}"
    digest = hashlib.sha256(model_id.encode("utf-8")).hexdigest()[:16]
    return f"candidate-{digest}"


def _untrained(model_id: str, model_path: Path, metadata_path: Path, reason: str,
               version: str = "v1",
               rows: Sequence[Mapping[str, Any]] = ()) -> dict[str, Any]:
    meta = {"id": model_id, "version": version, "algorithm": "lightgbm", "status": "untrained", "reason": reason,
            "nTrain": 0, "metrics": {"nRaces": 0, "logLossDefinition": "race_multiclass",
                                      "baselineLogLoss": None, "baselineUniformLogLoss": None},
            "trainedAt": datetime.now(timezone.utc).isoformat(),
            "featureColumns": [], "trainFrom": None, "trainTo": None, "validFrom": None,
            "validTo": None, "testFrom": None, "testTo": None}
    model_path.parent.mkdir(parents=True, exist_ok=True)
    with model_path.open("wb") as f:
        pickle.dump({"metadata": meta, "model": None, "bootstrap_models": []}, f)
    metadata_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


def _lane_baseline_log_loss(train: Sequence[Mapping[str, Any]],
                            test: Sequence[Mapping[str, Any]]) -> float | None:
    """Evaluate normalized empirical lane win rates learned from train only."""
    appearances: dict[str, int] = {}
    wins: dict[str, int] = {}
    for row in train:
        lane = row.get("lane", row.get("number"))
        if lane is None:
            continue
        key = str(lane)
        appearances[key] = appearances.get(key, 0) + 1
        wins[key] = wins.get(key, 0) + _target(row)
    rates = {lane: wins.get(lane, 0) / count for lane, count in appearances.items() if count}
    grouped: dict[str, list[Mapping[str, Any]]] = {}
    for row in test:
        grouped.setdefault(str(row["race_id"]), []).append(row)
    losses = []
    for group in grouped.values():
        winner_indices = [i for i, row in enumerate(group) if _target(row)]
        if len(winner_indices) != 1:
            continue
        raw = [rates.get(str(row.get("lane", row.get("number"))), 0.0) for row in group]
        total = sum(raw)
        probability = (raw[winner_indices[0]] / total if total > 0 else 1 / len(group))
        losses.append(-math.log(max(1e-15, probability)))
    return sum(losses) / len(losses) if losses else None


def _feature_columns(requested: Sequence[str] | None,
                     rows: Sequence[Mapping[str, Any]] = (), *, sport: str = "boat") -> list[str]:
    if sport == "horse":
        from edgelab.features.horse import FEATURE_COLUMNS
    else:
        FEATURE_COLUMNS = BOAT_FEATURE_COLUMNS
    columns = (sorted({key for row in rows for key in row if key in FEATURE_COLUMNS})
               if requested is None else list(requested))
    invalid = [column for column in columns if column in RESULT_COLUMNS or column not in FEATURE_COLUMNS]
    if invalid:
        raise ValueError(f"feature column(s) are not allowlisted or contain result data: {', '.join(invalid)}")
    return columns


def train_model(rows: Sequence[Mapping[str, Any]], *, model_id: str = "boat-win-lgbm-v1",
                sport: str = "boat", bet_type: str = "win", version: str = "v1",
                feature_columns: Sequence[str] | None = None,
                artifact_dir: str | Path = "ml/artifacts", min_train_races: int = 300,
                valid_fraction: float = .15, test_fraction: float = .15,
                boat_venue_schema_version: str | None = None,
                corrected_training_data_sha256: str | None = None,
                n_bootstrap: int = 4, seed: int = 17) -> dict[str, Any]:
    """Train chronological LightGBM classifier and write model.pkl + metadata.json.

    On insufficient/invalid data or an unusable LightGBM runtime, write an
    explicit untrained artifact rather than silently substituting a model.
    """
    dest = Path(artifact_dir)
    model_path, metadata_path = dest / f"{model_id}.pkl", dest / f"{model_id}.json"
    columns = _feature_columns(feature_columns, rows, sport=sport)
    # Enforce point-in-time availability when timestamp fields are supplied.
    clean = []
    for source in rows:
        row = dict(source)
        available = row.get("available_at")
        predicted = row.get("predicted_at")
        if predicted and not available_by(row, predicted):
            continue
        if row.get("race_id") is None or not ("winner" in row or "target" in row):
            continue
        clean.append(row)
    train, valid, test = temporal_split(clean, valid_fraction, test_fraction)
    train_races = {str(r["race_id"]) for r in train}
    if len(train_races) < min_train_races or not valid or not test:
        return _untrained(model_id, model_path, metadata_path,
                          f"insufficient_temporal_data: train_races={len(train_races)}, valid={len(valid)}, test={len(test)}",
                          version=version)
    if len({_target(r) for r in train}) < 2:
        return _untrained(model_id, model_path, metadata_path, "training data contains only one class", version=version)
    if not columns:
        return _untrained(model_id, model_path, metadata_path, "no numeric feature columns", version=version)
    try:
        import lightgbm as lgb
        # LightGBM can be installed but unusable on a host missing its runtime dependency.
        classifier = lgb.LGBMClassifier(objective="binary", n_estimators=300, learning_rate=.03,
            num_leaves=15, max_depth=-1, min_child_samples=20, reg_lambda=1.0,
            random_state=seed, verbosity=-1, n_jobs=1)
        classifier.fit(_features(train, columns), [_target(r) for r in train])
    except Exception as exc:
        return _untrained(model_id, model_path, metadata_path,
                          f"lightgbm_unavailable_or_fit_failed: {type(exc).__name__}: {exc}", version=version)

    valid_scores = _score(classifier, valid, columns)
    temperature = _choose_temperature(valid, valid_scores)
    test_pred = _with_probabilities(test, _score(classifier, test, columns), temperature)
    metrics = compute_metrics(test_pred)
    metrics["baselineUniformLogLoss"] = metrics.get("baselineLogLoss")
    metrics["baselineLogLoss"] = (_lane_baseline_log_loss(train, test)
                                  if sport == "boat" else metrics.get("baselineUniformLogLoss"))
    metrics["logLossDefinition"] = "race_multiclass"
    # Betting metrics are reported only if held-out odds exist; do not infer
    # losing runners' odds from the winner's payout.
    candidates = [r for r in test_pred if r.get("odds") is not None
                  and float(r.get("probability", 0)) * float(r["odds"]) - 1 > .05]
    if candidates:
        stakes = 100 * len(candidates)
        paid = sum(float(r.get("payout", r.get("final_payout", 0)) or 0)
                   for r in candidates if _target(r))
        metrics["roi"] = paid / stakes
        metrics["expectedRoi"] = sum(float(r["probability"]) * float(r["odds"]) - 1
                                      for r in candidates) / len(candidates)
        equity = peak = drawdown = 0.0
        for row in sorted(candidates, key=lambda r: (str(r.get("race_date", "")), str(r.get("race_id", "")))):
            equity += (float(row.get("payout", row.get("final_payout", 0)) or 0) - 100) if _target(row) else -100
            peak = max(peak, equity)
            drawdown = max(drawdown, peak - equity)
        metrics["maxDrawdown"] = drawdown
    else:
        metrics["roi"] = None
        metrics["expectedRoi"] = None
        metrics["maxDrawdown"] = None
    race_losses = []
    by_race: dict[str, list[dict[str, Any]]] = {}
    for row in test_pred:
        by_race.setdefault(str(row["race_id"]), []).append(row)
    for group in by_race.values():
        m = compute_metrics(group)
        if m["logLoss"] is not None:
            race_losses.append(float(m["logLoss"]))
    metrics["logLossStd"] = bootstrap_std(race_losses, seed=seed)
    # Independent race-resampled LightGBM models provide per-runner prediction spread.
    # If data is too small or a replicate is invalid, keep the primary model only.
    bootstrap_models = []
    race_groups: dict[str, list[dict[str, Any]]] = {}
    for row in train:
        race_groups.setdefault(str(row["race_id"]), []).append(row)
    import random
    rng = random.Random(seed)
    race_ids = list(race_groups)
    # Primary fit plus four independent race-bootstrap fits = five estimators.
    for i in range(max(0, min(int(n_bootstrap), 4))):
        sampled_ids = [rng.choice(race_ids) for _ in race_ids]
        sample = [r for rid in sampled_ids for r in race_groups[rid]]
        if len({_target(r) for r in sample}) < 2:
            continue
        try:
            replica = lgb.LGBMClassifier(objective="binary", n_estimators=220, learning_rate=.03,
                num_leaves=15, min_child_samples=20, reg_lambda=1.0,
                random_state=seed + i + 1, verbosity=-1, n_jobs=1)
            replica.fit(_features(sample, columns), [_target(r) for r in sample])
            bootstrap_models.append(replica)
        except Exception:
            continue
    dates = lambda values: sorted(str(r.get("race_date") or r.get("date")) for r in values if r.get("race_date") or r.get("date"))
    meta = {"id": model_id, "sport": sport, "betType": bet_type, "version": version,
        "algorithm": "LightGBM binary classifier + per-race softmax", "status": "candidate",
        "trainFrom": min(dates(train)) if dates(train) else None, "trainTo": max(dates(train)) if dates(train) else None,
        "validFrom": min(dates(valid)) if dates(valid) else None, "validTo": max(dates(valid)) if dates(valid) else None,
        "testFrom": min(dates(test)) if dates(test) else None, "testTo": max(dates(test)) if dates(test) else None,
        "nTrain": len(train), "nTrainRaces": len(train_races), "temperature": temperature,
        "calibration": "validation race-wise temperature scaling", "metrics": metrics,
        "trainedAt": datetime.now(timezone.utc).isoformat(), "featureColumns": columns,
        "nBootstrapModels": len(bootstrap_models), "notes": "prob_std is standard deviation across race-bootstrap models"}
    if sport == "boat" and boat_venue_schema_version:
        if (not corrected_training_data_sha256 or len(corrected_training_data_sha256) != 64
                or any(char not in "0123456789abcdef" for char in corrected_training_data_sha256)):
            raise ValueError("boat venue schema marker requires a lowercase SHA256 of the corrected source snapshot")
        meta["boatVenueSchemaVersion"] = boat_venue_schema_version
        meta["correctedTrainingDataSha256"] = corrected_training_data_sha256
    artifact = {"metadata": meta, "model": classifier, "bootstrap_models": bootstrap_models,
                "feature_columns": columns, "temperature": temperature}
    dest.mkdir(parents=True, exist_ok=True)
    with model_path.open("wb") as f:
        pickle.dump(artifact, f, protocol=pickle.HIGHEST_PROTOCOL)
    metadata_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    return meta


train = train_model
