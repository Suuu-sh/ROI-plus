import assert from "node:assert/strict";
import test from "node:test";
import { compareMigrationNames, parseWranglerLedgerJson } from "./check-d1-migrations-ready.mjs";

const migration8 = "0008_paper_decision_timing.sql";
const migration9 = "0009_verified_betting_cutoff.sql";
const migration10 = "0010_boatrace_prerace_observations.sql";
const migration11 = "0011_boatrace_capture_archives.sql";

test("parses the Wrangler D1 JSON result shape", () => {
  const names = parseWranglerLedgerJson(JSON.stringify([{
    results: [{ name: migration8 }, { name: migration9 }],
    success: true,
    meta: { rows_read: 2, rows_written: 0 },
  }]));
  assert.deepEqual(names, [migration8, migration9]);
});

test("accepts an empty ledger response structurally for comparison to fail closed", () => {
  const names = parseWranglerLedgerJson(JSON.stringify([{ results: [], success: true }]));
  assert.deepEqual(names, []);
  assert.equal(compareMigrationNames([migration8], names).ready, false);
});

test("rejects failed queries, malformed JSON, and ambiguous truncated ledgers", () => {
  assert.throws(() => parseWranglerLedgerJson("not json"), /valid JSON/);
  assert.throws(() => parseWranglerLedgerJson(JSON.stringify([{ results: [], success: false }])), /did not succeed/);
  const rows = Array.from({ length: 100 }, (_, index) => ({ name: String(index).padStart(4, "0") + "_migration.sql" }));
  assert.throws(() => parseWranglerLedgerJson(JSON.stringify([{ results: rows, success: true }])), /bounded query limit/);
});

test("fails readiness when 0010 or 0011 is absent from the applied ledger", () => {
  const result = compareMigrationNames([migration8, migration9, migration10, migration11], [migration8, migration9]);
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, [migration10, migration11]);
  assert.deepEqual(result.unexpected, []);
});

test("requires exact migration-ledger agreement", () => {
  const result = compareMigrationNames([migration8, migration9], [migration8, migration9, migration10]);
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, [migration10]);
  assert.throws(() => compareMigrationNames([migration8, migration8], [migration8]), /duplicate/);
});
