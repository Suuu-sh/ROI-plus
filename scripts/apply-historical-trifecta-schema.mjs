import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareMigrationNames, parseWranglerLedgerJson } from './check-d1-migrations-ready.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = '0014_historical_trifecta_experiment.sql'
const ledgerSql = 'SELECT name FROM d1_migrations ORDER BY id LIMIT 100;'

export function migrationAction(localNames, appliedNames) {
  const comparison = compareMigrationNames(localNames, appliedNames)
  if (comparison.unexpected.length) throw new Error('Remote migration ledger contains names absent from this checkout.')
  if (comparison.ready) return 'already-applied'
  if (comparison.missing.length === 1 && comparison.missing[0] === target) return 'apply-target'
  throw new Error('Fail closed: remote migrations must equal this checkout except for the single 0014 target.')
}

async function localNames() {
  const entries = await readdir(path.join(root, 'db', 'migrations'), { withFileTypes: true })
  const names = entries.filter(x => x.isFile() && x.name.endsWith('.sql')).map(x => x.name).sort()
  if (!names.length || names.length >= 100) throw new Error('Local migration list is outside the bounded preflight.')
  return names
}
function queryRemote() {
  const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'roi-plus', '--remote', '--json', '--command', ledgerSql], {
    cwd: path.join(root, 'apps', 'api'), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw new Error('Read-only remote migration ledger query failed.')
  return parseWranglerLedgerJson(result.stdout)
}
function applyRemote() {
  const result = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'roi-plus', '--remote'], {
    cwd: path.join(root, 'apps', 'api'), encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, CI: 'true' },
  })
  if (result.error || result.status !== 0) throw new Error('Remote 0014 migration apply failed.')
}
async function main() {
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    if (!process.env[name]) throw new Error('Required deployment credential is unavailable: ' + name)
  }
  const names = await localNames()
  if (!names.includes(target)) throw new Error('Target migration is not present in this checkout.')
  const before = queryRemote()
  const action = migrationAction(names, before)
  if (process.argv.includes('--check')) {
    console.log(action === 'already-applied' ? 'Historical experiment schema already applied.' : 'Historical experiment schema preflight is safe to apply.')
    return
  }
  if (action === 'apply-target') applyRemote()
  const after = queryRemote()
  if (!compareMigrationNames(names, after).ready) throw new Error('Remote migration ledger did not converge to this checkout.')
  console.log('Historical experiment schema migration state verified.')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('Historical experiment schema workflow failed closed: ' + error.message); process.exitCode = 1 })
}
