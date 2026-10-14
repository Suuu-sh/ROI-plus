import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { assertPreservedRows, buildSnapshotGuardChecks, classifyD1Failure, buildSnapshotGuardStatements, ledgerInvariantSql, sqlFile, validateSnapshotIdentity } from './delete-purchase-history-date.mjs'

const trigger = `CREATE TRIGGER trg_experimental_paper_bet_reconciliations_no_delete BEFORE DELETE ON experimental_paper_bet_reconciliations BEGIN SELECT RAISE(ABORT, 'experimental paper bet reconciliations are immutable'); END`
function fixture() {
 const db=new Database(':memory:'); db.pragma('foreign_keys=ON')
 db.exec(`CREATE TABLE races(id TEXT PRIMARY KEY,race_date TEXT);
 CREATE TABLE bets(id TEXT PRIMARY KEY,race_id TEXT REFERENCES races(id));
 CREATE TABLE daily_summaries(date TEXT,sport TEXT,PRIMARY KEY(date,sport));
 CREATE TABLE paper_decisions(race_id TEXT,phase TEXT,audit TEXT,PRIMARY KEY(race_id,phase));
 CREATE TABLE experimental_paper_decisions(id TEXT PRIMARY KEY,race_id TEXT REFERENCES races(id));
 CREATE TABLE experimental_paper_bets(id TEXT PRIMARY KEY,decision_id TEXT REFERENCES experimental_paper_decisions(id) ON DELETE RESTRICT,race_id TEXT REFERENCES races(id),status TEXT,stake INTEGER,payout INTEGER,probability REAL,prob_std REAL);
 CREATE TABLE experimental_paper_bet_reconciliations(bet_id TEXT PRIMARY KEY REFERENCES experimental_paper_bets(id) ON DELETE RESTRICT,refund_amount INTEGER);
 CREATE TABLE historical_trifecta_experiment_decisions(id TEXT PRIMARY KEY,race_id TEXT REFERENCES races(id));
 CREATE TABLE historical_trifecta_experiment_bets(id TEXT PRIMARY KEY,decision_id TEXT REFERENCES historical_trifecta_experiment_decisions(id) ON DELETE RESTRICT,race_id TEXT REFERENCES races(id),status TEXT,stake INTEGER,payout INTEGER);
 CREATE TABLE experimental_bankroll(experiment_key TEXT PRIMARY KEY,initial_balance INTEGER,available_balance INTEGER,updated_at TEXT);
 CREATE TABLE historical_trifecta_experiment_bankroll(experiment_key TEXT PRIMARY KEY,initial_balance INTEGER,available_balance INTEGER,updated_at TEXT);
 ${trigger};`)
 const insRace=db.prepare('INSERT INTO races VALUES(?,?)'); insRace.run('r13','2026-10-13');insRace.run('r14','2026-10-14')
 db.prepare('INSERT INTO bets VALUES(?,?)').run('normal13','r13'); db.prepare('INSERT INTO bets VALUES(?,?)').run('normal14','r14')
 db.prepare('INSERT INTO daily_summaries VALUES(?,?)').run('2026-10-13','boat');db.prepare('INSERT INTO daily_summaries VALUES(?,?)').run('2026-10-14','boat')
 db.prepare('INSERT INTO paper_decisions VALUES(?,?,?)').run('r13','primary_t60','keep-guard')
 db.prepare('INSERT INTO experimental_paper_decisions VALUES(?,?)').run('ed13','r13');db.prepare('INSERT INTO experimental_paper_decisions VALUES(?,?)').run('ed14','r14')
 const exp=db.prepare('INSERT INTO experimental_paper_bets(id,decision_id,race_id,status,stake,payout) VALUES(?,?,?,?,?,?)')
 exp.run('open13','ed13','r13','open',100,null);exp.run('lost13','ed13','r13','lost',200,0);exp.run('reconciled22','ed13','r13','void',22,22);exp.run('future14','ed14','r14','open',100,null);exp.run('futureLost14','ed14','r14','lost',200,0);exp.run('futureWin14','ed14','r14','won',300,700);exp.run('futureVoid14','ed14','r14','void',100,100)
 db.prepare('INSERT INTO experimental_paper_bet_reconciliations VALUES(?,?)').run('reconciled22',22)
 db.prepare('INSERT INTO historical_trifecta_experiment_decisions VALUES(?,?)').run('hd13','r13');db.prepare('INSERT INTO historical_trifecta_experiment_decisions VALUES(?,?)').run('hd14','r14')
 const hist=db.prepare('INSERT INTO historical_trifecta_experiment_bets VALUES(?,?,?,?,?,?)')
 hist.run('hopen13','hd13','r13','open',100,null);hist.run('hfuture14','hd14','r14','open',100,null);hist.run('hlost14','hd14','r14','lost',200,0);hist.run('hwon14','hd14','r14','won',300,700);hist.run('hvoid14','hd14','r14','void',100,100)
 db.prepare('INSERT INTO experimental_bankroll VALUES(?,?,?,?)').run('boat-trifecta-small-sample-v1',100000,99800,'before')
 db.prepare('INSERT INTO historical_trifecta_experiment_bankroll VALUES(?,?,?,?)').run('boat-trifecta-historical-base-v1',100000,100000,'before')
 return db
}
const scopes=[
 ['bets',"SELECT * FROM bets WHERE race_id IN (SELECT id FROM races WHERE race_date='2026-10-13') ORDER BY id"],
 ['daily_summaries',"SELECT * FROM daily_summaries WHERE date='2026-10-13' ORDER BY sport"],
 ['experimental_paper_bets',"SELECT * FROM experimental_paper_bets WHERE race_id IN (SELECT id FROM races WHERE race_date='2026-10-13') ORDER BY id"],
 ['experimental_paper_bet_reconciliations',"SELECT q.* FROM experimental_paper_bet_reconciliations q JOIN experimental_paper_bets b ON b.id=q.bet_id JOIN races r ON r.id=b.race_id WHERE r.race_date='2026-10-13' ORDER BY q.bet_id"],
 ['historical_trifecta_experiment_bets',"SELECT * FROM historical_trifecta_experiment_bets WHERE race_id IN (SELECT id FROM races WHERE race_date='2026-10-13') ORDER BY id"],
 ['paper_decisions',"SELECT d.* FROM paper_decisions d JOIN races r ON r.id=d.race_id WHERE r.race_date='2026-10-13' ORDER BY d.race_id,d.phase"],
 ['experimental_paper_decisions',"SELECT d.* FROM experimental_paper_decisions d JOIN races r ON r.id=d.race_id WHERE r.race_date='2026-10-13' ORDER BY d.id"],
 ['historical_trifecta_experiment_decisions',"SELECT d.* FROM historical_trifecta_experiment_decisions d JOIN races r ON r.id=d.race_id WHERE r.race_date='2026-10-13' ORDER BY d.id"],
 ['experimental_bankroll','SELECT * FROM experimental_bankroll ORDER BY experiment_key'],
 ['historical_trifecta_experiment_bankroll','SELECT * FROM historical_trifecta_experiment_bankroll ORDER BY experiment_key'],
]
function snapshot(db){return {tables:Object.fromEntries(scopes.map(([n,q])=>[n,db.prepare(q).all()])),triggerSchema:[{name:'trg_experimental_paper_bet_reconciliations_no_delete',type:'trigger',sql:trigger}]}}

test('deletes only target date, reverses exact experiment effects, preserves audit/future state and restores trigger',()=>{
 const db=fixture(), before=snapshot(db)
 db.transaction(()=>db.exec(sqlFile(before)))()
 assert.equal(db.prepare("SELECT count(*) n FROM bets WHERE race_id='r13'").get().n,0)
 assert.equal(db.prepare("SELECT count(*) n FROM bets WHERE race_id='r14'").get().n,1)
 assert.equal(db.prepare("SELECT count(*) n FROM daily_summaries WHERE date='2026-10-13'").get().n,0)
 assert.equal(db.prepare("SELECT count(*) n FROM daily_summaries WHERE date='2026-10-14'").get().n,1)
 assert.equal(db.prepare("SELECT count(*) n FROM experimental_paper_bets WHERE race_id='r13'").get().n,0)
 assert.equal(db.prepare("SELECT count(*) n FROM experimental_paper_bet_reconciliations").get().n,0)
 assert.equal(db.prepare("SELECT available_balance FROM experimental_bankroll").get().available_balance,100100)
 assert.equal(db.prepare("SELECT available_balance FROM historical_trifecta_experiment_bankroll").get().available_balance,100100)
 assert.equal(db.prepare("SELECT count(*) n FROM paper_decisions WHERE race_id='r13'").get().n,1)
 assert.equal(db.prepare("SELECT count(*) n FROM experimental_paper_decisions WHERE race_id='r13'").get().n,1)
 assert.equal(db.prepare("SELECT count(*) n FROM historical_trifecta_experiment_decisions WHERE race_id='r13'").get().n,1)
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND name='trg_experimental_paper_bet_reconciliations_no_delete'").get().n,1)
 for(const experimental of [true,false]){const invariant=db.prepare(ledgerInvariantSql(experimental)).get();assert.equal(invariant.available_balance,invariant.ledger_expected)}
 db.close()
})
test('mutation SQL is one bounded D1 query batch with no import transaction wrapper',()=>{
 const sql=sqlFile(snapshot(fixture()))
 assert.doesNotMatch(sql,/^(?:BEGIN TRANSACTION|COMMIT);?$/im)
 assert.ok(Buffer.byteLength(sql)<100*1024)
 assert.match(sql,/DROP TRIGGER/)
 assert.match(sql,/DELETE FROM daily_summaries/)
})

test('snapshot guard rolls back all changes on concurrent target write',()=>{
 const db=fixture(), before=snapshot(db)
 db.prepare('INSERT INTO bets VALUES(?,?)').run('concurrent','r13')
 assert.throws(()=>db.transaction(()=>db.exec(sqlFile(before)))(),/malformed JSON/)
 assert.equal(db.prepare("SELECT count(*) n FROM bets WHERE race_id='r13'").get().n,2)
 assert.equal(db.prepare("SELECT available_balance FROM experimental_bankroll").get().available_balance,99800)
 assert.equal(db.prepare("SELECT count(*) n FROM experimental_paper_bet_reconciliations").get().n,1)
 db.close()
})
test('later delete failure rolls back balance adjustment and child cleanup',()=>{
 const db=fixture(), before=snapshot(db)
 db.exec("CREATE TRIGGER deny_parent BEFORE DELETE ON experimental_paper_bets BEGIN SELECT RAISE(ABORT,'blocked'); END")
 assert.throws(()=>db.transaction(()=>db.exec(sqlFile(before)))(),/blocked/)
 assert.equal(db.prepare("SELECT count(*) n FROM experimental_paper_bets WHERE race_id='r13'").get().n,3)
 assert.equal(db.prepare("SELECT count(*) n FROM experimental_paper_bet_reconciliations").get().n,1)
 assert.equal(db.prepare("SELECT available_balance FROM experimental_bankroll").get().available_balance,99800)
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND name='trg_experimental_paper_bet_reconciliations_no_delete'").get().n,1)
 for(const experimental of [true,false]){const invariant=db.prepare(ledgerInvariantSql(experimental)).get();assert.equal(invariant.available_balance,invariant.ledger_expected)}
 db.close()
})

test('per-row D1 guards chunk large target snapshots below 8 KiB',()=>{
 const db=fixture(), data=snapshot(db)
 data.tables.bets=Array.from({length:300},(_,i)=>({id:`large-${i}-${'x'.repeat(30)}`,race_id:'r13',status:'open',stake:100,payout:null,profit:null}))
 const statements=buildSnapshotGuardStatements(data)
 assert.ok(statements.length>scopes.length)
 assert.ok(statements.every(sql=>Buffer.byteLength(sql)<=8*1024))
 db.close()
})
test('non-target preservation allows only an open-to-settled mutable transition',()=>{
 const old={id:'keep',race_id:'r14',status:'open',stake:100,payout:null,profit:null,settled_at:null,selection:'1'}
 assert.doesNotThrow(()=>assertPreservedRows('bets',[old],[{...old,status:'lost',payout:0,profit:-100,settled_at:'2026-10-14T00:00:00Z'}],'id',['status','payout','profit','settled_at']))
 assert.throws(()=>assertPreservedRows('bets',[old],[{...old,selection:'2'}],'id',['status','payout','profit','settled_at']),/immutable value changed/)
 assert.throws(()=>assertPreservedRows('bets',[old],[],'id',['status','payout','profit','settled_at']),/disappeared/)
})

test('accepts the uploaded version-2 scoped backup manifest at its approved SHA',()=>{
 const sha='a'.repeat(40)
 const captured={version:2,date:'2026-10-13',sourceSha:sha,restorePointBookmark:'opaque-restore-point',tables:{bets:[]},protection:{bets:[]},hashes:{bets:'sha256'},triggerSchema:[]}
 assert.equal(validateSnapshotIdentity(captured,sha),true)
 assert.equal(validateSnapshotIdentity({...captured,version:1},sha),false)
 assert.equal(validateSnapshotIdentity(captured,'b'.repeat(40)),false)
 assert.equal(validateSnapshotIdentity({...captured,date:'2026-10-14'},sha),false)
})

test('REAL-affinity snapshots compare numeric values without JSON text formatting',()=>{
 const db=fixture()
 db.prepare("UPDATE experimental_paper_bets SET probability=1.0,prob_std=0.05 WHERE id='open13'").run()
 const before=snapshot(db)
 const rows=before.tables.experimental_paper_bets
 const fields=Object.keys(rows[0]).flatMap(k=>[`'${k}'`,`"${k}"`]).join(',')
 const sql="SELECT COALESCE(json_group_array(json_object("+fields+")),'[]') AS j FROM (SELECT * FROM experimental_paper_bets WHERE race_id IN (SELECT id FROM races WHERE race_date='2026-10-13') ORDER BY id)"
 assert.notEqual(db.prepare(sql).get().j,JSON.stringify(rows))
 assert.ok(buildSnapshotGuardChecks(before).every(check=>db.prepare(check.sql).get().ok===1))
 db.transaction(()=>db.exec(sqlFile(before)))()
 assert.equal(db.prepare("SELECT count(*) n FROM experimental_paper_bets WHERE race_id='r13'").get().n,0)
 db.close()
})

test('D1 failure diagnostics expose only allowlisted signatures and safe guard labels',()=>{
 assert.equal(classifyD1Failure('cannot start a transaction within a transaction'),'nested_transaction')
 assert.equal(classifyD1Failure('SQLITE_TOOBIG'),'sqlite_toobig')
 assert.equal(classifyD1Failure('snapshot_guard_experimental_paper_bets_4'),'snapshot_guard_experimental_paper_bets_4')
 assert.equal(classifyD1Failure('D1 runs your SQL in a transaction for you'),'remote_d1_nonzero')
 assert.equal(classifyD1Failure('private row value: secret123'),'remote_d1_nonzero')
})
