import test from "node:test";
import assert from "node:assert/strict";
import { validateApprovedMigrationSet } from "./apply-approved-d1-migrations.mjs";

const base = ["0001_init.sql", "0002_results_allow_dead_heat.sql", "0003_payouts_wide.sql", "0004_ticket_predictions_and_odds_evidence.sql", "0006_data_repair_audit.sql", "0007_ranked_multi_bets.sql", "0008_paper_decision_timing.sql", "0009_verified_betting_cutoff.sql"];
const migration10 = "0010_boatrace_prerace_observations.sql";
const migration11 = "0011_boatrace_capture_archives.sql";
const local = [...base, migration10, migration11];

test("accepts both migrations pending and retry subsets", () => {
  assert.deepEqual(validateApprovedMigrationSet(local, base), [migration10, migration11]);
  assert.deepEqual(validateApprovedMigrationSet(local, [...base, migration10]), [migration11]);
  assert.deepEqual(validateApprovedMigrationSet(local, [...base, migration10, migration11]), []);
});

test("rejects unknown, missing baseline, and out-of-set migrations", () => {
  assert.throws(() => validateApprovedMigrationSet(local, base.slice(1)), /outside the approved/);
  assert.throws(() => validateApprovedMigrationSet(local, [...base, "0012_future.sql"]), /outside the approved/);
  assert.throws(() => validateApprovedMigrationSet([...local, "0012_future.sql"], base), /differs from the pinned/);
});

test("rejects duplicate ledger entries", () => {
  assert.throws(() => validateApprovedMigrationSet(local, [...base, base[0]]), /ledger is invalid/);
});
