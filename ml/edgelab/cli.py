"""Command-line entry point for collection, training, prediction and sync."""
from __future__ import annotations

import argparse
import hashlib
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Any

from edgelab.storage import DEFAULT_STORE, load_rows, merge_rows, save_rows


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _coerce_dt(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


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


def run_daily(day: str, cutoff: str) -> dict[str, Any]:
    """Collect and synchronize only the two-day daily delta, then best-effort backfill."""
    target = date.fromisoformat(day)
    previous = (target - timedelta(days=1)).isoformat()
    collect_boat(previous, day)
    rows = load_rows()
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
    try:
        predictions = _predict_boat_date(rows, day, cutoff)
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        # A missing/legacy active artifact blocks inference only; daily data
        # collection, sync, and feedback must continue for recovery.
        predictions = []
        prediction_error = f"{type(exc).__name__}: {exc}"
    save_rows(rows)
    prev_ids = {r.get("id") for r in rows.get("races", []) if r.get("race_date") == previous}
    today_ids = {r.get("id") for r in rows.get("races", []) if r.get("race_date") == day}
    latest_runs = {}
    for run in rows.get("collection_runs", []):
        if run.get("target_date") in (previous, day) and run.get("sport") == "boat":
            latest_runs[run["target_date"]] = run
    run_ids = {r.get("id") for r in latest_runs.values()}
    payload = {
        "races": [r for r in rows.get("races", []) if r.get("id") in prev_ids | today_ids],
        "entries": [r for r in rows.get("entries", []) if r.get("race_id") in today_ids],
        "predictions": predictions,
        "results": [r for r in rows.get("results", []) if r.get("race_id") in prev_ids],
        "payouts": [r for r in rows.get("payouts", []) if r.get("race_id") in prev_ids],
        "collection_runs": [r for r in rows.get("collection_runs", []) if r.get("id") in run_ids],
        "venues": __import__("edgelab.venues", fromlist=["venue_rows"]).venue_rows(),
        "models": rows.get("models", []),
    }
    from edgelab.sync import sync_rows
    synced = sync_rows(payload)
    backfill: dict[str, Any]
    try:
        from edgelab.backfill_sync import run as backfill_run
        backfill = backfill_run(since="2026-07-01", until=(target - timedelta(days=1)).isoformat(),
                                budget=int(__import__("os").environ.get("BACKFILL_BUDGET", "35000")),
                                database="roi-plus")
    except Exception as exc:
        backfill = {"skipped": True, "reason": f"{type(exc).__name__}: {exc}"}
    from edgelab.learning import score_feedback
    learning_report = score_feedback(rows)
    return {"date": day, "cutoff": cutoff, "collected_dates": [previous, day],
            "predictions": len(predictions), "sync": synced, "backfill": backfill,
            "feedback_models": len(learning_report["models"]), "prediction_error": prediction_error}


def _make_training_rows(store: dict[str, list[dict[str, Any]]], sport: str) -> list[dict[str, Any]]:
    outcomes = {(row.get("race_id"), row.get("number")): row.get("finish_order")
                for row in store.get("results", []) if row.get("data_origin") == "real"}
    races = {row.get("id"): row for row in store.get("races", [])
             if row.get("sport") == sport and row.get("data_origin") == "real"}
    entries = [row for row in store.get("entries", [])
               if row.get("race_id") in races and row.get("data_origin") == "real"]
    if sport == "boat":
        from edgelab.features.boat import build_boat_features
        grouped: dict[str, list[dict[str, Any]]] = {}
        for entry in entries:
            grouped.setdefault(str(entry["race_id"]), []).append(entry)
        enriched = []
        for race_id, group in grouped.items():
            race = races[race_id]
            # Historical training uses B-file base features only. K-file exhibition
            # and weather fields are not assumed safe just because B availability is known.
            features = build_boat_features(group, race_date=race["race_date"])
            from edgelab.features.boat import FEATURE_COLUMNS
            enriched.extend({**{k: v for k, v in entry.items() if k not in FEATURE_COLUMNS}, **feature}
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
        if post_time:
            try:
                cutoff = datetime.fromisoformat(post_time.replace("Z", "+00:00")) - timedelta(minutes=10)
                row["predicted_at"] = cutoff.isoformat()
                # Default features use only program (B) data; K's pre-race fields
                # carry their own timestamp in features_json.pre_race_available_at.
                row["available_at"] = entry.get("available_at")
            except (TypeError, ValueError):
                pass
        result.append(row)
    return result


def collect_boat(start: str, end: str, *, max_requests: int | None = None) -> int:
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
                if not cache.is_file() and max_requests is not None and requests >= max_requests:
                    continue
                if not cache.is_file():
                    requests += 1
                path = fetch_boatrace_file(kind, day)
                if path is None:
                    existing = True
                    continue
                content = read_lzh(path)
                parsed = parser(content, race_date=day.isoformat())
                for table, values in parsed.items():
                    rows.setdefault(table, []).extend(values)
            except Exception as exc:  # each date gets a durable failure record
                errors.append(f"{kind}: {type(exc).__name__}: {exc}")
        # K's exhibit/ST fields are only usable from ten minutes before the
        # scheduled deadline. Reuse the official B timetable, never race-day
        # midnight, as their availability timestamp.
        scheduled = {race["id"]: race.get("post_time") for race in rows.get("races", [])
                     if race.get("post_time")}
        for race in rows.get("races", []):
            if race.get("status") == "finished" and race.get("id") in scheduled:
                race["post_time"] = scheduled[race["id"]]
        for entry in rows.get("entries", []):
            if entry.get("exhibition_time") is not None or entry.get("start_exhibition") is not None:
                post_time = scheduled.get(entry.get("race_id"))
                pre_race_at = None
                if post_time:
                    try:
                        pre_race_at = (datetime.fromisoformat(post_time.replace("Z", "+00:00"))
                                       - timedelta(minutes=10)).isoformat()
                    except ValueError:
                        pre_race_at = None
                # Keep the row-level available_at from the B program; record the
                # later availability of exhibition data separately.
                # 番組情報（選手・モーター等）は B と同じく開催日 0:00 時点で利用可能。
                # B が欠けた日でも ingest 必須項目が埋まるよう、pop せず同じ値を入れる。
                race_date = str(entry.get("race_id", ""))[5:13]
                entry["available_at"] = (f"{race_date[:4]}-{race_date[4:6]}-{race_date[6:]}T00:00:00+09:00"
                                         if len(race_date) == 8 and race_date.isdigit() else None)
                try:
                    extra = json.loads(entry.get("features_json") or "{}")
                except (TypeError, ValueError):
                    extra = {}
                extra["pre_race_available_at"] = pre_race_at
                entry["features_json"] = json.dumps(extra, ensure_ascii=False, separators=(",", ":"))
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


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="edgelab")
    sub = parser.add_subparsers(dest="command", required=True)
    collect = sub.add_parser("collect-boat", help="collect official boat-race B/K files")
    collect.add_argument("--from", dest="date_from", required=True)
    collect.add_argument("--to", dest="date_to", required=True)
    train = sub.add_parser("train", help="train an independent sport model")
    train.add_argument("--sport", choices=("boat", "horse"), required=True)
    predict = sub.add_parser("predict", help="predict races for a date")
    predict.add_argument("--sport", choices=("boat", "horse"), required=True)
    predict.add_argument("--date", required=True)
    predict.add_argument("--cutoff", help="ISO timestamp cutoff")
    sync = sub.add_parser("sync", help="sync local normalized rows to /api/ingest")
    sync.add_argument("--dry-run", action="store_true")
    sync.add_argument("--output-dir", default="ml/outbox")
    sync.add_argument("--tables", nargs="+", choices=("venues", "races", "entries", "results", "payouts", "odds_snapshots", "models", "predictions", "collection_runs"))
    backfill = sub.add_parser("backfill", help="collect a date range of boat data")
    backfill.add_argument("--from", dest="date_from", required=True)
    backfill.add_argument("--to", dest="date_to", required=True)
    bf = sub.add_parser("backfill-sync", help="send historical race days to D1 within the daily write budget")
    bf.add_argument("--since", required=True)
    bf.add_argument("--until")
    bf.add_argument("--budget", type=int, default=90_000, help="max rows_written_24h incl. current usage")
    bf.add_argument("--database", default="roi-plus")
    bf.add_argument("--dry-run", action="store_true")
    rebuild = sub.add_parser("rebuild", help="rebuild normalized rows from local raw Boatrace LZH files")
    rebuild.add_argument("--raw", default="data/raw/boatrace", help="directory containing cached B/K LZH files")
    live = sub.add_parser("live", help="collect today's program and near-deadline win odds")
    live.add_argument("--date", required=True)
    live.add_argument("--window-min", type=int, default=25)
    live.add_argument("--now", help="ISO timestamp")
    live.add_argument("--max-requests", type=int, default=30)
    daily = sub.add_parser("daily", help="run the idempotent daily boat pipeline")
    daily.add_argument("--date", default=None, help="JST date (defaults to today)")
    daily.add_argument("--now", help="ISO timestamp cutoff (defaults to current time)")
    sub.add_parser("feedback", help="score saved real predictions against completed outcomes")
    sub.add_parser("learn", help="train/evaluate a candidate after enough new real outcomes")
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
                   ("races", "entries", "results", "payouts", "odds_snapshots", "models", "predictions", "collection_runs")}
        payload["venues"] = venue_rows()
        if args.tables:
            payload = {key: payload[key] for key in args.tables if key in payload}
        print(json.dumps(sync_rows(payload, dry_run=args.dry_run, output_dir=args.output_dir), ensure_ascii=False))
        return 0
    if args.command == "train":
        from edgelab.models.train import train_model
        rows = load_rows()
        training_rows = _make_training_rows(rows, args.sport)
        dates = sorted({str(r.get("race_date")) for r in training_rows if r.get("race_date")})
        fingerprint = hashlib.sha256("|".join(dates + sorted({str(r.get("race_id")) for r in training_rows})).encode()).hexdigest()[:8]
        model_id = f"{args.sport}-win-lgbm-{datetime.now(timezone.utc):%Y%m%d}-{fingerprint}"
        result = train_model(training_rows, sport=args.sport,
                             model_id=model_id)
        model_row = {
            "id": result["id"], "sport": result.get("sport", args.sport),
            "bet_type": result.get("betType", "win"), "version": result.get("version", "v1"),
            "algorithm": result.get("algorithm", "LightGBM"), "status": result["status"],
            "train_from": result.get("trainFrom"), "train_to": result.get("trainTo"),
            "valid_from": result.get("validFrom"), "valid_to": result.get("validTo"),
            "test_from": result.get("testFrom"), "test_to": result.get("testTo"),
            "n_train": result.get("nTrain", 0),
            "metrics_json": json.dumps(result.get("metrics", {}), ensure_ascii=False),
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
