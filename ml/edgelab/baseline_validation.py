"""Network-free validation for a first safe boat model baseline."""
from __future__ import annotations

import hashlib
import json
import math
import pickle
import random
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from edgelab.features.boat import BASE_FEATURE_COLUMNS
from edgelab.models.compare import compute_metrics, temporal_split
from edgelab.models.train import _race_softmax, _score, candidate_version
from edgelab.predict import load_artifact, predict_rows

POLICY_VERSION = "initial-baseline-v1"
MIN_HELDOUT_RACES = 400
MIN_HELDOUT_DAYS = 7
MAX_ECE = 0.05
MAX_SLICE_LOSS_REGRESSION = 0.25
BOOTSTRAP_SAMPLES = 2000
DEFAULT_MODEL_ID = "boat-win-lgbm-20261010-ee79bc87"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _canonical_json(value: Any) -> str:
    # Match JavaScript JSON.stringify number rendering used by the API's
    # canonical digest, while sorting object keys recursively.
    def canonical(item: Any) -> str:
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if isinstance(item, int):
            return str(item)
        if isinstance(item, float):
            if not math.isfinite(item):
                raise ValueError("non-finite number cannot be fingerprinted")
            if item == 0:
                return "0"
            rendered = repr(item)
            absolute = abs(item)
            if 1e-6 <= absolute < 1e21 and "e" in rendered.lower():
                mantissa, exponent = rendered.lower().split("e")
                sign = ""
                if mantissa.startswith("-"):
                    sign, mantissa = "-", mantissa[1:]
                digits = mantissa.replace(".", "")
                decimal_at = (mantissa.index(".") if "." in mantissa else len(mantissa)) + int(exponent)
                if decimal_at <= 0:
                    rendered = sign + "0." + "0" * -decimal_at + digits
                elif decimal_at >= len(digits):
                    rendered = sign + digits + "0" * (decimal_at - len(digits))
                else:
                    rendered = sign + digits[:decimal_at] + "." + digits[decimal_at:]
                return rendered
            if "e" in rendered.lower():
                mantissa, exponent = rendered.lower().split("e")
                exp = int(exponent)
                return f"{mantissa}e{'+' if exp >= 0 else ''}{exp}"
            return rendered[:-2] if rendered.endswith(".0") else rendered
        if isinstance(item, str):
            return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if isinstance(item, (list, tuple)):
            return "[" + ",".join(canonical(part) for part in item) + "]"
        if isinstance(item, Mapping):
            return "{" + ",".join(canonical(str(key)) + ":" + canonical(item[key])
                                    for key in sorted(item)) + "}"
        raise TypeError(f"unsupported fingerprint value: {type(item).__name__}")

    return canonical(value)


def _canonical_sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _race_scores(rows: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, float]]:
    grouped: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row["race_id"])].append(row)
    output = {}
    for race_id, group in grouped.items():
        winners = [r for r in group if bool(r.get("winner"))]
        if len(winners) != 1:
            continue
        probs = [float(r["probability"]) for r in group]
        winner = next(i for i, row in enumerate(group) if bool(row.get("winner")))
        output[race_id] = {
            "logLoss": -math.log(max(1e-15, probs[winner])),
            "brier": sum((prob - (i == winner)) ** 2 for i, prob in enumerate(probs)),
        }
    return output


def _mean_ci(values: Sequence[float], *, seed: int = 1701) -> list[float] | None:
    if len(values) < 2:
        return None
    rng = random.Random(seed)
    means = sorted(sum(rng.choices(values, k=len(values))) / len(values)
                   for _ in range(BOOTSTRAP_SAMPLES))
    return [means[int(.025 * (len(means) - 1))], means[int(.975 * (len(means) - 1))]]


def _date_cluster_ci(values: Mapping[str, float], dates: Mapping[str, str], *, seed: int = 1702) -> list[float] | None:
    grouped: dict[str, list[float]] = defaultdict(list)
    for race_id, value in values.items():
        grouped[dates[race_id]].append(value)
    keys = sorted(grouped)
    if len(keys) < 2:
        return None
    rng = random.Random(seed)
    estimates = []
    for _ in range(BOOTSTRAP_SAMPLES):
        sampled = rng.choices(keys, k=len(keys))
        sample = [value for key in sampled for value in grouped[key]]
        estimates.append(sum(sample) / len(sample))
    estimates.sort()
    return [estimates[int(.025 * (len(estimates) - 1))],
            estimates[int(.975 * (len(estimates) - 1))]]


def _metrics(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    return compute_metrics(rows)


def _lane_probabilities(train: Sequence[Mapping[str, Any]], race: Sequence[Mapping[str, Any]]) -> list[float]:
    appearances: dict[str, int] = defaultdict(int)
    wins: dict[str, int] = defaultdict(int)
    for row in train:
        lane = str(row.get("lane", row.get("number")))
        appearances[lane] += 1
        wins[lane] += int(bool(row.get("winner")))
    rates = {lane: wins[lane] / count for lane, count in appearances.items() if count}
    raw = [rates.get(str(row.get("lane", row.get("number"))), 0.0) for row in race]
    total = sum(raw)
    return [value / total for value in raw] if total > 0 else [1 / len(race)] * len(race)


def _probability_rows(race_id: str, race: Sequence[Mapping[str, Any]], artifact: Mapping[str, Any],
                      cutoff: str) -> list[dict[str, Any]]:
    # Reuse the production inference boundary and its feature/schema validation.
    predictions = predict_rows(race, artifact, predicted_at=cutoff, data_origin="real")
    if len(predictions) != len(race):
        raise ValueError(f"incomplete model prediction cohort for {race_id}")
    return [{**dict(row), "probability": float(pred["probability"]),
             "prob_std": float(pred["prob_std"])}
            for row, pred in zip(race, predictions)]


def _roi_replay(scored: Sequence[Mapping[str, Any]], store: Mapping[str, Sequence[Mapping[str, Any]]],
                cutoffs: Mapping[str, str]) -> dict[str, Any]:
    odds: dict[tuple[str, int], list[Mapping[str, Any]]] = defaultdict(list)
    for row in store.get("odds_snapshots", []):
        if row.get("data_origin") != "real" or row.get("bet_type") != "win":
            continue
        try:
            odds[(str(row["race_id"]), int(row["selection"]))].append(row)
        except (KeyError, TypeError, ValueError):
            continue
    payouts = {(str(row.get("race_id")), str(row.get("selection"))): row
               for row in store.get("payouts", [])
               if row.get("data_origin") == "real" and row.get("bet_type") == "win"}
    grouped: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in scored:
        grouped[str(row["race_id"])].append(row)
    skipped = defaultdict(int)
    race_returns: list[tuple[str, float, int]] = []
    for race_id, group in grouped.items():
        cutoff = datetime.fromisoformat(cutoffs[race_id].replace("Z", "+00:00"))
        odds_map = {}
        for row in group:
            number = int(row["number"])
            valid = []
            for odd in odds[(race_id, number)]:
                try:
                    captured = datetime.fromisoformat(str(odd["captured_at"]).replace("Z", "+00:00"))
                    value = float(odd["odds"])
                    if captured <= cutoff and value > 1 and math.isfinite(value):
                        valid.append((captured, value))
                except (KeyError, TypeError, ValueError):
                    continue
            if valid:
                odds_map[number] = max(valid, key=lambda item: item[0])[1]
        if len(odds_map) != len(group):
            skipped["missing_authentic_pre_race_odds"] += 1
            continue
        picks = [row for row in group if float(row["probability"]) * odds_map[int(row["number"])] - 1 > .05]
        if not picks:
            continue
        winner = next((row for row in group if bool(row.get("winner"))), None)
        payout = payouts.get((race_id, str(winner.get("number")))) if winner else None
        try:
            paid = float(payout["payout"]) if payout and payout.get("payout") is not None else None
        except (TypeError, ValueError):
            paid = None
        if paid is None or paid <= 0 or not math.isfinite(paid):
            skipped["missing_recorded_winner_payout"] += 1
            continue
        profit = sum((paid / 100 - 1) if bool(row.get("winner")) else -1 for row in picks)
        race_returns.append((race_id, profit, len(picks)))
    n_bets = sum(count for _, _, count in race_returns)
    total_profit = sum(profit for _, profit, _ in race_returns)
    race_roi = {rid: profit / count for rid, profit, count in race_returns}
    ci = _mean_ci(list(race_roi.values()), seed=1901)
    status = ("counterfactual_replay_unproven" if n_bets < 30 or not ci or ci[0] <= 0
              else "counterfactual_replay_positive_evidence_not_profitability_proof")
    return {"status": status, "basis": "retrospective frozen-model replay; authentic odds captured before race cutoff; not saved pre-race forecasts or real bets",
            "selectionRule": "probability * authentic pre-race odds - 1 > 0.05",
            "nBets": n_bets, "nRaces": len(race_returns),
            "empiricalROI": total_profit / n_bets if n_bets else None,
            "raceClusterConfidenceInterval95": ci, "skipped": dict(skipped)}


def validate_initial_baseline(store: Mapping[str, Sequence[Mapping[str, Any]]], *,
                              model_id: str = DEFAULT_MODEL_ID,
                              artifact_dir: str | Path = "ml/artifacts",
                              registry: Sequence[Mapping[str, Any]] | None = None,
                              valid_fraction: float = .15,
                              test_fraction: float = .15,
                              generated_at: str | None = None,
                              workflow_run_id: str | None = None) -> dict[str, Any]:
    """Evaluate an existing candidate without training, writing artifacts, or network access."""
    from edgelab.cli import _make_training_rows

    dest = Path(artifact_dir)
    json_path, pickle_path = dest / f"{model_id}.json", dest / f"{model_id}.pkl"
    report_time = generated_at or datetime.now(timezone.utc).isoformat()
    active_models: list[dict[str, Any]] = []
    registry_source = "unavailable"
    candidate_registry = None
    if registry is not None:
        registry_source = "authenticated_registry"
        for row in registry:
            if row.get("id") == model_id:
                candidate_registry = row
                continue
            if row.get("sport") != "boat" or row.get("bet_type") != "win":
                continue
            status = str(row.get("status") or "")
            compatibility = "unknown"
            active_json = dest / f"{row.get('id')}.json"
            active_pickle = dest / f"{row.get('id')}.pkl"
            if active_json.is_file() and active_pickle.is_file():
                try:
                    active_meta = json.loads(active_json.read_text(encoding="utf-8"))
                    active_artifact = load_artifact(active_pickle)
                    active_columns = active_meta.get("featureColumns") or []
                    active_pkl_meta = active_artifact.get("metadata") or {}
                    active_artifact_columns = list(active_artifact.get("feature_columns") or [])
                    stable_active_meta = {k: v for k, v in active_meta.items() if k != "metrics"}
                    stable_active_pkl_meta = {k: v for k, v in active_pkl_meta.items() if k != "metrics"}
                    if (active_meta.get("id") != row.get("id") or active_meta.get("sport") != "boat"
                            or not active_columns or any(c not in BASE_FEATURE_COLUMNS for c in active_columns)):
                        compatibility = "incompatible"
                    elif (stable_active_meta == stable_active_pkl_meta
                          and active_meta.get("version") == row.get("version")
                          and list(active_columns) == active_artifact_columns):
                        compatibility = "compatible"
                except (OSError, ValueError, TypeError):
                    compatibility = "unknown"
            active_models.append({"id": row.get("id"), "version": row.get("version"),
                                  "status": status,
                                  "metricsSha256": hashlib.sha256(
                                      (row.get("metrics_json") or "").encode("utf-8")).hexdigest(),
                                  "artifactCompatibility": compatibility})
        active_models.sort(key=lambda r: (str(r.get("id")), str(r.get("version")), str(r.get("status"))))
    active_snapshot = {"source": registry_source, "models": active_models,
                       "snapshotSha256": _canonical_sha256(active_models) if registry is not None else None}

    checks = {key: False for key in (
        "safeFeatureSchema", "realOnly", "completeFullRaceCohorts", "probabilitiesFiniteNormalized",
        "storedMetricsReproduced", "temporalSplitMatchesArtifact", "disjointRaceIds",
        "fitAndValidationPrecedeHoldout", "minHeldoutRaceCount", "minHeldoutDateCount",
        "pairedLogLossImprovement", "pairedBrierImprovement", "eceWithinThreshold",
        "pairedLogLossDateClusterImprovement", "pairedBrierDateClusterImprovement",
        "noGrossDateSliceReversal", "authenticatedRegistrySnapshot",
        "candidateRegisteredAsCandidate", "noCompatibleActiveModels",
    )}
    details: dict[str, Any] = {"policyVersion": POLICY_VERSION, "candidateModelId": model_id,
        "sport": "boat", "betType": "win", "dataOrigin": "real", "validatedAt": report_time,
        "status": "invalid", "thresholds": {"minHeldoutRaces": MIN_HELDOUT_RACES,
        "minHeldoutDays": MIN_HELDOUT_DAYS, "maxECE": MAX_ECE,
        "maxDateSliceLossRegression": MAX_SLICE_LOSS_REGRESSION,
        "pairedRaceBootstrapUpperBoundMustBeBelow": 0.0,
        "bootstrapSamples": BOOTSTRAP_SAMPLES}, "checks": checks,
        "activeModelSnapshot": active_snapshot,
        "workflowRunId": workflow_run_id,
        "candidateRegistryIdentity": ({"id": candidate_registry.get("id"),
            "version": candidate_registry.get("version"), "status": candidate_registry.get("status")}
            if candidate_registry else None),
        "sourceAvailability": "assumed_from_B_prerace_content_not_recorded",
        "historyFeatures": "not_observed_or_used",
        "limitations": ["B available_at is a synthesized race-day midnight, not a measured source publication timestamp.",
                        "Evaluation is a retrospective temporal holdout, not a saved pre-race prediction.",
                        "No comparison to legacy v1 is valid; that artifact has a known late-feature leakage path.",
                        "Historical replay is not actual virtual-bet settlement or real profitability evidence."]}
    try:
        if not json_path.is_file() or not pickle_path.is_file():
            raise FileNotFoundError("exact candidate JSON/pickle artifact pair is required")
        metadata = json.loads(json_path.read_text(encoding="utf-8"))
        artifact = load_artifact(pickle_path)
        pkl_meta = artifact.get("metadata") or {}
        columns = list(artifact.get("feature_columns") or [])
        metadata_columns = list(metadata.get("featureColumns") or [])
        details["artifact"] = {"version": metadata.get("version"), "jsonSha256": _sha256(json_path),
                                "pickleSha256": _sha256(pickle_path), "featureColumns": metadata_columns}
        stable_metadata = {k: v for k, v in metadata.items() if k != "metrics"}
        stable_pkl_metadata = {k: v for k, v in pkl_meta.items() if k != "metrics"}
        json_saved_metrics, pkl_saved_metrics = metadata.get("metrics") or {}, pkl_meta.get("metrics") or {}
        metric_identity = all(json_saved_metrics.get(k) == pkl_saved_metrics.get(k)
                              for k in ("logLoss", "brier", "ece"))
        if (metadata.get("id") != model_id or pkl_meta.get("id") != model_id
                or stable_metadata != stable_pkl_metadata or not metric_identity or columns != metadata_columns
                or metadata.get("sport") != "boat" or metadata.get("betType") != "win"
                or metadata.get("status") != "candidate"
                or metadata.get("version") != candidate_version(model_id)):
            raise ValueError("candidate identity, version, or JSON/pickle metadata do not match")
        checks["safeFeatureSchema"] = bool(columns) and all(c in BASE_FEATURE_COLUMNS for c in columns)
        if not checks["safeFeatureSchema"]:
            raise ValueError("candidate artifact uses a feature schema outside the approved boat base allowlist")
        rows = list(_make_training_rows(dict(store), "boat"))
        checks["realOnly"] = bool(rows) and all(row.get("data_origin") == "real" for row in rows)
        if not checks["realOnly"]:
            raise ValueError("no usable real-only training rows")
        train, valid, test = temporal_split(rows, valid_fraction=valid_fraction,
                                            test_fraction=test_fraction)
        dates = lambda values: sorted({str(row.get("race_date") or row.get("date"))[:10] for row in values
                                       if row.get("race_date") or row.get("date")})
        train_dates, valid_dates, test_dates = dates(train), dates(valid), dates(test)
        train_ids = {str(r["race_id"]) for r in train}
        valid_ids = {str(r["race_id"]) for r in valid}
        test_ids = {str(r["race_id"]) for r in test}
        expected_ranges = (metadata.get("trainFrom"), metadata.get("trainTo"),
                           metadata.get("validFrom"), metadata.get("validTo"),
                           metadata.get("testFrom"), metadata.get("testTo"))
        actual_ranges = (train_dates[0] if train_dates else None, train_dates[-1] if train_dates else None,
                         valid_dates[0] if valid_dates else None, valid_dates[-1] if valid_dates else None,
                         test_dates[0] if test_dates else None, test_dates[-1] if test_dates else None)
        ranges_match = expected_ranges == actual_ranges and len(train) == int(metadata.get("nTrain") or -1)
        details["temporal"] = {"trainFrom": actual_ranges[0], "trainTo": actual_ranges[1],
            "validFrom": actual_ranges[2], "validTo": actual_ranges[3],
            "testFrom": actual_ranges[4], "testTo": actual_ranges[5],
            "trainRaceCount": len(train_ids), "validRaceCount": len(valid_ids),
            "testRaceCount": len(test_ids), "disjointRaceIds": not (train_ids & valid_ids or train_ids & test_ids or valid_ids & test_ids),
            "fitAndValidationPrecedeHoldout": bool(valid_dates and test_dates and max(train_dates) < min(valid_dates) and max(valid_dates) < min(test_dates)),
            "splitMatchesArtifactMetadata": ranges_match}
        checks["temporalSplitMatchesArtifact"] = ranges_match
        checks["disjointRaceIds"] = details["temporal"]["disjointRaceIds"]
        checks["fitAndValidationPrecedeHoldout"] = details["temporal"]["fitAndValidationPrecedeHoldout"]
        details["cohort"] = {"raceCount": len(test_ids), "dayCount": len(test_dates),
            "from": test_dates[0] if test_dates else None, "to": test_dates[-1] if test_dates else None,
            "raceSetSha256": _canonical_sha256(sorted(test_ids)),
            "dataRowsSha256": _canonical_sha256(sorted((str(r["race_id"]), int(r["number"]),
                str(r.get("race_date")), bool(r.get("winner")),
                {c: r.get(c) for c in columns}) for r in rows))}
        test_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        train_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in test: test_groups[str(row["race_id"])].append(row)
        for row in train: train_groups[str(row["race_id"])].append(row)
        full = bool(test_groups) and all(len(group) == 6 and {int(r["number"]) for r in group} == set(range(1, 7))
            and sum(bool(r.get("winner")) for r in group) == 1 for group in test_groups.values())
        checks["completeFullRaceCohorts"] = full
        checks["minHeldoutRaceCount"] = len(test_ids) >= MIN_HELDOUT_RACES
        checks["minHeldoutDateCount"] = len(test_dates) >= MIN_HELDOUT_DAYS
        race_ids_disjoint = len(train_ids | valid_ids | test_ids) == len(train_ids) + len(valid_ids) + len(test_ids)
        checks["disjointRaceIds"] = race_ids_disjoint
        if not (ranges_match and full and race_ids_disjoint):
            raise ValueError("reconstructed train/validation/holdout cohorts do not satisfy artifact provenance")

        race_map = {str(r.get("id")): r for r in store.get("races", [])
                    if r.get("sport") == "boat" and r.get("data_origin") == "real"}
        actual_rows, baseline_rows, cutoffs = [], [], {}
        for race_id, group in sorted(test_groups.items()):
            race = race_map.get(race_id) or {}
            post = race.get("post_time")
            if not post:
                raise ValueError("holdout race is missing a trustworthy official post_time")
            post_dt = datetime.fromisoformat(str(post).replace("Z", "+00:00"))
            cutoff = (post_dt - timedelta(minutes=10)).isoformat()
            if any(datetime.fromisoformat(str(r["available_at"]).replace("Z", "+00:00")) > post_dt - timedelta(minutes=10)
                   for r in group if r.get("available_at")):
                raise ValueError("a holdout feature timestamp exceeds the conservative pre-race cutoff")
            cutoffs[race_id] = cutoff
            predicted = _probability_rows(race_id, group, artifact, cutoff)
            probs = [row["probability"] for row in predicted]
            stds = [row["prob_std"] for row in predicted]
            if (any(not math.isfinite(p) or p < 0 or p > 1 for p in probs)
                    or not math.isclose(sum(probs), 1.0, abs_tol=.02)
                    or any(not math.isfinite(s) or s < 0 for s in stds)):
                raise ValueError("candidate emitted a malformed probability/uncertainty cohort")
            actual_rows.extend(predicted)
            baseline_probs = _lane_probabilities(train, group)
            baseline_rows.extend({**dict(row), "probability": baseline_probs[i], "prob_std": 0.0}
                                 for i, row in enumerate(group))
        checks["probabilitiesFiniteNormalized"] = len(actual_rows) == len(test) and len(actual_rows) > 0
        candidate_metrics = _metrics(actual_rows)
        baseline_metrics = _metrics(baseline_rows)
        # Reproduce saved primary-estimator metrics as an integrity check. Production
        # predictions additionally average available race-bootstrap estimators.
        primary_rows = []
        primary_columns = columns
        primary_model = artifact.get("model")
        temp = float(artifact.get("temperature", metadata.get("temperature", 1.0)))
        for race_id, group in sorted(test_groups.items()):
            probs = _race_softmax(_score(primary_model, group, primary_columns), group, temp)
            primary_rows.extend({**dict(row), "probability": probs[i]} for i, row in enumerate(group))
        primary_metrics = _metrics(primary_rows)
        stored_metrics = metadata.get("metrics") or {}
        metric_agreement = all(stored_metrics.get(key) is not None and primary_metrics.get(key) is not None
            and abs(float(stored_metrics[key]) - float(primary_metrics[key])) <= 1e-6
            for key in ("logLoss", "brier", "ece"))
        checks["storedMetricsReproduced"] = metric_agreement
        candidate_scores, baseline_scores = _race_scores(actual_rows), _race_scores(baseline_rows)
        common = sorted(set(candidate_scores) & set(baseline_scores))
        ll_delta = {rid: candidate_scores[rid]["logLoss"] - baseline_scores[rid]["logLoss"] for rid in common}
        brier_delta = {rid: candidate_scores[rid]["brier"] - baseline_scores[rid]["brier"] for rid in common}
        date_of = {rid: str(test_groups[rid][0].get("race_date"))[:10] for rid in common}
        ll_ci, brier_ci = _mean_ci(list(ll_delta.values())), _mean_ci(list(brier_delta.values()), seed=1703)
        ll_date_ci = _date_cluster_ci(ll_delta, date_of)
        brier_date_ci = _date_cluster_ci(brier_delta, date_of, seed=1704)
        checks["pairedLogLossImprovement"] = bool(ll_ci and ll_ci[1] < 0)
        checks["pairedBrierImprovement"] = bool(brier_ci and brier_ci[1] < 0)
        checks["pairedLogLossDateClusterImprovement"] = bool(ll_date_ci and ll_date_ci[1] < 0)
        checks["pairedBrierDateClusterImprovement"] = bool(brier_date_ci and brier_date_ci[1] < 0)
        checks["eceWithinThreshold"] = candidate_metrics.get("ece") is not None and candidate_metrics["ece"] <= MAX_ECE
        by_week: dict[str, list[dict[str, Any]]] = defaultdict(list)
        from datetime import date
        for row in actual_rows:
            d = date.fromisoformat(str(row["race_date"])[:10])
            iso = d.isocalendar()
            by_week[f"{iso.year}-W{iso.week:02d}"].append(row)
        baseline_by_week: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in baseline_rows:
            d = date.fromisoformat(str(row["race_date"])[:10]); iso = d.isocalendar()
            baseline_by_week[f"{iso.year}-W{iso.week:02d}"].append(row)
        slices = []
        no_gross_reversal = True
        for period in sorted(by_week):
            m, b = _metrics(by_week[period]), _metrics(baseline_by_week[period])
            dll, db = float(m["logLoss"]) - float(b["logLoss"]), float(m["brier"]) - float(b["brier"])
            if dll > MAX_SLICE_LOSS_REGRESSION or db > MAX_SLICE_LOSS_REGRESSION:
                no_gross_reversal = False
            slices.append({"period": period, "raceCount": m["nRaces"], "logLoss": m["logLoss"],
                "brier": m["brier"], "ece": m["ece"], "deltaLogLossVsLane": dll,
                "deltaBrierVsLane": db})
        checks["noGrossDateSliceReversal"] = no_gross_reversal
        checks["authenticatedRegistrySnapshot"] = registry is not None
        checks["candidateRegisteredAsCandidate"] = bool(candidate_registry
            and candidate_registry.get("sport") == "boat" and candidate_registry.get("bet_type") == "win"
            and candidate_registry.get("status") == "candidate"
            and candidate_registry.get("version") == metadata.get("version"))
        classified = all(m["artifactCompatibility"] != "unknown" for m in active_models if m["status"] == "active")
        compatible_active = any(m["status"] == "active" and m["artifactCompatibility"] == "compatible"
                                for m in active_models)
        checks["noCompatibleActiveModels"] = registry is not None and classified and not compatible_active
        details.update(status="evaluated", candidateMetrics=candidate_metrics,
            laneBaselineMetrics=baseline_metrics,
            pairedComparison={"method": "paired bootstrap by race; separate date-cluster bootstrap",
                "raceCount": len(common), "logLossDelta": sum(ll_delta.values()) / len(common) if common else None,
                "logLossCI95": ll_ci, "brierDelta": sum(brier_delta.values()) / len(common) if common else None,
                "brierCI95": brier_ci, "dateClusterLogLossCI95": ll_date_ci,
                "dateClusterBrierCI95": brier_date_ci},
            dateSlices=slices, profitability=_roi_replay(actual_rows, store, cutoffs),
            activeModelSnapshot=active_snapshot)
        details["checks"] = checks
    except (OSError, ValueError, TypeError, KeyError, IndexError, pickle.UnpicklingError) as exc:
        details["failureReason"] = f"{type(exc).__name__}: {exc}"

    evidence_checks = ("safeFeatureSchema", "realOnly", "completeFullRaceCohorts",
        "probabilitiesFiniteNormalized", "storedMetricsReproduced", "temporalSplitMatchesArtifact",
        "disjointRaceIds", "fitAndValidationPrecedeHoldout", "minHeldoutRaceCount",
        "minHeldoutDateCount", "pairedLogLossImprovement", "pairedBrierImprovement",
        "pairedLogLossDateClusterImprovement", "pairedBrierDateClusterImprovement",
        "eceWithinThreshold", "noGrossDateSliceReversal")
    details["modelEvidenceEligible"] = all(checks[name] for name in evidence_checks)
    approval_checks = evidence_checks + ("authenticatedRegistrySnapshot",
        "candidateRegisteredAsCandidate", "noCompatibleActiveModels")
    eligible = all(checks[name] for name in approval_checks)
    details["initialBaselineEligible"] = eligible
    details["initialBaselineReason"] = (None if eligible else
        details.get("failureReason") or "; ".join(name for name in approval_checks if not checks[name]))
    fingerprint_payload = {k: v for k, v in details.items()
                           if k not in {"fingerprint", "validatedAt", "initialBaselineEligible", "initialBaselineReason"}}
    details["fingerprint"] = _canonical_sha256(fingerprint_payload)
    return details
