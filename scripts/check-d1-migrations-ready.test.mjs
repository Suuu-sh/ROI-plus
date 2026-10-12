import assert from "node:assert/strict";
import test from "node:test";
import { compareMigrationNames, parseWranglerLedgerJson } from "./check-d1-migrations-ready.mjs";
import { readFile } from "node:fs/promises";

const migration8 = "0008_paper_decision_timing.sql";
const migration9 = "0009_verified_betting_cutoff.sql";
const migration10 = "0010_boatrace_prerace_observations.sql";
const migration11 = "0011_boatrace_capture_archives.sql";

test("main deployment push filter covers release and D1 readiness inputs", async () => {
  const workflow = await readFile(new URL("../.github/workflows/deploy-workers.yml", import.meta.url), "utf8");
  const push = workflow.split("  push:\n")[1]?.split("\npermissions:")[0];
  assert.ok(push, "the deployment workflow must define a push trigger");
  const pushLines = push.split("\n");
  assert.ok(pushLines.some((line) => line.trim() === "branches: [main]"), "deployment trigger must target main");

  const pathsHeader = pushLines.findIndex((line) => line.trim() === "paths:");
  assert.notEqual(pathsHeader, -1, "the main push trigger must declare path filters");
  const paths = pushLines.slice(pathsHeader + 1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).replaceAll("'", ""));
  for (const requiredPath of [
    "apps/api/**",
    "apps/web/**",
    "packages/shared/**",
    "package.json",
    "package-lock.json",
    ".github/workflows/deploy-workers.yml",
    "db/migrations/**",
    "scripts/check-d1-migrations-ready.mjs",
    "scripts/check-d1-migrations-ready.test.mjs",
  ]) {
    assert.ok(paths.includes(requiredPath), `deployment trigger is missing ${requiredPath}`);
  }
});

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
