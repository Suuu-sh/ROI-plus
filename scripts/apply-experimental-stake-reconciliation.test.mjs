import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateApproval, validateExperimentalMigrationSet, validateMigrationContent } from "./apply-experimental-stake-reconciliation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = [
  "0001_init.sql", "0002_results_allow_dead_heat.sql", "0003_payouts_wide.sql",
  "0004_ticket_predictions_and_odds_evidence.sql", "0006_data_repair_audit.sql",
  "0007_ranked_multi_bets.sql", "0008_paper_decision_timing.sql", "0009_verified_betting_cutoff.sql",
  "0010_boatrace_prerace_observations.sql", "0011_boatrace_capture_archives.sql",
  "0012_experimental_trifecta_paper.sql",
];
const migration = "0013_reconcile_invalid_experimental_stakes.sql";
const local = [...base, migration];

test("requires exact workflow source SHA and explicit stake-unit confirmation", () => {
  const sha = "a".repeat(40);
  assert.doesNotThrow(() => validateApproval({ approvedSha: sha, githubSha: sha, confirmationText: "APPLY EXPERIMENTAL STAKE UNITS 0013" }));
  assert.throws(() => validateApproval({ approvedSha: "b".repeat(40), githubSha: sha, confirmationText: "APPLY EXPERIMENTAL STAKE UNITS 0013" }), /does not match/);
  assert.throws(() => validateApproval({ approvedSha: sha, githubSha: sha, confirmationText: "APPLY EXPERIMENTAL STAKE RECONCILIATION 0013" }), /does not match/);
  assert.throws(() => validateApproval({ approvedSha: "not-a-sha", githubSha: sha, confirmationText: "APPLY EXPERIMENTAL STAKE UNITS 0013" }), /does not match/);
});

test("allows only migration 0013 pending or already applied with exact 0012 baseline", () => {
  assert.deepEqual(validateExperimentalMigrationSet(local, base), [migration]);
  assert.deepEqual(validateExperimentalMigrationSet(local, [...base, migration]), []);
  assert.throws(() => validateExperimentalMigrationSet([...local, "0014_other.sql"], base), /differs/);
  assert.throws(() => validateExperimentalMigrationSet(local, base.slice(0, -1)), /outside/);
  assert.throws(() => validateExperimentalMigrationSet(local, [...base, "0014_other.sql"]), /outside/);
  assert.throws(() => validateExperimentalMigrationSet(local, [...base, base[0]]), /invalid/);
});

test("pins and validates the exact reconciliation migration bytes", async () => {
  const migrationBytes = await readFile(path.join(root, "db", "migrations", migration));
  assert.doesNotThrow(() => validateMigrationContent(migrationBytes));
  assert.throws(() => validateMigrationContent(Buffer.concat([migrationBytes, Buffer.from("-- altered\n")])), /content verification/);
});
