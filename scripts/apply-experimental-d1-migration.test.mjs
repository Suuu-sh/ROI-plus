import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateApproval, validateExperimentalMigrationSet, validateMigrationContent } from "./apply-experimental-d1-migration.mjs";

const base = [
  "0001_init.sql", "0002_results_allow_dead_heat.sql", "0003_payouts_wide.sql",
  "0004_ticket_predictions_and_odds_evidence.sql", "0006_data_repair_audit.sql",
  "0007_ranked_multi_bets.sql", "0008_paper_decision_timing.sql", "0009_verified_betting_cutoff.sql",
  "0010_boatrace_prerace_observations.sql", "0011_boatrace_capture_archives.sql",
];
const migration = "0012_experimental_trifecta_paper.sql";
const local = [...base, migration];

test("requires exact workflow SHA and operator confirmation", () => {
  const sha = "a".repeat(40);
  assert.doesNotThrow(() => validateApproval({ approvedSha: sha, githubSha: sha, confirmationText: "APPLY EXPERIMENTAL TRIFECTA PAPER 0012" }));
  assert.throws(() => validateApproval({ approvedSha: "b".repeat(40), githubSha: sha, confirmationText: "APPLY EXPERIMENTAL TRIFECTA PAPER 0012" }), /does not match/);
  assert.throws(() => validateApproval({ approvedSha: sha, githubSha: sha, confirmationText: "APPLY ROI+ MIGRATIONS 0010 AND 0011" }), /does not match/);
});

test("allows only 0012 pending or already applied with exact 0010/0011 baseline", () => {
  assert.deepEqual(validateExperimentalMigrationSet(local, base), [migration]);
  assert.deepEqual(validateExperimentalMigrationSet(local, [...base, migration]), []);
  assert.throws(() => validateExperimentalMigrationSet([...local, "0013_other.sql"], base), /differs/);
  assert.throws(() => validateExperimentalMigrationSet(local, base.slice(0, -1)), /outside/);
  assert.throws(() => validateExperimentalMigrationSet(local, [...base, "0013_other.sql"]), /outside/);
  assert.throws(() => validateExperimentalMigrationSet(local, [...base, base[0]]), /invalid/);
});

test("pins migration bytes and rejects destructive SQL commands", () => {
  const additive = "CREATE TABLE experimental_bankroll (id TEXT);\nINSERT INTO experimental_bankroll VALUES ('x');\n";
  const hash = createHash("sha256").update(additive).digest("hex");
  assert.doesNotThrow(() => validateMigrationContent(additive, hash));
  assert.doesNotThrow(() => validateMigrationContent(Buffer.from(additive, "utf8"), hash));
  assert.throws(() => validateMigrationContent(`${additive}DROP TABLE races;`, createHash("sha256").update(`${additive}DROP TABLE races;`).digest("hex")), /non-additive/);
  assert.throws(() => validateMigrationContent(additive, "0".repeat(64)), /content verification/);
});
