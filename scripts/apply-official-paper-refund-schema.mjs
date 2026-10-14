import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareMigrationNames, parseWranglerLedgerJson } from './check-d1-migrations-ready.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiRoot = path.join(root, 'apps', 'api')
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const target = '0015_official_paper_refunds.sql'
const migrationDir = path.join(root, 'db', 'migrations')
const tableQueries = [
  ['experimental_paper_bets', 'SELECT * FROM experimental_paper_bets ORDER BY id LIMIT 5001;', 'id'],
  ['historical_trifecta_experiment_bets', 'SELECT * FROM historical_trifecta_experiment_bets ORDER BY id LIMIT 5001;', 'id'],
  ['experimental_paper_bet_reconciliations', 'SELECT * FROM experimental_paper_bet_reconciliations ORDER BY bet_id LIMIT 5001;', 'bet_id'],
]
const maxRows = 5000
const maxOutputBytes = 4 * 1024 * 1024
const maxBackupBytes = 32 * 1024 * 1024
const snapshotPath = path.join(process.env.REFUND_BACKUP_DIR || '/tmp', 'roi-plus-refund-schema-snapshot.json')

export function refundMigrationAction(local, applied) {
  const comparison = compareMigrationNames(local, applied)
  if (comparison.unexpected.length) throw new Error('Remote migration ledger contains names absent from this checkout.')
  if (comparison.ready) return 'already-applied'
  if (comparison.missing.length === 1 && comparison.missing[0] === target) return 'apply-target'
  throw new Error('Fail closed: 0015 must be the only unapplied migration.')
}

function run(args, { timeout = 30_000, maxBuffer = maxOutputBytes } = {}) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: apiRoot, encoding: 'utf8', timeout, maxBuffer,
    env: { ...process.env, CI: 'true' },
  })
  if (result.error || result.status !== 0) throw new Error('A bounded remote D1 operation failed.')
  return result.stdout
}

function parseQuery(output) {
  let payload
  try { payload = JSON.parse(output) } catch { throw new Error('Wrangler returned invalid bounded-query JSON.') }
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success !== true || !Array.isArray(payload[0].results)) {
    throw new Error('Wrangler returned an unexpected bounded-query result.')
  }
  if (payload[0].results.length > maxRows) throw new Error('Refund migration snapshot exceeded its row bound.')
  return payload[0].results
}

function query(sql) {
  return parseQuery(run(['d1', 'execute', 'roi-plus', '--remote', '--json', '--command', sql]))
}

async function prepareSnapshot() {
  const snapshots = {}
  const backupDir = process.env.REFUND_BACKUP_DIR || '/tmp'
  await mkdir(backupDir, { recursive: true })
  for (const [table, sql] of tableQueries) {
    const rows = query(sql)
    const keys = new Set(rows.map((row) => row[table === 'experimental_paper_bet_reconciliations' ? 'bet_id' : 'id']))
    if (keys.size !== rows.length) throw new Error('Pre-migration snapshot contains duplicate primary keys.')
    snapshots[table] = rows
    const exportPath = path.join(backupDir, `${table}.sql`)
    run(['d1', 'export', 'roi-plus', '--remote', '--skip-confirmation', '--no-schema', '--table', table, '--output', exportPath], { timeout: 120_000 })
    if ((await stat(exportPath)).size > maxBackupBytes) throw new Error('Pre-migration table export exceeded its size bound.')
  }
  const info = run(['d1', 'time-travel', 'info', 'roi-plus', '--json'])
  let bookmarkInfo
  try { bookmarkInfo = JSON.parse(info) } catch { throw new Error('D1 Time Travel snapshot confirmation was unavailable.') }
  const bookmarkMatch = JSON.stringify(bookmarkInfo).match(/[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}/i)
  if (!bookmarkMatch) throw new Error('D1 Time Travel did not return a verifiable restore bookmark.')
  const snapshot = { createdAt: new Date().toISOString(), bookmark: bookmarkMatch[0], tables: snapshots }
  await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 })
  return snapshot
}

export function assertPreserved(before, after) {
  const idOf = (table, row) => row[table === 'experimental_paper_bet_reconciliations' ? 'bet_id' : 'id']
  for (const [table, originalRows] of Object.entries(before.tables)) {
    const currentRows = after[table]
    const currentById = new Map(currentRows.map((row) => [idOf(table, row), row]))
    for (const oldRow of originalRows) {
      const current = currentById.get(idOf(table, oldRow))
      if (!current) throw new Error('Refund migration lost a pre-existing row in ' + table + '.')
      if (table === 'experimental_paper_bet_reconciliations') {
        if (JSON.stringify(current) !== JSON.stringify(oldRow)) throw new Error('Refund migration changed immutable reconciliation data.')
      } else {
        if (!['open', 'won', 'lost', 'void'].includes(current.status)) throw new Error('Refund migration left an unknown status in ' + table + '.')
        const transitioned = oldRow.status === 'open' && current.status !== 'open'
        const mutable = new Set(table === 'experimental_paper_bets'
          ? ['status', 'payout', 'profit', 'settled_at']
          : ['status', 'payout', 'profit', 'settled_at', 'final_odds'])
        for (const [key, value] of Object.entries(oldRow)) {
          if ((transitioned && mutable.has(key)) || value === current[key]) continue
          throw new Error('Refund migration changed immutable bet data in ' + table + '.')
        }
      }
    }
  }
}

async function localNames() {
  const entries = await readdir(migrationDir, { withFileTypes: true })
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).map((entry) => entry.name).sort()
  if (!names.includes(target) || names.length >= 100) throw new Error('Local migration set is outside the bounded preflight.')
  return names
}

function runIntegrityChecks() {
  const fk = query('PRAGMA foreign_key_check;')
  if (fk.length !== 0) throw new Error('Foreign-key integrity check failed after migration.')
  const checks = query("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name IN ('experimental_paper_bets','historical_trifecta_experiment_bets');")
  if (checks.length !== 2 || checks.some((row) => !String(row.sql).includes("'void'"))) {
    throw new Error('Refund status schema check failed after migration.')
  }
}

async function main() {
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    if (!process.env[name]) throw new Error('Required deployment credential is unavailable: ' + name)
  }
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (sha.error || sha.status !== 0 || process.env.APPROVED_SOURCE_SHA !== sha.stdout.trim()) {
    throw new Error('Approved source SHA must exactly match the checked-out commit.')
  }
  if (process.env.REFUND_SCHEMA_CONFIRMATION !== 'APPLY ROI+ MIGRATION 0015') {
    throw new Error('Explicit migration confirmation is required.')
  }
  const migrationBytes = await readFile(path.join(migrationDir, target))
  if (!migrationBytes.length) throw new Error('Target migration is empty.')

  const local = await localNames()
  if (process.argv.includes('--prepare')) {
    const snapshot = await prepareSnapshot()
    const counts = Object.entries(snapshot.tables).map(([table, rows]) => `${table}=${rows.length}`).join(', ')
    console.log(`Refund migration preflight snapshot ready; migration=${target}; bookmark=${snapshot.bookmark}; bounded rows verified (${counts}).`)
    return
  }
  if (!process.argv.includes('--apply')) throw new Error('Select exactly one of --prepare or --apply.')
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
  if (!snapshot.bookmark || !snapshot.tables) throw new Error('Pre-migration backup snapshot is incomplete.')
  for (const [table] of tableQueries) {
    const backup = await stat(path.join(process.env.REFUND_BACKUP_DIR || '/tmp', `${table}.sql`))
    if (backup.size <= 0 || backup.size > maxBackupBytes) throw new Error('Pre-migration SQL export is missing or outside its size bound.')
  }
  const beforeLedger = parseWranglerLedgerJson(run(['d1', 'execute', 'roi-plus', '--remote', '--json', '--command', 'SELECT name FROM d1_migrations ORDER BY id LIMIT 100;']))
  const action = refundMigrationAction(local, beforeLedger)
  if (action === 'apply-target') {
    run(['d1', 'migrations', 'apply', 'roi-plus', '--remote'], { timeout: 120_000, maxBuffer: maxOutputBytes })
  }
  const afterRows = {}
  for (const [table, sql] of tableQueries) afterRows[table] = query(sql)
  assertPreserved(snapshot, afterRows)
  runIntegrityChecks()
  const afterLedger = parseWranglerLedgerJson(run(['d1', 'execute', 'roi-plus', '--remote', '--json', '--command', 'SELECT name FROM d1_migrations ORDER BY id LIMIT 100;']))
  if (!compareMigrationNames(local, afterLedger).ready) throw new Error('Remote migration ledger did not converge to this checkout.')
  const summaries = Object.entries(afterRows).map(([name, rows]) => {
    const sha256 = createHash('sha256').update(JSON.stringify(rows)).digest('hex')
    return `${name}=${rows.length}/${sha256.slice(0, 12)}`
  }).join(', ')
  console.log(`Official refund schema ${action === 'already-applied' ? 'verified' : 'applied'}; migration=${target}; preserved row IDs and data verified (${summaries}); foreign keys clean.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error('Official refund schema workflow failed closed: ' + error.message); process.exitCode = 1 })
}
