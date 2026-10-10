#!/usr/bin/env python3
"""Generate and locally dry-run one guarded Boatrace D1 repair SQL file.

The script never connects to Cloudflare or mutates its input database. It takes
an offline clean normalized B/K store and a safe-table JSON backup, writes one
SQL file for a single explicitly selected race date, and verifies that file on
a private SQLite clone of the backup.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
import shutil
import sqlite3
import tempfile
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db" / "migrations"
SCHEMA_TABLES = ("venues", "races", "entries", "odds_snapshots", "results", "payouts", "models", "predictions", "bets", "collection_runs", "daily_summaries", "settings")
REPAIR_TABLES = ("races", "entries", "results", "payouts", "odds_snapshots", "predictions", "bets")
REPAIR_VENUES = {"09", "23"}
RACE_COLUMNS = ("id", "sport", "venue_id", "race_date", "race_no", "name", "distance", "surface", "track_condition", "weather", "wind_speed", "wave_height", "post_time", "status", "data_origin")
ENTRY_COLUMNS = ("id", "race_id", "number", "frame", "name", "jockey", "trainer", "weight_carried", "horse_weight", "racer_class", "national_win_rate", "local_win_rate", "motor_no", "motor_2rate", "boat_no", "boat_2rate", "exhibition_time", "start_exhibition", "features_json", "available_at", "data_origin")
RESULT_COLUMNS = ("race_id", "finish_order", "number", "data_origin")
PAYOUT_COLUMNS = ("race_id", "bet_type", "selection", "payout", "popularity", "data_origin")
ODDS_COLUMNS = ("id", "race_id", "bet_type", "selection", "odds", "captured_at", "source", "data_origin")
PREDICTION_COLUMNS = ("id", "race_id", "model_id", "number", "probability", "prob_std", "predicted_at", "data_origin")
BET_COLUMNS = ("id", "race_id", "sport", "bet_type", "selection", "stake", "mode", "predicted_prob", "odds_at_bet", "expected_roi", "edge_label", "model_id", "placed_at", "status", "payout", "profit", "final_odds", "settled_at", "ev_lost", "data_origin")
JSON_ROWS = {"races": RACE_COLUMNS, "entries": ENTRY_COLUMNS, "results": RESULT_COLUMNS, "payouts": PAYOUT_COLUMNS}
PK_COLUMNS = {"races": ("id",), "entries": ("race_id", "number"), "results": ("race_id", "number"), "payouts": ("race_id", "bet_type", "selection"), "odds_snapshots": ("id",), "predictions": ("id",), "bets": ("id",)}
BET_TYPES = {"win", "place", "quinella", "exacta", "wide", "trio", "trifecta"}
SOURCE_FILE_RE = re.compile(r"^([bk])(\d{6})\.lzh$", re.I)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sql(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite number in repair source")
        return repr(value)
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    raise ValueError(f"unsupported SQLite value type: {type(value).__name__}")


def row_values(row: dict[str, Any], columns: Iterable[str]) -> str:
    return ",".join(sql(row.get(c)) for c in columns)


def qident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _date(value: str) -> str:
    return date.fromisoformat(value).isoformat()


def source_hashes(store: dict[str, Any], target_date: str) -> dict[str, dict[str, str]]:
    """Hash exact locally cached daily B/K bytes without exposing their paths."""
    expected_stamp = date.fromisoformat(target_date).strftime("%y%m%d")
    found: dict[str, dict[str, str]] = {}
    for path_value in store.get("sourceFiles", []):
        if not isinstance(path_value, str):
            continue
        path = Path(path_value)
        match = SOURCE_FILE_RE.fullmatch(path.name)
        if not match or match.group(2) != expected_stamp:
            continue
        kind = match.group(1).lower()
        if kind in found:
            raise ValueError(f"multiple cached {kind.upper()} sources match {target_date}")
        if not path.is_file():
            raise ValueError(f"cached {kind.upper()} source bytes are unavailable for {target_date}")
        found[kind] = {"filename": path.name, "sha256": digest_bytes(path.read_bytes()), "_path": str(path)}
    if set(found) != {"b", "k"}:
        raise ValueError(f"exact cached B and K source bytes are required for {target_date}")
    return found


def reparse_and_match(clean_store: dict[str, Any], target_date: str, held_venues: set[str], expected: dict[str, list[dict[str, Any]]], source: dict[str, dict[str, str]]) -> None:
    """Reparse the exact hashed LZH bytes; the normalized cache is not self-authenticating."""
    from sys import path as sys_path
    sys_path.insert(0, str(ROOT / "ml"))
    try:
        from edgelab.collectors.boatrace import read_lzh
        from edgelab.parsers.boatrace_b import parse_b
        from edgelab.parsers.boatrace_k import parse_k
        from edgelab.storage import merge_rows
        reparsed: dict[str, list[dict[str, Any]]] = {table: [] for table in JSON_ROWS}
        for kind, parser in (("b", parse_b), ("k", parse_k)):
            text = read_lzh(source[kind]["_path"])
            merge_rows(reparsed, parser(text, race_date=target_date))
        source_venues = {str(r.get("venue_id")) for r in reparsed["races"] if r.get("race_date") == target_date and str(r.get("venue_id")) in REPAIR_VENUES}
        if source_venues != held_venues:
            raise ValueError(f"reparsed official B/K venue set differs from explicit held venues for {target_date}")
        clean: dict[str, list[dict[str, Any]]] = {table: [] for table in JSON_ROWS}
        clean_ids = {r["id"] for r in expected["races"]}
        for table in JSON_ROWS:
            rows = reparsed[table]
            if table == "races":
                rows = [r for r in rows if r.get("id") in clean_ids]
            else:
                rows = [r for r in rows if r.get("race_id") in clean_ids]
            clean[table] = [{c: row.get(c) for c in JSON_ROWS[table]} for row in rows]
            # `closed` is a local safety downgrade for incomplete result cards;
            # the official K parser still records its source status as finished.
            if table == "races":
                for row in clean[table]:
                    if row.get("status") == "finished":
                        row["status"] = "finished"
            clean[table].sort(key=lambda r: tuple(str(r.get(k, "")) for k in PK_COLUMNS[table]))
        expected_source = copy.deepcopy(expected)
        for row in expected_source["races"]:
            if row.get("status") == "closed":
                row["status"] = "finished"
        if canonical_json(clean) != canonical_json(expected_source):
            raise ValueError(f"normalized clean-store rows do not match reparsing the exact B/K bytes for {target_date}")
    finally:
        if sys_path[0] == str(ROOT / "ml"):
            sys_path.pop(0)


def select_clean_rows(store: dict[str, Any], target_date: str, held_venues: set[str]) -> dict[str, list[dict[str, Any]]]:
    if store.get("networkAccess") is not False or store.get("existingStoreModified") is not False:
        raise ValueError("clean-store provenance must assert offline operation and no source-store mutation")
    rows = store.get("rows")
    if not isinstance(rows, dict):
        raise ValueError("normalized clean-store rows are missing")
    all_races = rows.get("races", [])
    target_races = [r for r in all_races if r.get("sport") == "boat" and r.get("data_origin") == "real" and r.get("race_date") == target_date and str(r.get("venue_id")) in held_venues]
    if not target_races:
        raise ValueError(f"clean store has no held races for {target_date} at the explicitly expected venues")
    by_race = {r["id"]: r for r in target_races}
    if len(by_race) != len(target_races):
        raise ValueError("duplicate clean race IDs")
    for venue in held_venues:
        venue_races = [r for r in target_races if str(r.get("venue_id")) == venue]
        if {int(r.get("race_no", 0)) for r in venue_races} != set(range(1, 13)):
            raise ValueError(f"official B snapshot is not a complete 1-12 race card for held venue {venue}")
    scoped = {table: [] for table in JSON_ROWS}
    scoped["races"] = target_races
    for table in ("entries", "results", "payouts"):
        for row in rows.get(table, []):
            if row.get("race_id") in by_race:
                scoped[table].append(row)
    entries_by_race: dict[str, list[dict[str, Any]]] = defaultdict(list)
    results_by_race: dict[str, list[dict[str, Any]]] = defaultdict(list)
    payouts_by_race: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in scoped["entries"]: entries_by_race[row["race_id"]].append(row)
    for row in scoped["results"]: results_by_race[row["race_id"]].append(row)
    for row in scoped["payouts"]: payouts_by_race[row["race_id"]].append(row)
    for race_id, race in by_race.items():
        if not re.fullmatch(rf"boat-{target_date.replace('-', '')}-{re.escape(str(race['venue_id']))}-{int(race['race_no']):02d}", str(race.get("id", ""))):
            raise ValueError(f"race ID/date/venue identity mismatch: {race_id}")
        if not race.get("post_time") or race.get("data_origin") != "real" or race.get("status") not in {"finished", "closed"}:
            raise ValueError(f"race lacks a complete historical B/K record: {race_id}")
        entries = entries_by_race[race_id]
        if len(entries) != 6 or {int(e.get("number", 0)) for e in entries} != set(range(1, 7)):
            raise ValueError(f"B entry set is not exactly six lanes: {race_id}")
        if any(e.get("data_origin") != "real" or e.get("race_id") != race_id or not e.get("available_at") for e in entries):
            raise ValueError(f"B entry provenance is incomplete: {race_id}")
        results = results_by_race[race_id]
        if not 1 <= len(results) <= 6 or len({int(r.get("number", 0)) for r in results}) != len(results):
            raise ValueError(f"K result set is incomplete or malformed: {race_id}")
        if any(r.get("data_origin") != "real" or r.get("race_id") != race_id or int(r.get("number", 0)) not in range(1, 7) or int(r.get("finish_order", 0)) not in range(1, 7) for r in results):
            raise ValueError(f"K result provenance or lane/rank is invalid: {race_id}")
        if len({int(r["finish_order"]) for r in results}) != len(results):
            raise ValueError(f"duplicate/ambiguous K finish ranks are unsupported: {race_id}")
        payouts = payouts_by_race[race_id]
        if not payouts or any(p.get("data_origin") != "real" or p.get("race_id") != race_id or p.get("bet_type") not in BET_TYPES or int(p.get("payout", -1)) < 0 for p in payouts):
            raise ValueError(f"K payout set is empty or malformed: {race_id}")
        keys = {(p["bet_type"], str(p["selection"])) for p in payouts}
        if len(keys) != len(payouts):
            raise ValueError(f"duplicate normalized K payout keys: {race_id}")
        winners = {str(r["number"]) for r in results if int(r["finish_order"]) == 1}
        win_selections = {str(p["selection"]) for p in payouts if p["bet_type"] == "win" and int(p["payout"]) > 0}
        if not winners or win_selections != winners:
            raise ValueError(f"K result winners and positive win payouts disagree: {race_id}")
        ordered_top = [str(r["number"]) for r in sorted(results, key=lambda x: (int(x["finish_order"]), int(x["number"]))) if int(r["finish_order"]) in (1, 2, 3)]
        positive_trifecta = [str(p["selection"]) for p in payouts if p["bet_type"] == "trifecta" and int(p["payout"]) > 0]
        if len(ordered_top) == 3 and len(set(int(r["finish_order"]) for r in results)) >= 3:
            if len(positive_trifecta) != 1 or positive_trifecta[0] != "-".join(ordered_top):
                raise ValueError(f"K trifecta payout must be exactly the unique ordered top-three result: {race_id}")
        # Non-finishers/dead heats remain closed, never falsely restored as settled races.
        complete_result = len(results) == 6 and {int(r["finish_order"]) for r in results} == set(range(1, 7))
        if complete_result:
            race["status"] = "finished"
        else:
            race["status"] = "closed"
    for table, cols in JSON_ROWS.items():
        scoped[table] = [{col: r.get(col) for col in cols} for r in scoped[table]]
        scoped[table].sort(key=lambda r: tuple(str(r.get(k, "")) for k in PK_COLUMNS[table]))
    return scoped


def source_snapshot_sha(rows: dict[str, list[dict[str, Any]]]) -> str:
    return digest_bytes(canonical_json(rows).encode("utf-8"))


def archive_sql(repair_id: str, b_sha: str, k_sha: str, snapshot_sha: str,
                archive_columns: dict[str, list[str]], scope_table: str) -> list[str]:
    statements = [
        "CREATE TABLE IF NOT EXISTS data_repair_archive (repair_id TEXT NOT NULL, table_name TEXT NOT NULL, race_id TEXT NOT NULL, row_key TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), source_b_sha256 TEXT NOT NULL, source_k_sha256 TEXT NOT NULL, normalized_snapshot_sha256 TEXT NOT NULL, archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(repair_id,table_name,row_key));",
        "CREATE TABLE IF NOT EXISTS data_repair_audit_marks (repair_id TEXT NOT NULL, race_id TEXT NOT NULL, record_type TEXT NOT NULL CHECK(record_type IN ('bet','prediction')), record_id TEXT NOT NULL, reason TEXT NOT NULL, marked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(repair_id,record_type,record_id));",
        "CREATE TABLE IF NOT EXISTS data_repair_quarantined_races (race_id TEXT PRIMARY KEY REFERENCES races(id), repair_id TEXT NOT NULL, reason TEXT NOT NULL, marked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);",
        "CREATE TABLE IF NOT EXISTS data_repair_runs (repair_id TEXT PRIMARY KEY, race_date TEXT NOT NULL, held_venues_json TEXT NOT NULL, source_b_sha256 TEXT NOT NULL, source_k_sha256 TEXT NOT NULL, normalized_snapshot_sha256 TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);",
        f"INSERT OR IGNORE INTO data_repair_runs(repair_id,race_date,held_venues_json,source_b_sha256,source_k_sha256,normalized_snapshot_sha256) VALUES({sql(repair_id)},'__DATE__','__VENUES__',{sql(b_sha)},{sql(k_sha)},{sql(snapshot_sha)});",
    ]
    for table in REPAIR_TABLES:
        cols = archive_columns.get(table, [])
        alias = "x"
        key_cols = PK_COLUMNS[table]
        row_key = " || ':' || ".join(f"COALESCE(CAST({alias}.{qident(c)} AS TEXT),'∅')" for c in key_cols)
        json_args = ",".join(f"'{c}',{alias}.{qident(c)}" for c in cols)
        race_expr = f"{alias}.id" if table == "races" else f"{alias}.race_id"
        where = f"{race_expr} IN (SELECT race_id FROM {qident(scope_table)})"
        statements.append(
            f"INSERT OR IGNORE INTO data_repair_archive(repair_id,table_name,race_id,row_key,payload_json,source_b_sha256,source_k_sha256,normalized_snapshot_sha256) "
            f"SELECT {sql(repair_id)},{sql(table)},{race_expr},{row_key},json_object({json_args}),{sql(b_sha)},{sql(k_sha)},{sql(snapshot_sha)} FROM {qident(table)} {alias} WHERE {where};"
        )
    reason = "race data source corrected; original forecast/purchase remains immutable and is excluded from clean revalidation pending review"
    statements += [
        f"DELETE FROM data_repair_quarantined_races WHERE race_id IN (SELECT race_id FROM {qident(scope_table)} WHERE disposition='replace');",
        f"INSERT OR REPLACE INTO data_repair_quarantined_races(race_id,repair_id,reason) SELECT race_id,{sql(repair_id)},'race absent from the exact authoritative held-venue B/K source snapshot' FROM {qident(scope_table)} WHERE disposition='quarantine';",
        f"INSERT OR IGNORE INTO data_repair_audit_marks(repair_id,race_id,record_type,record_id,reason) SELECT {sql(repair_id)},p.race_id,'prediction',p.id,{sql(reason)} FROM predictions p WHERE p.race_id IN (SELECT race_id FROM {qident(scope_table)});",
        f"INSERT OR IGNORE INTO data_repair_audit_marks(repair_id,race_id,record_type,record_id,reason) SELECT {sql(repair_id)},b.race_id,'bet',b.id,{sql(reason)} FROM bets b WHERE b.race_id IN (SELECT race_id FROM {qident(scope_table)});",
    ]
    return statements


def generate_sql(target_date: str, held_venues: set[str], rows: dict[str, list[dict[str, Any]]], existing_ids: list[str], source: dict[str, dict[str, str]], repair_id: str, archive_columns: dict[str, list[str]]) -> str:
    snap_sha = source_snapshot_sha(rows)
    suffix = re.sub(r"[^a-zA-Z0-9_]", "_", repair_id)
    targets, scope, expected, guard = (f"_repair_targets_{suffix}", f"_repair_scope_{suffix}", f"_repair_expected_{suffix}", f"_repair_guard_{suffix}")
    q_targets, q_scope, q_expected, q_guard = map(qident, (targets, scope, expected, guard))
    stmt = ["-- Generated offline; execute only after separately reviewing the paired report.",
            "-- Do not add explicit BEGIN/COMMIT: Wrangler D1 file execution is atomic and wraps SQL in a transaction.",
            "-- D1 does not support TEMP tables: uniquely named ordinary guard tables are created without IF NOT EXISTS (collision fails closed) and dropped at the end.",
            f"CREATE TABLE {q_targets}(race_id TEXT PRIMARY KEY,venue_id TEXT NOT NULL,race_no INTEGER NOT NULL);",
            f"CREATE TABLE {q_scope}(race_id TEXT PRIMARY KEY,disposition TEXT NOT NULL CHECK(disposition IN ('replace','quarantine')));",
            f"CREATE TABLE {q_expected}(race_id TEXT PRIMARY KEY);"]
    for race in rows["races"]:
        stmt.append(f"INSERT INTO {q_targets} VALUES({sql(race['id'])},{sql(str(race['venue_id']))},{int(race['race_no'])});")
        stmt.append(f"INSERT INTO {q_scope} VALUES({sql(race['id'])},'replace');")
    for race_id in existing_ids:
        # Existing venue/date IDs are preflighted from the source backup; the SQL guard
        # prevents a stale plan from applying after an unexpected concurrent change.
        stmt.append(f"INSERT INTO {q_expected} VALUES({sql(race_id)});")
    existing_predicate = f"sport='boat' AND data_origin='real' AND race_date={sql(target_date)} AND venue_id IN ('09','23')"
    stmt += [
        f"CREATE TABLE {q_guard}(ok INTEGER NOT NULL CHECK(ok=1));",
        f"INSERT INTO {q_guard} SELECT CASE WHEN (SELECT COUNT(*) FROM races WHERE {existing_predicate})=(SELECT COUNT(*) FROM {q_expected}) AND NOT EXISTS(SELECT id FROM races WHERE {existing_predicate} EXCEPT SELECT race_id FROM {q_expected}) AND NOT EXISTS(SELECT race_id FROM {q_expected} EXCEPT SELECT id FROM races WHERE {existing_predicate}) THEN 1 ELSE 0 END;",
        f"INSERT INTO {q_guard} SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM {q_targets} t JOIN races r ON r.id=t.race_id WHERE r.sport<>'boat' OR r.venue_id<>t.venue_id OR r.race_date<>{sql(target_date)} OR r.race_no<>t.race_no OR r.data_origin<>'real') AND NOT EXISTS(SELECT 1 FROM races r JOIN {q_targets} t ON r.sport='boat' AND r.venue_id=t.venue_id AND r.race_date={sql(target_date)} AND r.race_no=t.race_no WHERE r.id<>t.race_id) THEN 1 ELSE 0 END;",
        f"INSERT INTO {q_guard} SELECT CASE WHEN (SELECT COUNT(DISTINCT id) FROM venues WHERE id IN ({','.join(sql(v) for v in sorted(held_venues))}) AND sport='boat')={len(held_venues)} THEN 1 ELSE 0 END;",
        f"INSERT OR IGNORE INTO {q_scope} SELECT r.id,'quarantine' FROM races r WHERE {existing_predicate} AND NOT EXISTS(SELECT 1 FROM {q_targets} t WHERE t.race_id=r.id);",
    ]
    # Archive all original source/forecast/ledger rows before any replacement.
    archive = archive_sql(repair_id, source["b"]["sha256"], source["k"]["sha256"], snap_sha, archive_columns, scope)
    for line in archive:
        stmt.append(line.replace("'__DATE__'", sql(target_date)).replace("'__VENUES__'", sql(canonical_json(sorted(held_venues)))))
    stmt += [
        f"UPDATE races SET status='closed',updated_at=CURRENT_TIMESTAMP WHERE id IN (SELECT race_id FROM {q_scope} WHERE disposition='quarantine');",
        f"DELETE FROM entries WHERE race_id IN (SELECT race_id FROM {q_scope});",
        f"DELETE FROM results WHERE race_id IN (SELECT race_id FROM {q_scope});",
        f"DELETE FROM payouts WHERE race_id IN (SELECT race_id FROM {q_scope});",
    ]
    racecols = ",".join(qident(c) for c in RACE_COLUMNS)
    insertcols = racecols + ',"updated_at"'
    for race in rows["races"]:
        vals = row_values(race, RACE_COLUMNS) + ",CURRENT_TIMESTAMP"
        update = [f"{qident(c)}=excluded.{qident(c)}" for c in RACE_COLUMNS if c != "id"] + ['"updated_at"=CURRENT_TIMESTAMP']
        stmt.append(f"INSERT INTO races({insertcols}) VALUES({vals}) ON CONFLICT(id) DO UPDATE SET {','.join(update)};")
    for table, columns in (("entries", ENTRY_COLUMNS), ("results", RESULT_COLUMNS), ("payouts", PAYOUT_COLUMNS)):
        cols = ",".join(qident(c) for c in columns)
        for row in rows[table]:
            stmt.append(f"INSERT INTO {qident(table)}({cols}) VALUES({row_values(row, columns)});")
    stmt.extend([f"DROP TABLE {q_guard};", f"DROP TABLE {q_expected};", f"DROP TABLE {q_scope};", f"DROP TABLE {q_targets};"])
    return "\n".join(stmt) + "\n"


def db_rows(snapshot: dict[str, Any], table: str) -> list[dict[str, Any]]:
    return snapshot.get(table, [])


def load_backup_db(db: sqlite3.Connection, snapshot: dict[str, Any]) -> None:
    db.execute("PRAGMA foreign_keys=ON")
    for migration in sorted(MIGRATIONS.glob("000[1-3]_*.sql")):
        db.executescript(migration.read_text(encoding="utf-8"))
    # Static venue labels are part of the product's non-sensitive master data.
    from sys import path as sys_path
    sys_path.insert(0, str(ROOT / "ml"))
    try:
        from edgelab.venues import venue_rows
        venue_data = venue_rows()
    finally:
        if sys_path[0] == str(ROOT / "ml"):
            sys_path.pop(0)
    insert_rows(db, "venues", venue_data)
    for table in ("races", "entries", "odds_snapshots", "results", "payouts", "models", "predictions", "bets", "collection_runs"):
        insert_rows(db, table, db_rows(snapshot, table))


def insert_rows(db: sqlite3.Connection, table: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    allowed = {r[1] for r in db.execute(f"PRAGMA table_info({qident(table)})")}
    for row in rows:
        cols = [k for k in row if k in allowed]
        if not cols:
            continue
        db.execute(f"INSERT INTO {qident(table)}({','.join(qident(c) for c in cols)}) VALUES({','.join('?' for _ in cols)})", [row[k] for k in cols])


def scoped_fingerprints(db: sqlite3.Connection, race_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not race_ids:
        return {t: {"rows": 0, "sha256": digest_bytes(b"[]")} for t in REPAIR_TABLES}
    placeholders = ",".join("?" for _ in race_ids)
    output: dict[str, dict[str, Any]] = {}
    for table in REPAIR_TABLES:
        key = "id" if table == "races" else "race_id"
        columns = [x[1] for x in db.execute(f"PRAGMA table_info({qident(table)})")]
        rows = [dict(row) for row in db.execute(f"SELECT * FROM {qident(table)} WHERE {qident(key)} IN ({placeholders}) ORDER BY {','.join(qident(c) for c in columns)}", race_ids)]
        output[table] = {"rows": len(rows), "sha256": digest_bytes(canonical_json(rows).encode("utf-8"))}
    return output


def execute_sql_atomic(db: sqlite3.Connection, text: str) -> None:
    db.execute("BEGIN")
    statements: list[str] = []
    buffer = ""
    try:
        for line in text.splitlines():
            if line.lstrip().startswith("--"):
                continue
            buffer += line + "\n"
            if sqlite3.complete_statement(buffer):
                statement = buffer.strip()
                if statement:
                    statements.append(statement)
                buffer = ""
        if buffer.strip():
            raise ValueError("generated SQL ended with an incomplete statement")
        for statement in statements:
            db.execute(statement)
        db.commit()
    except Exception:
        db.rollback()
        raise


def plan(snapshot_path: Path, backup_path: Path, target_date: str, held_venues: set[str], out_dir: Path) -> dict[str, Any]:
    clean_store = json.loads(snapshot_path.read_text(encoding="utf-8"))
    backup = json.loads(backup_path.read_text(encoding="utf-8"))
    target_date = _date(target_date)
    if not held_venues or not held_venues <= REPAIR_VENUES:
        raise ValueError("held venues must be an explicit non-empty subset of 09 and 23")
    source = source_hashes(clean_store, target_date)
    rows = select_clean_rows(clean_store, target_date, held_venues)
    source_venues = {str(r.get("venue_id")) for r in clean_store.get("rows", {}).get("races", []) if r.get("sport") == "boat" and r.get("data_origin") == "real" and r.get("race_date") == target_date and str(r.get("venue_id")) in REPAIR_VENUES}
    if source_venues != held_venues:
        raise ValueError(f"held venues must enumerate all authoritative 09/23 venues present in the B/K snapshot for {target_date}")
    reparse_and_match(clean_store, target_date, held_venues, rows, source_hashes(clean_store, target_date))
    snap_sha = source_snapshot_sha(rows)
    existing = [r for r in backup.get("races", []) if r.get("sport") == "boat" and r.get("data_origin") == "real" and r.get("race_date") == target_date and str(r.get("venue_id")) in REPAIR_VENUES]
    for race in existing:
        venue, race_no = str(race.get("venue_id")), int(race.get("race_no", 0))
        expected_id = f"boat-{target_date.replace('-', '')}-{venue}-{race_no:02d}"
        if venue not in REPAIR_VENUES or race_no not in range(1, 13) or str(race.get("id")) != expected_id:
            raise ValueError("production snapshot contains a noncanonical target-date race row; refusing automatic quarantine")
    existing_ids = sorted(str(r["id"]) for r in existing)
    target_ids = {r["id"] for r in rows["races"]}
    quarantine = sorted(str(r["id"]) for r in existing if r["id"] not in target_ids)
    scope_ids = sorted(target_ids | set(quarantine))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    repair_id = f"boat-repair-{target_date.replace('-', '')}-{snap_sha[:12]}-{stamp}"
    declared_columns = backup.get("schemaColumns", {})
    archive_columns = {
        table: sorted(set(declared_columns.get(table, [])) | {key for row in backup.get(table, []) for key in row})
        for table in REPAIR_TABLES
    }
    sql_text = generate_sql(target_date, held_venues, rows, existing_ids, source, repair_id, archive_columns)
    out_dir.mkdir(parents=True, exist_ok=True)
    sql_path = out_dir / f"boatrace-repair-{target_date}.sql"
    report_path = out_dir / f"boatrace-repair-{target_date}.report.json"
    # Never overwrite a previous repair plan/report: each archive key is unique.
    if sql_path.exists() or report_path.exists():
        raise FileExistsError("repair output already exists; choose a new output directory")
    sql_path.write_text(sql_text, encoding="utf-8")

    fd, db_path = tempfile.mkstemp(prefix="roi-repair-dryrun-", suffix=".sqlite")
    import os
    os.close(fd)
    try:
        local_db = sqlite3.connect(db_path)
        local_db.row_factory = sqlite3.Row
        load_backup_db(local_db, backup)
        local_db.commit()
        pre = scoped_fingerprints(local_db, scope_ids)
        affected_bets = [dict(x) for x in local_db.execute(f"SELECT id,race_id,bet_type,selection,stake,status,model_id,placed_at FROM bets WHERE race_id IN ({','.join('?' for _ in scope_ids)}) ORDER BY placed_at,id", scope_ids)] if scope_ids else []
        affected_predictions = [dict(x) for x in local_db.execute(f"SELECT id,race_id,model_id,number,predicted_at,data_origin FROM predictions WHERE race_id IN ({','.join('?' for _ in scope_ids)}) ORDER BY predicted_at,id", scope_ids)] if scope_ids else []
        execute_sql_atomic(local_db, sql_text)
        post = scoped_fingerprints(local_db, scope_ids)
        # The ledger and predictions must remain byte-for-byte unchanged by repair.
        if pre["bets"] != post["bets"] or pre["predictions"] != post["predictions"]:
            raise AssertionError("repair SQL mutated immutable historical bets or predictions")
        mark_counts = {kind: local_db.execute(f"SELECT COUNT(DISTINCT record_id) FROM data_repair_audit_marks WHERE record_type=? AND race_id IN ({','.join('?' for _ in scope_ids)})", (kind, *scope_ids)).fetchone()[0] if scope_ids else 0 for kind in ("bet", "prediction")}
        if mark_counts != {"bet": len(affected_bets), "prediction": len(affected_predictions)}:
            raise AssertionError("repair audit marks do not cover the exact affected bet/prediction IDs")
        new_status = {r["id"]: r["status"] for r in rows["races"]}
        for race_id in quarantine:
            race = local_db.execute("SELECT status FROM races WHERE id=?", (race_id,)).fetchone()
            if race is None or race["status"] != "closed":
                raise AssertionError(f"quarantined race was not retained closed: {race_id}")
        marked_quarantine = sorted(x[0] for x in local_db.execute("SELECT race_id FROM data_repair_quarantined_races WHERE repair_id=?", (repair_id,)))
        if marked_quarantine != quarantine:
            raise AssertionError("persistent phantom-race quarantine markers do not match exact stale race IDs")
        for race_id, status in new_status.items():
            result = local_db.execute("SELECT status,post_time FROM races WHERE id=?", (race_id,)).fetchone()
            if result is None or result["status"] != status:
                raise AssertionError(f"authoritative race status mismatch after repair: {race_id}")
            if result["post_time"] != next(r["post_time"] for r in rows["races"] if r["id"] == race_id):
                raise AssertionError(f"B-file post time mismatch after repair: {race_id}")
        report = {
            "repairId": repair_id,
            "raceDate": target_date,
            "heldVenues": sorted(held_venues),
            "affectedDates": [target_date],
            "quarantinedRaceIds": quarantine,
            "quarantinedRaceMarks": len(marked_quarantine),
            "replacedRaceIds": sorted(target_ids),
            "sourceEvidence": {kind: {"filename": val["filename"], "sha256": val["sha256"]} for kind, val in source.items()},
            "normalizedSnapshotSha256": snap_sha,
            "sqlFile": sql_path.name,
            "execution": "local SQLite clone only; no remote D1/Worker action performed",
            "atomicity": "generated SQL intentionally has no BEGIN/COMMIT; Wrangler D1 file execution provides transaction semantics",
            "preFingerprintCounts": pre,
            "postFingerprintCounts": post,
            "historicalLedger": {
                "bets": affected_bets,
                "predictions": affected_predictions,
                "auditMarkCounts": mark_counts,
                "changed": False,
                "auditMark": "contaminated_pending_review; original purchase/forecast fields remain immutable; do not reattribute or silently resettle",
            },
            "unresolvedDates": [],
        }
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        local_db.close()
    finally:
        Path(db_path).unlink(missing_ok=True)
    return {"sql": str(sql_path), "report": str(report_path), "repairId": repair_id, "quarantined": len(quarantine), "replaced": len(target_ids)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clean-store", type=Path, required=True, help="Offline normalized B/K store JSON")
    parser.add_argument("--production-snapshot", type=Path, required=True, help="Safe-table JSON export from pre-repair D1 backup")
    parser.add_argument("--date", required=True, help="One exact YYYY-MM-DD; emits one atomic day file")
    parser.add_argument("--held-venue", action="append", required=True, help="Explicit authoritative held venue code (09 or 23), repeatable")
    parser.add_argument("--out-dir", type=Path, required=True, help="Private output directory, e.g. ignored recovery-private")
    args = parser.parse_args()
    result = plan(args.clean_store, args.production_snapshot, args.date, set(args.held_venue), args.out_dir)
    print(json.dumps({k: v for k, v in result.items() if k not in {"sql", "report"}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
