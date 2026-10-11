"""Command-line entry point for collection, training, prediction and sync."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pickle
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Any

from edgelab.storage import DEFAULT_STORE, load_rows, merge_rows, save_rows


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _inference_timestamp() -> str:
    """Capture the real as-of time after collection, never reuse the run start."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _coerce_dt(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def _primary_prediction_as_of(betting_cutoff_at: str) -> str:
    """Use the primary T-60 input boundary, never the final betting deadline."""
    parsed = datetime.fromisoformat(betting_cutoff_at.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("official betting cutoff must include a timezone")
    return (parsed - timedelta(seconds=60)).isoformat(timespec="seconds")


def _apply_model_registry(rows: dict[str, Any], registry: list[dict[str, Any]]) -> set[str]:
    """Replace cached lifecycle claims with the authenticated registry snapshot."""
    remote = {str(model.get("id")): model for model in registry if model.get("id")}
    # Keep only locally-created candidates absent from the registry; never retain
    # a stale cached active/retired claim as authoritative state.
    local_candidates = [model for model in rows.get("models", [])
                        if model.get("status") in {"candidate", "untrained"}
                        and str(model.get("id")) not in remote]
    rows["models"] = [*local_candidates, *remote.values()]
    return set(remote)


def _safe_boat_schema_version(model_id: str, artifact_dir: Path = Path("ml/artifacts")) -> str | None:
    """Return the runtime feature marker only for a matching, safe JSON/pickle pair."""
    try:
        from edgelab.features.boat import BASE_FEATURE_COLUMNS
        from edgelab.predict import load_artifact
        json_meta = json.loads((artifact_dir / f"{model_id}.json").read_text(encoding="utf-8"))
        artifact = load_artifact(artifact_dir / f"{model_id}.pkl")
        pkl_meta = artifact.get("metadata") or {}
        columns = list(artifact.get("feature_columns") or [])
        saved_columns = list(json_meta.get("featureColumns") or [])
        stable_json = {k: v for k, v in json_meta.items() if k != "metrics"}
        stable_pkl = {k: v for k, v in pkl_meta.items() if k != "metrics"}
        json_metrics, pkl_metrics = json_meta.get("metrics") or {}, pkl_meta.get("metrics") or {}
        metrics_match = all(json_metrics.get(k) == pkl_metrics.get(k)
                            for k in ("logLoss", "brier", "ece"))
        return ("boat-base-v1" if json_meta.get("id") == model_id
                and pkl_meta.get("id") == model_id and stable_json == stable_pkl
                and metrics_match
                and columns == saved_columns and columns
                and all(column in BASE_FEATURE_COLUMNS for column in columns)
                and artifact.get("model") is not None and json_meta.get("status") == "candidate"
                else None)
    except (OSError, ValueError, TypeError, KeyError, pickle.UnpicklingError, EOFError):
        return None


def _verify_runtime_artifact(model_row: dict[str, Any], artifact_path: Path) -> None:
    """Fail closed unless registry evidence binds the safe schema to these exact bytes."""
    try:
        metrics = model_row.get("metrics")
        if not isinstance(metrics, dict):
            metrics = json.loads(model_row.get("metrics_json") or "{}")
        expected = metrics.get("boatArtifactSha256")
        source_digest = metrics.get("correctedTrainingDataSha256")
        if (metrics.get("boatFeatureSchemaVersion") != "boat-base-v1" or not expected
                or metrics.get("boatVenueSchemaVersion") != "boat-venue-v2"
                or not isinstance(source_digest, str) or len(source_digest) != 64
                or any(char not in "0123456789abcdef" for char in source_digest)):
            raise RuntimeError("active boat model lacks verified safe-schema/artifact identity metadata")
        actual = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError("active boat model artifact bytes do not match the registry-approved SHA256")
        from edgelab.predict import load_artifact
        sidecar_path = artifact_path.with_suffix(".json")
        sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        artifact = load_artifact(artifact_path)
        pickle_metadata = artifact.get("metadata") or {}
        for metadata in (sidecar, pickle_metadata):
            if (metadata.get("boatVenueSchemaVersion") != "boat-venue-v2"
                    or metadata.get("correctedTrainingDataSha256") != source_digest
                    or sidecar.get("id") != model_row.get("id")
                    or pickle_metadata.get("id") != model_row.get("id")):
                raise RuntimeError("active boat artifact metadata does not match venue-v2 registry provenance")
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        raise RuntimeError("active boat model has invalid safe-schema/artifact identity metadata") from exc


def _date_range(start: str, end: str):
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    if first > last:
        raise ValueError("--from must be on or before --to")
    current = first
    while current <= last:
        yield current
        current += timedelta(days=1)


def _predict_boat_date(rows: dict[str, list[dict[str, Any]]], day: str, cutoff: str,
                       artifact_dir: Path = Path("ml/artifacts")) -> list[dict[str, Any]]:
    """Predict one boat day with the selected persisted model; fail closed without artifacts."""
    from edgelab.features.boat import build_boat_features
    from edgelab.predict import load_artifact, predict_rows
    models = [m for m in rows.get("models", []) if m.get("sport") == "boat"]
    selected = next((m for m in models if m.get("status") == "active"), None)
    if selected is None:
        raise RuntimeError("no active model in authoritative local registry; candidate models are evaluation-only")
    model_id = str(selected["id"])
    artifact = artifact_dir / f"{model_id}.pkl"
    if not artifact.is_file():
        raise FileNotFoundError(f"model artifact not found: {artifact}; restore ml/artifacts cache or run train first")
    _verify_runtime_artifact(selected, artifact)
    race_map = {r["id"]: r for r in rows.get("races", [])
                if r.get("sport") == "boat" and r.get("race_date") == day
                and r.get("data_origin") == "real"}
    grouped: dict[str, list[dict[str, Any]]] = {}
    cutoff_dt = _coerce_dt(cutoff)
    for entry in rows.get("entries", []):
        rid = entry.get("race_id")
        race = race_map.get(rid)
        post_time = _coerce_dt(str(race["post_time"])) if race and race.get("post_time") else None
        if (race and entry.get("data_origin") == "real"
                and race.get("status") not in {"finished", "closed", "cancelled"}
                and post_time and post_time > cutoff_dt):
            grouped.setdefault(str(rid), []).append(dict(entry))
    from edgelab.features.boat import FEATURE_COLUMNS
    entries = [{**{k: v for k, v in entry.items() if k not in FEATURE_COLUMNS}, **feature}
               for rid, group in grouped.items()
               for entry, feature in zip(group, build_boat_features(group, race_date=day, predicted_at=cutoff))]
    predictions = predict_rows(entries, load_artifact(artifact), predicted_at=cutoff)
    # Deterministic natural keys make reruns idempotent.
    for row in predictions:
        row["predicted_at"] = cutoff
        row["id"] = f"{row['race_id']}:{row['model_id']}:{row['number']}:{cutoff}"
    merge_rows(rows, {"predictions": predictions})
    return predictions


def _predict_boat_trifecta_date(rows: dict[str, list[dict[str, Any]]], day: str, generated_at: str,
                                artifact_dir: Path = Path("ml/artifacts")) -> list[dict[str, Any]]:
    """Use exactly one authoritative active v2 trifecta artifact; never fall back to win."""
    from edgelab.features.boat import PRERACE_V2_SCHEMA
    from edgelab.models.trifecta import active_ticket_predictions
    from edgelab.predict import load_artifact

    def model_metrics(model: dict[str, Any]) -> dict[str, Any]:
        value = model.get("metrics")
        if isinstance(value, dict):
            return value
        try:
            decoded = json.loads(model.get("metrics_json") or "{}")
            return decoded if isinstance(decoded, dict) else {}
        except (TypeError, ValueError):
            return {}

    active = [model for model in rows.get("models", [])
              if model.get("sport") == "boat" and model.get("status") == "active"
              and (model.get("bet_type") or model.get("betType")) == "trifecta"]
    if len(active) != 1:
        raise RuntimeError("authoritative registry must contain exactly one active trifecta model")
    model = active[0]
    metrics = model_metrics(model)
    if metrics.get("boatFeatureSchemaVersion") != PRERACE_V2_SCHEMA:
        raise RuntimeError("active trifecta model is not boat-prerace-v2; daily forecast abstained")
    model_id = str(model.get("id") or "")
    if not model_id:
        raise RuntimeError("active trifecta registry row has no model ID")
    model_path = artifact_dir / f"{model_id}.pkl"
    artifact_sha = hashlib.sha256(model_path.read_bytes()).hexdigest()
    artifact = load_artifact(model_path)
    predictions = active_ticket_predictions(rows, model_row=model, artifact=artifact,
        model_id=model_id, cutoff=generated_at, artifact_sha256=artifact_sha,
        race_date=day, require_verified_cutoff=True)
    expected = {f"{a}-{b}-{c}" for a in range(1, 7) for b in range(1, 7) for c in range(1, 7)
                if a != b and a != c and b != c}
    def finite_unit_interval(value: Any) -> bool:
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        try:
            number = float(value)
        except OverflowError:
            return False
        return math.isfinite(number) and 0 <= number <= 1

    by_race: dict[str, list[dict[str, Any]]] = {}
    for prediction in predictions:
        by_race.setdefault(str(prediction.get("race_id")), []).append(prediction)
    safe_predictions = []
    for group in by_race.values():
        selections = {row.get("selection") for row in group}
        probabilities = [row.get("probability") for row in group]
        deviations = [row.get("prob_std") for row in group]
        if (len(group) == 120 and selections == expected
                and all(finite_unit_interval(p) for p in probabilities)
                and all(finite_unit_interval(sd) for sd in deviations)
                and abs(sum(float(p) for p in probabilities) - 1.0) <= 1e-6):
            safe_predictions.extend(group)
    merge_rows(rows, {"ticket_predictions": safe_predictions})
    return safe_predictions


def run_daily(day: str, cutoff: str) -> dict[str, Any]:
    """Collect and synchronize the current/previous-day delta; never backfill D1 history."""
    target = date.fromisoformat(day)
    previous = (target - timedelta(days=1)).isoformat()
    # K files can be published or amended while a meeting is in progress. Force
    # a fresh K fetch for today and the prior day; B files keep their stable cache.
    collect_boat(previous, day, refresh_k_dates={previous, day})
    rows = load_rows()
    try:
        beforeinfo_result = collect_beforeinfo(day, now=cutoff, window_min=25, max_requests=8)
        rows = load_rows()
    except Exception as exc:
        beforeinfo_result = {"status": "failed", "reason": type(exc).__name__, "observations": 0}
    from edgelab.sync import fetch_model_registry
    registry = fetch_model_registry()
    _apply_model_registry(rows, registry)
    # Stable run identifiers prevent duplicate collection-run writes on retries.
    daily_run_by_date = {}
    other_runs = []
    for run in rows.get("collection_runs", []):
        if run.get("sport") == "boat" and run.get("target_date") in (previous, day):
            daily_run_by_date[run["target_date"]] = run
        else:
            other_runs.append(run)
    for run_day, run in daily_run_by_date.items():
        run["id"] = f"daily-boat-{run_day}"
        other_runs.append(run)
    rows["collection_runs"] = other_runs
    prediction_error = None
    inference_as_of = _inference_timestamp()
    try:
        ticket_predictions = _predict_boat_trifecta_date(rows, day, inference_as_of)
    except (FileNotFoundError, OSError, RuntimeError, ValueError, TypeError, KeyError,
            AttributeError, EOFError, pickle.UnpicklingError, ImportError) as exc:
        # Missing, legacy, or non-v2 active artifacts block inference only;
        # daily data collection, sync, and feedback continue for recovery.
        ticket_predictions = []
        prediction_error = f"{type(exc).__name__}: {exc}"
    save_rows(rows)
    prev_ids = {r.get("id") for r in rows.get("races", []) if r.get("race_date") == previous}
    today_ids = {r.get("id") for r in rows.get("races", []) if r.get("race_date") == day}
    latest_runs = {}
    for run in rows.get("collection_runs", []):
        if run.get("target_date") in (previous, day) and run.get("sport") == "boat":
            latest_runs[run["target_date"]] = run
    run_ids = {r.get("id") for r in latest_runs.values()}
    def has_official_nonfinisher_marker(entry: dict[str, Any]) -> bool:
        """Keep prior-day K status for entries without a numeric finish order.

        The previous day's results/payouts are synced so settlement can finish,
        but ordinary prior-day entry updates are unnecessary. Explicit K-file
        terminal markers are needed to prove that every program entry either
        finished or has an official non-finisher outcome.
        """
        try:
            finish_code = json.loads(entry.get("features_json") or "{}").get("finish_code")
        except (TypeError, ValueError):
            return False
        return (finish_code in {"F", "L", "K", "欠場", "欠", "失格", "転覆", "妨害", "落水", "エンスト", "不完走"}
                or (isinstance(finish_code, str) and finish_code.startswith("K")
                    and finish_code[1:].isdigit()))

    payload = {
        "races": [r for r in rows.get("races", []) if r.get("id") in prev_ids | today_ids],
        "entries": [r for r in rows.get("entries", [])
                    if r.get("race_id") in today_ids
                    or (r.get("race_id") in prev_ids and has_official_nonfinisher_marker(r))],
        "ticket_predictions": ticket_predictions,
        # K files can already contain same-day finished races during midday or
        # late-night runs; settle those alongside yesterday's outcomes.
        "results": [r for r in rows.get("results", []) if r.get("race_id") in prev_ids | today_ids],
        "payouts": [r for r in rows.get("payouts", []) if r.get("race_id") in prev_ids | today_ids],
        "prerace_observations": [r for r in rows.get("prerace_observations", []) if r.get("race_id") in today_ids],
        "collection_runs": [r for r in rows.get("collection_runs", []) if r.get("id") in run_ids],
        "venues": __import__("edgelab.venues", fromlist=["venue_rows"]).venue_rows(),
        "models": rows.get("models", []),
    }
    from edgelab.sync import sync_rows
    synced = sync_rows(payload)
    from edgelab.learning import score_feedback
    learning_report = score_feedback(rows)
    collection_runs = [run for run in payload["collection_runs"] if run.get("sport") == "boat"]
    collection_ready = all(run.get("status") in {"success", "skipped"} for run in collection_runs)
    forecast_reason = prediction_error
    if forecast_reason is None and not ticket_predictions:
        forecast_reason = "no upcoming real races with verified cutoffs produced v2 trifecta predictions at this cutoff"
    forecast_ready = forecast_reason is None
    return {"date": day, "cutoff": cutoff, "prediction_as_of": inference_as_of,
            "collected_dates": [previous, day],
            "daily_collection_success": collection_ready,
            "forecast_ready": forecast_ready,
            "forecast_status": "ready" if forecast_ready else "not_ready",
            "forecast_reason": forecast_reason,
            "predictions": len(ticket_predictions), "ticket_predictions": len(ticket_predictions),
            "prerace_observations": beforeinfo_result, "sync": synced,
            "feedback_models": len(learning_report["models"])}


def _make_training_rows(store: dict[str, list[dict[str, Any]]], sport: str, *,
                       feature_schema: str = "boat-base-v1") -> list[dict[str, Any]]:
    outcomes = {(row.get("race_id"), row.get("number")): row.get("finish_order")
                for row in store.get("results", []) if row.get("data_origin") == "real"}
    races = {row.get("id"): row for row in store.get("races", [])
             if row.get("sport") == sport and row.get("data_origin") == "real"}
    entries = [row for row in store.get("entries", [])
               if row.get("race_id") in races and row.get("data_origin") == "real"]
    if sport == "boat":
        from edgelab.features.boat import (PRERACE_V2_SCHEMA, build_boat_features,
                                           build_boat_prerace_v2_features, completed_racer_history)
        grouped: dict[str, list[dict[str, Any]]] = {}
        for entry in entries:
            grouped.setdefault(str(entry["race_id"]), []).append(entry)
        enriched = []
        history = completed_racer_history(store) if feature_schema == PRERACE_V2_SCHEMA else []
        for race_id, group in grouped.items():
            race = races[race_id]
            if feature_schema == PRERACE_V2_SCHEMA:
                # T-60 training inputs require the exact official racelist cutoff.
                # B-file post_time is only a start-time approximation and is not
                # promoted to a betting cutoff.
                if (race.get("betting_cutoff_source") != "boatrace-racelist-cutoff-v1"
                        or not race.get("betting_cutoff_at")):
                    continue
                try:
                    predicted_at = _primary_prediction_as_of(str(race["betting_cutoff_at"]))
                    observed_at = datetime.fromisoformat(str(race.get("betting_cutoff_observed_at")).replace("Z", "+00:00"))
                    target_at = datetime.fromisoformat(predicted_at)
                    if observed_at.tzinfo is None or observed_at > target_at:
                        continue
                except (TypeError, ValueError):
                    continue
                features = build_boat_prerace_v2_features(group, race=race, predicted_at=predicted_at,
                    history=history, observations=store.get("prerace_observations", []))
                from edgelab.features.boat import PRERACE_V2_FEATURE_COLUMNS
                feature_columns = PRERACE_V2_FEATURE_COLUMNS
            else:
                if feature_schema != "boat-base-v1":
                    raise ValueError(f"unsupported boat feature schema: {feature_schema}")
                # Existing v1 model training remains B-file-only.
                features = build_boat_features(group, race_date=race["race_date"])
                from edgelab.features.boat import FEATURE_COLUMNS
                feature_columns = FEATURE_COLUMNS
            enriched.extend({**{k: v for k, v in entry.items() if k not in feature_columns}, **feature}
                            for entry, feature in zip(group, features))
        entries = enriched
    cohort_ids = set()
    by_race: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        by_race.setdefault(str(entry.get("race_id")), []).append(entry)
    for race_id, group in by_race.items():
        race = races.get(race_id)
        post = race.get("post_time") if race else None
        timestamp = _coerce_dt(str(post)) if post else None
        numbers = {int(e["number"]) for e in group if e.get("number") is not None}
        results = {int(n): outcomes.get((race_id, n)) for n in numbers}
        if (race and race.get("status") == "finished" and timestamp and numbers
                and set(results) == numbers and all(v is not None for v in results.values())
                and len({str(v) for v in results.values()}) == len(results)
                and sum(1 for v in results.values() if str(v) == "1") == 1
                and all(__import__("edgelab.normalization.availability", fromlist=["available_by"])
                        .available_by(e, timestamp.isoformat()) for e in group)):
            cohort_ids.add(race_id)
    result = []
    for entry in entries:
        race = races[entry["race_id"]]
        if str(entry.get("race_id")) not in cohort_ids:
            continue
        finish = outcomes.get((entry["race_id"], entry.get("number")))
        if finish is None:
            continue
        row = {**entry, "race_date": race.get("race_date"),
               "finish_order": finish,
               "winner": str(finish) == "1", "target": str(finish) == "1"}
        post_time = race.get("post_time")
        if feature_schema == "boat-prerace-v2":
            cutoff = race.get("betting_cutoff_at")
            if race.get("betting_cutoff_source") == "boatrace-racelist-cutoff-v1" and cutoff:
                try:
                    row["predicted_at"] = _primary_prediction_as_of(str(cutoff))
                except (TypeError, ValueError):
                    continue
                row["available_at"] = entry.get("available_at")
        elif post_time:
            try:
                cutoff = datetime.fromisoformat(post_time.replace("Z", "+00:00")) - timedelta(minutes=10)
                row["predicted_at"] = cutoff.isoformat()
                # Legacy candidate training remains B-file-only. T-60 candidate
                # rows use the true cutoff branch above and source observation times.
                row["available_at"] = entry.get("available_at")
            except (TypeError, ValueError):
                pass
        result.append(row)
    return result


def collect_boat(start: str, end: str, *, max_requests: int | None = None,
                 refresh_k_dates: set[str] | None = None) -> int:
    from edgelab.collectors.boatrace import fetch_boatrace_file, read_lzh
    from edgelab.parsers.boatrace_b import parse_b
    from edgelab.parsers.boatrace_k import parse_k

    store = load_rows()
    requests = 0
    for day in _date_range(start, end):
        started, rows, errors, existing = _now(), {}, [], False
        for kind, parser in (("B", parse_b), ("K", parse_k)):
            try:
                cache = Path("data/raw/boatrace") / f"{kind.lower()}{day:%y%m%d}.lzh"
                refresh_k = kind == "K" and day.isoformat() in (refresh_k_dates or set())
                cache_exists = cache.is_file()
                if (not cache_exists or refresh_k) and max_requests is not None and requests >= max_requests:
                    if refresh_k:
                        errors.append("K refresh skipped: max_requests budget exhausted")
                        path = cache if cache_exists else None
                        if path is None:
                            continue
                    else:
                        continue
                else:
                    if not cache_exists or refresh_k:
                        requests += 1
                    validator = None
                    if refresh_k:
                        def validator(content: str, *, expected_date=day.isoformat(), parse=parser):
                            parsed = parse(content, race_date=expected_date)
                            race_ids = {str(r.get("id")) for r in parsed.get("races", []) if r.get("id")}
                            if (not race_ids or not any(str(r.get("race_id")) in race_ids
                                                        for r in parsed.get("results", []))
                                    or any(r.get("race_date") != expected_date for r in parsed.get("races", []))):
                                raise ValueError("refreshed K file has no valid same-day race results")
                    path = fetch_boatrace_file(kind, day, refresh=refresh_k, validator=validator)
                    if path is None:
                        existing = True
                        if refresh_k:
                            errors.append("K refresh unavailable: source file is not present")
                            path = cache if cache_exists else None
                        if path is None:
                            continue
                content = read_lzh(path)
                parsed = parser(content, race_date=day.isoformat())
                if kind == "K":
                    observed_at = _now()
                    for result in parsed.get("results", []):
                        result["available_at"] = observed_at
                for table, values in parsed.items():
                    rows.setdefault(table, []).extend(values)
            except Exception as exc:  # each date gets a durable failure record
                errors.append(f"{kind}: {type(exc).__name__}: {exc}")
        # Restore the official B schedule after parsing K results; the result
        # page can report a different post-race display time.
        scheduled = {race["id"]: race.get("post_time") for race in rows.get("races", [])
                     if race.get("post_time")}
        for race in rows.get("races", []):
            if race.get("status") == "finished" and race.get("id") in scheduled:
                race["post_time"] = scheduled[race["id"]]
        merge_rows(store, rows)
        status = "failed" if errors and not rows else "partial" if errors else "skipped" if not rows and existing else "success"
        store.setdefault("collection_runs", []).append({
            "id": str(uuid.uuid4()), "source": "mbrace-boat", "sport": "boat",
            "target_date": day.isoformat(), "started_at": started, "finished_at": _now(),
            "status": status, "records": sum(len(v) for k, v in rows.items() if k != "races"),
            "error": "; ".join(errors) or None,
            "reason": "official file not present (no meeting)" if status == "skipped" else None,
        })
    save_rows(store)
    # Preserve failed-run telemetry and allow the following workflow sync step
    # to deliver it to the collection-status endpoint.
    return 0


def collect_beforeinfo(day: str, *, now: str | None = None, window_min: int = 25,
                       max_requests: int = 8, store_path: str | Path = DEFAULT_STORE,
                       fetcher=None, wait_for_slot=None) -> dict[str, Any]:
    """Collect bounded current-day official exhibition/weather observations."""
    from edgelab.collectors.boatrace_beforeinfo import collect_beforeinfo as collect
    from edgelab.storage import load_rows

    current = datetime.fromisoformat(now.replace("Z", "+00:00")) if now else datetime.now(ZoneInfo("Asia/Tokyo"))
    if current.tzinfo is None:
        current = current.replace(tzinfo=ZoneInfo("Asia/Tokyo"))
    if current.astimezone(ZoneInfo("Asia/Tokyo")).date().isoformat() != date.fromisoformat(day).isoformat():
        return {"status": "skipped", "targets": 0, "requests": 0, "observations": 0, "failures": [],
                "reason": "collector accepts current JST day only"}
    store = load_rows(store_path)
    result = collect(store, now=current, window_min=window_min, max_requests=max_requests,
                     fetcher=fetcher, wait_for_slot=wait_for_slot)
    save_rows(store, store_path)
    return result


def rebuild_boat(raw_dir: str | Path = "data/raw/boatrace") -> dict[str, int]:
    """Rebuild the normalized boat store from locally cached official LZH files."""
    from edgelab.collectors.boatrace import read_lzh
    from edgelab.parsers.boatrace_b import parse_b
    from edgelab.parsers.boatrace_k import parse_k

    raw_path = Path(raw_dir)
    store: dict[str, list[dict[str, Any]]] = {
        key: [] for key in ("races", "entries", "odds_snapshots", "results", "payouts",
                            "predictions", "models", "collection_runs")
    }
    files = sorted(path for path in raw_path.glob("*.lzh")
                   if len(path.stem) == 7 and path.stem[0].lower() in {"b", "k"}
                   and path.stem[1:].isdigit())
    for path in files:
        kind = path.stem[0].lower()
        day = datetime.strptime(path.stem[1:], "%y%m%d").date().isoformat()
        content = read_lzh(path)
        parsed = (parse_b if kind == "b" else parse_k)(content, race_date=day)
        merge_rows(store, parsed)
    save_rows(store)
    return {table: len(rows) for table, rows in store.items()}


def preview_boat_day(day: str, raw_dir: str | Path, output: str | Path) -> dict[str, Any]:
    """Build a network-free, separate-file snapshot for one cached B/K day.

    This is deliberately not a repair operation: it neither loads nor modifies
    the normalized store, and refuses to overwrite an existing preview.
    """
    from edgelab.collectors.boatrace import read_lzh
    from edgelab.parsers.boatrace_b import parse_b
    from edgelab.parsers.boatrace_k import parse_k

    target_day = date.fromisoformat(day)
    raw_path = Path(raw_dir)
    output_path = Path(output)
    if output_path.resolve() == DEFAULT_STORE.resolve():
        raise ValueError("preview output must not target the normalized store")
    if output_path.exists():
        raise FileExistsError(f"refusing to overwrite existing preview: {output_path}")
    stamp = target_day.strftime("%y%m%d")
    paths = {kind: raw_path / f"{kind}{stamp}.lzh" for kind in ("b", "k")}
    missing = [str(path) for path in paths.values() if not path.is_file()]
    if missing:
        raise FileNotFoundError("cached day requires both B and K files: " + ", ".join(missing))
    snapshot: dict[str, list[dict[str, Any]]] = {
        key: [] for key in ("races", "entries", "odds_snapshots", "results", "payouts",
                            "predictions", "ticket_predictions", "models", "collection_runs")
    }
    for kind, parser in (("b", parse_b), ("k", parse_k)):
        merge_rows(snapshot, parser(read_lzh(paths[kind]), race_date=target_day.isoformat()))
    by_race: dict[str, dict[str, Any]] = {}
    for payout in snapshot["payouts"]:
        if payout.get("bet_type") == "trifecta" and float(payout.get("payout") or 0) > 0:
            by_race.setdefault(str(payout.get("race_id")), {}).setdefault("positivePayouts", []).append(
                str(payout.get("selection")))
    for result in snapshot["results"]:
        try:
            rank = int(result.get("finish_order"))
        except (TypeError, ValueError):
            continue
        if rank in (1, 2, 3):
            item = by_race.setdefault(str(result.get("race_id")), {})
            item.setdefault("top3", {})[rank] = str(result.get("number"))
    summaries = []
    for race in sorted(snapshot["races"], key=lambda row: str(row.get("id"))):
        rid = str(race["id"])
        audit = by_race.get(rid, {})
        ordered = [audit.get("top3", {}).get(rank) for rank in (1, 2, 3)]
        positive = audit.get("positivePayouts", [])
        summaries.append({"raceId": rid, "venueId": race.get("venue_id"),
                          "entryCount": sum(1 for entry in snapshot["entries"] if entry.get("race_id") == rid),
                          "finishTop3": "-".join(ordered) if all(ordered) else None,
                          "positiveTrifectaPayoutSelections": sorted(positive),
                          "trifectaPayoutConsistent": (len(positive) == 1 and all(ordered)
                                                       and positive[0] == "-".join(ordered))})
    report = {"date": target_day.isoformat(), "networkAccess": False, "storeModified": False,
              "sourceFiles": {kind: str(path) for kind, path in paths.items()},
              "rowCounts": {table: len(rows) for table, rows in snapshot.items()},
              "races": summaries, "snapshot": snapshot}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                           encoding="utf-8")
    return {"date": day, "output": str(output_path), "networkAccess": False,
            "storeModified": False, "races": len(summaries), "rowCounts": report["rowCounts"]}


def preview_boat_cache(raw_dir: str | Path, output: str | Path) -> dict[str, Any]:
    """Rebuild paired locally cached B/K days to a separate safe snapshot."""
    from edgelab.collectors.boatrace import read_lzh
    from edgelab.parsers.boatrace_b import parse_b
    from edgelab.parsers.boatrace_k import parse_k

    raw_path, output_path = Path(raw_dir), Path(output)
    if output_path.resolve() == DEFAULT_STORE.resolve():
        raise ValueError("preview output must not target the normalized store")
    if output_path.exists():
        raise FileExistsError(f"refusing to overwrite existing preview: {output_path}")
    files = {path.stem[0].lower() + path.stem[1:]: path for path in raw_path.glob("*.lzh")
             if len(path.stem) == 7 and path.stem[0].lower() in {"b", "k"}
             and path.stem[1:].isdigit()}
    paired = sorted(key[1:] for key in files if key.startswith("b") and "k" + key[1:] in files)
    if not paired:
        raise FileNotFoundError(f"no paired B/K cache files in {raw_path}")
    snapshot: dict[str, list[dict[str, Any]]] = {key: [] for key in (
        "races", "entries", "odds_snapshots", "results", "payouts", "predictions",
        "ticket_predictions", "models", "collection_runs")}
    for stamp in paired:
        day = datetime.strptime(stamp, "%y%m%d").date().isoformat()
        for prefix, parser in (("b", parse_b), ("k", parse_k)):
            merge_rows(snapshot, parser(read_lzh(files[prefix + stamp]), race_date=day))
    source_paths = sorted((files[prefix + stamp] for stamp in paired for prefix in ("b", "k")),
                          key=lambda path: path.name)
    source_files = [{"name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                    for path in source_paths]
    report = {"networkAccess": False, "storeModified": False,
              "sourceFiles": source_files,
              "pairedDays": [datetime.strptime(stamp, "%y%m%d").date().isoformat() for stamp in paired],
              "unpairedFileCount": len(files) - 2 * len(paired),
              "rowCounts": {table: len(rows) for table, rows in snapshot.items()}, "snapshot": snapshot}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                           encoding="utf-8")
    return {"output": str(output_path), "networkAccess": False, "storeModified": False,
            "pairedDays": len(paired), "unpairedFileCount": report["unpairedFileCount"],
            "rowCounts": report["rowCounts"]}


def migrate_boat_venue_cache(raw_dir: str | Path, marker_path: str | Path) -> dict[str, Any]:
    """One-time local cache migration; never synchronizes or changes remote rows."""
    from edgelab.collectors.boatrace import read_lzh
    from edgelab.parsers.boatrace_b import parse_b
    from edgelab.parsers.boatrace_k import parse_k

    marker = Path(marker_path)
    if marker.exists():
        saved = json.loads(marker.read_text(encoding="utf-8"))
        if saved.get("schemaVersion") != "boat-venue-v2":
            raise RuntimeError("existing boat venue migration marker has an unknown version")
        return {"status": "already_migrated", "schemaVersion": saved["schemaVersion"],
                "remoteSyncPerformed": False}
    raw_path = Path(raw_dir)
    files = {path.stem[0].lower() + path.stem[1:]: path for path in raw_path.glob("*.lzh")
             if len(path.stem) == 7 and path.stem[0].lower() in {"b", "k"}
             and path.stem[1:].isdigit()}
    paired = sorted(key[1:] for key in files if key.startswith("b") and "k" + key[1:] in files)
    if not paired:
        raise FileNotFoundError("venue migration requires locally cached paired B/K files; no network fallback")
    old = load_rows()
    clean: dict[str, list[dict[str, Any]]] = {key: [] for key in (
        "races", "entries", "odds_snapshots", "results", "payouts", "predictions", "models", "collection_runs")}
    for stamp in paired:
        day = datetime.strptime(stamp, "%y%m%d").date().isoformat()
        for prefix, parse in (("b", parse_b), ("k", parse_k)):
            merge_rows(clean, parse(read_lzh(files[prefix + stamp]), race_date=day))
    clean["predictions"] = list(old.get("predictions", []))
    clean["odds_snapshots"] = list(old.get("odds_snapshots", []))
    save_rows(clean)
    source_paths = sorted((files[prefix + stamp] for stamp in paired for prefix in ("b", "k")),
                          key=lambda path: path.name)
    source_files = [{"name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                    for path in source_paths]
    marker_value = {"schemaVersion": "boat-venue-v2", "migratedAt": _now(),
        "source": "paired local B/K LZH cache", "pairedDays": len(paired), "sourceFiles": source_files,
        "rowCounts": {table: len(rows) for table, rows in clean.items()},
        "preservedHistoricalPredictions": len(clean["predictions"]),
        "preservedHistoricalOddsSnapshots": len(clean["odds_snapshots"]), "remoteSyncPerformed": False}
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps(marker_value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"status": "migrated", **marker_value}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="edgelab")
    sub = parser.add_subparsers(dest="command", required=True)
    collect = sub.add_parser("collect-boat", help="collect official boat-race B/K files")
    collect.add_argument("--from", dest="date_from", required=True)
    collect.add_argument("--to", dest="date_to", required=True)
    train = sub.add_parser("train", help="train an independent sport model")
    train.add_argument("--sport", choices=("boat", "horse"), required=True)
    trifecta = sub.add_parser("train-trifecta", help="train/evaluate an offline T-60, pre-race-v2 candidate exact-order trifecta model")
    trifecta.add_argument("--model-id", help="immutable candidate model ID")
    trifecta.add_argument("--artifact-dir", default="ml/artifacts")
    trifecta.add_argument("--min-train-races", type=int, default=300)
    trifecta.add_argument("--replay-max-picks", type=int, choices=range(1, 7), default=1,
                          help="runtime-like cap for the offline replay (default matches the runtime default)")
    trifecta.add_argument("--replay-race-budget", type=int, default=100,
                          help="integer-yen replay stake budget per race")
    trifecta.add_argument("--output", default="ml/data/learning/trifecta-report.json")
    archives = sub.add_parser("import-prerace-archives", help="verify and import one date of prerace archives into the local offline store")
    archives.add_argument("--date", required=True, help="race date in YYYY-MM-DD")
    archives.add_argument("--store", default=str(DEFAULT_STORE), help="local JSON row store")
    predict_ticket = sub.add_parser("predict-trifecta", help="generate local exact-order forecasts from an explicitly active validated artifact")
    predict_ticket.add_argument("--cutoff", required=True, help="ISO prediction cutoff")
    predict_ticket.add_argument("--artifact-dir", default="ml/artifacts")
    predict = sub.add_parser("predict", help="predict races for a date")
    predict.add_argument("--sport", choices=("boat", "horse"), required=True)
    predict.add_argument("--date", required=True)
    predict.add_argument("--cutoff", help="ISO timestamp cutoff")
    sync = sub.add_parser("sync", help="sync local normalized rows to /api/ingest")
    sync.add_argument("--dry-run", action="store_true")
    sync.add_argument("--output-dir", default="ml/outbox")
    sync.add_argument("--tables", nargs="+", choices=("venues", "races", "entries", "results", "payouts", "odds_snapshots", "models", "predictions", "ticket_predictions", "prerace_observations", "collection_runs"))
    backfill = sub.add_parser("backfill", help="collect a date range of boat data")
    backfill.add_argument("--from", dest="date_from", required=True)
    backfill.add_argument("--to", dest="date_to", required=True)
    bf = sub.add_parser("backfill-sync", help="preview historical D1 backfill (remote writes disabled)")
    bf.add_argument("--since", required=True)
    bf.add_argument("--until")
    bf.add_argument("--budget", type=int, default=20_000, help="dry-run estimate cap (hard-capped at 20k)")
    bf.add_argument("--database", default="roi-plus")
    bf.add_argument("--dry-run", action="store_true")
    rebuild = sub.add_parser("rebuild", help="rebuild normalized rows from local raw Boatrace LZH files")
    rebuild.add_argument("--raw", default="data/raw/boatrace", help="directory containing cached B/K LZH files")
    preview = sub.add_parser("preview-boat-day", help="write a separate network-free B/K rebuild preview for one cached day")
    preview.add_argument("--date", required=True)
    preview.add_argument("--raw", default="data/raw/boatrace")
    preview.add_argument("--output", required=True, help="new path; will not overwrite existing files")
    cache_preview = sub.add_parser("preview-boat-cache", help="rebuild paired B/K files to a separate safe snapshot")
    cache_preview.add_argument("--raw", default="data/raw/boatrace")
    cache_preview.add_argument("--output", required=True, help="new output path; existing store is never modified")
    migration = sub.add_parser("migrate-boat-venue-cache", help="one-time local clean rebuild for venue identity v2")
    migration.add_argument("--raw", default="data/raw/boatrace")
    migration.add_argument("--marker", default="ml/data/boat-venue-v2.json")
    live = sub.add_parser("live", help="collect today's program and near-deadline win odds")
    live.add_argument("--date", required=True)
    live.add_argument("--window-min", type=int, default=25)
    live.add_argument("--now", help="ISO timestamp")
    live.add_argument("--max-requests", type=int, default=30)
    beforeinfo = sub.add_parser("collect-beforeinfo", help="collect current-day official exhibition and weather observations")
    beforeinfo.add_argument("--date", required=True)
    beforeinfo.add_argument("--now", help="ISO timestamp; defaults to current JST time")
    beforeinfo.add_argument("--window-min", type=int, default=25)
    beforeinfo.add_argument("--max-requests", type=int, default=8)
    beforeinfo.add_argument("--sync", action="store_true", help="sync today's collected rows after the DB migration is installed")
    daily = sub.add_parser("daily", help="run the idempotent daily boat pipeline")
    daily.add_argument("--date", default=None, help="JST date (defaults to today)")
    daily.add_argument("--now", help="ISO timestamp cutoff (defaults to current time)")
    sub.add_parser("feedback", help="score saved real predictions against completed outcomes")
    sub.add_parser("learn", help="train/evaluate a candidate after enough new real outcomes")
    validation = sub.add_parser("validate-baseline", help="validate an existing initial baseline artifact without retraining")
    validation.add_argument("--model-id", default="boat-win-lgbm-20261010-ee79bc87")
    validation.add_argument("--artifact-dir", default="ml/artifacts")
    validation.add_argument("--output", default="ml/data/learning/initial-baseline-report.json")
    validation.add_argument("--sync-validation", action="store_true",
                            help="refresh authenticated registry evidence and sync only this candidate's metrics")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "daily":
        now = datetime.fromisoformat(args.now.replace("Z", "+00:00")) if args.now else datetime.now(ZoneInfo("Asia/Tokyo"))
        if now.tzinfo is None:
            now = now.replace(tzinfo=ZoneInfo("Asia/Tokyo"))
        day = args.date or now.astimezone(ZoneInfo("Asia/Tokyo")).date().isoformat()
        print(json.dumps(run_daily(day, now.isoformat()), ensure_ascii=False))
        return 0
    if args.command == "collect-boat":
        return collect_boat(args.date_from, args.date_to)
    if args.command == "collect-beforeinfo":
        result = collect_beforeinfo(args.date, now=args.now, window_min=args.window_min,
                                    max_requests=args.max_requests)
        if args.sync and result.get("observations"):
            from edgelab.sync import sync_rows
            store = load_rows()
            day = date.fromisoformat(args.date).isoformat()
            today_ids = {r.get("id") for r in store.get("races", []) if r.get("race_date") == day}
            result["sync"] = sync_rows({"prerace_observations": [o for o in store.get("prerace_observations", [])
                                                                  if o.get("race_id") in today_ids]})
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if args.command == "import-prerace-archives":
        from edgelab.importers.boatrace_capture_archive import import_capture_archives
        from edgelab.sync import fetch_prerace_capture_archives
        pages = fetch_prerace_capture_archives(args.date)
        rows = load_rows(args.store)
        result = import_capture_archives(rows, pages, args.date)
        if result.get("importedArchives"):
            save_rows(rows, args.store)
        result["localStoreUpdated"] = bool(result.get("importedArchives"))
        result["remoteSyncPerformed"] = False
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0 if result.get("excludedArchives", 0) == 0 else 2
    if args.command == "preview-boat-day":
        print(json.dumps(preview_boat_day(args.date, args.raw, args.output), ensure_ascii=False))
        return 0
    if args.command == "preview-boat-cache":
        print(json.dumps(preview_boat_cache(args.raw, args.output), ensure_ascii=False))
        return 0
    if args.command == "train-trifecta":
        from edgelab.models.trifecta import train_trifecta
        rows = load_rows()
        from edgelab.features.boat import PRERACE_V2_SCHEMA
        training_rows = _make_training_rows(rows, "boat", feature_schema=PRERACE_V2_SCHEMA)
        digest = hashlib.sha256("|".join(sorted({str(r.get("race_id")) for r in training_rows})).encode()).hexdigest()[:8]
        model_id = args.model_id or f"boat-trifecta-lgbm-{datetime.now(timezone.utc):%Y%m%d}-{digest}"
        if any(str(model.get("id")) == model_id for model in rows.get("models", [])):
            raise RuntimeError("candidate model ID already exists locally; model IDs are immutable")
        result = train_trifecta(training_rows, rows, model_id=model_id,
                                artifact_dir=args.artifact_dir, min_train_races=args.min_train_races,
                                feature_schema_version=PRERACE_V2_SCHEMA,
                                replay_max_picks=args.replay_max_picks,
                                replay_race_budget=args.replay_race_budget)
        if result.get("status") == "candidate":
            metrics = dict(result.get("metrics") or {})
            metrics["ticketArtifactSha256"] = result["ticketArtifactSha256"]
            model_row = {"id": model_id, "sport": "boat", "bet_type": "trifecta",
                "version": f"candidate-{result['ticketArtifactSha256'][:16]}",
                "algorithm": result["algorithm"], "status": "candidate",
                "train_from": result.get("trainFrom"), "train_to": result.get("trainTo"),
                "valid_from": result.get("validFrom"), "valid_to": result.get("validTo"),
                "test_from": result.get("testFrom"), "test_to": result.get("testTo"),
                "n_train": result.get("nTrainRaces"),
                "metrics_json": json.dumps(metrics, ensure_ascii=False, allow_nan=False),
                "trained_at": result.get("trainedAt"),
                "notes": "Offline temporal candidate; promotion disabled pending explicit validation/review."}
            merge_rows(rows, {"models": [model_row]})
            save_rows(rows)
            result["localCandidateRegistered"] = True
            result["remoteSyncPerformed"] = False
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        result["reportPath"] = str(output)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0 if result.get("status") == "candidate" else 2
    if args.command == "predict-trifecta":
        from edgelab.models.trifecta import active_ticket_predictions
        from edgelab.predict import load_artifact
        rows = load_rows()
        from edgelab.sync import fetch_model_registry
        registry = fetch_model_registry()
        _apply_model_registry(rows, registry)
        active = [m for m in rows.get("models", []) if m.get("sport") == "boat"
                  and m.get("status") == "active"
                  and (m.get("bet_type") or m.get("betType")) == "trifecta"]
        if len(active) != 1:
            raise RuntimeError("authoritative registry must contain exactly one active trifecta model")
        model_row = active[0]
        model_id = str(model_row["id"])
        model_path = Path(args.artifact_dir) / f"{model_id}.pkl"
        artifact_sha = hashlib.sha256(model_path.read_bytes()).hexdigest()
        artifact = load_artifact(model_path)
        predictions = active_ticket_predictions(rows, model_row=model_row, artifact=artifact,
            model_id=model_id, cutoff=args.cutoff, artifact_sha256=artifact_sha)
        merge_rows(rows, {"ticket_predictions": predictions})
        save_rows(rows)
        print(json.dumps({"modelId": model_id, "cutoff": args.cutoff,
                          "ticketPredictions": len(predictions), "synced": False}, ensure_ascii=False))
        return 0
    if args.command == "migrate-boat-venue-cache":
        print(json.dumps(migrate_boat_venue_cache(args.raw, args.marker), ensure_ascii=False))
        return 0

    if args.command == "backfill":
        code = collect_boat(args.date_from, args.date_to)
        return code
    if args.command == "backfill-sync":
        from edgelab.backfill_sync import run
        print(json.dumps(run(since=args.since, until=args.until, budget=args.budget,
                             database=args.database, dry_run=args.dry_run), ensure_ascii=False))
        return 0
    if args.command == "rebuild":
        print(json.dumps(rebuild_boat(args.raw), ensure_ascii=False))
        return 0
    if args.command == "live":
        from edgelab.live import run_live
        result = run_live(args.date, window_min=args.window_min, now=args.now,
                          max_requests=args.max_requests)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if args.command == "feedback":
        from edgelab.learning import score_feedback
        report = score_feedback(load_rows())
        print(json.dumps({"report": "ml/data/learning/report.json",
                          "models": len(report["models"])}, ensure_ascii=False))
        return 0
    if args.command == "validate-baseline":
        from edgelab.baseline_validation import validate_initial_baseline
        from edgelab.learning import _atomic_json
        rows = load_rows()
        registry, registry_error = None, None
        if args.sync_validation:
            from edgelab.sync import fetch_model_registry
            try:
                registry = fetch_model_registry()
            except RuntimeError as exc:
                registry_error = f"{type(exc).__name__}: {exc}"
        validation = validate_initial_baseline(rows, model_id=args.model_id,
            artifact_dir=args.artifact_dir, registry=registry,
            workflow_run_id=__import__("os").environ.get("GITHUB_RUN_ID"))
        report = {"version": 1, "generatedAt": validation["validatedAt"],
                  "workflowRunId": validation.get("workflowRunId"),
                  "modelId": args.model_id, "modelEvidenceEligible": validation["modelEvidenceEligible"],
                  "initialBaselineEligible": validation["initialBaselineEligible"],
                  "initialBaselineReason": validation["initialBaselineReason"],
                  "initialBaselineValidation": validation}
        if registry_error:
            report["registryError"] = registry_error
        if args.sync_validation and validation["initialBaselineEligible"]:
            try:
                remote = next((m for m in registry or [] if m.get("id") == args.model_id), None)
                if not remote or remote.get("status") != "candidate":
                    raise RuntimeError("candidate is absent from authenticated registry or is not a candidate")
                if remote.get("version") != validation.get("artifact", {}).get("version"):
                    raise RuntimeError("candidate version differs from authenticated registry")
                marker = _safe_boat_schema_version(args.model_id, Path(args.artifact_dir))
                if marker != "boat-base-v1":
                    raise RuntimeError("candidate artifact pair failed safe boat schema identity check")
                try:
                    metrics = json.loads(remote.get("metrics_json") or "{}")
                except (TypeError, ValueError) as exc:
                    raise RuntimeError("registered candidate metrics are invalid") from exc
                if not isinstance(metrics, dict):
                    raise RuntimeError("registered candidate metrics are invalid")
                metrics["promotionEligible"] = False
                metrics["promotionReason"] = "initial baseline requires a separate human decision"
                # This separate eligibility path is only evidence for explicit
                # human approval; it must never alter ordinary promotion gates.
                metrics["initialBaselineEligible"] = True
                metrics["initialBaselineReason"] = None
                metrics["initialBaselineValidation"] = validation
                metrics["boatFeatureSchemaVersion"] = marker
                metrics["boatArtifactSha256"] = validation["artifact"]["pickleSha256"]
                candidate_row = {**remote, "metrics_json": json.dumps(metrics, ensure_ascii=False, allow_nan=False)}
                from edgelab.sync import sync_rows
                report["sync"] = sync_rows({"models": [candidate_row]})
            except (RuntimeError, ValueError, TypeError) as exc:
                # Preserve the offline evaluation report even if authenticated
                # registry refresh/sync is unavailable or the row has changed.
                report["syncError"] = f"{type(exc).__name__}: {exc}"
                report["initialBaselineEligible"] = False
                report["initialBaselineReason"] = report["syncError"]
        _atomic_json(Path(args.output), report)
        print(json.dumps({"report": args.output, "modelId": args.model_id,
                          "modelEvidenceEligible": report["modelEvidenceEligible"],
                          "initialBaselineEligible": report["initialBaselineEligible"],
                          "initialBaselineReason": report["initialBaselineReason"],
                          "synced": bool(report.get("sync"))}, ensure_ascii=False))
        return 0
    if args.command == "learn":
        from edgelab.learning import guarded_candidate, score_feedback
        from edgelab.sync import fetch_model_registry, sync_rows
        rows = load_rows()
        registry = fetch_model_registry()
        authoritative_ids = _apply_model_registry(rows, registry)
        training_rows = _make_training_rows(rows, "boat")
        digest = hashlib.sha256("|".join(sorted({str(r.get("race_id")) for r in training_rows})).encode()).hexdigest()[:8]
        model_id = f"boat-win-lgbm-{datetime.now(timezone.utc):%Y%m%d}-{digest}"
        result = guarded_candidate(rows, training_rows, model_id=model_id,
                                  authoritative_model_ids=authoritative_ids)
        if result.get("status") == "candidate":
            # guarded_candidate already wrote this unique artifact; reproduce only the metadata row.
            metadata = json.loads((Path("ml/artifacts") / f"{model_id}.json").read_text(encoding="utf-8"))
            metadata.setdefault("metrics", {})["promotionEligible"] = bool(result.get("promotionEligible"))
            if not result.get("promotionEligible"):
                metadata["metrics"]["promotionReason"] = result.get("promotionReason") or "no eligible incumbent comparison"
            schema_version = _safe_boat_schema_version(model_id)
            if schema_version:
                metadata["metrics"]["boatFeatureSchemaVersion"] = schema_version
                metadata["metrics"]["boatArtifactSha256"] = hashlib.sha256(
                    (Path("ml/artifacts") / f"{model_id}.pkl").read_bytes()).hexdigest()
            else:
                metadata["metrics"]["promotionEligible"] = False
                metadata["metrics"]["promotionReason"] = "candidate artifact pair failed safe boat schema identity check"
            (Path("ml/artifacts") / f"{model_id}.json").write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
            model_row = {"id": model_id, "sport": "boat", "bet_type": "win", "version": metadata.get("version", "v1"),
                         "algorithm": metadata.get("algorithm", "LightGBM"), "status": "candidate",
                         "train_from": metadata.get("trainFrom"), "train_to": metadata.get("trainTo"),
                         "valid_from": metadata.get("validFrom"), "valid_to": metadata.get("validTo"),
                         "test_from": metadata.get("testFrom"), "test_to": metadata.get("testTo"),
                         "n_train": metadata.get("nTrain", 0), "metrics_json": json.dumps(metadata.get("metrics", {})),
                         "trained_at": metadata.get("trainedAt"), "notes": "guarded unattended candidate; manual promotion only"}
            merge_rows(rows, {"models": [model_row]})
            save_rows(rows)
            sync_rows({"models": [model_row]})
            from edgelab.learning import LEARNING_STATE, _atomic_json
            _atomic_json(LEARNING_STATE, {"version": 1, "trainedRaceIds": result.get("evaluatedRaceIds", []),
                                          "lastModelId": model_id, "updatedAt": datetime.now(timezone.utc).isoformat()})
        elif result.get("status") == "existing_registered_id":
            # Recover state if an earlier run synced successfully but was interrupted before checkpoint.
            registered = next((m for m in rows.get("models", []) if m.get("id") == model_id), None)
            if registered and registered.get("status") == "candidate":
                from edgelab.learning import LEARNING_STATE, _atomic_json
                _atomic_json(LEARNING_STATE, {"version": 1, "trainedRaceIds": result.get("evaluatedRaceIds", []),
                                              "lastModelId": model_id, "updatedAt": datetime.now(timezone.utc).isoformat()})
        report = {"learning": result, "feedback": score_feedback(rows)}
        from edgelab.learning import _atomic_json
        _atomic_json(Path("ml/data/learning/report.json"), report)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if args.command == "sync":
        from edgelab.sync import sync_rows
        rows = load_rows()
        from edgelab.venues import venue_rows
        payload = {key: rows.get(key, []) for key in
                   ("races", "entries", "results", "payouts", "odds_snapshots", "models", "predictions", "ticket_predictions", "prerace_observations", "collection_runs")}
        payload["venues"] = venue_rows()
        if args.tables:
            payload = {key: payload[key] for key in args.tables if key in payload}
        print(json.dumps(sync_rows(payload, dry_run=args.dry_run, output_dir=args.output_dir), ensure_ascii=False))
        return 0
    if args.command == "train":
        from edgelab.models.train import candidate_version, train_model
        rows = load_rows()
        training_rows = _make_training_rows(rows, args.sport)
        dates = sorted({str(r.get("race_date")) for r in training_rows if r.get("race_date")})
        fingerprint = hashlib.sha256("|".join(dates + sorted({str(r.get("race_id")) for r in training_rows})).encode()).hexdigest()[:8]
        model_id = f"{args.sport}-win-lgbm-{datetime.now(timezone.utc):%Y%m%d}-{fingerprint}"
        result = train_model(training_rows, sport=args.sport,
                             model_id=model_id, version=candidate_version(model_id))
        model_metrics = dict(result.get("metrics", {}))
        if args.sport == "boat":
            schema_version = _safe_boat_schema_version(model_id)
            if schema_version:
                model_metrics["boatFeatureSchemaVersion"] = schema_version
                model_metrics["boatArtifactSha256"] = hashlib.sha256(
                    (Path("ml/artifacts") / f"{model_id}.pkl").read_bytes()).hexdigest()
        model_row = {
            "id": result["id"], "sport": result.get("sport", args.sport),
            "bet_type": result.get("betType", "win"), "version": result.get("version", "v1"),
            "algorithm": result.get("algorithm", "LightGBM"), "status": result["status"],
            "train_from": result.get("trainFrom"), "train_to": result.get("trainTo"),
            "valid_from": result.get("validFrom"), "valid_to": result.get("validTo"),
            "test_from": result.get("testFrom"), "test_to": result.get("testTo"),
            "n_train": result.get("nTrain", 0),
            "metrics_json": json.dumps(model_metrics, ensure_ascii=False),
            "trained_at": result.get("trainedAt"), "notes": result.get("reason"),
        }
        merge_rows(rows, {"models": [model_row]})
        save_rows(rows)
        print(json.dumps(model_row, ensure_ascii=False, default=str))
        return 0
    if args.command == "predict":
        from edgelab.predict import load_artifact, predict_rows
        rows = load_rows()
        race_ids = {race["id"] for race in rows.get("races", [])
                    if race.get("sport") == args.sport and race.get("race_date") == args.date
                    and race.get("data_origin") == "real"}
        entries = [entry for entry in rows.get("entries", [])
                   if entry.get("race_id") in race_ids and entry.get("data_origin") == "real"]
        if args.sport == "boat":
            from edgelab.features.boat import build_boat_features
            race_by_id = {race["id"]: race for race in rows.get("races", []) if race.get("id") in race_ids}
            entries = [dict(entry) for entry in entries]
            by_race: dict[str, list[dict[str, Any]]] = {}
            for entry in entries:
                by_race.setdefault(str(entry["race_id"]), []).append(entry)
            from edgelab.features.boat import FEATURE_COLUMNS
            entries = [
                {**{k: v for k, v in entry.items() if k not in FEATURE_COLUMNS}, **feature}
                for race_id, group in by_race.items()
                for feature, entry in zip(build_boat_features(
                    group, race_date=args.date, predicted_at=args.cutoff or _now()), group)
            ]
        active = next((m for m in rows.get("models", [])
                       if m.get("sport") == args.sport and m.get("status") == "active"), None)
        if active is None:
            raise RuntimeError("no active model in local registry; candidate models are evaluation-only")
        artifact = Path("ml/artifacts") / f"{active['id']}.pkl"
        predicted_at = args.cutoff or _now()
        if not artifact.is_file():
            raise FileNotFoundError(f"model artifact not found: {artifact}; run train first")
        if args.sport == "boat":
            _verify_runtime_artifact(active, artifact)
        eligible = []
        race_lookup = {r["id"]: r for r in rows.get("races", []) if r.get("id") in race_ids}
        cutoff_dt = _coerce_dt(str(predicted_at))
        for entry in entries:
            race = race_lookup.get(entry.get("race_id")) or {}
            post = _coerce_dt(str(race["post_time"])) if race.get("post_time") else None
            if race.get("status") not in {"finished", "closed", "cancelled"} and post and post > cutoff_dt:
                eligible.append(entry)
        predictions = predict_rows(eligible, load_artifact(artifact), predicted_at=predicted_at)
        merge_rows(rows, {"predictions": predictions})
        save_rows(rows)
        print(f"predictions: {len(predictions)}")
        return 0
    return 2
