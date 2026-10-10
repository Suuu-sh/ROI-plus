from __future__ import annotations

import unittest
import json
import sqlite3

from generate_boatrace_results_refresh import (
    _assert_entry_identity_matches_b,
    _archive_statement,
    _complete_results,
    _validate_result_payout_integrity,
)


class ResultsRefreshValidationTest(unittest.TestCase):
    def _rows(self, count: int = 5):
        race = "boat-20990101-01-01"
        results = [{"race_id": race, "finish_order": n, "number": n, "data_origin": "real"} for n in range(1, count + 1)]
        payouts = [
            {"race_id": race, "bet_type": "win", "selection": "1", "payout": 250, "popularity": 1, "data_origin": "real"},
            {"race_id": race, "bet_type": "trifecta", "selection": "1-2-3", "payout": 900, "popularity": 1, "data_origin": "real"},
        ]
        return {"races": [{"id": race}], "results": results, "payouts": payouts}

    def test_partial_disqualification_card_remains_closed_without_inventing_sixth_rank(self):
        rows = self._rows(5)
        self.assertFalse(_complete_results(rows["results"]))
        self.assertEqual(_validate_result_payout_integrity(rows), {"boat-20990101-01-01": "closed"})
        self.assertEqual(len(rows["results"]), 5)
        self.assertNotIn(6, {r["finish_order"] for r in rows["results"]})

    def test_rejects_incomplete_or_ambiguous_payout_integrity(self):
        rows = self._rows(5)
        rows["payouts"][0]["selection"] = "2"
        with self.assertRaisesRegex(ValueError, "positive official win payout"):
            _validate_result_payout_integrity(rows)
        rows = self._rows(5)
        rows["payouts"][1]["selection"] = "1-3-2"
        with self.assertRaisesRegex(ValueError, "official trifecta payout"):
            _validate_result_payout_integrity(rows)

    def test_rejects_duplicate_finish_ranks(self):
        rows = self._rows(5)
        rows["results"][1]["finish_order"] = 1
        with self.assertRaisesRegex(ValueError, "ambiguous official result"):
            _validate_result_payout_integrity(rows)

    def _identity_pair(self):
        target = {"boat-20990101-01-01"}
        rid = next(iter(target))
        b_entries = [{"race_id": rid, "number": n, "name": f"Racer{n}",
                      "features_json": json.dumps({"racer_id": str(1000 + n)})} for n in range(1, 7)]
        backup = {"entries": [{"race_id": rid, "number": n,
                               "name": f"Racer{n} Official",
                               "features_json": json.dumps({"racer_id": str(1000 + n)})} for n in range(1, 7)]}
        return target, b_entries, backup

    def test_allows_only_verified_racer_id_name_prefix_variants(self):
        target, b_entries, backup = self._identity_pair()
        self.assertEqual(_assert_entry_identity_matches_b(b_entries, backup, target), 6)
        backup["entries"][1]["name"] = "Racer2"
        self.assertEqual(_assert_entry_identity_matches_b(b_entries, backup, target), 5)

    def test_rejects_different_or_missing_official_registration_id(self):
        for value in ("9999", ""):
            target, b_entries, backup = self._identity_pair()
            backup["entries"][0]["features_json"] = json.dumps({"racer_id": value})
            with self.assertRaisesRegex(ValueError, "racer registration ID"):
                _assert_entry_identity_matches_b(b_entries, backup, target)
        target, b_entries, backup = self._identity_pair()
        b_entries[0]["features_json"] = "{}"
        with self.assertRaisesRegex(ValueError, "racer registration ID"):
            _assert_entry_identity_matches_b(b_entries, backup, target)

    def test_rejects_nonprefix_name_even_when_registration_id_matches(self):
        target, b_entries, backup = self._identity_pair()
        backup["entries"][0]["name"] = "Different Name"
        with self.assertRaisesRegex(ValueError, "exact prefix"):
            _assert_entry_identity_matches_b(b_entries, backup, target)

    def test_archive_captures_exported_race_fields_and_original_status(self):
        db = sqlite3.connect(":memory:")
        db.executescript("""
            CREATE TABLE races(id TEXT PRIMARY KEY,status TEXT,updated_at TEXT,weather TEXT);
            CREATE TABLE _scope(race_id TEXT PRIMARY KEY);
            CREATE TABLE data_repair_archive(repair_id TEXT,table_name TEXT,race_id TEXT,row_key TEXT,payload_json TEXT,
                source_b_sha256 TEXT,source_k_sha256 TEXT,normalized_snapshot_sha256 TEXT,archived_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(repair_id,table_name,row_key));
            INSERT INTO races VALUES('boat-20990101-01-01','scheduled','before-refresh','晴');
            INSERT INTO _scope VALUES('boat-20990101-01-01');
        """)
        stmt = _archive_statement("races", ["id", "status", "updated_at", "weather"], ("id",),
                                  "x.id", "x.id=t.race_id", "_scope", "refresh-test",
                                  {"b": {"sha256": "b"}, "k": {"sha256": "k"}}, "snapshot")
        db.execute(stmt)
        row = db.execute("SELECT row_key,payload_json FROM data_repair_archive WHERE repair_id='refresh-test' AND table_name='races'").fetchone()
        self.assertEqual(row[0], "boat-20990101-01-01")
        self.assertEqual(json.loads(row[1]), {"id": "boat-20990101-01-01", "status": "scheduled",
                                              "updated_at": "before-refresh", "weather": "晴"})
        db.close()


if __name__ == "__main__":
    unittest.main()
