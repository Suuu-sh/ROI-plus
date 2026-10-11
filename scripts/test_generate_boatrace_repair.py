from __future__ import annotations

import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from generate_boatrace_repair import plan, select_clean_rows


def fixture(tmp: Path):
    target_date = "2099-01-01"
    b_file = tmp / "b990101.lzh"
    k_file = tmp / "k990101.lzh"
    b_file.write_bytes(b"official-b-fixture")
    k_file.write_bytes(b"official-k-fixture")
    races, entries, results, payouts = [], [], [], []
    for race_no in range(1, 13):
        race_id = f"boat-20990101-23-{race_no:02d}"
        races.append({"id": race_id, "sport": "boat", "venue_id": "23", "race_date": target_date,
                      "race_no": race_no, "name": "fixture", "distance": 1200, "surface": None,
                      "track_condition": None, "weather": "晴", "wind_speed": 1.0, "wave_height": 1.0,
                      "post_time": f"{target_date}T12:{race_no:02d}:00+09:00", "status": "finished", "data_origin": "real"})
        for number in range(1, 7):
            entries.append({"id": f"{race_id}-{number}", "race_id": race_id, "number": number,
                            "frame": number, "name": f"R{race_no}-{number}", "jockey": None, "trainer": None,
                            "weight_carried": None, "horse_weight": None, "racer_class": None,
                            "national_win_rate": None, "local_win_rate": None, "motor_no": str(number),
                            "motor_2rate": None, "boat_no": str(number), "boat_2rate": None,
                            "exhibition_time": None, "start_exhibition": None, "features_json": "{}",
                            "available_at": f"{target_date}T00:00:00+09:00", "data_origin": "real"})
        for rank, number in enumerate((1, 2, 3, 4, 5, 6), 1):
            results.append({"race_id": race_id, "finish_order": rank, "number": number, "data_origin": "real"})
        payouts.append({"race_id": race_id, "bet_type": "win", "selection": "1", "payout": 250,
                        "popularity": 1, "data_origin": "real"})
        payouts.append({"race_id": race_id, "bet_type": "trifecta", "selection": "1-2-3", "payout": 900,
                        "popularity": 1, "data_origin": "real"})
    clean = {"networkAccess": False, "existingStoreModified": False,
             "sourceFiles": [str(b_file), str(k_file)],
             "rows": {"races": races, "entries": entries, "results": results, "payouts": payouts}}
    clean_path = tmp / "clean.json"
    clean_path.write_text(json.dumps(clean), encoding="utf-8")
    old_race_id = "boat-20990101-09-01"
    old = {"id": old_race_id, "sport": "boat", "venue_id": "09", "race_date": target_date,
           "race_no": 1, "name": "wrong-source", "distance": 1200, "surface": None,
           "track_condition": None, "weather": None, "wind_speed": None, "wave_height": None,
           "post_time": f"{target_date}T12:01:00+09:00", "status": "closed", "data_origin": "real",
           "updated_at": f"{target_date}T00:00:00Z"}
    backup = {"races": [old], "entries": [{"id": f"{old_race_id}-1", "race_id": old_race_id, "number": 1,
              "frame": 1, "name": "old", "available_at": f"{target_date}T00:00:00+09:00", "data_origin": "real"}],
              "results": [{"race_id": old_race_id, "finish_order": 1, "number": 1, "data_origin": "real"}],
              "payouts": [{"race_id": old_race_id, "bet_type": "win", "selection": "1", "payout": 500,
                           "popularity": 1, "data_origin": "real"}],
              "odds_snapshots": [{"id": "old-odds", "race_id": old_race_id, "bet_type": "win", "selection": "1",
                                  "odds": 5, "captured_at": "2099-01-01T11:00:00+09:00", "source": "fixture", "data_origin": "real"}],
              "predictions": [{"id": "old-pred", "race_id": old_race_id, "model_id": "old-model", "number": 1,
                               "probability": .9, "prob_std": .01, "predicted_at": "2099-01-01T11:00:00+09:00", "data_origin": "real"}],
              "bets": [{"id": "old-bet", "race_id": old_race_id, "sport": "boat", "bet_type": "win", "selection": "1",
                        "stake": 100, "mode": "manual", "predicted_prob": .9, "odds_at_bet": 5, "expected_roi": 3.5,
                        "edge_label": "HIGH_EDGE", "model_id": "old-model", "placed_at": "2099-01-01T11:00:00+09:00",
                        "status": "won", "payout": 500, "profit": 400, "final_odds": 5,
                        "settled_at": "2099-01-01T13:00:00+09:00", "ev_lost": 0, "data_origin": "real"}],
              "models": [{"id": "old-model", "sport": "boat", "bet_type": "win", "version": "v1",
                          "algorithm": "old", "status": "retired", "metrics_json": "{}"}]}
    backup_path = tmp / "backup.json"
    backup_path.write_text(json.dumps(backup), encoding="utf-8")
    return clean_path, backup_path, old_race_id


class RepairPlanTest(unittest.TestCase):
    def test_generated_day_is_atomic_under_d1_file_semantics_and_keeps_ledger_immutable(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clean, backup, old_race_id = fixture(tmp)
            with patch('generate_boatrace_repair.reparse_and_match'):
                result = plan(clean, backup, "2099-01-01", {"23"}, tmp / "out")
            sql_text = Path(result["sql"]).read_text(encoding="utf-8")
            report = json.loads(Path(result["report"]).read_text(encoding="utf-8"))
            self.assertNotRegex(sql_text, r"(?im)^\s*(BEGIN|COMMIT)\b")
            self.assertNotIn("CREATE TEMP TABLE", sql_text)
            self.assertIn("D1 does not support TEMP tables", sql_text)
            self.assertRegex(sql_text, r"CREATE TABLE \"_repair_guard_[^\"]+\"")
            self.assertRegex(sql_text, r"DROP TABLE \"_repair_guard_[^\"]+\"")
            self.assertEqual(result["replaced"], 12)
            self.assertEqual(result["quarantined"], 1)
            self.assertEqual(report["quarantinedRaceMarks"], 1)
            self.assertEqual(report["affectedDates"], ["2099-01-01"])
            self.assertEqual(report["historicalLedger"]["bets"][0]["id"], "old-bet")
            self.assertEqual(report["historicalLedger"]["predictions"][0]["id"], "old-pred")
            self.assertFalse(report["historicalLedger"]["changed"])
            self.assertEqual(report["historicalLedger"]["auditMarkCounts"], {"bet":1,"prediction":1})
            self.assertEqual(report["preFingerprintCounts"]["bets"]["sha256"], report["postFingerprintCounts"]["bets"]["sha256"])
            self.assertEqual(report["preFingerprintCounts"]["predictions"]["sha256"], report["postFingerprintCounts"]["predictions"]["sha256"])
            self.assertEqual(report["postFingerprintCounts"]["races"]["rows"], 13)
            self.assertEqual(report["postFingerprintCounts"]["entries"]["rows"], 72)

    def test_refuses_missing_exact_day_b_or_k_source(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clean, backup, _ = fixture(tmp)
            obj = json.loads(clean.read_text(encoding="utf-8"))
            obj["sourceFiles"] = [p for p in obj["sourceFiles"] if Path(p).name.startswith("b")]
            clean.write_text(json.dumps(obj), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "exact cached B and K"):
                plan(clean, backup, "2099-01-01", {"23"}, tmp / "out")

    def test_refuses_source_bytes_that_do_not_reparse_to_normalized_rows(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clean, backup, _ = fixture(tmp)
            with patch('generate_boatrace_repair.reparse_and_match', side_effect=ValueError('source mismatch')):
                with self.assertRaisesRegex(ValueError, 'source mismatch'):
                    plan(clean, backup, "2099-01-01", {"23"}, tmp / "out")
            self.assertFalse((tmp / "out").exists())

    def test_requires_positive_win_and_trifecta_payouts_to_match_results(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clean_path, _, _ = fixture(tmp)
            clean = json.loads(clean_path.read_text(encoding="utf-8"))
            clean["rows"]["payouts"][0]["selection"] = "2"
            with self.assertRaisesRegex(ValueError, 'win payouts disagree'):
                select_clean_rows(clean, "2099-01-01", {"23"})
            clean["rows"]["payouts"][0]["selection"] = "1"
            clean["rows"]["payouts"][1]["selection"] = "1-3-2"
            with self.assertRaisesRegex(ValueError, 'trifecta payout'):
                select_clean_rows(clean, "2099-01-01", {"23"})

    def test_rejects_ambiguous_duplicate_finish_ranks(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clean_path, _, _ = fixture(tmp)
            clean = json.loads(clean_path.read_text(encoding="utf-8"))
            clean["rows"]["results"][1]["finish_order"] = 1
            with self.assertRaisesRegex(ValueError, 'duplicate/ambiguous'):
                select_clean_rows(clean, "2099-01-01", {"23"})


if __name__ == "__main__":
    unittest.main()
