import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiRoot = path.join(root, 'apps', 'api')
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const targetDate = '2026-10-13'
const confirmation = 'DELETE PURCHASE HISTORY FOR 2026-10-13 ONLY'
const backupDir = process.env.PURCHASE_HISTORY_BACKUP_DIR || '/tmp/roi-plus-purchase-history-backup'
const backupPath = path.join(backupDir, 'purchase-history-2026-10-13.json')
const sqlPath = path.join(backupDir, 'delete-purchase-history-2026-10-13.sql')
const reportPath = path.join(backupDir, 'delete-report.json')
const maxRows = 5000
const maxBytes = 16 * 1024 * 1024
const maxSqlStatementBytes = 8 * 1024
const maxSqlStatements = 1000
const criticalGuardFields = {
  bets:['id','race_id','status','stake','payout','profit'],
  daily_summaries:['date','sport','bets','stake','payout'],
  experimental_paper_bets:['id','race_id','status','stake','payout','profit'],
  experimental_paper_bet_reconciliations:['bet_id','refund_amount'],
  historical_trifecta_experiment_bets:['id','race_id','status','stake','payout','profit'],
  paper_decisions:['race_id','phase'],
  experimental_paper_decisions:['id','race_id'],
  historical_trifecta_experiment_decisions:['id','race_id'],
  experimental_bankroll:['experiment_key','initial_balance'],
  historical_trifecta_experiment_bankroll:['experiment_key','initial_balance'],
}
const childTable = 'experimental_paper_bet_reconciliations'
const childTrigger = 'trg_experimental_paper_bet_reconciliations_no_delete'
const scopes = [
  ['bets', "SELECT * FROM bets WHERE race_id IN (SELECT id FROM races WHERE race_date='2026-10-13') ORDER BY id"],
  ['daily_summaries', "SELECT * FROM daily_summaries WHERE date='2026-10-13' ORDER BY sport"],
  ['experimental_paper_bets', "SELECT * FROM experimental_paper_bets WHERE race_id IN (SELECT id FROM races WHERE race_date='2026-10-13') ORDER BY id"],
  ['experimental_paper_bet_reconciliations', "SELECT q.* FROM experimental_paper_bet_reconciliations q JOIN experimental_paper_bets b ON b.id=q.bet_id JOIN races r ON r.id=b.race_id WHERE r.race_date='2026-10-13' ORDER BY q.bet_id"],
  ['historical_trifecta_experiment_bets', "SELECT * FROM historical_trifecta_experiment_bets WHERE race_id IN (SELECT id FROM races WHERE race_date='2026-10-13') ORDER BY id"],
  ['paper_decisions', "SELECT d.* FROM paper_decisions d JOIN races r ON r.id=d.race_id WHERE r.race_date='2026-10-13' ORDER BY d.race_id,d.phase"],
  ['experimental_paper_decisions', "SELECT d.* FROM experimental_paper_decisions d JOIN races r ON r.id=d.race_id WHERE r.race_date='2026-10-13' ORDER BY d.id"],
  ['historical_trifecta_experiment_decisions', "SELECT d.* FROM historical_trifecta_experiment_decisions d JOIN races r ON r.id=d.race_id WHERE r.race_date='2026-10-13' ORDER BY d.id"],
  ['experimental_bankroll', "SELECT * FROM experimental_bankroll ORDER BY experiment_key"],
  ['historical_trifecta_experiment_bankroll', "SELECT * FROM historical_trifecta_experiment_bankroll ORDER BY experiment_key"],
]
const protectedScopes = [
  ['bets', "SELECT b.* FROM bets b JOIN races r ON r.id=b.race_id WHERE r.race_date<>'2026-10-13' ORDER BY b.id", 'id', ['status','payout','profit','final_odds','settled_at']],
  ['experimental_paper_bets', "SELECT b.* FROM experimental_paper_bets b JOIN races r ON r.id=b.race_id WHERE r.race_date<>'2026-10-13' ORDER BY b.id", 'id', ['status','payout','profit','settled_at']],
  ['experimental_paper_bet_reconciliations', "SELECT q.* FROM experimental_paper_bet_reconciliations q JOIN experimental_paper_bets b ON b.id=q.bet_id JOIN races r ON r.id=b.race_id WHERE r.race_date<>'2026-10-13' ORDER BY q.bet_id", 'bet_id', []],
  ['historical_trifecta_experiment_bets', "SELECT b.* FROM historical_trifecta_experiment_bets b JOIN races r ON r.id=b.race_id WHERE r.race_date<>'2026-10-13' ORDER BY b.id", 'id', ['status','payout','profit','settled_at','final_odds']],
  ['daily_summaries', "SELECT * FROM daily_summaries WHERE date<>'2026-10-13' ORDER BY date,sport", 'date', []],
]
function fail(message) { throw new Error(message) }
export function classifyD1Failure(output, errorCode=null) {
  if(['ETIMEDOUT','ENOBUFS','ENOENT','SQLITE_TOOBIG','SQLITE_ERROR'].includes(errorCode))return errorCode.toLowerCase()
  const patterns=[
    [/cannot start a transaction within a transaction/i,'nested_transaction'],
    [/not authorized/i,'not_authorized'],
    [/incomplete input/i,'incomplete_input'],
    [/malformed JSON/i,'malformed_json'],
    [/snapshot_guard_(bets|daily_summaries|experimental_paper_bets|experimental_paper_bet_reconciliations|historical_trifecta_experiment_bets|paper_decisions|experimental_paper_decisions|historical_trifecta_experiment_decisions|experimental_bankroll|historical_trifecta_experiment_bankroll)_([0-9]+)/i,null],
    [/too many SQL variables/i,'sql_variable_limit'],
    [/expression tree is too large/i,'expression_tree_limit'],
    [/SQLITE_TOOBIG/i,'sqlite_toobig'],
    [/SQLITE_ERROR/i,'sqlite_error'],
    [/no such trigger/i,'no_such_trigger'],[/no such table/i,'no_such_table'],[/no such index/i,'no_such_index'],[/no such column/i,'no_such_column'],
    [/foreign key constraint failed/i,'foreign_key'],
    [/statement too long|too many statements/i,'statement_limit'],
    [/D1 reset before execute completed!/i,'import_rollback'],
    [/failed to execute query/i,'query_failed'],
    [/syntax error/i,'sql_syntax'],
    [/unauthorized|authentication|not authenticated/i,'auth'],
    [/ETIMEDOUT|timed out/i,'timeout'],
    [/fetch failed|network error/i,'network'],
  ]
  for(const [pattern,label] of patterns){
    const match=output.match(pattern)
    if(match)return label===null?`snapshot_guard_${match[1].toLowerCase()}_${match[2]}`:label
  }
  return 'remote_d1_nonzero'
}
function run(args, timeout=60000, stage='remote_d1_operation') {
  const result = spawnSync(process.execPath,[wrangler,...args],{cwd:apiRoot,encoding:'utf8',timeout,maxBuffer:maxBytes,env:{...process.env,CI:'true'}})
  if (result.error || result.status!==0) {
    const category=classifyD1Failure(`${result.stderr||''}\n${result.stdout||''}`,result.error?.code)
    fail(`A bounded remote D1 operation failed [${stage}:${category}].`)
  }
  return result.stdout
}
function parseQuery(output) {
  let payload
  try { payload=JSON.parse(output) } catch { fail('Wrangler returned invalid bounded-query JSON.') }
  if (!Array.isArray(payload)||payload.length!==1||payload[0]?.success!==true||!Array.isArray(payload[0].results)||payload[0].results.length>maxRows) fail('Unexpected or oversized bounded-query result.')
  return payload[0].results
}
function query(sql,stage='read_query') { return parseQuery(run(['d1','execute','roi-plus','--remote','--json','--command',sql],60000,stage)) }
function preflightSnapshot(snapshot) {
  for(const check of buildSnapshotGuardChecks(snapshot)){
    const rows=query(check.sql,`preflight_${check.table}_${check.part}`)
    if(rows.length!==1||Number(rows[0].ok)!==1)fail(`Read-only purchase snapshot preflight mismatch (${check.table}_${check.part}).`)
  }
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function quote(value) { return "'"+String(value).replaceAll("'","''")+"'" }
export function buildSnapshotGuardStatements(snapshot) {
  return buildSnapshotGuardChecks(snapshot).map(check=>`SELECT CASE WHEN ${check.condition} THEN 1 ELSE json('snapshot_guard_${check.table}_${check.part}') END;`)
}
export function buildSnapshotGuardChecks(snapshot) {
  const result=[]
  for(const [name,select] of scopes){
    const rows=snapshot.tables[name]
    if(!Array.isArray(rows))fail('Scoped snapshot table is missing.')
    if(!rows.length){
      const condition=`(SELECT COUNT(*) FROM (${select}))=0`
      result.push({table:name,part:0,condition,sql:`SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END AS ok;`})
      continue
    }
    let part=0,conditions=[]
    const flush=()=>{
      if(!conditions.length)return
      const condition=conditions.join(' AND ')
      result.push({table:name,part,condition,sql:`SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END AS ok;`})
      conditions=[];part++
    }
    for(const row of rows){
      const keys=(criticalGuardFields[name]||Object.keys(row)).filter(key=>Object.hasOwn(row,key))
      if(!keys.length)fail('Scoped snapshot row has no fields.')
      const values=keys.map(key=>{
        const value=row[key]
        if(value===null)return 'NULL'
        if(typeof value==='string')return quote(value)
        if(typeof value==='number'&&Number.isFinite(value))return String(value)
        fail('Scoped snapshot contains an unsupported SQLite value.')
      })
      const condition=`EXISTS(SELECT 1 FROM (${select}) AS s WHERE ${keys.map((key,i)=>`s."${key}" IS ${values[i]}`).join(' AND ')})`
      const candidate=[...conditions,condition].join(' AND ')
      if(Buffer.byteLength(`SELECT CASE WHEN ${candidate} THEN 1 ELSE 0 END AS ok;`)>maxSqlStatementBytes){
        flush()
        if(Buffer.byteLength(`SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END AS ok;`)>maxSqlStatementBytes)fail('A scoped snapshot row exceeds the bounded D1 statement size.')
      }
      conditions.push(condition)
    }
    flush()
    const countCondition=`(SELECT COUNT(*) FROM (${select}))=${rows.length}`
    result.push({table:name,part,condition:countCondition,sql:`SELECT CASE WHEN ${countCondition} THEN 1 ELSE 0 END AS ok;`})
  }
  if(result.length>maxSqlStatements)fail('Scoped snapshot requires too many atomic guard statements.')
  return result
}
function reverseAmount(row, reconciled=false) {
  if(reconciled)return 0
  return row.status==='open'?Number(row.stake):Number(row.stake)-Number(row.payout??0)
}
function expectedAvailable(rows, targetRows, reconciliationRows=[]) {
  const reconciled=new Set(reconciliationRows.map(row=>row.bet_id))
  return Number(rows[0]?.available_balance??0)+targetRows.reduce((sum,row)=>sum+reverseAmount(row,reconciled.has(row.id)),0)
}
export function ledgerInvariantSql(experimental) {
  if(experimental)return `SELECT b.initial_balance,b.available_balance,b.initial_balance-COALESCE((SELECT SUM(t.stake) FROM experimental_paper_bets t LEFT JOIN experimental_paper_bet_reconciliations q ON q.bet_id=t.id WHERE q.bet_id IS NULL),0)+COALESCE((SELECT SUM(CASE WHEN t.status<>'open' THEN COALESCE(t.payout,0) ELSE 0 END) FROM experimental_paper_bets t LEFT JOIN experimental_paper_bet_reconciliations q ON q.bet_id=t.id WHERE q.bet_id IS NULL),0) AS ledger_expected FROM experimental_bankroll b WHERE b.experiment_key='boat-trifecta-small-sample-v1'`
  return `SELECT b.initial_balance,b.available_balance,b.initial_balance-COALESCE((SELECT SUM(t.stake) FROM historical_trifecta_experiment_bets t),0)+COALESCE((SELECT SUM(CASE WHEN t.status<>'open' THEN COALESCE(t.payout,0) ELSE 0 END) FROM historical_trifecta_experiment_bets t),0) AS ledger_expected FROM historical_trifecta_experiment_bankroll b WHERE b.experiment_key='boat-trifecta-historical-base-v1'`
}
export function assertPreservedRows(table, before, after, key, mutableFields=[]) {
  const byKey=new Map(after.map(row=>[row[key],row]))
  for(const oldRow of before){
    const current=byKey.get(oldRow[key])
    if(!current)fail(`Non-target ${table} row disappeared.`)
    const transitioned=oldRow.status==='open'&&['won','lost','void'].includes(current.status)
    if(transitioned&&mutableFields.includes('settled_at')&&!current.settled_at)fail(`Non-target ${table} settlement timestamp is missing.`)
    for(const [field,value] of Object.entries(oldRow)){
      if(transitioned&&mutableFields.includes(field))continue
      if(value!==current[field])fail(`Non-target ${table} immutable value changed.`)
    }
  }
}
export function assertPreservedSummaries(before, after) {
  const afterByKey=new Map(after.map(row=>[`${row.date}/${row.sport}`,row]))
  for(const old of before){
    const current=afterByKey.get(`${old.date}/${old.sport}`)
    if(!current)fail('Non-target daily summary disappeared.')
    for(const field of ['bets','stake','payout'])if(Number(current[field])<Number(old[field]))fail('Non-target daily summary moved backwards.')
  }
}
export function validateSnapshotIdentity(snapshot, sourceSha) {
  return snapshot?.version===2
    && snapshot.date===targetDate
    && typeof sourceSha==='string'
    && snapshot.sourceSha===sourceSha
    && typeof snapshot.restorePointBookmark==='string'
    && snapshot.tables && snapshot.protection && snapshot.hashes && Array.isArray(snapshot.triggerSchema)
}
function validateApproval() {
  if (!/^[a-f0-9]{40}$/.test(process.env.APPROVED_SOURCE_SHA||'') || process.env.APPROVED_SOURCE_SHA!==process.env.GITHUB_SHA) fail('Approved source SHA must exactly match this workflow commit.')
  if (process.env.DELETE_CONFIRMATION!==confirmation) fail('Explicit date-scoped deletion confirmation is required.')
}
async function schemaInfo() {
  const rows=query(`SELECT type,name,sql FROM sqlite_schema WHERE name IN (${[childTrigger,'trg_experimental_paper_bets_valid_stake_insert','trg_experimental_paper_bets_valid_stake_update'].map(quote).join(',')}) ORDER BY type,name`)
  if (!rows.some(r=>r.name===childTrigger&&r.type==='trigger'&&r.sql.includes('BEFORE DELETE ON experimental_paper_bet_reconciliations'))) fail('Expected immutable reconciliation delete trigger is unavailable.')
  return rows
}
async function capture() {
  await mkdir(backupDir,{recursive:true})
  const tables={}
  for (const [name,sql] of scopes) tables[name]=query(sql)
  const schema=await schemaInfo()
  const protection={}
  for(const [name,sql] of protectedScopes)protection[name]=query(sql)
  const timeTravelOutput=run(['d1','time-travel','info','roi-plus','--json'])
  let timeTravelInfo
  try{timeTravelInfo=JSON.parse(timeTravelOutput)}catch{fail('D1 Time Travel restore-point confirmation was unavailable.')}
  const bookmark=JSON.stringify(timeTravelInfo).match(/[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}/i)?.[0]
  if(!bookmark)fail('D1 Time Travel did not return a verifiable restore bookmark.')
  const balances={experimental_bankroll:tables.experimental_bankroll,historical_trifecta_experiment_bankroll:tables.historical_trifecta_experiment_bankroll}
  const manifest={version:2,date:targetDate,sourceSha:process.env.GITHUB_SHA,capturedAt:new Date().toISOString(),restorePointBookmark:bookmark,tables,balances,protection,triggerSchema:schema,hashes:Object.fromEntries([...Object.entries(tables),...Object.entries(protection).map(([k,v])=>[`protected:${k}`,v])].map(([k,v])=>[k,digest(v)]))}
  const body=JSON.stringify(manifest)
  if (Buffer.byteLength(body)>maxBytes) fail('Scoped backup exceeded its hard size limit.')
  await writeFile(backupPath,body,{mode:0o600})
  const counts=Object.fromEntries(Object.entries(tables).map(([k,v])=>[k,v.length]))
  console.log(JSON.stringify({date:targetDate,counts,protectedCounts:Object.fromEntries(Object.entries(protection).map(([k,v])=>[k,v.length])),scopedSnapshotSha256:digest(manifest),triggerDefinitionsBackedUp:schema.length,restorePointCaptured:true}))
}
export function sqlFile(snapshot) {
  const guardSql=buildSnapshotGuardStatements(snapshot)
  const balanceAdjust=(table, key, bets, recon=false)=>{
    const expr=recon
      ? `CASE WHEN EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q WHERE q.bet_id=b.id) THEN 0 WHEN b.status='open' THEN b.stake ELSE b.stake-COALESCE(b.payout,0) END`
      : `CASE WHEN b.status='open' THEN b.stake ELSE b.stake-COALESCE(b.payout,0) END`
    return `UPDATE ${table} SET available_balance=available_balance+COALESCE((SELECT SUM(${expr}) FROM ${bets} b JOIN races r ON r.id=b.race_id WHERE r.race_date='2026-10-13'),0),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE experiment_key=${quote(key)};`
  }
  const triggerSql=snapshot.triggerSchema.find(x=>x.name===childTrigger)?.sql
  if (!triggerSql || !/^[\s\S]+$/.test(triggerSql)) fail('Reconciliation trigger backup missing.')
  const assertLedger=(experimental)=>`SELECT CASE WHEN EXISTS(SELECT 1 FROM (${ledgerInvariantSql(experimental)}) AS ledger_check WHERE available_balance=ledger_expected) THEN 1 ELSE json('bankroll ledger invariant mismatch') END;`
  // Wrangler's remote --command sends this as one Cloudflare D1 query request.
  // D1 executes semicolon-separated statements as an atomic batch; --file uses
  // the database-import path and temporarily blocks the database.
  return `${guardSql.join('\n')}\n${assertLedger(true)}\n${assertLedger(false)}\n${balanceAdjust('experimental_bankroll','boat-trifecta-small-sample-v1','experimental_paper_bets',true)}\n${balanceAdjust('historical_trifecta_experiment_bankroll','boat-trifecta-historical-base-v1','historical_trifecta_experiment_bets')}\nDROP TRIGGER ${childTrigger};\nDELETE FROM ${childTable} WHERE bet_id IN (SELECT b.id FROM experimental_paper_bets b JOIN races r ON r.id=b.race_id WHERE r.race_date='2026-10-13');\nDELETE FROM experimental_paper_bets WHERE race_id IN (SELECT id FROM races WHERE race_date='2026-10-13');\n${triggerSql};\nDELETE FROM historical_trifecta_experiment_bets WHERE race_id IN (SELECT id FROM races WHERE race_date='2026-10-13');\nDELETE FROM bets WHERE race_id IN (SELECT id FROM races WHERE race_date='2026-10-13');\nDELETE FROM daily_summaries WHERE date='2026-10-13';\n${assertLedger(true)}\n${assertLedger(false)}\n`
}
async function deleteScoped() {
  validateApproval()
  const snapshot=JSON.parse(await readFile(backupPath,'utf8'))
  if(!validateSnapshotIdentity(snapshot,process.env.GITHUB_SHA)) fail('Scoped backup identity or source SHA mismatch.')
  const currentTrigger=await schemaInfo()
  if (digest(currentTrigger)!==digest(snapshot.triggerSchema)) fail('Trigger schema changed since backup.')
  preflightSnapshot(snapshot)
  const sql=sqlFile(snapshot)
  await writeFile(sqlPath,sql,{mode:0o600})
  if((await stat(sqlPath)).size>maxBytes) fail('Deletion transaction exceeded size limit.')
  run(['d1','execute','roi-plus','--remote','--command',sql],120000,'atomic_delete_batch')
  const after={}
  for(const [name,queryText] of scopes) after[name]=query(queryText)
  if(after.bets.length||after.daily_summaries.length||after.experimental_paper_bets.length||after.experimental_paper_bet_reconciliations.length||after.historical_trifecta_experiment_bets.length) fail('Target purchase rows remain after deletion.')
  for(const name of ['paper_decisions','experimental_paper_decisions','historical_trifecta_experiment_decisions']) if(digest(after[name])!==digest(snapshot.tables[name])) fail('Decision audit changed; inspect possible concurrent settlement.')
  const afterProtection={}
  for(const [name,sql] of protectedScopes)afterProtection[name]=query(sql)
  for(const [name,,key,mutable] of protectedScopes){
    if(name==='daily_summaries')assertPreservedSummaries(snapshot.protection[name],afterProtection[name])
    else assertPreservedRows(name,snapshot.protection[name],afterProtection[name],key,mutable)
  }
  const fk=query('PRAGMA foreign_key_check;')
  if(fk.length)fail('Foreign-key integrity check failed after deletion.')
  const experimentalInvariant=query(ledgerInvariantSql(true))
  const historicalInvariant=query(ledgerInvariantSql(false))
  if(experimentalInvariant.length!==1||Number(experimentalInvariant[0].available_balance)!==Number(experimentalInvariant[0].ledger_expected))fail('Experimental bankroll no longer matches the surviving ticket ledger.')
  if(historicalInvariant.length!==1||Number(historicalInvariant[0].available_balance)!==Number(historicalInvariant[0].ledger_expected))fail('Historical bankroll no longer matches the surviving ticket ledger.')
  const restoredTriggerSchema=await schemaInfo()
  if(digest(restoredTriggerSchema)!==digest(snapshot.triggerSchema)) fail('Trigger schema was not restored exactly.')
  const report={date:targetDate,restorePointCaptured:Boolean(snapshot.restorePointBookmark),deleted:Object.fromEntries(['bets','daily_summaries','experimental_paper_bets','experimental_paper_bet_reconciliations','historical_trifecta_experiment_bets'].map(k=>[k,snapshot.tables[k].length])),decisionAuditsPreserved:Object.fromEntries(['paper_decisions','experimental_paper_decisions','historical_trifecta_experiment_decisions'].map(k=>[k,snapshot.tables[k].length])),nonTargetRowsPreserved:true,foreignKeysValid:true,bankrollLedgerInvariant:{experimental:experimentalInvariant[0],historical:historicalInvariant[0]},balanceBefore:snapshot.balances,balanceAfter:{experimental_bankroll:after.experimental_bankroll,historical_trifecta_experiment_bankroll:after.historical_trifecta_experiment_bankroll},targetPurchaseRowsRemaining:0,triggerRestored:true}
  if(!report.triggerRestored) fail('Immutable reconciliation trigger was not restored.')
  await writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600})
  console.log(JSON.stringify(report))
  if(process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,`## Approved purchase-history deletion\n\nDate: ${targetDate}. Deleted scoped normal, experimental, historical purchase and date summary rows: ${JSON.stringify(report.deleted)}. Race, prediction, odds, result and decision audit rows remain. Experimental bankroll deltas reversed; trigger restored. Backup artifact: roi-plus-purchase-history-backup-${process.env.GITHUB_RUN_ID}.\n`)
}
async function main(){
 validateApproval()
 if(process.argv[2]==='--backup') return capture()
 if(process.argv[2]==='--delete') return deleteScoped()
 fail('Choose exactly one of --backup or --delete.')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e=>{console.error('Approved purchase history deletion failed closed: '+e.message);process.exitCode=1})
