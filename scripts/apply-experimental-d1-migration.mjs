import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWranglerLedgerJson } from "./check-d1-migrations-ready.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const migrationsDirectory = path.join(repositoryRoot, "db", "migrations");
const wranglerCli = path.join(repositoryRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const migrationName = "0012_experimental_trifecta_paper.sql";
const approvedMigrationSha256 = "b260fb4926ebf2f31e589a4387dbeb2a82766191f12a432277f5f44ebe9d8989";
const approvedBase = [
  "0001_init.sql", "0002_results_allow_dead_heat.sql", "0003_payouts_wide.sql",
  "0004_ticket_predictions_and_odds_evidence.sql", "0006_data_repair_audit.sql",
  "0007_ranked_multi_bets.sql", "0008_paper_decision_timing.sql", "0009_verified_betting_cutoff.sql",
  "0010_boatrace_prerace_observations.sql", "0011_boatrace_capture_archives.sql",
];
const ledgerQuery = "SELECT name FROM d1_migrations ORDER BY id LIMIT 100;";
const confirmation = "APPLY EXPERIMENTAL TRIFECTA PAPER 0012";

export function validateApproval({ approvedSha, githubSha, confirmationText }) {
  if (typeof approvedSha !== "string" || !/^[0-9a-f]{40}$/.test(approvedSha)
    || approvedSha !== githubSha || confirmationText !== confirmation) {
    throw new Error("Explicit source approval does not match this workflow run.");
  }
}

export function validateExperimentalMigrationSet(localNames, appliedNames) {
  if (!Array.isArray(localNames) || new Set(localNames).size !== localNames.length
    || JSON.stringify([...localNames].sort()) !== JSON.stringify([...approvedBase, migrationName].sort())) {
    throw new Error("Repository migration set differs from the approved experimental migration.");
  }
  if (!Array.isArray(appliedNames) || new Set(appliedNames).size !== appliedNames.length) {
    throw new Error("Remote migration ledger is invalid.");
  }
  const allowed = new Set([...approvedBase, migrationName]);
  if (appliedNames.some((name) => !allowed.has(name)) || approvedBase.some((name) => !appliedNames.includes(name))) {
    throw new Error("Remote migration ledger is outside the approved pre-migration state.");
  }
  return appliedNames.includes(migrationName) ? [] : [migrationName];
}

export function validateMigrationContent(content, expectedHash = approvedMigrationSha256) {
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== expectedHash) throw new Error("Pinned experimental migration content verification failed.");
  const uncommented = content.replace(/^\s*--.*$/gm, "");
  if (/^\s*(?:DROP|ALTER|UPDATE|DELETE|REPLACE|PRAGMA|ATTACH|DETACH|VACUUM)\b/im.test(uncommented)) {
    throw new Error("Experimental migration contains a non-additive SQL operation.");
  }
  if (!/^\s*CREATE TABLE\b/m.test(uncommented) || !/^\s*INSERT INTO experimental_bankroll\b/m.test(uncommented)) {
    throw new Error("Experimental migration does not match the expected additive schema.");
  }
}

async function localMigrationNames() {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql")).map((entry) => entry.name).sort();
}

function readRemoteLedger() {
  const result = spawnSync(process.execPath, [wranglerCli, "d1", "execute", "roi-plus", "--remote", "--json", "--command", ledgerQuery], {
    cwd: path.join(repositoryRoot, "apps", "api"), encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("Read-only remote migration ledger query failed.");
  return parseWranglerLedgerJson(result.stdout);
}

async function check() {
  validateApproval({
    approvedSha: process.env.APPROVED_SOURCE_SHA,
    githubSha: process.env.GITHUB_SHA,
    confirmationText: process.env.EXPERIMENTAL_MIGRATION_CONFIRMATION,
  });
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("Required Cloudflare deployment credentials are unavailable.");
  }
  const content = await readFile(path.join(migrationsDirectory, migrationName));
  validateMigrationContent(content);
  const localNames = await localMigrationNames();
  const pending = validateExperimentalMigrationSet(localNames, readRemoteLedger());
  return pending;
}

async function main() {
  const pending = await check();
  if (process.argv.includes("--check")) {
    console.log(`Approved experimental migration preflight passed (${pending.length} migration(s) pending).`);
    return;
  }
  if (process.env.CI !== "true") throw new Error("Remote application is permitted only from the approved CI workflow.");
  if (pending.length === 0) {
    console.log("Approved experimental migration is already applied; no changes made.");
    return;
  }
  const result = spawnSync(process.execPath, [wranglerCli, "d1", "migrations", "apply", "roi-plus", "--remote"], {
    cwd: path.join(repositoryRoot, "apps", "api"), env: process.env, encoding: "utf8", timeout: 120000,
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (result.error || result.status !== 0) throw new Error("Approved experimental remote D1 migration application failed.");
  console.log("Approved experimental migration application completed (1 migration).");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`Experimental D1 migration workflow failed closed: ${error.message}`);
    process.exitCode = 1;
  });
}
