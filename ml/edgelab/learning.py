"""Replay-safe feedback scoring and guarded local candidate learning."""
from __future__ import annotations

import json
import math
import random
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from edgelab.models.compare import compute_metrics, temporal_split
from edgelab.models.train import _features, _race_softmax, _score, train_model
from edgelab.predict import load_artifact

FEEDBACK_PATH = Path("ml/data/learning/feedback.json")
LEARNING_STATE = Path("ml/data/learning/state.json")
REPORT_PATH = Path("ml/data/learning/report.json")
MIN_NEW_RACES = 30
MIN_COMPLETE_RACES = 400


def _atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     delete=False) as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
        temp = Path(stream.name)
    temp.replace(path)


def _timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _race_cohorts(store: Mapping[str, Sequence[Mapping[str, Any]]]) -> dict[str, dict[str, Any]]:
    races = {str(r.get("id")): r for r in store.get("races", [])
             if r.get("sport") == "boat" and r.get("data_origin") == "real"}
    entries: dict[str, dict[int, Mapping[str, Any]]] = defaultdict(dict)
    results: dict[str, dict[int, Mapping[str, Any]]] = defaultdict(dict)
    for row in store.get("entries", []):
        if row.get("data_origin") == "real":
            try: entries[str(row["race_id"])][int(row["number"])] = row
            except (KeyError, TypeError, ValueError): pass
    for row in store.get("results", []):
        if row.get("data_origin") == "real":
            try: results[str(row["race_id"])][int(row["number"])] = row
            except (KeyError, TypeError, ValueError): pass
    cohorts = {}
    for race_id, race in races.items():
        field, outcome = entries.get(race_id, {}), results.get(race_id, {})
        post_time = _timestamp(race.get("post_time"))
        finish = [r.get("finish_order") for r in outcome.values()]
        if (not field or set(field) != set(outcome) or len(finish) != len(field)
                or any(value is None for value in finish)
                or len({str(value) for value in finish}) != len(finish)
                or sum(1 for value in finish if str(value) == "1") != 1 or not post_time
                or race.get("status") != "finished"):
            continue
        cohorts[race_id] = {"race": race, "entries": field, "results": outcome,
                            "post_time": post_time}
    return cohorts


def score_feedback(store: Mapping[str, Sequence[Mapping[str, Any]]], *,
                   report_path: str | Path = REPORT_PATH,
                   feedback_path: str | Path = FEEDBACK_PATH,
                   artifact_dir: str | Path = "ml/artifacts") -> dict[str, Any]:
    """Score complete real prediction cohorts; never label a single loss a mistake."""
    cohorts = _race_cohorts(store)
    predictions: dict[str, dict[str, list[Mapping[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for p in store.get("predictions", []):
        if p.get("data_origin") != "real" or p.get("probability") is None:
            continue
        try: predictions[str(p.get("model_id"))][str(p["race_id"])].append(p)
        except (KeyError, TypeError, ValueError): pass
    model_reports, scored = {}, {}
    from edgelab.features.boat import BASE_FEATURE_COLUMNS
    for model_id, by_race in predictions.items():
        metadata_path = Path(artifact_dir) / f"{model_id}.json"
        try:
            model_meta = json.loads(metadata_path.read_text(encoding="utf-8"))
            feature_columns = model_meta.get("featureColumns") or []
            schema_safe = bool(feature_columns) and all(c in BASE_FEATURE_COLUMNS for c in feature_columns)
            model_trained_at = _timestamp(model_meta.get("trainedAt"))
            train_to = str(model_meta.get("trainTo") or "")[:10]
            valid_to = str(model_meta.get("validTo") or "")[:10]
            temporal_provenance_safe = bool(model_trained_at and train_to and valid_to)
        except (OSError, ValueError, TypeError):
            schema_safe = False
            model_trained_at, train_to, valid_to, temporal_provenance_safe = None, "", "", False
        if not schema_safe or not temporal_provenance_safe:
            exclusion = ("excluded_unverified_or_legacy_feature_schema" if not schema_safe
                         else "excluded_unverified_temporal_model_provenance")
            model_reports[model_id] = {"completeRaces": 0, "status": exclusion,
                                       "roi": {"status": "unproven_model_provenance", "nBets": 0,
                                               "empiricalROI": None, "confidenceInterval95": None}}
            continue
        evaluated, error_rows, selected = [], [], []
        rejected = defaultdict(int)
        for race_id, cohort in cohorts.items():
            snapshots: dict[str, dict[int, Mapping[str, Any]]] = defaultdict(dict)
            for p in by_race.get(race_id, []):
                try: snapshots[str(p.get("predicted_at"))][int(p["number"])] = p
                except (KeyError, TypeError, ValueError): continue
            field = cohort["entries"]
            race_date = str(cohort["race"].get("race_date") or "")[:10]
            choices = []
            provenance_rejected = False
            for raw_time, snapshot in snapshots.items():
                timestamp = _timestamp(raw_time)
                if (timestamp and snapshot and timestamp >= model_trained_at):
                    # Fits and calibration outcomes through validTo are in-sample,
                    # even when a prediction row was later backfilled.
                    if not race_date or train_to >= race_date or valid_to >= race_date:
                        provenance_rejected = True
                        continue
                elif timestamp and snapshot:
                    provenance_rejected = True
                    continue
                if (timestamp and timestamp < cohort["post_time"] and set(snapshot) == set(field)
                        and all(_timestamp(field[n].get("available_at"))
                                and _timestamp(field[n].get("available_at")) <= timestamp for n in field)):
                    choices.append((timestamp, snapshot))
            if not choices:
                if provenance_rejected:
                    rejected["prediction_not_out_of_sample_for_artifact"] += 1
                elif snapshots and any(set(snapshot) == set(field) for snapshot in snapshots.values()):
                    rejected["untrustworthy_or_late_prediction_time"] += 1
                else:
                    rejected["incomplete_prediction_cohort"] += 1
                continue
            timestamp, pred = max(choices, key=lambda item: item[0])
            if not pred:
                rejected["incomplete_prediction_cohort"] += 1; continue
            actual = [int(str(cohort["results"][n]["finish_order"]) == "1") for n in field]
            rows = [{"race_id": race_id, "number": n, "winner": bool(actual[i]),
                     "probability": float(pred[n]["probability"])} for i, n in enumerate(field)]
            # Reject malformed probability vectors rather than silently repairing evidence.
            if (any(not math.isfinite(r["probability"]) or r["probability"] < 0 for r in rows)
                    or not math.isclose(sum(r["probability"] for r in rows), 1.0, abs_tol=.02)):
                rejected["invalid_probability_cohort"] += 1; continue
            evaluated.extend(rows)
            winner = next(n for i, n in enumerate(field) if actual[i])
            ranking = sorted(rows, key=lambda r: r["probability"], reverse=True)
            error_rows.append({"race_id": race_id, "winner": winner,
                               "top_pick": ranking[0]["number"],
                               "winner_probability": pred[winner]["probability"],
                               "top_probability": ranking[0]["probability"],
                               "prediction_timestamp": next(iter(pred.values())).get("predicted_at"),
                               "top_pick_missed": ranking[0]["number"] != winner})
            for n in field:
                p = pred[n]
                scored[f"{race_id}|{model_id}|{n}|{p.get('predicted_at')}"] = {
                    "race_id": race_id, "model_id": model_id, "number": n,
                    "predicted_at": p.get("predicted_at"), "winner": bool(actual[list(field).index(n)]),
                    "probability": p["probability"], "feedback_version": 1}
        metrics = compute_metrics(evaluated)
        # ROI uses only captured pre-prediction odds and recorded winner payout.
        odds_by_runner: dict[tuple[str, int], list[Mapping[str, Any]]] = defaultdict(list)
        for odd in store.get("odds_snapshots", []):
            if odd.get("data_origin") != "real" or odd.get("bet_type") != "win": continue
            try: odds_by_runner[(str(odd["race_id"]), int(odd["selection"]))].append(odd)
            except (KeyError, TypeError, ValueError): pass
        payouts = {(str(p.get("race_id")), str(p.get("selection"))): p
                   for p in store.get("payouts", []) if p.get("data_origin") == "real" and p.get("bet_type") == "win"}
        roi_records, roi_skips = [], defaultdict(int)
        for race_error in error_rows:
            race_id = race_error["race_id"]
            snapshots = defaultdict(dict)
            for p in by_race[race_id]:
                try: snapshots[str(p.get("predicted_at"))][int(p["number"])] = p
                except (KeyError, TypeError, ValueError): continue
            pmap = snapshots[str(race_error["prediction_timestamp"])]
            cohort = cohorts[race_id]
            timestamp = _timestamp(next(iter(pmap.values())).get("predicted_at"))
            race_odds = {}
            for n in cohort["entries"]:
                available = [o for o in odds_by_runner[(race_id, n)]
                             if _timestamp(o.get("captured_at")) and _timestamp(o.get("captured_at")) <= timestamp]
                if available:
                    latest = max(available, key=lambda o: _timestamp(o.get("captured_at")))
                    try:
                        value = float(latest["odds"])
                        if value > 1 and math.isfinite(value): race_odds[n] = value
                    except (KeyError, TypeError, ValueError): pass
            if len(race_odds) != len(cohort["entries"]):
                roi_skips["missing_pre_prediction_odds_cohort"] += 1; continue
            pick_ids = [n for n in race_odds if float(pmap[n]["probability"]) * race_odds[n] - 1 > .05]
            if not pick_ids: continue
            winner = race_error["winner"]
            payout = payouts.get((race_id, str(winner)))
            if payout is None or payout.get("payout") is None:
                roi_skips["missing_recorded_winner_payout"] += 1; continue
            try: paid = float(payout["payout"])
            except (TypeError, ValueError):
                roi_skips["invalid_recorded_winner_payout"] += 1; continue
            if not math.isfinite(paid) or paid <= 0:
                roi_skips["invalid_recorded_winner_payout"] += 1; continue
            profit = sum((paid / 100 - 1) if n == winner else -1.0 for n in pick_ids)
            roi_records.append((profit, len(pick_ids)))
        n_bets = sum(count for _, count in roi_records)
        roi = (sum(profit for profit, _ in roi_records) / n_bets) if n_bets else None
        ci = _bootstrap_roi_ci(roi_records) if roi_records else None
        readiness = ("unproven_insufficient_real_bets" if n_bets < 30 else
                     "empirical_positive_with_uncertainty" if ci and ci[0] > 0 else
                     "not_evidenced_positive" )
        bins = []
        for index in range(10):
            bucket = [r for r in evaluated if min(9, int(float(r["probability"]) * 10)) == index]
            bins.append({"range": f"{index / 10:.1f}-{(index + 1) / 10:.1f}", "n": len(bucket),
                         "meanPredicted": (sum(float(r["probability"]) for r in bucket) / len(bucket) if bucket else None),
                         "observedWinRate": (sum(bool(r["winner"]) for r in bucket) / len(bucket) if bucket else None)})
        model_reports[model_id] = {"metrics": metrics, "completeRaces": metrics["nRaces"],
            "calibrationBins": bins,
            "top_pick_miss_rate": (sum(e["top_pick_missed"] for e in error_rows) / len(error_rows) if error_rows else None),
            "missed_winner_count": sum(e["top_pick_missed"] for e in error_rows),
            "low_winner_probability_count": sum(float(e["winner_probability"]) < .10 for e in error_rows),
            "roi": {"status": readiness, "threshold": "probability * authentic pre-prediction odds - 1 > 0.05",
                    "basis": "counterfactual replay; not production auto-bet profitability",
                    "nBets": n_bets, "empiricalROI": roi, "confidenceInterval95": ci,
                    "skipped": dict(roi_skips)}, "rejected": dict(rejected)}
    state = {"version": 1, "scored": scored, "updatedAt": datetime.now(timezone.utc).isoformat()}
    report = {"version": 1, "generatedAt": state["updatedAt"], "source": "local real-data store only",
              "models": model_reports, "limitations": ["A missed top pick or lost bet is not by itself a model mistake.",
                  "ROI is empirical only for complete cohorts with pre-prediction odds and recorded winner payout.",
                  "ROI is counterfactual replay, not actual bet settlement or production auto-bet profitability.",
                  "The offline feedback command does not determine authoritative remote active status."]}
    _atomic_json(Path(feedback_path), state)
    _atomic_json(Path(report_path), report)
    return report


def _bootstrap_roi_ci(records: Sequence[tuple[float, int]], *, seed: int = 17,
                      samples: int = 1000) -> list[float] | None:
    """Cluster bootstrap by race to retain within-race bet correlation."""
    if len(records) < 2: return None
    rng = random.Random(seed)
    estimates = []
    for _ in range(samples):
        sample = rng.choices(records, k=len(records))
        bets = sum(count for _, count in sample)
        estimates.append(sum(profit for profit, _ in sample) / bets if bets else 0.0)
    estimates.sort()
    return [estimates[int(.025 * (samples - 1))], estimates[int(.975 * (samples - 1))]]


def guarded_candidate(store: dict[str, Any], training_rows: Sequence[Mapping[str, Any]], *,
                      model_id: str, authoritative_model_ids: set[str] | None = None,
                      min_new_races: int = MIN_NEW_RACES) -> dict[str, Any]:
    """Train a uniquely named candidate after enough new real outcomes.

    Candidate and eligible local incumbent are evaluated on the same latest
    temporal test partition. The partition is not used for either fit or
    temperature calibration, and this function never promotes a model.
    """
    from edgelab.models.compare import compare_models, temporal_split
    if not training_rows:
        return {"status": "skipped", "reason": "no complete real outcome cohorts"}
    _, _, holdout = temporal_split(training_rows)
    if not holdout:
        return {"status": "skipped", "reason": "insufficient temporal dates for untouched holdout"}
    state_path = LEARNING_STATE
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    complete_ids = sorted({str(r["race_id"]) for r in training_rows})
    if len(complete_ids) < MIN_COMPLETE_RACES:
        return {"status": "skipped", "reason": "insufficient total complete real races",
                "completeRaces": len(complete_ids), "required": MIN_COMPLETE_RACES}
    new_ids = sorted(set(complete_ids) - set(state.get("trainedRaceIds", [])))
    if len(new_ids) < min_new_races:
        return {"status": "skipped", "reason": "not enough new completed real races",
                "newRaces": len(new_ids), "required": min_new_races}
    if authoritative_model_ids is not None and model_id in authoritative_model_ids:
        return {"status": "existing_registered_id", "modelId": model_id,
                "evaluatedRaceIds": complete_ids,
                "reason": "refusing to overwrite artifact for a model already present in registry"}
    holdout_start = min(str(r.get("race_date") or r.get("date")) for r in holdout)
    result = train_model(training_rows, sport="boat", model_id=model_id)
    output: dict[str, Any] = {"status": result.get("status"), "modelId": model_id,
                              "newRaces": len(new_ids), "holdoutStart": holdout_start,
                              "holdoutEnd": max(str(r.get("race_date") or r.get("date")) for r in holdout),
                              "candidateMetrics": None, "comparison": None,
                              "promotion": "manual only"}
    if result.get("status") != "candidate":
        output["reason"] = result.get("reason", "candidate training failed closed")
        return output
    candidate_path = Path("ml/artifacts") / f"{model_id}.pkl"
    candidate = load_artifact(candidate_path)
    columns = list(candidate.get("feature_columns") or [])
    if result.get("validTo") and str(result["validTo"]) >= holdout_start:
        output.update(status="rejected", reason="candidate validation overlaps untouched holdout")
        return output
    test_rows = [dict(r) for r in holdout]
    for row in test_rows: row["predicted_at"] = row.get("predicted_at") or row.get("post_time")
    candidate_scores = _score(candidate["model"], test_rows, columns)
    candidate_pred = [{**r, "probability": p} for r, p in zip(test_rows, _race_softmax(candidate_scores, test_rows, float(candidate.get("temperature", 1.0))))]
    candidate_metrics = compute_metrics(candidate_pred)
    output["candidateMetrics"] = candidate_metrics
    # Only compare artifacts from this local cache; remote active state is not visible here.
    eligible = []
    for row in store.get("models", []):
        if (row.get("sport") != "boat" or row.get("id") == model_id
                or row.get("status") != "active"
                or (authoritative_model_ids is not None and str(row.get("id")) not in authoritative_model_ids)):
            continue
        path = Path("ml/artifacts") / f"{row.get('id')}.pkl"
        if not path.is_file(): continue
        try: incumbent = load_artifact(path)
        except (OSError, ValueError, EOFError): continue
        meta = incumbent.get("metadata") or {}
        if (not meta.get("trainTo") or not meta.get("validTo")
                or str(meta["trainTo"]) >= holdout_start or str(meta["validTo"]) >= holdout_start):
            continue
        old_columns = list(incumbent.get("feature_columns") or meta.get("featureColumns") or [])
        if not old_columns or any(c not in {"lane", "national_win_rate", "local_win_rate", "motor_2rate", "boat_2rate", "national_2rate", "local_2rate", "age", "weight_carried", "racer_class_code", "history_starts", "history_wins", "history_win_rate"} for c in old_columns):
            continue  # legacy/later-info artifacts are not trusted as comparison baselines
        old_scores = _score(incumbent["model"], test_rows, old_columns)
        old_pred = [{**r, "probability": p} for r, p in zip(test_rows, _race_softmax(old_scores, test_rows, float(incumbent.get("temperature", 1.0))))]
        eligible.append((str(meta.get("trainedAt") or ""), row.get("id"), compute_metrics(old_pred)))
    if eligible:
        _, incumbent_id, incumbent_metrics = max(eligible)
        output["localIncumbentId"] = incumbent_id
        output["comparison"] = compare_models({"metrics": incumbent_metrics}, {"metrics": candidate_metrics})
    else:
        output["comparison"] = {"candidate": False, "reason": "no eligible pre-holdout clean local incumbent"}
    output["promotionEligible"] = bool(output["comparison"].get("candidate"))
    output["promotionReason"] = (None if output["promotionEligible"] else
                                 output["comparison"].get("reason", "no eligible incumbent"))
    output["limitations"] = ["Only the authenticated remote active registry row with a compatible local artifact was considered.",
                             "Candidate evaluation is not a promotion and does not prove profitability."]
    output["evaluatedRaceIds"] = complete_ids
    return output

