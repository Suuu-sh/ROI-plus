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
const approvedCommit = "8168453d614df174d6c8bb0a244f7d774edffc67";
const approvedBase = [
  "0001_init.sql", "0002_results_allow_dead_heat.sql", "0003_payouts_wide.sql",
  "0004_ticket_predictions_and_odds_evidence.sql", "0006_data_repair_audit.sql",
  "0007_ranked_multi_bets.sql", "0008_paper_decision_timing.sql", "0009_verified_betting_cutoff.sql",
];
const approvedMigrations = new Map([
  ["0010_boatrace_prerace_observations.sql", "e1351e047182ceb350595d3cbbc98329c92c21192a3d074a96c6a9109ec198f4"],
  ["0011_boatrace_capture_archives.sql", "d36b2dc9682f8a6976839ff9b6edcfd906674db537a76e023fc61b93946a2002"],
]);
const ledgerQuery = "SELECT name FROM d1_migrations ORDER BY id LIMIT 100;";

export function validateApprovedMigrationSet(localNames, appliedNames) {
  if (!Array.isArray(localNames) || new Set(localNames).size !== localNames.length) {
    throw new Error("Repository migration list is invalid.");
  }
  if (!Array.isArray(appliedNames) || new Set(appliedNames).size !== appliedNames.length) {
    throw new Error("Remote migration ledger is invalid.");
  }
  const expectedBase = approvedBase;
  const allowedApplied = new Set([...expectedBase, ...approvedMigrations.keys()]);
  if (localNames.length !== allowedApplied.size || localNames.some((name) => !allowedApplied.has(name))) {
    throw new Error("Repository migration set differs from the pinned approval.");
  }
  if (appliedNames.some((name) => !allowedApplied.has(name)) || expectedBase.some((name) => !appliedNames.includes(name))) {
    throw new Error("Remote migration ledger is outside the approved pre-migration state.");
  }
  const pending = [...approvedMigrations.keys()].filter((name) => !appliedNames.includes(name));
  return pending;
}

async function localMigrationNames() {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql")).map((entry) => entry.name).sort();
}

async function assertPinnedCheckout() {
  const localNames = await localMigrationNames();
  const expectedNames = [...localNames].sort();
  const expected = [...approvedBase, ...approvedMigrations.keys()].sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(expected)) {
    throw new Error("Repository migration filenames differ from the pinned approval set.");
  }
  for (const [name, expectedHash] of approvedMigrations) {
    const content = await readFile(path.join(migrationsDirectory, name));
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== expectedHash) throw new Error("Pinned migration content verification failed.");
  }
}

function readRemoteLedger() {
  const result = spawnSync(process.execPath, [wranglerCli, "d1", "execute", "roi-plus", "--remote", "--json", "--command", ledgerQuery], {
    cwd: path.join(repositoryRoot, "apps", "api"), encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("Read-only remote migration ledger query failed.");
  return parseWranglerLedgerJson(result.stdout);
}

async function check() {
  if (process.env.APPROVED_SOURCE_SHA !== approvedCommit) {
    throw new Error("Approved source SHA does not match the pinned migration approval.");
  }
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("Required Cloudflare deployment credentials are unavailable.");
  }
  await assertPinnedCheckout();
  const localNames = await localMigrationNames();
  const pending = validateApprovedMigrationSet(localNames, readRemoteLedger());
  return pending;
}

async function main() {
  const pending = await check();
  if (process.argv.includes("--check")) {
    console.log(`Approved migration preflight passed (${pending.length} approved migration(s) pending).`);
    return;
  }
  if (pending.length === 0) {
    console.log("Approved migrations are already applied; no changes made.");
    return;
  }
  // The pinned checkout contains exactly the approved migrations. Wrangler tracks each
  // migration in d1_migrations and runs in CI without an interactive prompt.
  const result = spawnSync(process.execPath, [wranglerCli, "d1", "migrations", "apply", "roi-plus", "--remote"], {
    cwd: path.join(repositoryRoot, "apps", "api"), env: process.env, encoding: "utf8", timeout: 120000,
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (result.error || result.status !== 0) throw new Error("Approved remote D1 migration application failed.");
  console.log(`Approved migration application completed (${pending.length} migration(s)).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`Approved D1 migration workflow failed closed: ${error.message}`);
    process.exitCode = 1;
  });
}
