#!/usr/bin/env python3
"""Prepare a guarded, offline SQL refresh of one day's official boat results.

This narrowly scoped plan replaces only results and payouts for canonical races
already present in a production snapshot, then refreshes their status. It never
connects to Cloudflare or mutates its inputs.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sqlite3
import sys
import tempfile
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import generate_boatrace_repair as common  # noqa: E402

RACE_DATE = "2026-10-10"
EXCLUDED_VENUES = {"09", "23"}
SOURCE_FILE_RE = re.compile(r"^([bk])(\d{6})\.lzh$", re.I)
RACE_COLUMNS = common.RACE_COLUMNS
ENTRY_COLUMNS = common.ENTRY_COLUMNS
RESULT_COLUMNS = common.RESULT_COLUMNS
PAYOUT_COLUMNS = common.PAYOUT_COLUMNS
PK_COLUMNS = common.PK_COLUMNS


def _sha_json(value: Any) -> str:
    return common.digest_bytes(common.canonical_json(value).encode("utf-8"))


def _source_files(store: dict[str, Any], day: str) -> dict[str, dict[str, str]]:
    stamp = date.fromisoformat(day).strftime("%y%m%d")
    found: dict[str, dict[str, str]] = {}
    for value in store.get("sourceFiles", []):
        if not isinstance(value, str):
            continue
        path = Path(value)
        match = SOURCE_FILE_RE.fullmatch(path.name)
        if match is None or match.group(2) != stamp:
            continue
        kind = match.group(1).lower()
        if kind in found:
            raise ValueError(f"multiple cached {kind.upper()} files for {day}")
        if not path.is_file():
            raise ValueError(f"cached {kind.upper()} bytes unavailable for {day}")
        raw = path.read_bytes()
        found[kind] = {"filename": path.name, "sha256": common.digest_bytes(raw), "_path": str(path)}
    if set(found) != {"b", "k"}:
        raise ValueError(f"exact cached B and K files required for {day}")
    return found


def _parse_official(source: dict[str, dict[str, str]], day: str) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    from edgelab.collectors.boatrace import read_lzh
    from edgelab.parsers.boatrace_b import parse_b
    from edgelab.parsers.boatrace_k import parse_k
    from edgelab.storage import merge_rows

    parsed: dict[str, list[dict[str, Any]]] = {t: [] for t in common.JSON_ROWS}
    b_rows = parse_b(read_lzh(source["b"]["_path"]), race_date=day)
    k_rows = parse_k(read_lzh(source["k"]["_path"]), race_date=day)
    merge_rows(parsed, b_rows)
    merge_rows(parsed, k_rows)
    return parsed, b_rows["entries"]


def _project_rows(parsed: dict[str, list[dict[str, Any]]], day: str,
                  race_ids: set[str]) -> dict[str, list[dict[str, Any]]]:
    rows = {t: [] for t in common.JSON_ROWS}
    for table, columns in common.JSON_ROWS.items():
        key = "id" if table == "races" else "race_id"
        for row in parsed[table]:
            if row.get(key) in race_ids and row.get("race_date", day) == day:
                rows[table].append({c: row.get(c) for c in columns})
        rows[table].sort(key=lambda r: tuple(str(r.get(k, "")) for k in PK_COLUMNS[table]))
    return rows


def _validate_sources(store: dict[str, Any], parsed: dict[str, list[dict[str, Any]]],
                      day: str, target_ids: set[str], production: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    preview = store.get("rows")
    if store.get("networkAccess") is not False or store.get("existingStoreModified") is not False or not isinstance(preview, dict):
        raise ValueError("clean-store provenance must confirm offline, unmodified normalized preview")
    official_races = [r for r in parsed["races"] if r.get("sport") == "boat" and r.get("data_origin") == "real" and r.get("race_date") == day and str(r.get("venue_id")) not in EXCLUDED_VENUES]
    official_ids = {str(r["id"]) for r in official_races}
    if len(official_ids) != len(official_races) or official_ids != target_ids:
        raise ValueError("official B/K canonical race ID set does not exactly match existing production target set")
    preview_races = [r for r in preview.get("races", []) if r.get("sport") == "boat" and r.get("data_origin") == "real" and r.get("race_date") == day and str(r.get("venue_id")) not in EXCLUDED_VENUES]
    if {str(r.get("id")) for r in preview_races} != target_ids or len(preview_races) != len(target_ids):
        raise ValueError("normalized preview race set differs from the official B/K target set")
    expected = _project_rows(parsed, day, target_ids)
    for table, columns in common.JSON_ROWS.items():
        key = "id" if table == "races" else "race_id"
        preview_rows = [{c: r.get(c) for c in columns} for r in preview.get(table, []) if r.get(key) in target_ids]
        preview_rows.sort(key=lambda r: tuple(str(r.get(k, "")) for k in PK_COLUMNS[table]))
        # The local preview deliberately downgrades partial K results to closed.
        if table == "races":
            for row in expected[table]:
                prod = next((x for x in production["races"] if x.get("id") == row["id"]), None)
                if row.get("status") == "finished" and prod and prod.get("status") == "closed":
                    row["status"] = "closed"
            # Status is derived below from result completeness, not parser-side status.
            for row in expected[table]:
                rows = [r for r in expected["results"] if r["race_id"] == row["id"]]
                row["status"] = "finished" if _complete_results(rows) else "closed"
            for row in preview_rows:
                rows = [r for r in expected["results"] if r["race_id"] == row["id"]]
                row["status"] = "finished" if _complete_results(rows) else "closed"
        if common.canonical_json(preview_rows) != common.canonical_json(expected[table]):
            raise ValueError(f"normalized {table} preview does not match exact B/K reparse for target races")
    return expected


def _complete_results(results: list[dict[str, Any]]) -> bool:
    return len(results) == 6 and {int(r["number"]) for r in results} == set(range(1, 7)) and {int(r["finish_order"]) for r in results} == set(range(1, 7))


def _validate_races_and_entries(rows: dict[str, list[dict[str, Any]]], backup: dict[str, Any], day: str) -> tuple[list[str], dict[str, list[dict[str, Any]]]]:
    existing = [r for r in backup.get("races", []) if r.get("sport") == "boat" and r.get("data_origin") == "real" and r.get("race_date") == day and str(r.get("venue_id")) not in EXCLUDED_VENUES]
    expected_ids = set()
    for race in existing:
        venue, no = str(race.get("venue_id")), int(race.get("race_no", 0))
        expected_id = f"boat-{day.replace('-', '')}-{venue}-{no:02d}"
        if no not in range(1, 13) or str(race.get("id")) != expected_id:
            raise ValueError("production snapshot contains a noncanonical target-day boat race")
        expected_ids.add(expected_id)
    source_ids = {r["id"] for r in rows["races"]}
    if len(source_ids) != 132 or expected_ids != source_ids:
        raise ValueError("expected exactly 132 existing canonical races outside excluded venues")
    existing_entries = [e for e in backup.get("entries", []) if e.get("race_id") in source_ids]
    by_key = {(e["race_id"], int(e["number"])): e for e in existing_entries}
    if len(by_key) != len(existing_entries) or len(by_key) != 132 * 6 or any(set(n for rid, n in by_key if rid == race_id) != set(range(1, 7)) for race_id in source_ids):
        raise ValueError("existing production entries are not exactly six unique lanes per target race")
    entries = {rid: [{"race_id": rid, "number": n, "name": by_key[(rid, n)].get("name"),
                      "racer_id": str(json.loads(by_key[(rid, n)].get("features_json") or "{}").get("racer_id") or "").strip()}
                     for n in range(1, 7)] for rid in sorted(source_ids)}
    return sorted(source_ids), entries


def _assert_entry_identity_matches_b(b_entries: list[dict[str, Any]], backup: dict[str, Any], target_ids: set[str]) -> int:
    """Require exact racer ID/race/lane and only allow strict B-name prefixes."""
    source_rows = [e for e in b_entries if e.get("race_id") in target_ids]
    source = {(e["race_id"], int(e["number"])): e for e in source_rows}
    existing_rows = [e for e in backup.get("entries", []) if e.get("race_id") in target_ids]
    existing = {(e["race_id"], int(e["number"])): e for e in existing_rows}
    if len(source) != len(source_rows) or len(existing) != len(existing_rows) or set(source) != set(existing):
        raise ValueError("official B and production entry race/lane identity sets differ")
    prefix_variants = 0
    for key, b_entry in source.items():
        prod_entry = existing[key]
        b_id = str(json.loads(b_entry.get("features_json") or "{}").get("racer_id") or "").strip()
        prod_id = str(json.loads(prod_entry.get("features_json") or "{}").get("racer_id") or "").strip()
        if not b_id or not prod_id or b_id != prod_id:
            raise ValueError("official B racer registration ID is missing or differs from production identity")
        b_name, prod_name = str(b_entry.get("name") or ""), str(prod_entry.get("name") or "")
        if not b_name or not prod_name or not prod_name.startswith(b_name):
            raise ValueError("official B fixed-width name is not an exact prefix of the existing official name")
        if b_name != prod_name:
            prefix_variants += 1
    return prefix_variants


def _validate_result_payout_integrity(rows: dict[str, list[dict[str, Any]]]) -> dict[str, str]:
    results: dict[str, list[dict[str, Any]]] = defaultdict(list)
    payouts: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows["results"]: results[row["race_id"]].append(row)
    for row in rows["payouts"]: payouts[row["race_id"]].append(row)
    statuses = {}
    for race in rows["races"]:
        rid = race["id"]
        rs, ps = results[rid], payouts[rid]
        if not rs or len({int(r["number"]) for r in rs}) != len(rs) or len({int(r["finish_order"]) for r in rs}) != len(rs):
            raise ValueError(f"missing, duplicate, or ambiguous official result rows: {rid}")
        if any(r.get("data_origin") != "real" or int(r["number"]) not in range(1, 7) or int(r["finish_order"]) not in range(1, 7) for r in rs):
            raise ValueError(f"invalid official result provenance/lane/rank: {rid}")
        if not ps or len({(p["bet_type"], str(p["selection"])) for p in ps}) != len(ps):
            raise ValueError(f"missing or duplicate official payout rows: {rid}")
        if any(p.get("data_origin") != "real" or p.get("bet_type") not in common.BET_TYPES or int(p.get("payout", -1)) < 0 for p in ps):
            raise ValueError(f"invalid official payout provenance/value: {rid}")
        winners = {str(r["number"]) for r in rs if int(r["finish_order"]) == 1}
        win_payouts = {str(p["selection"]) for p in ps if p["bet_type"] == "win" and int(p["payout"]) > 0}
        if not winners or winners != win_payouts:
            raise ValueError(f"positive official win payout does not match result winner: {rid}")
        top3 = [str(r["number"]) for r in sorted(rs, key=lambda r: (int(r["finish_order"]), int(r["number"]))) if int(r["finish_order"]) in (1, 2, 3)]
        tri = [str(p["selection"]) for p in ps if p["bet_type"] == "trifecta" and int(p["payout"]) > 0]
        if len(top3) == 3 and (len(tri) != 1 or tri[0] != "-".join(top3)):
            raise ValueError(f"official trifecta payout differs from ordered top three: {rid}")
        statuses[rid] = "finished" if _complete_results(rs) else "closed"
    return statuses


def _archive_statement(table: str, columns: list[str], key_columns: tuple[str, ...],
                      race_expr: str, scope_join: str, scope_table: str,
                      repair_id: str, source: dict[str, dict[str, str]], snapshot_sha: str) -> str:
    """Archive one table's full exported row payload, using its production keys."""
    key_expr = " || ':' || ".join(f"COALESCE(CAST(x.{common.qident(c)} AS TEXT),'∅')" for c in key_columns)
    json_args = ",".join(f"'{c}',x.{common.qident(c)}" for c in columns)
    return ("INSERT OR IGNORE INTO data_repair_archive(repair_id,table_name,race_id,row_key,payload_json,source_b_sha256,source_k_sha256,normalized_snapshot_sha256) "
            f"SELECT {common.sql(repair_id)},{common.sql(table)},{race_expr},{key_expr},json_object({json_args}),{common.sql(source['b']['sha256'])},{common.sql(source['k']['sha256'])},{common.sql(snapshot_sha)} "
            f"FROM {common.qident(table)} x JOIN {common.qident(scope_table)} t ON {scope_join};")


def _build_sql(day: str, repair_id: str, rows: dict[str, list[dict[str, Any]]],
               target_ids: list[str], expected_entries: dict[str, list[dict[str, Any]]],
               source: dict[str, dict[str, str]], statuses: dict[str, str],
               production: dict[str, Any]) -> str:
    suffix = re.sub(r"[^a-zA-Z0-9_]", "_", repair_id)
    ids_t, entries_t, guard_t = (f"_results_refresh_ids_{suffix}", f"_results_refresh_entries_{suffix}", f"_results_refresh_guard_{suffix}")
    qids, qentries, qguard = map(common.qident, (ids_t, entries_t, guard_t))
    snapshot_sha = _sha_json({"results": rows["results"], "payouts": rows["payouts"], "statuses": statuses})
    stmt = ["-- Generated offline; review paired report before executing via approved D1 procedure.",
            "-- No BEGIN/COMMIT: D1 file execution is atomic; ordinary uniquely named guard tables are dropped at end.",
            f"CREATE TABLE {qids}(race_id TEXT PRIMARY KEY,venue_id TEXT NOT NULL,race_no INTEGER NOT NULL);",
            f"CREATE TABLE {qentries}(race_id TEXT NOT NULL,number INTEGER NOT NULL,racer_id TEXT NOT NULL,name TEXT,PRIMARY KEY(race_id,number));"]
    races_by_id = {r["id"]: r for r in production["races"] if r.get("id") in set(target_ids)}
    for rid in target_ids:
        race = races_by_id[rid]
        stmt.append(f"INSERT INTO {qids} VALUES({common.sql(rid)},{common.sql(str(race['venue_id']))},{int(race['race_no'])});")
        for entry in expected_entries[rid]:
            stmt.append(f"INSERT INTO {qentries} VALUES({common.sql(rid)},{int(entry['number'])},{common.sql(entry['racer_id'])},{common.sql(entry['name'])});")
    stmt.extend([
        f"CREATE TABLE {qguard}(ok INTEGER NOT NULL CHECK(ok=1));",
        f"INSERT INTO {qguard} SELECT CASE WHEN (SELECT COUNT(*) FROM races WHERE sport='boat' AND data_origin='real' AND race_date={common.sql(day)} AND venue_id NOT IN ('09','23'))=132 AND NOT EXISTS(SELECT id FROM races WHERE sport='boat' AND data_origin='real' AND race_date={common.sql(day)} AND venue_id NOT IN ('09','23') EXCEPT SELECT race_id FROM {qids}) AND NOT EXISTS(SELECT race_id FROM {qids} EXCEPT SELECT id FROM races WHERE sport='boat' AND data_origin='real' AND race_date={common.sql(day)} AND venue_id NOT IN ('09','23')) THEN 1 ELSE 0 END;",
        f"INSERT INTO {qguard} SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM {qids} t JOIN races r ON r.id=t.race_id WHERE r.sport<>'boat' OR r.data_origin<>'real' OR r.race_date<>{common.sql(day)} OR r.venue_id<>t.venue_id OR r.race_no<>t.race_no) THEN 1 ELSE 0 END;",
        f"INSERT INTO {qguard} SELECT CASE WHEN (SELECT COUNT(*) FROM entries e JOIN {qids} t ON e.race_id=t.race_id)=792 AND NOT EXISTS(SELECT e.race_id,e.number,json_extract(e.features_json,'$.racer_id'),e.name FROM entries e JOIN {qids} t ON e.race_id=t.race_id EXCEPT SELECT race_id,number,racer_id,name FROM {qentries}) AND NOT EXISTS(SELECT race_id,number,racer_id,name FROM {qentries} EXCEPT SELECT e.race_id,e.number,json_extract(e.features_json,'$.racer_id'),e.name FROM entries e JOIN {qids} t ON e.race_id=t.race_id) THEN 1 ELSE 0 END;",
        "CREATE TABLE IF NOT EXISTS data_repair_archive (repair_id TEXT NOT NULL,table_name TEXT NOT NULL,race_id TEXT NOT NULL,row_key TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),source_b_sha256 TEXT NOT NULL,source_k_sha256 TEXT NOT NULL,normalized_snapshot_sha256 TEXT NOT NULL,archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(repair_id,table_name,row_key));",
    ])
    for table, cols in (("results", RESULT_COLUMNS), ("payouts", PAYOUT_COLUMNS)):
        stmt.append(_archive_statement(table, list(cols), PK_COLUMNS[table], "x.race_id", "x.race_id=t.race_id", ids_t, repair_id, source, snapshot_sha))
    race_columns = sorted({key for race in production.get("races", []) if race.get("id") in set(target_ids) for key in race})
    if not race_columns:
        raise ValueError("production snapshot exports no race columns to archive")
    stmt.append(_archive_statement("races", race_columns, PK_COLUMNS["races"], "x.id", "x.id=t.race_id", ids_t, repair_id, source, snapshot_sha))
    stmt.extend([f"DELETE FROM results WHERE race_id IN (SELECT race_id FROM {qids});", f"DELETE FROM payouts WHERE race_id IN (SELECT race_id FROM {qids});"])
    for row in rows["results"]:
        stmt.append(f"INSERT INTO results({','.join(common.qident(c) for c in RESULT_COLUMNS)}) VALUES({common.row_values(row, RESULT_COLUMNS)});")
    for row in rows["payouts"]:
        stmt.append(f"INSERT INTO payouts({','.join(common.qident(c) for c in PAYOUT_COLUMNS)}) VALUES({common.row_values(row, PAYOUT_COLUMNS)});")
    for rid, status in sorted(statuses.items()):
        stmt.append(f"UPDATE races SET status={common.sql(status)},updated_at=CURRENT_TIMESTAMP WHERE id={common.sql(rid)};")
    stmt.extend([f"DROP TABLE {qguard};", f"DROP TABLE {qentries};", f"DROP TABLE {qids};"])
    return "\n".join(stmt) + "\n"


def build_plan(clean_path: Path, production_path: Path, day: str, out_dir: Path) -> dict[str, Any]:
    if date.fromisoformat(day).isoformat() != RACE_DATE:
        raise ValueError(f"this one-off refresh is restricted to {RACE_DATE}")
    store = json.loads(clean_path.read_text(encoding="utf-8"))
    production = json.loads(production_path.read_text(encoding="utf-8"))
    source = _source_files(store, day)
    parsed, b_entries = _parse_official(source, day)
    target_existing = [r for r in production.get("races", []) if r.get("sport") == "boat" and r.get("data_origin") == "real" and r.get("race_date") == day and str(r.get("venue_id")) not in EXCLUDED_VENUES]
    target_ids = {str(r["id"]) for r in target_existing}
    expected, = (_validate_sources(store, parsed, day, target_ids, production),)
    prefix_variants = _assert_entry_identity_matches_b(b_entries, production, target_ids)
    target_ids_sorted, expected_entries = _validate_races_and_entries(expected, production, day)
    statuses = _validate_result_payout_integrity(expected)
    snapshot_sha = _sha_json(expected)
    repair_id = f"boat-results-refresh-{day.replace('-', '')}-{snapshot_sha[:12]}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    sql_text = _build_sql(day, repair_id, expected, target_ids_sorted, expected_entries, source, statuses, production)
    out_dir.mkdir(parents=True, exist_ok=True)
    sql_path = out_dir / f"boatrace-results-refresh-{day}.sql"
    report_path = out_dir / f"boatrace-results-refresh-{day}.report.json"
    if sql_path.exists() or report_path.exists():
        raise FileExistsError("refresh plan output already exists; choose a new output directory")
    sql_path.write_text(sql_text, encoding="utf-8")
    return {"sql": str(sql_path), "report": str(report_path), "repairId": repair_id,
            "rows": expected, "targetIds": target_ids_sorted, "statuses": statuses,
            "source": source, "snapshotSha256": snapshot_sha,
            "entryIdentity": {"racerIdMatches": 792, "bNamePrefixVariants": prefix_variants}}


def dry_run(plan: dict[str, Any], production: dict[str, Any]) -> dict[str, Any]:
    fd, db_path = tempfile.mkstemp(prefix="roi-results-refresh-", suffix=".sqlite")
    import os
    os.close(fd)
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    try:
        common.load_backup_db(db, production)
        db.commit()
        target_ids = plan["targetIds"]
        before_results = common.scoped_fingerprints(db, target_ids)["results"]
        before_payouts = common.scoped_fingerprints(db, target_ids)["payouts"]
        ledger_before = {t: common.scoped_fingerprints(db, target_ids)[t] for t in ("bets", "predictions", "entries", "races")}
        common.execute_sql_atomic(db, Path(plan["sql"]).read_text(encoding="utf-8"))
        after = {t: common.scoped_fingerprints(db, target_ids)[t] for t in ("results", "payouts", "bets", "predictions", "entries", "races")}
        for t in ("bets", "predictions", "entries"):
            if after[t] != ledger_before[t]: raise AssertionError(f"refresh unexpectedly mutated {t}")
        expected_results = plan["rows"]["results"]
        expected_payouts = plan["rows"]["payouts"]
        actual_results = [dict(r) for r in db.execute(f"SELECT race_id,finish_order,number,data_origin FROM results WHERE race_id IN ({','.join('?' for _ in target_ids)}) ORDER BY race_id,number", target_ids)]
        actual_payouts = [dict(r) for r in db.execute(f"SELECT race_id,bet_type,selection,payout,popularity,data_origin FROM payouts WHERE race_id IN ({','.join('?' for _ in target_ids)}) ORDER BY race_id,bet_type,selection", target_ids)]
        expected_results = sorted(expected_results, key=lambda x:(x["race_id"],x["number"]))
        expected_payouts = sorted(expected_payouts, key=lambda x:(x["race_id"],x["bet_type"],x["selection"]))
        if common.canonical_json(actual_results) != common.canonical_json(expected_results) or common.canonical_json(actual_payouts) != common.canonical_json(expected_payouts):
            raise AssertionError("dry-run output differs from exact K parsed rows")
        statuses = {r["id"]: r["status"] for r in db.execute(f"SELECT id,status FROM races WHERE id IN ({','.join('?' for _ in target_ids)})", target_ids)}
        if statuses != plan["statuses"]: raise AssertionError("dry-run race status differs from supported completeness policy")
        archives = {t: db.execute("SELECT COUNT(*) FROM data_repair_archive WHERE repair_id=? AND table_name=?", (plan["repairId"], t)).fetchone()[0] for t in ("races", "results", "payouts")}
        if archives != {"races": len(target_ids), "results": before_results["rows"], "payouts": before_payouts["rows"]}: raise AssertionError("prior race/result/payout snapshot archive incomplete")
        sample_race = target_ids[0]
        archived_race = db.execute("SELECT payload_json FROM data_repair_archive WHERE repair_id=? AND table_name='races' AND race_id=?", (plan["repairId"], sample_race)).fetchone()
        before_race = next(r for r in production["races"] if r.get("id") == sample_race)
        archive_payload = json.loads(archived_race["payload_json"]) if archived_race else {}
        if archive_payload != before_race or "status" not in archive_payload:
            raise AssertionError("archived race row does not preserve all exported fields and prior status")
        bet_count = db.execute(f"SELECT COUNT(*) FROM bets WHERE race_id IN ({','.join('?' for _ in target_ids)}) AND status='open'", target_ids).fetchone()[0]
        eligible_bets = db.execute(f"SELECT COUNT(*) FROM bets b JOIN races r ON r.id=b.race_id WHERE b.race_id IN ({','.join('?' for _ in target_ids)}) AND b.status='open' AND r.status='finished'", target_ids).fetchone()[0]
        finished_races = sum(1 for rid in target_ids if plan["statuses"][rid] == "finished")
        return {"preResults": before_results, "prePayouts": before_payouts, "post": after,
                "archived": archives, "archivedRaceStatusPreserved": True,
                "openBets": bet_count, "finishedRaces": finished_races,
                "projectedSettlementEligibleOpenBets": eligible_bets,
                "settlementClaim": "projection only; no bets were settled; production settlement requires separately reviewed action"}
    finally:
        db.close()
        Path(db_path).unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clean-store", type=Path, required=True)
    parser.add_argument("--production-snapshot", type=Path, required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    plan = build_plan(args.clean_store, args.production_snapshot, args.date, args.out_dir)
    production = json.loads(args.production_snapshot.read_text(encoding="utf-8"))
    dry = dry_run(plan, production)
    report = {"repairId": plan["repairId"], "raceDate": args.date,
              "targetRaceCount": len(plan["targetIds"]), "excludedVenues": sorted(EXCLUDED_VENUES),
              "resultRows": len(plan["rows"]["results"]), "payoutRows": len(plan["rows"]["payouts"]),
              "completeSixLaneUniqueRankRaces": sum(v == "finished" for v in plan["statuses"].values()),
              "partialOrAmbiguousResultsClosed": sum(v == "closed" for v in plan["statuses"].values()),
              "sourceEvidence": {k: {"filename": v["filename"], "sha256": v["sha256"]} for k,v in plan["source"].items()},
              "sqlSha256": common.digest_bytes(Path(plan["sql"]).read_bytes()),
              "entryIdentity": {**plan["entryIdentity"], "entryRowsUnmodified": True,
                                "nameDifferencePolicy": "B fixed-width name must be an exact prefix of the existing official name; racer registration ID, canonical race ID, and lane must match exactly"},
              "normalizedRowsSha256": plan["snapshotSha256"], "sqlFile": Path(plan["sql"]).name,
              "execution": "local SQLite clone only; no remote D1/Worker action performed", "dryRun": dry}
    Path(plan["report"]).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k:v for k,v in report.items() if k not in {"dryRun"}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
