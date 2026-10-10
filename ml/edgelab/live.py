"""Idempotent daily live collection orchestration."""
from __future__ import annotations

import os
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from edgelab.storage import load_rows, merge_rows, save_rows

JST = ZoneInfo("Asia/Tokyo")
DISABLED_REASON = "ENABLE_BOATRACE_ODDS_SCRAPE が無効"


def select_odds_targets(races, snapshots, now: datetime, window_min: int = 25):
    """Return races due within the inclusive window, excluding final/recent odds."""
    recent_cutoff = now - timedelta(minutes=10)
    selected = []
    for race in races:
        try:
            post = datetime.fromisoformat(str(race["post_time"]).replace("Z", "+00:00"))
            if post.tzinfo is None:
                post = post.replace(tzinfo=JST)
            minutes = (post.astimezone(JST) - now.astimezone(JST)).total_seconds() / 60
        except (KeyError, TypeError, ValueError):
            continue
        if not 0 <= minutes <= window_min:
            continue
        race_id = race.get("id")
        existing = [row for row in snapshots if row.get("race_id") == race_id and row.get("bet_type") == "win"]
        if any(str(row.get("source", "")).endswith("-final") for row in existing):
            continue
        recent = False
        for row in existing:
            try:
                captured = datetime.fromisoformat(str(row["captured_at"]).replace("Z", "+00:00"))
                if captured.tzinfo is None:
                    captured = captured.replace(tzinfo=JST)
                recent |= captured >= recent_cutoff
            except (KeyError, TypeError, ValueError):
                continue
        if not recent:
            selected.append(race)
    return selected


def _models_for_live(rows):
    return [m for m in rows.get("models", [])
            if m.get("sport") == "boat" and m.get("status") == "active"]


def run_live(target_date: str, *, window_min: int = 25, now: str | None = None,
             max_requests: int = 30) -> dict:
    day = date.fromisoformat(target_date)
    if window_min < 0 or max_requests < 0:
        raise ValueError("window and request limit must be non-negative")
    current = datetime.fromisoformat(now.replace("Z", "+00:00")) if now else datetime.now(JST)
    if current.tzinfo is None:
        current = current.replace(tzinfo=JST)
    current = current.astimezone(JST)
    store = load_rows()
    delta = {key: [] for key in ("races", "entries", "odds_snapshots", "predictions", "collection_runs")}
    from edgelab.cli import collect_boat
    from pathlib import Path
    raw_requests = sum(not (Path("data/raw/boatrace") / f"{kind}{day:%y%m%d}.lzh").is_file()
                       for kind in ("b", "k"))
    collect_boat(day.isoformat(), day.isoformat(), max_requests=max_requests)
    store = load_rows()
    races = [r for r in store.get("races", []) if r.get("sport") == "boat" and r.get("race_date") == day.isoformat()]
    race_ids = {r.get("id") for r in races}
    delta["races"] = races
    delta["entries"] = [e for e in store.get("entries", []) if e.get("race_id") in race_ids]
    if os.environ.get("ENABLE_BOATRACE_ODDS_SCRAPE") != "true":
        delta["collection_runs"].append({"id": str(uuid.uuid4()), "source": "boatrace-odds", "sport": "boat",
            "target_date": day.isoformat(), "started_at": current.isoformat(timespec="seconds"),
            "finished_at": datetime.now(JST).isoformat(timespec="seconds"), "status": "skipped", "records": 0,
            "error": None, "reason": DISABLED_REASON})
        merge_rows(store, delta)
        save_rows(store)
        if os.environ.get("EDGELAB_API_URL"):
            from edgelab.sync import sync_rows
            sync_rows(delta)
        return {"status": "skipped", "reason": DISABLED_REASON, "requests": min(max_requests, raw_requests)}
    targets = select_odds_targets(races, store.get("odds_snapshots", []), current, window_min)
    remaining = max_requests
    remaining = max(0, max_requests - raw_requests)
    from edgelab.collectors.boatrace_odds import fetch_win_odds, make_snapshot_rows, parse_win_odds
    for race in targets[:remaining]:
        venue = str(race.get("venue_id", ""))
        race_no = race.get("race_no")
        if not (venue.isdigit() and len(venue) == 2 and race_no):
            continue
        html = fetch_win_odds(race_no, venue, day)
        if not html:
            continue
        parsed = parse_win_odds(html)
        captured = datetime.now(JST).isoformat(timespec="seconds")
        delta["odds_snapshots"].extend(make_snapshot_rows(str(race["id"]), parsed, captured))

    # Do not trust cached active status for this live entrypoint. If the
    # authenticated registry is unavailable, skip prediction rather than use a
    # stale or candidate artifact.
    if os.environ.get("EDGELAB_API_URL") and os.environ.get("INGEST_TOKEN"):
        from edgelab.sync import fetch_model_registry
        from edgelab.cli import _apply_model_registry
        _apply_model_registry(store, fetch_model_registry())
    else:
        store["models"] = []

    # Only the active model can drive live predictions; candidates are evaluation-only.
    models = _models_for_live(store)
    prediction_error = None
    if not models:
        prediction_error = "no authoritative active model; candidate models are evaluation-only"
    if models:
        from edgelab.predict import load_artifact, predict_rows
        from edgelab.features.boat import build_boat_features
        model = models[0]
        artifact_path = __import__("pathlib").Path("ml/artifacts") / f"{model['id']}.pkl"
        if artifact_path.is_file():
            try:
                artifact = load_artifact(artifact_path)
                existing = {(p.get("race_id"), p.get("model_id")) for p in store.get("predictions", [])}
                target_ids = {r.get("id") for r in targets[:remaining]}
                for race in races:
                    if race.get("id") not in target_ids:
                        continue
                    if (race.get("id"), model["id"]) in existing:
                        continue
                    entries = [e for e in store.get("entries", []) if e.get("race_id") == race.get("id")
                               and e.get("data_origin") == "real"]
                    enriched = [dict(e) for e in entries]
                    features = build_boat_features(enriched, race_date=day.isoformat(), predicted_at=current.isoformat())
                    from edgelab.features.boat import FEATURE_COLUMNS
                    model_rows = [{**{k: v for k, v in e.items() if k not in FEATURE_COLUMNS}, **f}
                                  for e, f in zip(enriched, features)]
                    delta["predictions"].extend(predict_rows(model_rows,
                                                            artifact, predicted_at=current.isoformat()))
            except (ValueError, FileNotFoundError) as exc:
                prediction_error = f"{type(exc).__name__}: {exc}"
        else:
            prediction_error = f"active artifact missing: {artifact_path}"
    # Preserve just this date's B/K rows in the outbound delta.
    delta["collection_runs"].append({"id": str(uuid.uuid4()), "source": "boatrace-odds", "sport": "boat",
        "target_date": day.isoformat(), "started_at": current.isoformat(timespec="seconds"),
        "finished_at": datetime.now(JST).isoformat(timespec="seconds"), "status": "partial" if prediction_error else "success", "records":
        len(delta["odds_snapshots"]) + len(delta["predictions"]), "error": prediction_error, "reason": prediction_error})
    merge_rows(store, delta)
    save_rows(store)
    if os.environ.get("EDGELAB_API_URL"):
        from edgelab.sync import sync_rows
        sync_rows(delta)
    return {"status": "success", "requests": min(max_requests, raw_requests + min(len(targets), remaining)),
            "races": len(races), "odds_snapshots": len(delta["odds_snapshots"]),
            "predictions": len(delta["predictions"]), "prediction_error": prediction_error}
