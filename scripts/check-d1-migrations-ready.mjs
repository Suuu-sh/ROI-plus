import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const migrationsDirectory = path.join(repositoryRoot, "db", "migrations");
const wranglerCli = path.join(repositoryRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const maxLedgerRows = 100;
const ledgerQuery = "SELECT name FROM d1_migrations ORDER BY id LIMIT 100;";

function validateNames(names, label) {
  if (!Array.isArray(names)) throw new Error(label + " must be an array.");
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== "string" || !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) {
      throw new Error(label + " contains an invalid migration name.");
    }
    if (seen.has(name)) throw new Error(label + " contains duplicate migration names.");
    seen.add(name);
  }
  return seen;
}

export function parseWranglerLedgerJson(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("Wrangler did not return valid JSON.");
  }

  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new Error("Wrangler returned an unexpected D1 query result.");
  }
  const query = payload[0];
  if (!query || query.success !== true || !Array.isArray(query.results)) {
    throw new Error("The D1 migration ledger query did not succeed.");
  }
  if (query.results.length >= maxLedgerRows) {
    throw new Error("The D1 migration ledger reached the bounded query limit.");
  }

  const names = query.results.map((row) => {
    if (!row || typeof row.name !== "string") {
      throw new Error("The D1 migration ledger returned an invalid row.");
    }
    return row.name;
  });
  validateNames(names, "Remote migration ledger");
  return names;
}

export function compareMigrationNames(localNames, appliedNames) {
  const local = validateNames(localNames, "Repository migrations");
  const applied = validateNames(appliedNames, "Remote migration ledger");
  const missing = [...local].filter((name) => !applied.has(name)).sort();
  const unexpected = [...applied].filter((name) => !local.has(name)).sort();
  return { ready: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

async function readLocalMigrationNames() {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0 || names.length >= maxLedgerRows) {
    throw new Error("Repository migration files are missing or exceed the readiness-check bound.");
  }
  validateNames(names, "Repository migrations");
  return names;
}

async function main() {
  const requiredSecrets = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
  const missingSecrets = requiredSecrets.filter((name) => !process.env[name]);
  if (missingSecrets.length > 0) {
    throw new Error("Existing Cloudflare deployment credentials are unavailable: " + missingSecrets.join(", "));
  }

  const localNames = await readLocalMigrationNames();
  const query = spawnSync(
    process.execPath,
    [wranglerCli, "d1", "execute", "roi-plus", "--remote", "--json", "--command", ledgerQuery],
    { cwd: path.join(repositoryRoot, "apps", "api"), encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 }
  );
  if (query.error || query.status !== 0) {
    throw new Error("The read-only remote D1 migration ledger query failed.");
  }

  const appliedNames = parseWranglerLedgerJson(query.stdout);
  const comparison = compareMigrationNames(localNames, appliedNames);
  if (!comparison.ready) {
    const details = [];
    if (comparison.missing.length > 0) details.push("not applied: " + comparison.missing.join(", "));
    if (comparison.unexpected.length > 0) details.push("not present in this checkout: " + comparison.unexpected.join(", "));
    throw new Error("Remote D1 schema is not ready (" + details.join("; ") + ").");
  }

  console.log("D1 migration readiness confirmed (" + localNames.length + " migrations applied).");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error("D1 migration readiness check failed closed: " + error.message);
    process.exitCode = 1;
  });
}
