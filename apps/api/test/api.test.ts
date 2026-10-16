import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import worker, { app, settleOpen, autoBet, autoBetWithReport, recordPaperAbstention, experimentalPaperDecision, cron } from '../src/index.js';
import { D1SqliteAdapter } from './d1-adapter.js';
import { payoutYen, settleValues } from '../src/services/logic.js';
import { readWriteBudget, reserveWriteBudget } from '../src/services/writeBudget.js';

const root=resolve(import.meta.dirname,'../../..');
let sqlite: Sqlite.Database, DB: D1SqliteAdapter;
const env=(extra:Record<string,unknown>={})=>({DB,INGEST_TOKEN:'test-token',ENABLE_AUTO_BET:'true',...extra});
const jstIso=(ms=Date.now())=>new Date(ms+9*60*60*1000).toISOString().replace('Z','+09:00');
const jstDate=(date:Date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const setPaperCutoff=(raceId:string,decisionAt:number)=>sqlite.prepare('UPDATE races SET race_date=?,post_time=?,betting_cutoff_at=?,betting_cutoff_source=?,betting_cutoff_observed_at=? WHERE id=?').run(jstDate(),jstIso(decisionAt+240_000),jstIso(decisionAt+60_000),'boatrace-racelist-cutoff-v1',jstIso(decisionAt-30_000),raceId);
const canonicalJson=(value:any):string=>Array.isArray(value)?`[${value.map(canonicalJson).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`:JSON.stringify(value)??'null';
const sha256Json=(value:unknown)=>createHash('sha256').update(canonicalJson(value),'utf8').digest('hex');
const sha256Text=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const purchasePage=(url:string,oddsBySelection:Map<string,number>)=>{
 const u=new URL(url),firsts=[1,2,3,4,5,6],rows:string[]=[];
 for(let group=0;group<5;group++)for(let row=0;row<4;row++)rows.push(`<tr>${firsts.map(a=>{
  const b=firsts.filter(n=>n!==a)[group],c=firsts.filter(n=>n!==a&&n!==b)[row];
  return `${row===0?`<td rowspan="4">${b}</td>`:''}<td>${c}</td><td>${oddsBySelection.get(`${a}-${b}-${c}`)??200}</td>`;
 }).join('')}</tr>`);
 return `<div class="tab3"><a href="/owpc/pc/race/racelist?rno=${u.searchParams.get('rno')}&amp;jcd=${u.searchParams.get('jcd')}&amp;hd=${u.searchParams.get('hd')}">出走表</a><a href="/owpc/pc/race/raceresult?rno=${u.searchParams.get('rno')}&amp;jcd=${u.searchParams.get('jcd')}&amp;hd=${u.searchParams.get('hd')}">結果</a></div><p>オッズ更新時間 12:00</p><span>3連単オッズ</span><table><thead><tr>${firsts.map(n=>`<th>${n}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
};
beforeEach(()=>{
 sqlite=new Sqlite(':memory:'); DB=new D1SqliteAdapter(sqlite);
 for (const f of readdirSync(resolve(root,'db/migrations')).filter(f=>f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(resolve(root,'db/migrations',f),'utf8'));
 sqlite.prepare("INSERT INTO settings(key,value) VALUES('roi_d1_write_budget_utc',?)").run(JSON.stringify({date:new Date().toISOString().slice(0,10),reserved:0,oddsReserved:0}));
 sqlite.exec(readFileSync(resolve(root,'db/seed/sample.sql'),'utf8'));
 // Synthetic official HTTP market; never issue real requests from decision tests.
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  const u=new URL(url),race=sqlite.prepare('SELECT id FROM races WHERE venue_id=? AND race_no=? AND race_date=? LIMIT 1').get(u.searchParams.get('jcd'),Number(u.searchParams.get('rno')),u.searchParams.get('hd')?.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3')) as any;
  const rows=race?sqlite.prepare("SELECT selection,odds,captured_at FROM odds_snapshots WHERE race_id=? AND bet_type='trifecta'").all(race.id) as any[]:[];
  if(rows.length&&Date.now()-Date.parse(rows[0].captured_at)>10*60_000)return new Response('',{status:503});
  return new Response(purchasePage(url,new Map(rows.map(x=>[x.selection,x.odds]))));
 }));
 sqlite.prepare("UPDATE models SET metrics_json=json_set(CASE WHEN json_valid(metrics_json) THEN metrics_json ELSE '{}' END,'$.boatVenueSchemaVersion','boat-venue-v2','$.correctedTrainingDataSha256',?,'$.boatArtifactSha256',?) WHERE id='boat-active'").run('f'.repeat(64),'a'.repeat(64));
 sqlite.prepare("UPDATE races SET post_time=? WHERE data_origin='sample' AND status='scheduled'").run(jstIso(Date.now()+60*60_000));
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();sqlite.close();});
const addBetInputs=(raceId:string,prefix:string)=>{
 const entry=sqlite.prepare('SELECT number FROM entries WHERE race_id=? ORDER BY number LIMIT 1').get(raceId) as {number:number};
 sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES(?,?,'win',?,10,?,'test','sample')").run(`${prefix}-odds`,raceId,String(entry.number),jstIso(Date.now()-5000));
 sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES(?,?,'boat-active',?,0.5,0.01,?,'sample')").run(`${prefix}-prediction`,raceId,entry.number,jstIso(Date.now()-10000));
 return String(entry.number);
};
const addValidatedTrifectaFixture=(raceId='boat-20990101-99-01',modelId='boat-trifecta-validated')=>{
 const raceNo=Number(/-(\d{2})$/.exec(raceId)?.[1]??'01');
 const version=modelId==='boat-trifecta-validated'?'v1':modelId;
 const artifactSha256='b'.repeat(64);
 const metrics={ticketModelSchemaVersion:'ticket-selection-v1',ticketPredictionSemantics:'exact-selection-probability-v1',ticketBetType:'trifecta',ticketArtifactSha256:artifactSha256,promotionEligible:true,
  ticketValidation:{status:'independently_validated',independentReviewId:'offline-ticket-audit-1',policyVersion:'ticket-selection-v1',betType:'trifecta',artifactSha256,reportSha256:'c'.repeat(64),dataOrigin:'real',completeCombinationCoverage:true,probabilitiesNormalized:true,outOfSampleValidated:true,pointInTimeSafe:true,validatedAt:jstIso()}};
 sqlite.prepare("INSERT OR IGNORE INTO venues(id,sport,name) VALUES('99','boat','Ticket fixture')").run();
 sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at) VALUES(?,'boat','99','2099-01-01',?,?,'scheduled','real',?)").run(raceId,raceNo,jstIso(Date.now()+60*60_000),jstIso());
 const numbers=[1,2,3,4,5,6];
 for(const number of numbers)sqlite.prepare("INSERT INTO entries(id,race_id,number,name,available_at,data_origin) VALUES(?,?,?,? ,?,'real')").run(`${raceId}-${number}`,raceId,number,`Runner ${number}`,jstIso(Date.now()-60_000));
 sqlite.prepare("INSERT INTO models(id,sport,bet_type,version,algorithm,status,metrics_json,trained_at) VALUES(?,'boat','trifecta',?,'fixture','active',?,?)").run(modelId,version,JSON.stringify(metrics),jstIso(Date.now()-60_000));
 const oddsUrl=`https://www.boatrace.jp/owpc/pc/race/odds3t?hd=20990101&jcd=99&rno=${raceNo}`,capturedAt=jstIso(Date.now()-5000),predictedAt=jstIso(Date.now()-10_000),sha='d'.repeat(64);
 const selections:string[]=[];
 for(const a of numbers)for(const b of numbers)for(const c of numbers)if(a!==b&&a!==c&&b!==c)selections.push(`${a}-${b}-${c}`);
 for(let i=0;i<selections.length;i++){
  const selection=selections[i];
  sqlite.prepare("INSERT INTO ticket_predictions(id,race_id,model_id,bet_type,selection,probability,prob_std,predicted_at,data_origin,feature_schema_version,artifact_sha256) VALUES(?,?,?,'trifecta',?,?,0.001,?,'real','ticket-selection-v1',?)").run(`${modelId}-${raceId}-tp-${i}`,raceId,modelId,selection,1/120,predictedAt,artifactSha256);
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin,source_url,source_sha256,quality_status) VALUES(?,?,'trifecta',?,200,?,'boatrace-trifecta-official-v1','real',?,?,'verified-complete-v1')").run(`${modelId}-${raceId}-to-${i}`,raceId,selection,capturedAt,oddsUrl,sha);
 }
 return {raceId,modelId,selections};
};
const addPaperTrifecta=(raceId='boat-20990101-99-01',modelId='boat-trifecta-validated')=>{
 const fixture=addValidatedTrifectaFixture(raceId,modelId);
 const decisionAt=Date.now();setPaperCutoff(raceId,decisionAt);
 sqlite.prepare("UPDATE odds_snapshots SET source_url=REPLACE(source_url,'20990101',?) WHERE race_id=? AND bet_type='trifecta'")
  .run(jstDate().replaceAll('-',''),raceId);
 return {...fixture,decisionAt};
};
describe('EdgeLab API',()=>{
 it('reconciles open invalid experimental stakes once and rejects future invalid rows',()=>{
  const migrationDb=new Sqlite(':memory:');
  try{
   migrationDb.exec(`CREATE TABLE experimental_paper_decisions(id TEXT PRIMARY KEY,experiment_key TEXT,outcome TEXT);
    CREATE TABLE experimental_paper_bets(id TEXT PRIMARY KEY,decision_id TEXT,race_id TEXT,stake INTEGER,data_origin TEXT,status TEXT);
    CREATE TABLE experimental_bankroll(experiment_key TEXT PRIMARY KEY,available_balance INTEGER,updated_at TEXT);
    INSERT INTO experimental_paper_decisions VALUES('placed','boat-trifecta-small-sample-v1','placed');
    INSERT INTO experimental_paper_bets VALUES('invalid-22','placed','boat-live',22,'real','open');
    INSERT INTO experimental_paper_bets VALUES('invalid-80','placed','boat-live',80,'real','open');
    INSERT INTO experimental_paper_bets VALUES('valid-100','placed','boat-live',100,'real','open');
    INSERT INTO experimental_paper_bets VALUES('settled-invalid','placed','boat-old',99,'real','lost');
    INSERT INTO experimental_bankroll VALUES('boat-trifecta-small-sample-v1',100000,'before');`);
   const migration=readFileSync(resolve(root,'db/migrations/0013_reconcile_invalid_experimental_stakes.sql'),'utf8');
   migrationDb.exec(migration);
   expect(migrationDb.prepare('SELECT bet_id,original_stake,refund_amount,repair_reason FROM experimental_paper_bet_reconciliations ORDER BY bet_id').all()).toEqual([
    {bet_id:'invalid-22',original_stake:22,refund_amount:22,repair_reason:'invalid_stake_unit'},
    {bet_id:'invalid-80',original_stake:80,refund_amount:80,repair_reason:'invalid_stake_unit'},
   ]);
   expect(migrationDb.prepare('SELECT available_balance FROM experimental_bankroll').get()).toMatchObject({available_balance:100102});
   expect(migrationDb.prepare("SELECT status,stake FROM experimental_paper_bets WHERE id='invalid-22'").get()).toMatchObject({status:'open',stake:22});
   expect(migrationDb.prepare("SELECT COUNT(*) n FROM experimental_paper_bet_reconciliations WHERE refund_applied_at IS NULL").get()).toMatchObject({n:0});

   // Retrying the data-repair DML is a no-op after the refund marker is set.
   const repairStart=migration.indexOf('-- The nullable refund marker');
   const repairEnd=migration.indexOf('CREATE TRIGGER trg_experimental_paper_bets_valid_stake_insert');
   migrationDb.exec(migration.slice(repairStart,repairEnd));
   expect(migrationDb.prepare('SELECT available_balance FROM experimental_bankroll').get()).toMatchObject({available_balance:100102});
   expect(()=>migrationDb.prepare("INSERT INTO experimental_paper_bets VALUES('future-22','placed','boat-new',22,'real','open')").run()).toThrow(/must be at least 100 yen/);
   expect(()=>migrationDb.prepare("UPDATE experimental_paper_bets SET stake=99 WHERE id='valid-100'").run()).toThrow(/must be at least 100 yen/);
  }finally{migrationDb.close();}
 });

 it('health and date-filtered sample races respond',async()=>{
  expect((await app.request('/api/health',{},env())).status).toBe(200);
  // サンプルは生成日を「今日」として作られるため、シード内の最新日付を使う（実行日に依存させない）
  const today=(sqlite.prepare("SELECT MAX(race_date) d FROM races WHERE data_origin='sample'").get() as {d:string}).d;
  const r=await app.request(`/api/races?sport=horse&date=${today}&origin=sample`,{},env());
  expect(r.status).toBe(200); const rows=await r.json() as any[]; expect(rows.length).toBeGreaterThanOrEqual(12); expect(rows.every(x=>x.dataOrigin==='sample')).toBe(true);
 });
 it('keeps official result-worker provenance server-owned even from authenticated ingest',async()=>{
  const response=await app.request('/api/ingest/collection-runs',{method:'POST',headers:{Authorization:'Bearer test-token','content-type':'application/json'},
    body:JSON.stringify([{id:'boat-result:boat-20261013-09-01',source:'boatrace-results-worker-v1',sport:'boat',target_date:'2026-10-13',started_at:jstIso(),finished_at:jstIso(),status:'success',records:8,reason:JSON.stringify({quality:'verified-official-outcome-v2',url:'https://www.boatrace.jp/owpc/pc/race/raceresult',sha256:'a'.repeat(64),fetchedAt:jstIso(),results:[],payouts:[]})}])},env());
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({error:'official result-worker evidence is server-owned'});
 });
 it('reads one bounded historical trifecta batch and odds snapshot without making candidates or writing',async()=>{
  const {raceId}=addValidatedTrifectaFixture();
  sqlite.prepare("UPDATE races SET status='finished',post_time=? WHERE id=?").run(jstIso(Date.now()-60_000),raceId);
  const beforeBudget=(sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get() as {value:string}).value;
  const response=await app.request(`/api/shadow/races/${raceId}`,{},env());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const snapshot=await response.json() as any;
  expect(snapshot).toMatchObject({
   race:{id:raceId,sport:'boat',dataOrigin:'real',status:'finished',entryCount:6},
   pointInTimeAvailability:'not-recorded',
  });
  expect(snapshot.predictionBatch).toMatchObject({modelId:'boat-trifecta-validated',modelVersion:'v1',rowCount:120});
  expect(snapshot.predictionBatch.rows).toHaveLength(120);
  expect(snapshot.oddsSnapshot).toMatchObject({source:'boatrace-trifecta-official-v1',qualityStatus:'verified-complete-v1',rowCount:120});
  expect(snapshot.oddsSnapshot.rows).toHaveLength(120);
  expect(snapshot).not.toHaveProperty('candidates');
  expect(snapshot.predictionBatch.rows[0]).not.toHaveProperty('buyEligible');
  const standardDetail=await app.request(`/api/races/${raceId}`,{},env());
  expect((await standardDetail.json() as any).tickets).toEqual([]);
  expect((sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get() as {value:string}).value).toBe(beforeBudget);
 });
 it('rejects malformed or non-real race IDs on the historical evidence route',async()=>{
  expect((await app.request('/api/shadow/races/not-a-race',{},env())).status).toBe(400);
  const sample=sqlite.prepare("SELECT id FROM races WHERE sport='boat' AND data_origin='sample' LIMIT 1").get() as {id:string};
  expect((await app.request(`/api/shadow/races/${sample.id}`,{},env())).status).toBe(400);
  expect((await app.request('/api/shadow/races/boat-20990101-98-01',{},env())).status).toBe(404);
 });
 it('ingest requires bearer and upserts idempotently',async()=>{
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('venue-99','boat','API fixture')").run();
  const race={id:'boat-20990101-99-01',sport:'boat',venue_id:'venue-99',race_date:'2099-01-01',race_no:1,status:'scheduled',data_origin:'real',updated_at:'2099-01-01T00:00:00Z'};
  const body=JSON.stringify([race]);
  const unauthorized=await app.request('/api/ingest/races',{method:'POST',headers:{'content-type':'application/json'},body},{DB,INGEST_TOKEN:'test-token'});
  expect(unauthorized.status).toBe(401); expect(unauthorized.headers.get('X-ROI-API-Revision')).toBe('ten-minute-results-settlement-v1');
  expect(await unauthorized.json()).toMatchObject({error:'unauthorized'});
  const req=()=>app.request('/api/ingest/races',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body},env());
  expect((await req()).status).toBe(200); expect((await req()).status).toBe(200);
  expect(sqlite.prepare('SELECT COUNT(*) n FROM races WHERE id=?').get(race.id)).toMatchObject({n:1});
  const unverified=await app.request('/api/ingest/races',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},
    body:JSON.stringify([{...race,betting_cutoff_at:'2099-01-01T00:01:00+09:00',betting_cutoff_source:'b-file-header-time'}])},env());
  expect(unverified.status).toBe(400);
  expect(sqlite.prepare('SELECT betting_cutoff_at,betting_cutoff_source FROM races WHERE id=?').get(race.id)).toMatchObject({betting_cutoff_at:null,betting_cutoff_source:null});
 });
 it('does not use the retired D1 reservation ledger when saving collection logs',async()=>{
  const day=new Date().toISOString().slice(0,10), before=(sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get() as {value:string}).value;
  sqlite.prepare("UPDATE settings SET value=? WHERE key='roi_d1_write_budget_utc'").run(JSON.stringify({date:day,reserved:20_000,oddsReserved:0,essentialReserved:16_000,optionalReserved:4_000}));
  const full=(sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get() as {value:string}).value;
  const row={id:'collection-log-budget-test',source:'daily-sync',sport:'boat',target_date:day,started_at:`${day}T00:00:00Z`,status:'success',records:1};
  const response=await app.request('/api/ingest/collection-runs',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:JSON.stringify([row])},env());
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({changed:1});
  expect(sqlite.prepare('SELECT id,status FROM collection_runs WHERE id=?').get(row.id)).toMatchObject({id:row.id,status:'success'});
  expect((sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get() as {value:string}).value).toBe(full);
  expect(before).not.toBe(full);
 });
 it('does not spend D1 budget for no-op natural-key replays or synthetic timestamp/ID changes',async()=>{
  const raceId='boat-20990101-88-01', post=(endpoint:string,rows:unknown[])=>app.request(`/api/ingest/${endpoint}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:JSON.stringify(rows)},env());
  const race={id:raceId,sport:'boat',venue_id:'b01',race_date:'2099-01-01',race_no:1,status:'scheduled',data_origin:'real',updated_at:'2099-01-01T00:00:00Z'};
  expect((await post('races',[race])).status).toBe(200);
  const firstEntry={id:'source-id-one',race_id:raceId,number:1,name:'Lane 1',available_at:'2098-12-31T00:00:00Z',data_origin:'real'};
  expect(await (await post('entries',[firstEntry])).json()).toMatchObject({changed:1});
  const before=JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get() as {value:string}).value);
  expect(await (await post('races',[{...race,updated_at:'2099-01-02T00:00:00Z'}])).json()).toMatchObject({changed:0});
  expect(await (await post('entries',[{...firstEntry,id:'source-id-two'}])).json()).toMatchObject({changed:0});
  const after=JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get() as {value:string}).value);
  expect(after).toEqual(before);
  expect(sqlite.prepare('SELECT id FROM entries WHERE race_id=? AND number=1').get(raceId)).toMatchObject({id:'source-id-one'});
 });
 it('reports application write reservations disabled and keeps obsolete management routes off',async()=>{
  const authHeader={authorization:'Bearer test-token','content-type':'application/json'};
  expect((await app.request('/api/ingest/write-budget',{},env())).status).toBe(401);
  expect(await (await app.request('/api/ingest/write-budget',{headers:authHeader},env())).json()).toMatchObject({enabled:false,state:'disabled',remaining:null,essentialRemaining:null,optionalRemaining:null});
  sqlite.prepare("DELETE FROM settings WHERE key='roi_d1_write_budget_utc'").run();
  const payload=[{id:'boat-20990101-09-01',sport:'boat',venue_id:'b01',race_date:'2099-01-01',race_no:9,status:'scheduled',data_origin:'real'}];
  const ingest=await app.request('/api/ingest/races',{method:'POST',headers:authHeader,body:JSON.stringify(payload)},env());
  expect(ingest.status).toBe(200); expect(await ingest.json()).toMatchObject({changed:1});
  const seed=await app.request('/api/ingest/write-budget/seed',{method:'POST',headers:authHeader,body:'{}'},env());
  expect(seed.status).toBe(410); expect(await seed.json()).toMatchObject({code:'d1_write_budget_disabled',budget:{state:'disabled'}});
  const allowance=await app.request('/api/ingest/write-budget/allowance',{method:'POST',headers:authHeader,body:'{}'},env());
  expect(allowance.status).toBe(410); expect(await allowance.json()).toMatchObject({code:'d1_write_budget_disabled'});
 });
 it('serves only authenticated, current-JST, point-in-time-safe boat forecast inputs',async()=>{
  const nowMs=Date.now(), today=jstDate(new Date(nowMs)), cutoff=new Date(nowMs).toISOString(), raceId=`boat-${today.replaceAll('-','')}-98-01`;
  const availableAt=jstIso(nowMs-60_000),lateAvailableAt=jstIso(nowMs+60_000);
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('98','boat','Forecast fixture')").run();
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at) VALUES(?,'boat','98',?,1,?,'scheduled','real',?)")
   .run(raceId,today,jstIso(nowMs+60*60_000),jstIso(nowMs));
  sqlite.prepare("INSERT INTO entries(id,race_id,number,name,available_at,data_origin) VALUES(?,?,1,'Available',?,'real'),(?,?,2,'Late',?,'real')")
   .run(`${raceId}-1`,raceId,availableAt,`${raceId}-2`,raceId,lateAvailableAt);
  expect((await app.request(`/api/ingest/today-boat-forecast-inputs?date=${today}&cutoff=${encodeURIComponent(cutoff)}`,{},env())).status).toBe(401);
  const response=await app.request(`/api/ingest/today-boat-forecast-inputs?date=${today}&cutoff=${encodeURIComponent(cutoff)}`,{headers:{authorization:'Bearer test-token'}},env());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({date:today,races:[{id:raceId}],entries:[{id:`${raceId}-1`,available_at:availableAt,data_origin:'real'}]});
  expect((await app.request(`/api/ingest/today-boat-forecast-inputs?date=2099-01-01&cutoff=${encodeURIComponent(cutoff)}`,{headers:{authorization:'Bearer test-token'}},env())).status).toBe(400);
  expect((await app.request(`/api/ingest/today-boat-forecast-inputs?date=${today}&cutoff=${encodeURIComponent(new Date(Date.now()-10*60_000).toISOString())}`,{headers:{authorization:'Bearer test-token'}},env())).status).toBe(400);
 });
 it('keeps the operator odds endpoint explicit, current-day, and collector-flag gated',async()=>{
  const headers={authorization:'Bearer test-token','content-type':'application/json'}, body=JSON.stringify({date:new Date().toISOString().slice(0,10),confirmed:true});
  expect((await app.request('/api/ingest/collect-win-odds',{method:'POST',headers,body},env())).status).toBe(409);
  expect((await app.request('/api/ingest/collect-win-odds',{method:'POST',headers,body:JSON.stringify({date:new Date().toISOString().slice(0,10),confirmed:true,mode:'all'})},env({ENABLE_BOATRACE_ODDS_SCRAPE:'true'}))).status).toBe(400);
  expect((await app.request('/api/ingest/collect-win-odds',{method:'POST',headers,body},env({ENABLE_BOATRACE_ODDS_SCRAPE:'true'}))).status).toBe(409);
 });
 it('routes the fixed authenticated baseline operator through the existing promotion gates',async()=>{
  const modelId='boat-win-lgbm-20261010-14b4a90a',today=new Date().toISOString().slice(0,10);
  sqlite.prepare("INSERT INTO models(id,sport,bet_type,version,algorithm,status,metrics_json) VALUES(?,'boat','win','fixed','fixture','candidate',?)")
    .run(modelId,JSON.stringify({initialBaselineEligible:false,boatVenueSchemaVersion:'boat-venue-v2',correctedTrainingDataSha256:'f'.repeat(64),boatArtifactSha256:'a'.repeat(64)}));
  const headers={authorization:'Bearer test-token','content-type':'application/json'};
  const invalid=await app.request('/api/ingest/approved-boat-baseline/promote',{method:'POST',headers,body:JSON.stringify({date:today,confirmed:true,validationFingerprint:'a'.repeat(64)})},env());
  expect(invalid.status).toBe(400);
  const rejected=await app.request('/api/ingest/approved-boat-baseline/promote',{method:'POST',headers,body:JSON.stringify({date:today,confirmed:true,validationFingerprint:'a5596554c3def74853149fdaba5b54557473459ba12ffb717d2d6ad805e0acec'})},env());
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({error:'initial-baseline validation is not eligible'});
  expect(sqlite.prepare('SELECT status FROM models WHERE id=?').get(modelId)).toMatchObject({status:'candidate'});
 });
 it('rejects historical ingest without an open bet, but protects open-bet settlement inputs',async()=>{
  const raceId='boat-20010101-01-01', auth={authorization:'Bearer test-token','content-type':'application/json'};
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at) VALUES(?,'boat','b01','2001-01-01',1,'finished','real',?)").run(raceId,jstIso());
  const post=(endpoint:string,rows:unknown[])=>app.request(`/api/ingest/${endpoint}`,{method:'POST',headers:auth,body:JSON.stringify(rows)},env());
  const denied=await post('results',[{race_id:raceId,finish_order:1,number:1,data_origin:'real'}]);
  expect(denied.status).toBe(409); expect(await denied.json()).toMatchObject({code:'historical_ingest_disabled'});
  expect(sqlite.prepare('SELECT COUNT(*) n FROM results WHERE race_id=?').get(raceId)).toMatchObject({n:0});
  sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES('old-open',?,'boat','win','1',100,'manual','INSUFFICIENT_DATA',?,'open','real')").run(raceId,jstIso());
  expect((await post('races',[{id:raceId,sport:'boat',venue_id:'b01',race_date:'2001-01-01',race_no:1,name:'open-bet repair',status:'finished',data_origin:'real',updated_at:jstIso()}])).status).toBe(200);
  expect((await post('entries',[{id:'old-entry',race_id:raceId,number:1,name:'Lane 1',available_at:jstIso(),data_origin:'real'}])).status).toBe(200);
  expect((await post('results',[{race_id:raceId,finish_order:1,number:1,data_origin:'real'}])).status).toBe(200);
  expect((await post('payouts',[{race_id:raceId,bet_type:'win',selection:'1',payout:200,data_origin:'real'}])).status).toBe(200);
  expect(await readWriteBudget(DB)).toMatchObject({enabled:false,state:'disabled'});
 });
 it('ingests active and candidate predictions without a local write reservation',async()=>{
  const raceId=`boat-${jstDate().replaceAll('-','')}-01-01`, auth={authorization:'Bearer test-token','content-type':'application/json'};
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at) VALUES(?,'boat','b01',?,1,'scheduled','real',?)").run(raceId,jstDate(),jstIso());
  sqlite.prepare("INSERT INTO models(id,sport,bet_type,version,algorithm,status) VALUES('boat-candidate-budget','boat','win','test','fixture','candidate')").run();
  const post=await app.request('/api/ingest/predictions',{method:'POST',headers:auth,body:JSON.stringify([
   {id:'active-current-p',race_id:raceId,model_id:'boat-active',number:1,probability:0.5,predicted_at:jstIso(Date.now()-1000),data_origin:'real'},
   {id:'candidate-current-p',race_id:raceId,model_id:'boat-candidate-budget',number:2,probability:0.5,predicted_at:jstIso(Date.now()-1000),data_origin:'real'},
  ])},env());
  expect(post.status).toBe(200);
  expect(await readWriteBudget(DB)).toMatchObject({enabled:false,state:'disabled',reserved:null});
 });
 it('ingests venues and payouts idempotently and finishes paid-out races',async()=>{
  const raceId='boat-20990101-01-01';
  const race={id:raceId,sport:'boat',venue_id:'01',race_date:'2099-01-01',race_no:1,status:'scheduled',data_origin:'real',updated_at:'2099-01-01T00:00:00Z'};
  const post=(endpoint:string,body:unknown,token='test-token')=>app.request(`/api/ingest/${endpoint}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)},env());
  expect((await post('venues',[{id:'01',sport:'boat',name:'桐生'}])).status).toBe(200);
  expect((await post('races',[race])).status).toBe(200);
  expect((await post('results',[{race_id:raceId,finish_order:1,number:1,data_origin:'real'}])).status).toBe(200);
  expect(sqlite.prepare('SELECT status FROM races WHERE id=?').get(raceId)).toMatchObject({status:'finished'});
  sqlite.prepare("UPDATE races SET status='scheduled' WHERE id=?").run(raceId);
  const payout={race_id:raceId,bet_type:'win',selection:'1',payout:250,popularity:1,data_origin:'real'};
  expect((await post('payouts',[payout],'bad')).status).toBe(401);
  expect((await post('payouts',[payout])).status).toBe(200);
  expect((await post('payouts',[payout])).status).toBe(200);
  expect(sqlite.prepare('SELECT COUNT(*) n FROM payouts WHERE race_id=?').get(raceId)).toMatchObject({n:1});
  expect(sqlite.prepare('SELECT status FROM races WHERE id=?').get(raceId)).toMatchObject({status:'finished'});
 });
 it('origin filter separates sample and real races',async()=>{
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at) VALUES('boat-20990101-01-01','boat','b01','2099-01-01',1,'scheduled','real','2099-01-01T00:00:00Z')").run();
  const req=(origin:string)=>app.request(`/api/races?date=2099-01-01&origin=${origin}`,{},env());
  const real=await (await req('real')).json() as any[];
  const sample=await (await req('sample')).json() as any[];
  expect(real.map(x=>x.id)).toEqual(['boat-20990101-01-01']);
  expect(sample).toEqual([]);
 });
 it('hides quarantined phantom races and prevents ingest from resurrecting them',async()=>{
  const race=sqlite.prepare("SELECT * FROM races WHERE sport='boat' AND data_origin='sample' AND status='finished' LIMIT 1").get() as any;
  const entry=sqlite.prepare('SELECT number FROM entries WHERE race_id=? ORDER BY number LIMIT 1').get(race.id) as {number:number};
  const unusualProbability=0.987654321;
  sqlite.prepare('UPDATE races SET post_time=? WHERE id=?').run(jstIso(Date.now()-30000),race.id);
  sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES('phantom-calibration-p',?,'boat-active',?,?,0.01,?,'sample')").run(race.id,entry.number,unusualProbability,jstIso(Date.now()-60000));
  sqlite.prepare("INSERT INTO data_repair_quarantined_races(race_id,repair_id,reason) VALUES(?,?,?)").run(race.id,'repair-test','absent from authoritative held-venue source');
  sqlite.prepare("UPDATE races SET status='closed' WHERE id=?").run(race.id);
  const listed=await (await app.request(`/api/races?date=${race.race_date}&sport=boat&origin=sample`,{},env())).json() as any[];
  expect(listed.some(x=>x.id===race.id)).toBe(false);
  expect((await app.request(`/api/races/${race.id}`,{},env())).status).toBe(404);
  const ranked=await (await app.request(`/api/rankings?date=${race.race_date}&sport=boat&origin=sample`,{},env())).json() as any[];
  expect(ranked.some(x=>x.raceId===race.id)).toBe(false);
  const ingest=await app.request('/api/ingest/races',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:JSON.stringify([{...race,status:'scheduled'}])},env());
  expect(ingest.status).toBe(400);
  const results=await app.request('/api/ingest/results',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:JSON.stringify([{race_id:race.id,finish_order:1,number:entry.number,data_origin:'sample'}])},env());
  expect(results.status).toBe(400);
  const predictions=await app.request('/api/ingest/predictions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:JSON.stringify([{id:'blocked-phantom-p',race_id:race.id,model_id:'boat-active',number:entry.number,probability:0.5,predicted_at:jstIso(Date.now()-10000),data_origin:'sample'}])},env());
  expect(predictions.status).toBe(400);
  expect(sqlite.prepare('SELECT status FROM races WHERE id=?').get(race.id)).toMatchObject({status:'closed'});
  // Even if a separate path bypasses ingestion and flips status, calibration keeps the phantom excluded.
  sqlite.prepare("UPDATE races SET status='finished' WHERE id=?").run(race.id);
  const performance=await (await app.request('/api/performance/breakdown?origin=sample',{},env())).json() as any;
  expect(performance.calibration.some((x:any)=>Math.abs(x.predicted-unusualProbability)<1e-8)).toBe(false);
 });
 it('ingest preserves terminal races and manually managed model rows',async()=>{
  const post=(endpoint:string,body:unknown)=>app.request(`/api/ingest/${endpoint}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:JSON.stringify(body)},env());
  const race=sqlite.prepare("SELECT * FROM races WHERE data_origin='sample' AND status='finished' LIMIT 1").get() as any;
  expect((await post('races',[{...race,status:'scheduled'}])).status).toBe(409);
  expect(sqlite.prepare('SELECT status FROM races WHERE id=?').get(race.id)).toMatchObject({status:'finished'});
  const model=sqlite.prepare("SELECT * FROM models WHERE id='boat-active'").get() as any;
  expect((await post('models',[{...model,status:'candidate',version:'rewritten',metrics_json:'{}',trained_at:'2099-01-01'}])).status).toBe(200);
  expect(sqlite.prepare("SELECT status,version,metrics_json,trained_at FROM models WHERE id='boat-active'").get()).toMatchObject({status:'active',version:model.version,metrics_json:model.metrics_json,trained_at:model.trained_at});
  expect((await post('models',[{...model,id:'bad-active-ingest',status:'active'}])).status).toBe(400);
  expect((await app.request('/api/ingest/models',{},env())).status).toBe(401);
  const registry=await app.request('/api/ingest/models',{headers:{authorization:'Bearer test-token'}},env());
  expect(registry.status).toBe(200);
  expect(await registry.json()).toMatchObject({models:expect.arrayContaining([expect.objectContaining({id:'boat-active',status:'active'})])});
 });
 it('race detail keeps entries when odds are missing and marks the edge insufficient',async()=>{
  const raceId='boat-20990101-01-02';
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at) VALUES(?, 'boat','b01','2099-01-01',2,'scheduled','real','2099-01-01T00:00:00Z')").run(raceId);
  sqlite.prepare("INSERT INTO entries(id,race_id,number,name,available_at,data_origin) VALUES('missing-odds-entry',?,1,'No odds','2099-01-01T00:00:00Z','real')").run(raceId);
  const res=await app.request(`/api/races/${raceId}`,{},env());
  expect(res.status).toBe(200); const detail=await res.json() as any;
  expect(detail.entries).toHaveLength(1);
  expect(detail.entries[0]).toMatchObject({number:1,odds:null,expectedRoi:null,edge:'INSUFFICIENT_DATA'});
 });
 it('rejects bets on closed races, invalid stake units, missing odds, and insufficient bankroll',async()=>{
  const body=(raceId:string,stake=100,selection='1')=>JSON.stringify({raceId,betType:'win',selection,stake});
  const post=(payload:string)=>app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:payload},env());
  const finished=sqlite.prepare("SELECT id FROM races WHERE sport='horse' AND status='finished' LIMIT 1").get() as any;
  expect((await post(body(finished.id))).status).toBe(400);

  const race=sqlite.prepare("SELECT id FROM races WHERE sport='boat' AND status='scheduled' LIMIT 1").get() as any;
  const entry=sqlite.prepare('SELECT number FROM entries WHERE race_id=? LIMIT 1').get(race.id) as any;
  sqlite.prepare("DELETE FROM odds_snapshots WHERE race_id=? AND bet_type='win' AND selection=?").run(race.id,String(entry.number));
  const prediction=(id:string)=>sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES(?,?,'boat-active',?,0.4,0.01,?,'sample')").run(id,race.id,entry.number,jstIso(Date.now()-10000));
  prediction('validation-p');
  expect((await post(body(race.id,150,String(entry.number)))).status).toBe(400);
  expect((await post(body(race.id,100,String(entry.number)))).status).toBe(400); // odds missing
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('validation-stale-o',?,'win',?,3,?,'test','sample')").run(race.id,String(entry.number),jstIso(Date.now()-11*60_000));
  expect((await post(body(race.id,100,String(entry.number)))).status).toBe(400); // odds older than the 10-minute freshness window
  sqlite.prepare("DELETE FROM odds_snapshots WHERE id='validation-stale-o'").run();
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('validation-o',?,'win',?,3,?,'test','sample')").run(race.id,String(entry.number),jstIso(Date.now()-5000));
  sqlite.prepare("UPDATE settings SET value='-1000000000' WHERE key='initial_bankroll'").run();
  expect((await post(body(race.id,100,String(entry.number)))).status).toBe(400);
 });
 it('manual bet snapshots prediction and odds; settlement uses 100 yen payout',async()=>{
  const race=sqlite.prepare("SELECT r.id FROM races r WHERE r.data_origin='sample' AND r.status='scheduled' AND r.sport='boat' LIMIT 1").get() as any;
  const entry=sqlite.prepare('SELECT number FROM entries WHERE race_id=? LIMIT 1').get(race.id) as any;
  sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES('test-p',?,'boat-active',?,0.4,0.01,?,'sample')").run(race.id,entry.number,jstIso(Date.now()-10000));
  const oddsCapturedAt=jstIso(Date.now()-5000);
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('test-o',?,'win',?,3.0,?,'sample','sample')").run(race.id,String(entry.number),oddsCapturedAt);
  const resp=await app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId:race.id,betType:'win',selection:String(entry.number),stake:100})},env());
  expect(resp.status).toBe(201);const bet=await resp.json() as any;expect(bet.expectedRoi).toBeCloseTo(.2);expect(bet.oddsCapturedAt).toBe(oddsCapturedAt);
  expect(sqlite.prepare('SELECT odds_captured_at FROM bets WHERE id=?').get(bet.id)).toMatchObject({odds_captured_at:oddsCapturedAt});
  const listed=await app.request('/api/bets?origin=sample',{},env());
  const listedBet=(await listed.json() as any[]).find(x=>x.id===bet.id);expect(listedBet).toMatchObject({oddsCapturedAt});expect(listedBet.raceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  sqlite.prepare("UPDATE races SET status='finished' WHERE id=?").run(race.id);
  const field=sqlite.prepare('SELECT number FROM entries WHERE race_id=? AND data_origin=\'sample\' ORDER BY number').all(race.id) as {number:number}[];
  for(const [i,runner] of field.entries())sqlite.prepare('INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,?,?,\'sample\')').run(race.id,i+1,runner.number);
  const losingNumber=field.find(x=>x.number!==entry.number)!.number;
  sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES(?,'win',?,200,2,'sample')").run(race.id,String(losingNumber));
  expect(await settleOpen(DB)).toBe(0);
  sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES(?,'win',?,450,1,'sample')").run(race.id,String(entry.number));
  expect(await settleOpen(DB)).toBe(0);
  sqlite.prepare("DELETE FROM payouts WHERE race_id=? AND selection=?").run(race.id,String(losingNumber));
  expect(await settleOpen(DB)).toBe(1);
  const settled=sqlite.prepare('SELECT * FROM bets WHERE id=?').get(bet.id) as any;expect(settled.status).toBe('won');expect(settled.payout).toBe(450);expect(settled.profit).toBe(350);expect(settled.final_odds).toBe(4.5);
 });
 it('places an atomic multi-pick ticket with frozen rank, arbitrary yen stakes, idempotency, and equal-budget comparison',async()=>{
  const race=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' AND status='scheduled' AND sport='boat' LIMIT 1").get() as any;
  const entries=sqlite.prepare('SELECT number FROM entries WHERE race_id=? ORDER BY number LIMIT 2').all(race.id) as {number:number}[];
  const at=jstIso(Date.now()-5000),predAt=jstIso(Date.now()-10000);
  const odds=[3,2],probs=[0.6,0.5];
  entries.forEach((entry,i)=>{
   sqlite.prepare('INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES(?,? ,\'boat-active\',?,?,0.01,?,\'sample\')').run(`multi-p-${i}`,race.id,entry.number,probs[i],predAt);
   sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES(?,?,'win',?,?,?,'test','sample')").run(`multi-o-${i}`,race.id,String(entry.number),odds[i],at);
  });
  const selections=entries.map((entry,i)=>({selection:String(entry.number),stake:i===0?25:75}));
  const post=(stakes=selections)=>app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId:race.id,betType:'win',requestId:'same-ticket-id',selections:stakes})},env());
  sqlite.prepare("UPDATE settings SET value='99' WHERE key='initial_bankroll'").run();
  expect((await post()).status).toBe(400);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE bet_group_id='same-ticket-id'").get()).toMatchObject({n:0});
  sqlite.prepare("UPDATE settings SET value='100000' WHERE key='initial_bankroll'").run();
  const placed=await post();expect(placed.status).toBe(201);const body=await placed.json() as any;
  expect(body.bets).toHaveLength(2);expect(body.bets.map((b:any)=>b.stake)).toEqual([25,75]);
  expect(body.bets.map((b:any)=>b.candidateRank)).toEqual([1,2]);
  expect(body.bets.every((b:any)=>b.candidateCount===2&&b.groupId==='same-ticket-id'&&b.oddsCapturedAt===at&&b.predictedAtAtBet===predAt)).toBe(true);
  expect((await post()).status).toBe(200);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE bet_group_id='same-ticket-id'").get()).toMatchObject({n:2});
  expect((await post([{selection:String(entries[0].number),stake:100}])).status).toBe(409);
  const divergent=(selection:string)=>app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId:race.id,betType:'win',requestId:'concurrent-divergence',selections:[{selection,stake:10}]})},env());
  const concurrent=await Promise.all([divergent(String(entries[0].number)),divergent(String(entries[1].number))]);
  expect(concurrent.map(x=>x.status).sort()).toEqual([201,409]);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE bet_group_id='concurrent-divergence'").get()).toMatchObject({n:1});
  // Rank 1 wins; compare its official payout at the same total group budget.
  sqlite.prepare("UPDATE races SET status='finished' WHERE id=?").run(race.id);
  const field=sqlite.prepare('SELECT number FROM entries WHERE race_id=? ORDER BY number').all(race.id) as {number:number}[];
  for(const [i,runner] of field.entries())sqlite.prepare('INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,?,?,\'sample\')').run(race.id,runner.number===entries[0].number?1:i+2,runner.number);
  sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES(?,'win',?,300,1,'sample')").run(race.id,String(entries[0].number));
  expect(await settleOpen(DB)).toBe(3);
  const comparison=await (await app.request('/api/performance/rank-comparison?origin=sample',{},env())).json() as any;
  expect(comparison).toMatchObject({comparedRaceCount:1,totalStake:100,multiple:{stake:100,payout:75,profit:-25,roi:0.75},firstOnly:{stake:100,payout:300,profit:200,roi:3}});
  expect(settleValues(1,150,true)).toMatchObject({payout:1,profit:0,finalOdds:1.5});
  expect(settleValues(100,290,true)).toMatchObject({payout:290,profit:190,finalOdds:2.9});
  expect(payoutYen(1,150)).toBe(1);
 });
 it('handles rapid same-pick purchases and concurrent exact retries',async()=>{
  const race=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' AND status='scheduled' AND sport='boat' LIMIT 1").get() as any;
  const selection=addBetInputs(race.id,'rapid-same-pick');
  sqlite.prepare("UPDATE settings SET value='100000' WHERE key='initial_bankroll'").run();
  const frozenAt=Date.now();
  vi.spyOn(Date,'now').mockReturnValue(frozenAt);
  const post=(requestId:string)=>app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId:race.id,betType:'win',selection,stake:10,requestId})},env());
  const first=await post('rapid-first');expect(first.status).toBe(201);
  const second=await post('rapid-second');expect(second.status).toBe(201);
  const firstBody=await first.json() as any,secondBody=await second.json() as any;
  expect(firstBody.id).not.toBe(secondBody.id);
  expect(firstBody.placedAt).not.toBe(secondBody.placedAt);
  const concurrent=await Promise.all([post('rapid-concurrent'),post('rapid-concurrent')]);
  expect(concurrent.map(x=>x.status).sort()).toEqual([200,201]);
  const concurrentBodies=await Promise.all(concurrent.map(x=>x.json() as Promise<any>));
  expect(concurrentBodies[0].id).toBe(concurrentBodies[1].id);
 });
 it('keeps high-edge win forecasts out of future auto paper purchases',async()=>{
  sqlite.exec('DELETE FROM bets');
  sqlite.prepare("UPDATE settings SET value='200' WHERE key='initial_bankroll'").run();
  const races=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' AND status='scheduled' AND sport='boat' LIMIT 2").all() as {id:string}[];
  expect(races).toHaveLength(2);
  for(const [i,race] of races.entries())addBetInputs(race.id,`auto-cap-${i}`);
  const decisionAt=Date.now();for(const race of races)setPaperCutoff(race.id,decisionAt);
  sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES('existing-open',?,'boat','win','99',100,'manual','INSUFFICIENT_DATA',?,'open','sample')").run(races[0].id,jstIso());

  expect(await autoBet(DB,true,decisionAt)).toBe(0);
  expect(await autoBet(DB,true,decisionAt)).toBe(0);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE mode='auto' AND status='open'").get()).toMatchObject({n:0});
  expect(sqlite.prepare("SELECT SUM(stake) stake FROM bets WHERE status='open'").get()).toMatchObject({stake:100});
  expect(sqlite.prepare("SELECT COUNT(*) n FROM paper_decisions WHERE phase='primary_t60' AND outcome='abstained'").get()).toMatchObject({n:2});
 });
 it('honors the configured JST auto-bet start date and fails closed for malformed dates',async()=>{
  const {raceId,decisionAt}=addPaperTrifecta('boat-20990101-99-03','boat-trifecta-start-date');
  const setStart=(value:string)=>sqlite.prepare("INSERT INTO settings(key,value) VALUES('auto_bet_start_date',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
  const tomorrow=jstDate(new Date(decisionAt+24*60*60_000));
  setStart(tomorrow);
  expect(await autoBet(DB,true,decisionAt)).toBe(0);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM paper_decisions WHERE race_id=? AND phase='primary_t60'").get(raceId)).toMatchObject({n:0});
  setStart('2026-02-30');
  expect(await autoBet(DB,true,decisionAt)).toBe(0);
  setStart(jstDate(new Date(decisionAt)));
  expect(await autoBet(DB,true,decisionAt)).toBeGreaterThan(0);
 });
 it('uses newly fetched T-60 purchase odds, never the saved market, and freezes prediction time',async()=>{
  const {raceId,decisionAt}=addPaperTrifecta();
  const predictedAt=(sqlite.prepare('SELECT predicted_at FROM ticket_predictions WHERE race_id=? LIMIT 1').get(raceId) as any).predicted_at;
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(purchasePage(url,new Map([['1-2-3',240]])))));
  expect(await autoBet(DB,true,decisionAt)).toBe(1);
  const bet:any=sqlite.prepare("SELECT odds_at_bet,odds_captured_at,predicted_at_at_bet FROM bets WHERE race_id=? AND mode='auto'").get(raceId);
  expect(bet.odds_at_bet).toBe(240);expect(bet.predicted_at_at_bet).toBe(predictedAt);
  expect(Date.parse(bet.odds_captured_at)).toBeGreaterThanOrEqual(decisionAt);
  const snapshot=JSON.parse((sqlite.prepare('SELECT snapshot_json FROM paper_decisions WHERE race_id=?').get(raceId) as any).snapshot_json);
  expect(snapshot.purchaseOdds).toMatchObject({qualityStatus:'verified-complete-v1',capturedAt:bet.odds_captured_at});
  expect(snapshot.purchaseOdds.sha256).toMatch(/^[a-f0-9]{64}$/);
 });
 it('fails closed on fresh purchase fetch failure despite a qualifying saved market',async()=>{
  const {raceId,decisionAt}=addPaperTrifecta();
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:503})));
  expect(await autoBet(DB,true,decisionAt)).toBe(0);
  expect(sqlite.prepare('SELECT outcome,reason FROM paper_decisions WHERE race_id=?').get(raceId)).toMatchObject({outcome:'abstained',reason:'purchase_odds_fetch_failed_or_window_elapsed'});
 });
 it('never purchases when the fresh HTTP market finishes after the T-60 window',async()=>{
  const {raceId,decisionAt}=addPaperTrifecta();
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{vi.spyOn(Date,'now').mockReturnValue(decisionAt+11_001);return new Response(purchasePage(url,new Map()));}));
  expect(await autoBet(DB,true,decisionAt)).toBe(0);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE race_id=? AND mode='auto'").get(raceId)).toMatchObject({n:0});
 });
 it('splits a bounded auto race budget across ranked picks and records one complete group',async()=>{
  const {raceId,decisionAt}=addPaperTrifecta('boat-20990101-99-02','boat-trifecta-multi');
  sqlite.prepare("UPDATE settings SET value='2' WHERE key='auto_bet_max_picks'").run();
  sqlite.prepare("UPDATE settings SET value='101' WHERE key='auto_bet_race_budget'").run();
  expect(await Promise.all([autoBet(DB,true,decisionAt),autoBet(DB,true,decisionAt)])).toEqual(expect.arrayContaining([0,2]));
  const placed=sqlite.prepare("SELECT bet_group_id,candidate_rank,candidate_count,stake,bet_type,selection FROM bets WHERE mode='auto' AND race_id=? ORDER BY candidate_rank").all(raceId) as any[];
  expect(placed).toHaveLength(2);expect(placed.map(x=>x.stake)).toEqual([51,50]);
  expect(placed.every(x=>x.bet_type==='trifecta')).toBe(true);
  expect(placed.map(x=>x.candidate_rank)).toEqual([1,2]);expect(placed[0].bet_group_id).toBe(placed[1].bet_group_id);
  expect(placed.map(x=>x.selection)).toEqual(['1-2-3','1-2-4']);
  expect(placed.every(x=>x.candidate_count===2)).toBe(true);
  expect(sqlite.prepare("SELECT SUM(stake) stake FROM bets WHERE mode='auto' AND race_id=?").get(raceId)).toMatchObject({stake:101});
 });
 it('freezes the primary decision against the verified cutoff, not post_time, and labels its actual offset',async()=>{
  const {raceId,decisionAt}=addPaperTrifecta();
  const race={id:raceId};
  expect(await autoBet(DB,true,decisionAt)).toBe(1);
  const stored=sqlite.prepare("SELECT phase,cutoff_at,cutoff_source,cutoff_observed_at,target_at,input_as_of_at,decided_at,outcome,reason,bet_group_id,snapshot_json FROM paper_decisions WHERE race_id=?").get(race.id) as any;
  expect(stored).toMatchObject({phase:'primary_t60',cutoff_at:jstIso(decisionAt+60_000),cutoff_source:'boatrace-racelist-cutoff-v1',cutoff_observed_at:jstIso(decisionAt-30_000),target_at:jstIso(decisionAt),outcome:'placed',reason:null});
  const frozenSnapshot=JSON.parse(stored.snapshot_json);
  expect(frozenSnapshot.phase).toBe('primary_t60');
  expect(Date.parse(stored.input_as_of_at)).toBe(Date.parse(frozenSnapshot.inputAsOfAt));
  expect(Date.parse(stored.decided_at)).toBeGreaterThanOrEqual(Date.parse(frozenSnapshot.inputAsOfAt));
  const actualSecondsBeforeCutoff=(Date.parse(stored.cutoff_at)-Date.parse(stored.decided_at))/1000;
  expect(actualSecondsBeforeCutoff).toBeGreaterThanOrEqual(50);
  expect(actualSecondsBeforeCutoff).toBeLessThanOrEqual(70);
  expect((sqlite.prepare('SELECT post_time FROM races WHERE id=?').get(race.id) as any).post_time).not.toBe(stored.cutoff_at);
  const automatic=sqlite.prepare("SELECT bet_type,decision_phase,placed_at,odds_captured_at FROM bets WHERE race_id=? AND mode='auto'").get(race.id) as any;
  expect(automatic.bet_type).toBe('trifecta');
  expect(automatic.decision_phase).toBe('primary_t60');
  expect(automatic.placed_at).toBe(stored.decided_at);
  expect(frozenSnapshot.selections[0].oddsCapturedAt).toBe(automatic.odds_captured_at);
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('paper-late-odds',?,'win',?,30,?,'test','sample')")
    .run(race.id,String(frozenSnapshot.selections[0].selection),jstIso(decisionAt+5_000));
  expect(await autoBet(DB,true,decisionAt+5_000)).toBe(0);
  expect(sqlite.prepare('SELECT snapshot_json,decided_at,input_as_of_at,cutoff_observed_at FROM paper_decisions WHERE race_id=?').get(race.id)).toMatchObject({snapshot_json:stored.snapshot_json,decided_at:stored.decided_at,input_as_of_at:stored.input_as_of_at,cutoff_observed_at:stored.cutoff_observed_at});
  const listed=await app.request('/api/bets?origin=real',{},env());
  expect((await listed.json() as any[]).find(row=>row.raceId===race.id&&row.mode==='auto')?.decisionPhase).toBe('primary_t60');
  const read=await app.request(`/api/paper/decisions?date=${jstDate()}`,{},env());
  expect(read.status).toBe(200);const body=await read.json() as any;
  expect(body.timing.comparisons).toMatchObject({t30:{phase:'comparison_t30',status:'unavailable'},t10:{phase:'comparison_t10',status:'unavailable'}});
  expect(body.timing.primary).toMatchObject({cutoffSource:'boatrace-racelist-cutoff-v1',acceptedSecondsBeforeCutoff:{min:50,max:70}});
  expect(body.decisions.find((row:any)=>row.raceId===race.id)).toMatchObject({phase:'primary_t60',outcome:'placed',cutoffSource:'boatrace-racelist-cutoff-v1',cutoffObservedAt:stored.cutoff_observed_at,inputAsOfAt:stored.input_as_of_at,snapshot:frozenSnapshot});
  expect(body.decisions.find((row:any)=>row.raceId===race.id).actualSecondsBeforeCutoff).toBeGreaterThanOrEqual(50);
  expect(body.decisions.find((row:any)=>row.raceId===race.id).actualSecondsBeforeCutoff).toBeLessThanOrEqual(70);
  const oldBet=sqlite.prepare("SELECT decision_phase FROM bets WHERE race_id<>? AND data_origin='sample' LIMIT 1").get(race.id) as any;
  expect(oldBet?.decision_phase??null).toBeNull();
 });
 it('keeps concurrent primary abstention and trifecta placement mutually exclusive',async()=>{
  const {raceId,decisionAt:inputAsOfAt}=addPaperTrifecta('boat-20990101-99-03','boat-trifecta-race-invariant');
  await Promise.all([
   autoBetWithReport(DB,true,inputAsOfAt),
   recordPaperAbstention(DB,raceId,jstIso(inputAsOfAt+60_000),'boatrace-racelist-cutoff-v1',jstIso(inputAsOfAt-30_000),Date.now(),'concurrent_abstention_probe'),
  ]);
  const decision=sqlite.prepare("SELECT outcome,bet_group_id FROM paper_decisions WHERE race_id=? AND phase='primary_t60'").get(raceId) as any;
  const bets=sqlite.prepare("SELECT bet_group_id,decision_phase,bet_type FROM bets WHERE race_id=? AND mode='auto'").all(raceId) as any[];
  expect(decision).toBeTruthy();
  if(decision.outcome==='placed') {
   expect(bets.length).toBeGreaterThan(0);
   expect(bets.every(row=>row.bet_type==='trifecta'&&row.decision_phase==='primary_t60'&&row.bet_group_id===decision.bet_group_id)).toBe(true);
  } else {
   expect(decision.outcome).toBe('abstained');
   expect(bets).toHaveLength(0);
  }
  expect(sqlite.prepare("SELECT COUNT(*) n FROM paper_decisions d JOIN bets b ON b.race_id=d.race_id AND b.mode='auto' WHERE d.race_id=? AND d.phase='primary_t60' AND d.outcome='abstained'").get(raceId)).toMatchObject({n:0});
 });
 it('rechecks commit time after input reads and abstains if the T-60 window elapsed',async()=>{
  const inputAsOfAt=Date.now()-15_000;
  const fixture=addValidatedTrifectaFixture('boat-20990101-99-04','boat-trifecta-late-commit');
  const race={id:fixture.raceId};setPaperCutoff(race.id,inputAsOfAt);
  sqlite.prepare("UPDATE odds_snapshots SET source_url=REPLACE(source_url,'20990101',?) WHERE race_id=? AND bet_type='trifecta'")
    .run(jstDate().replaceAll('-',''),race.id);
  const report=await autoBetWithReport(DB,true,inputAsOfAt);
  expect(report.bought).toBe(0);
  const abstention=sqlite.prepare("SELECT outcome,reason,input_as_of_at,decided_at FROM paper_decisions WHERE race_id=? AND phase='primary_t60'").get(race.id) as any;
  expect(abstention).toMatchObject({outcome:'abstained',reason:'missed_timing',input_as_of_at:jstIso(inputAsOfAt)});
  expect(Date.parse(abstention.decided_at)).toBeGreaterThan(Date.parse(abstention.input_as_of_at));
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE race_id=? AND mode='auto'").get(race.id)).toMatchObject({n:0});
 });
 it('records T-60 abstentions for stale odds, invalid probabilities, unavailable models, missing cutoffs, and missed timing',async()=>{
  const decisionAt=Date.now();
  const races=Array.from({length:7},(_,i)=>addPaperTrifecta(`boat-20990101-99-${String(i+1).padStart(2,'0')}`,`boat-trifecta-abstention-${i}`).raceId);
  sqlite.prepare(`UPDATE odds_snapshots SET captured_at=? WHERE race_id=? AND bet_type='trifecta'`).run(jstIso(decisionAt-11*60_000),races[0]);
  sqlite.prepare("UPDATE ticket_predictions SET probability=NULL WHERE race_id=? AND bet_type='trifecta' AND selection='1-2-3'").run(races[1]);
  sqlite.prepare("DELETE FROM ticket_predictions WHERE race_id=?").run(races[2]);
  sqlite.prepare('UPDATE races SET betting_cutoff_at=NULL,betting_cutoff_source=NULL,betting_cutoff_observed_at=NULL WHERE id=?').run(races[3]);
  sqlite.prepare('UPDATE races SET post_time=? WHERE id=?').run(jstIso(decisionAt+2*60_000),races[3]);
  sqlite.prepare('UPDATE races SET betting_cutoff_at=? WHERE id=?').run(jstIso(decisionAt+30_000),races[4]);
  sqlite.prepare('UPDATE races SET betting_cutoff_at=? WHERE id=?').run(jstIso(decisionAt+10_000),races[5]);
  sqlite.prepare('UPDATE races SET betting_cutoff_observed_at=? WHERE id=?').run(jstIso(decisionAt-11*60_000),races[6]);
  const beforePerformance=await (await app.request('/api/performance/overview?origin=sample',{},env())).json() as any;
  expect(await autoBet(DB,true,decisionAt)).toBe(0);
  const reasons=sqlite.prepare('SELECT race_id,reason,outcome FROM paper_decisions').all() as any[];
  expect(reasons).toEqual(expect.arrayContaining([
   expect.objectContaining({race_id:races[0],outcome:'abstained'}),
   expect.objectContaining({race_id:races[1],outcome:'abstained'}),
   expect.objectContaining({race_id:races[2],reason:'active_model_prediction_unavailable',outcome:'abstained'}),
   expect.objectContaining({race_id:races[3],reason:'missing_or_invalid_cutoff',outcome:'abstained'}),
   expect.objectContaining({race_id:races[4],reason:'missed_timing',outcome:'abstained'}),
   expect.objectContaining({race_id:races[5],reason:'missed_timing',outcome:'abstained'}),
   expect.objectContaining({race_id:races[6],reason:'stale_cutoff_evidence',outcome:'abstained'}),
  ]));
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('paper-stale-late',?,'win','1',20,?,'test','sample')")
    .run(races[0],jstIso(decisionAt+1_000));
  expect(await autoBet(DB,true,decisionAt+1_000)).toBe(0);
  expect(sqlite.prepare(`SELECT COUNT(*) n FROM bets WHERE mode='auto' AND race_id IN (${races.map(()=>'?').join(',')})`).get(...races)).toMatchObject({n:0});
  expect(sqlite.prepare("SELECT outcome FROM paper_decisions WHERE race_id=?").get(races[0])).toMatchObject({outcome:'abstained'});
  expect(sqlite.prepare("SELECT COUNT(*) n FROM paper_decisions WHERE phase IN ('comparison_t30','comparison_t10')").get()).toMatchObject({n:0});
  const afterPerformance=await (await app.request('/api/performance/overview?origin=sample',{},env())).json() as any;
  expect(afterPerformance.betCount).toBe(beforePerformance.betCount);
 });
 it('records a no-qualifying-edge abstention when valid trifecta predictions have no eligible odds edge',async()=>{
  const {raceId,decisionAt}=addPaperTrifecta('boat-20990101-99-12','boat-trifecta-no-edge');
  sqlite.prepare("UPDATE odds_snapshots SET odds=1 WHERE race_id=? AND bet_type='trifecta'").run(raceId);
  expect(await autoBet(DB,true,decisionAt)).toBe(0);
  expect(sqlite.prepare("SELECT outcome,reason FROM paper_decisions WHERE race_id=? AND phase='primary_t60'").get(raceId)).toMatchObject({outcome:'abstained',reason:'no_qualifying_edge'});
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE race_id=? AND mode='auto'").get(raceId)).toMatchObject({n:0});
 });
 it('manual placement rejects a stake that would exceed bankroll after open stakes',async()=>{
  sqlite.exec('DELETE FROM bets');
  sqlite.prepare("UPDATE settings SET value='200' WHERE key='initial_bankroll'").run();
  const race=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' AND status='scheduled' AND sport='boat' LIMIT 1").get() as {id:string};
  const selection=addBetInputs(race.id,'manual-cap');
  sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES('manual-existing-open',?,'boat','win','99',100,'manual','INSUFFICIENT_DATA',?,'open','sample')").run(race.id,jstIso());
  const response=await app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId:race.id,betType:'win',selection,stake:200})},env());
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({error:'insufficient bankroll'});
  expect(sqlite.prepare("SELECT SUM(stake) stake FROM bets WHERE status='open'").get()).toMatchObject({stake:100});
 });
 it('manual bankroll reservation is atomic across concurrent placements',async()=>{
  sqlite.exec('DELETE FROM bets');
  sqlite.prepare("UPDATE settings SET value='100' WHERE key='initial_bankroll'").run();
  const races=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' AND status='scheduled' AND sport='boat' LIMIT 2").all() as {id:string}[];
  expect(races).toHaveLength(2);
  const requests=races.map((race,i)=>{
   const selection=addBetInputs(race.id,`manual-race-${i}`);
   return app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId:race.id,betType:'win',selection,stake:100})},env());
  });
  const responses=await Promise.all(requests);
  expect(responses.map(response=>response.status).sort()).toEqual([201,400]);
  expect(sqlite.prepare("SELECT SUM(stake) stake FROM bets WHERE status='open'").get()).toMatchObject({stake:100});
 });
 it('settles unmatched bets only after complete same-origin outcomes and refunds cancelled stakes',async()=>{
  sqlite.exec('DELETE FROM bets');
  const races=sqlite.prepare("SELECT id,status FROM races WHERE data_origin='sample' AND sport='boat' AND status='scheduled' LIMIT 2").all() as any[];
  const stake=100, placed=jstIso(Date.now()-10000);
  const addBet=(id:string,raceId:string,selection:string)=>sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES(?,?,'boat','win',?,?,'manual','INSUFFICIENT_DATA',?,'open','sample')").run(id,raceId,selection,stake,placed);
  addBet('lost-bet',races[0].id,'999');
  sqlite.prepare("UPDATE races SET status='finished' WHERE id=?").run(races[0].id);
  sqlite.prepare("UPDATE races SET status='cancelled' WHERE id=?").run(races[1].id);
  expect(await settleOpen(DB)).toBe(0);
  expect(sqlite.prepare("SELECT status FROM bets WHERE id='lost-bet'").get()).toMatchObject({status:'open'});
  const field=sqlite.prepare('SELECT number FROM entries WHERE race_id=? AND data_origin=\'sample\' ORDER BY number').all(races[0].id) as {number:number}[];
  for(const [i,runner] of field.entries())sqlite.prepare('INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,?,?,\'sample\')').run(races[0].id,i+1,runner.number);
  sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES(?,'win',?,300,1,'sample')").run(races[0].id,String(field[0].number));
  addBet('void-bet',races[1].id,'1');
  expect(await settleOpen(DB)).toBe(2);
  expect(sqlite.prepare('SELECT status,payout,profit,final_odds FROM bets WHERE id=\'lost-bet\'').get()).toMatchObject({status:'lost',payout:0,profit:-stake,final_odds:null});
  expect(sqlite.prepare('SELECT status,payout,profit,final_odds FROM bets WHERE id=\'void-bet\'').get()).toMatchObject({status:'void',payout:stake,profit:0,final_odds:1});
  const overview=await (await app.request('/api/performance/overview?origin=sample',{},env())).json() as any;
  expect(overview).toMatchObject({totalProfit:-stake,roi:0,settledCount:2,hitRate:0});
  const breakdown=await (await app.request('/api/performance/breakdown?origin=sample',{},env())).json() as any;
  expect(breakdown.bySport.find((row:any)=>row.sport==='boat')).toMatchObject({bets:1,stake,payout:0,profit:-stake,roi:0,hitRate:0});
 });
 it('keeps finished-race bets open until complete results and authentic winner payouts arrive, then settles idempotently',async()=>{
  const race=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' AND sport='boat' AND status='scheduled' LIMIT 1").get() as {id:string};
  const field=sqlite.prepare('SELECT number FROM entries WHERE race_id=? AND data_origin=\'sample\' ORDER BY number').all(race.id) as {number:number}[];
  expect(field.length).toBeGreaterThanOrEqual(2);
  const winner=field[0].number, loser=field[1].number, placed=jstIso(Date.now()-10000);
  const add=(id:string,selection:number)=>sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES(?,?,'boat','win',?,100,'manual','INSUFFICIENT_DATA',?,'open','sample')").run(id,race.id,String(selection),placed);
  add('pending-winner',winner); add('pending-loser',loser);
  sqlite.prepare("UPDATE races SET status='finished' WHERE id=?").run(race.id);
  expect(await settleOpen(DB)).toBe(0);
  expect(sqlite.prepare("SELECT status FROM bets WHERE race_id=? AND status='open'").get(race.id)).toMatchObject({status:'open'});
  for(const [i,runner] of field.entries())sqlite.prepare('INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,?,?,\'sample\')').run(race.id,i===0?1:i+1,runner.number);
  expect(await settleOpen(DB)).toBe(0);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE race_id=? AND status='open'").get(race.id)).toMatchObject({n:2});
  sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES(?,'win',?,250,1,'sample')").run(race.id,String(winner));
  expect(await settleOpen(DB)).toBe(2);
  expect(sqlite.prepare("SELECT status,payout,profit FROM bets WHERE id='pending-winner'").get()).toMatchObject({status:'won',payout:250,profit:150});
  expect(sqlite.prepare("SELECT status,payout,profit FROM bets WHERE id='pending-loser'").get()).toMatchObject({status:'lost',payout:0,profit:-100});
  expect(await settleOpen(DB)).toBe(0);
 });
 it('requires every entry to have a finish or official terminal marker and never guesses a terminal pick refund',async()=>{
  const race=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' AND sport='boat' AND status='scheduled' LIMIT 1").get() as {id:string};
  const field=sqlite.prepare('SELECT number FROM entries WHERE race_id=? AND data_origin=\'sample\' ORDER BY number').all(race.id) as {number:number}[];
  expect(field).toHaveLength(6);
  const placed=jstIso(Date.now()-10000), winner=field[0].number, loser=field[1].number, falseStarter=field[5].number;
  for(const [id,selection] of [['evidenced-loser',loser],['false-start-pick',falseStarter]] as const){
   sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES(?,?,'boat','win',?,100,'manual','INSUFFICIENT_DATA',?,'open','sample')").run(id,race.id,String(selection),placed);
  }
  sqlite.prepare("UPDATE races SET status='finished' WHERE id=?").run(race.id);
  for(const [i,runner] of field.slice(0,5).entries())sqlite.prepare('INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,?,?,\'sample\')').run(race.id,i+1,runner.number);
  sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES(?,'win',?,120,1,'sample')").run(race.id,String(winner));
  // One unrepresented entrant still blocks whole-field settlement.
  expect(await settleOpen(DB)).toBe(0);
  sqlite.prepare(`UPDATE entries SET features_json='{"finish_code":"F"}' WHERE race_id=? AND number=? AND data_origin='sample'`).run(race.id,falseStarter);
  // The finished field is now accounted for, but the F selection has no stored
  // return amount and therefore cannot safely be recorded as a win or loss.
  expect(await settleOpen(DB)).toBe(1);
  expect(sqlite.prepare("SELECT status,payout,profit FROM bets WHERE id='evidenced-loser'").get()).toMatchObject({status:'lost',payout:0,profit:-100});
  expect(sqlite.prepare("SELECT status,payout,profit FROM bets WHERE id='false-start-pick'").get()).toMatchObject({status:'open',payout:null,profit:null});
  const waitRace='boat-20990101-01-11';
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at) VALUES(?,'boat','b01','2099-01-01',11,'finished','real',?)").run(waitRace,jstIso());
  sqlite.prepare("INSERT INTO entries(id,race_id,number,name,features_json,available_at,data_origin) VALUES(?,?,5,'False start','{\"finish_code\":\"F\"}',?,'real')").run(`${waitRace}-5`,waitRace,jstIso());
  sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES('refund-wait',?,'boat','win','5',100,'manual','INSUFFICIENT_DATA',?,'open','real')").run(waitRace,placed);
  const listed=await app.request('/api/bets?origin=real',{},env());
  expect((await listed.json() as any[]).find(b=>b.id==='refund-wait')?.resultWaitReason).toBe('refundmissing');
 });
 it('keeps contradictory finish and terminal markers out of settled results',async()=>{
  const raceId='boat-20990101-99-13';
  const venueId=(sqlite.prepare("SELECT id FROM venues WHERE sport='boat' LIMIT 1").get() as {id:string}).id;
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at) VALUES(?,'boat',?,'2099-01-01',13,'scheduled','real',?)").run(raceId,venueId,jstIso());
  for(let number=1;number<=6;number++)sqlite.prepare("INSERT INTO entries(id,race_id,number,name,features_json,available_at,data_origin) VALUES(?,?,?,?,'{}',?,'real')").run(`${raceId}-${number}`,raceId,number,`Entry ${number}`,jstIso());
  const field=Array.from({length:6},(_,i)=>({number:i+1}));
  sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES('contradictory-result',?,'boat','win','3',100,'manual','NEUTRAL',?,'open','real')").run(raceId,jstIso(Date.now()-10_000));
  sqlite.prepare("UPDATE races SET status='finished' WHERE id=?").run(raceId);
  for(const [i,runner] of field.slice(0,5).entries())sqlite.prepare('INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,?,?,\'real\')').run(raceId,i+1,runner.number);
  sqlite.prepare("UPDATE entries SET features_json='{\"finish_code\":\"F\"}' WHERE race_id=? AND number=? AND data_origin='real'").run(raceId,field[4].number);
  sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES(?,'win','1',120,1,'real')").run(raceId);
  expect(await settleOpen(DB)).toBe(0);
  expect(sqlite.prepare("SELECT status FROM bets WHERE id='contradictory-result'").get()).toMatchObject({status:'open'});
  const listed=await app.request('/api/bets?origin=real',{},env());
  expect((await listed.json() as any[]).find(b=>b.id==='contradictory-result')?.resultWaitReason).toBe('officialresultmissing');
 });
 it('orders realized equity by settlement time and excludes open and refunded stakes from ROI',async()=>{
  sqlite.exec('DELETE FROM bets');
  const race=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' AND sport='boat' LIMIT 1").get() as {id:string};
  const base=Date.now()-60*60_000,placedAt=[0,60_000,120_000,180_000].map(offset=>jstIso(base+offset));
  const settledAt=[10,5,6].map(minutes=>jstIso(base+minutes*60_000));
  const insert=sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,payout,profit,settled_at,data_origin) VALUES(?,?,'boat','win',?,100,'manual','NEUTRAL',?,?,?,?,?,'sample')");
  insert.run('equity-loss',race.id,'1',placedAt[0],'lost',0,-100,settledAt[0]);
  insert.run('equity-win',race.id,'2',placedAt[1],'won',250,150,settledAt[1]);
  insert.run('equity-refund',race.id,'3',placedAt[2],'void',100,0,settledAt[2]);
  insert.run('equity-open',race.id,'4',placedAt[3],'open',null,null,null);
  const overview=await (await app.request('/api/performance/overview?origin=sample',{},env())).json() as any;
  expect(overview).toMatchObject({totalProfit:50,roi:1.25,betCount:4,settledCount:3,hitRate:0.5});
  expect(overview.equityCurve.map((point:any)=>point.bankroll)).toEqual([100000,100150,100150,100050]);
  const curveTimes=overview.equityCurve.slice(1).map((point:any)=>Date.parse(point.at));
  expect(curveTimes).toEqual([...curveTimes].sort((a:number,b:number)=>a-b));
  const breakdown=await (await app.request('/api/performance/breakdown?origin=sample',{},env())).json() as any;
  expect(breakdown.bySport.find((row:any)=>row.sport==='boat')).toMatchObject({bets:2,stake:200,payout:250,profit:50,roi:1.25,hitRate:0.5});
 });
 it('auto-bets only validated trifecta tickets once per race and promotes/rolls back the active model',async()=>{
  const race=sqlite.prepare("SELECT r.id FROM races r WHERE r.data_origin='sample' AND r.status='scheduled' AND r.sport='boat' LIMIT 1").get() as any;
  const first=sqlite.prepare('SELECT number FROM entries WHERE race_id=? LIMIT 1').get(race.id) as any;
  const decisionAt=Date.now();setPaperCutoff(race.id,decisionAt);
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('auto-odds',?,'win',?,10,?,'sample','sample')").run(race.id,String(first.number),jstIso(Date.now()-5000));
  sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES('auto-p',?,'boat-active',?,0.5,0.01,?,'sample')").run(race.id,first.number,jstIso(Date.now()-10000));
  expect(await autoBet(DB,true,decisionAt)).toBe(0);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE race_id=? AND mode='auto'").get(race.id)).toMatchObject({n:0});
  const {raceId:ticketRaceId,decisionAt:ticketDecisionAt}=addPaperTrifecta('boat-20990101-99-10','boat-trifecta-auto-once');
  expect(await autoBet(DB,true,ticketDecisionAt)).toBeGreaterThan(0);expect(await autoBet(DB,true,ticketDecisionAt)).toBe(0);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE race_id=? AND mode='auto'").get(ticketRaceId)).toMatchObject({n:1});
  expect(sqlite.prepare("SELECT bet_type,decision_phase FROM bets WHERE race_id=? AND mode='auto'").get(ticketRaceId)).toMatchObject({bet_type:'trifecta',decision_phase:'primary_t60'});
  const model=sqlite.prepare("SELECT id FROM models WHERE sport='horse' AND status='candidate' LIMIT 1").get() as any;
  expect((await app.request(`/api/models/${model.id}/promote`,{method:'POST'},env())).status).toBe(200);
  expect((await app.request(`/api/models/${model.id}/rollback`,{method:'POST'},env())).status).toBe(200);
 });
 it('ranks and manually places trifecta only with a complete artifact-bound model and fresh verified official odds set',async()=>{
  const {raceId,selections}=addValidatedTrifectaFixture();
  const rankings=await app.request('/api/rankings?date=2099-01-01&sport=boat&origin=real',{},env());
  expect(rankings.status).toBe(200);
  const rows=await rankings.json() as any[];
  expect(rows.filter(x=>x.raceId===raceId)).toHaveLength(120);
  expect(rows.find(x=>x.raceId===raceId)).toMatchObject({betType:'trifecta',buyEligible:true,dataOrigin:'real'});
  const detail=await app.request(`/api/races/${raceId}`,{},env());
  expect((await detail.json() as any).tickets).toHaveLength(120);
  const oddsCapturedAt=(sqlite.prepare("SELECT captured_at FROM odds_snapshots WHERE race_id=? AND bet_type='trifecta' LIMIT 1").get(raceId) as any).captured_at;
  const missingRequestId=await app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId,betType:'trifecta',selection:selections[0],stake:100})},env());
  expect(missingRequestId.status).toBe(400);
  vi.spyOn(Date,'now').mockReturnValue(Date.now());
  const requestId='manual-trifecta-retry';
  const post=(stake=100)=>app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId,betType:'trifecta',selection:selections[0],stake,requestId})},env());
  const placed=await post();
  expect(placed.status).toBe(201); const bet=await placed.json() as any; expect(bet).toMatchObject({betType:'trifecta',selection:selections[0],dataOrigin:'real',oddsCapturedAt,groupId:requestId});
  expect((await post()).status).toBe(200);
  expect((await post(200)).status).toBe(409);
  const crossType=await app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId,betType:'win',requestId,selections:[{selection:selections[0],stake:100}]})},env());
  expect(crossType.status).toBe(409);
  expect(sqlite.prepare('SELECT COUNT(*) n FROM bets WHERE bet_group_id=?').get(requestId)).toMatchObject({n:1});
  expect(sqlite.prepare('SELECT odds_captured_at FROM bets WHERE id=?').get(bet.id)).toMatchObject({odds_captured_at:oddsCapturedAt});
  const concurrentId='manual-trifecta-concurrent';
  const concurrentPost=()=>app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId,betType:'trifecta',selection:selections[0],stake:100,requestId:concurrentId})},env());
  const concurrent=await Promise.all([concurrentPost(),concurrentPost()]);
  expect(concurrent.map(x=>x.status).sort()).toEqual([200,201]);
  const concurrentBets=await Promise.all(concurrent.map(x=>x.json() as Promise<any>));
  expect(concurrentBets[0].id).toBe(concurrentBets[1].id);
  const listed=await app.request('/api/bets?origin=real',{},env());
  expect((await listed.json() as any[]).find(x=>x.id===bet.id)).toMatchObject({oddsCapturedAt});
  sqlite.prepare("DELETE FROM odds_snapshots WHERE race_id=? AND selection='6-5-4'").run(raceId);
  const incomplete=await app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId,betType:'trifecta',selection:selections[1],stake:100,requestId:'manual-trifecta-incomplete'})},env());
  expect(incomplete.status).toBe(400);
 });
 it('rejects ticket candidates when model training is not strictly earlier than prediction or the six-lane field is incomplete',async()=>{
  const {raceId,modelId}=addValidatedTrifectaFixture();
  const predictedAt=(sqlite.prepare('SELECT predicted_at FROM ticket_predictions WHERE race_id=? LIMIT 1').get(raceId) as any).predicted_at;
  sqlite.prepare('UPDATE models SET trained_at=? WHERE id=?').run(predictedAt,modelId);
  let response=await app.request(`/api/rankings?sport=boat&date=2099-01-01&origin=real`,{},env());
  expect((await response.json() as any[]).some(row=>row.raceId===raceId)).toBe(false);
  sqlite.prepare('UPDATE models SET trained_at=? WHERE id=?').run(jstIso(Date.now()-60_000),modelId);
  sqlite.prepare('DELETE FROM entries WHERE race_id=? AND number=6').run(raceId);
  response=await app.request(`/api/rankings?sport=boat&date=2099-01-01&origin=real`,{},env());
  expect((await response.json() as any[]).some(row=>row.raceId===raceId)).toBe(false);
 });
 it('stores and returns the captured odds time for manual and auto trifecta bets',async()=>{
  const {raceId,selections}=addValidatedTrifectaFixture();
  const decisionAt=Date.now();setPaperCutoff(raceId,decisionAt);
  sqlite.prepare("UPDATE odds_snapshots SET source_url=REPLACE(source_url,'20990101',?) WHERE race_id=? AND bet_type='trifecta'").run(jstDate().replaceAll('-',''),raceId);
  const oddsCapturedAt=(sqlite.prepare("SELECT captured_at FROM odds_snapshots WHERE race_id=? AND bet_type='trifecta' LIMIT 1").get(raceId) as any).captured_at;
  const placed=await app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId,betType:'trifecta',selection:selections[0],stake:100,requestId:'manual-trifecta-odds-time'})},env());
  expect(placed.status).toBe(201);
  const manual=await placed.json() as any;
  expect(manual.oddsCapturedAt).toBe(oddsCapturedAt);
  expect(sqlite.prepare("SELECT odds_captured_at FROM bets WHERE id=?").get(manual.id)).toMatchObject({odds_captured_at:oddsCapturedAt});

  const winCapturedAt=jstIso(Date.now()-4000);
  sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES('cross-win-p',?,'boat-active',1,0.5,0.05,?,'real')").run(raceId,jstIso(Date.now()-9000));
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('cross-win-o',?,'win','1',3,?,'verified-win-fixture','real')").run(raceId,winCapturedAt);
  expect(await autoBet(DB,true,decisionAt)).toBe(1);
  const automatic=sqlite.prepare("SELECT id,bet_type,odds_captured_at FROM bets WHERE race_id=? AND mode='auto'").get(raceId) as any;
  expect(automatic.bet_type).toBe('trifecta'); // conservative ROI beats the concurrent win candidate
  expect(Date.parse(automatic.odds_captured_at)).toBeGreaterThan(Date.parse(oddsCapturedAt));
  const listed=await app.request('/api/bets?origin=real',{},env());
  const bets=await listed.json() as any[];
  expect(bets.find(x=>x.id===manual.id)).toMatchObject({oddsCapturedAt});
  expect(bets.find(x=>x.id===automatic.id)).toMatchObject({oddsCapturedAt:automatic.odds_captured_at});
 });
 it('holds trifecta settlement until complete results and the exact winning trifecta payout exist; rejects unvalidated promotion',async()=>{
  const {raceId}=addValidatedTrifectaFixture();
  sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES('ticket-settle',?,'boat','trifecta','1-2-3',100,'manual','HIGH_EDGE',?,'open','real')").run(raceId,jstIso(Date.now()-10_000));
  sqlite.prepare("UPDATE races SET status='finished' WHERE id=?").run(raceId);
  for(const [i,number] of [1,2,3,4,5,6].entries())sqlite.prepare('INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,?,?,\'real\')').run(raceId,i+1,number);
  expect(await settleOpen(DB)).toBe(0);
  sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES(?,'trifecta','2-1-3',450,2,'real')").run(raceId);
  sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES(?,'trifecta','1-2-3',500,1,'real')").run(raceId);
  expect(await settleOpen(DB)).toBe(0);
  sqlite.prepare("DELETE FROM payouts WHERE race_id=? AND selection='2-1-3'").run(raceId);
  sqlite.prepare("UPDATE results SET finish_order=1 WHERE race_id=? AND number=3").run(raceId);
  expect(await settleOpen(DB)).toBe(0);
  sqlite.prepare("UPDATE results SET finish_order=3 WHERE race_id=? AND number=3").run(raceId);
  expect(await settleOpen(DB)).toBe(1);
  expect(sqlite.prepare("SELECT status,payout,profit FROM bets WHERE id='ticket-settle'").get()).toMatchObject({status:'won',payout:500,profit:400});
  const modelId='boat-trifecta-unvalidated';
  sqlite.prepare("INSERT INTO models(id,sport,bet_type,version,algorithm,status,metrics_json) VALUES(?,'boat','trifecta','v2','fixture','candidate',?)").run(modelId,JSON.stringify({ticketModelSchemaVersion:'ticket-selection-v1',ticketPredictionSemantics:'exact-selection-probability-v1',ticketBetType:'trifecta',ticketArtifactSha256:'e'.repeat(64),promotionEligible:true}));
  const promotion=await app.request(`/api/models/${modelId}/promote`,{method:'POST'},env());
  expect(promotion.status).toBe(400);
  expect(await promotion.json()).toMatchObject({error:'ticket model requires a recent artifact-bound validation and explicit complete-ticket quality gate'});
 });
 it('blocks manual promotion only when candidate explicitly failed qualification',async()=>{
  const model=sqlite.prepare("SELECT id FROM models WHERE sport='horse' AND status='candidate' LIMIT 1").get() as {id:string};
  sqlite.prepare('UPDATE models SET metrics_json=? WHERE id=?').run(JSON.stringify({promotionEligible:false,promotionReason:'same-holdout comparison failed'}),model.id);
  const response=await app.request(`/api/models/${model.id}/promote`,{method:'POST'},env());
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({error:'same-holdout comparison failed'});
 });
 it('accepts only an intact, current ML-generated initial-baseline validation contract',async()=>{
  const validation=JSON.parse(readFileSync(resolve(root,'ml/tests/fixtures/initial_baseline_validation.synthetic.json'),'utf8')) as any;
  validation.validatedAt=new Date().toISOString();
  validation.boatVenueSchemaVersion='boat-venue-v2';
  validation.correctedTrainingDataSha256='f'.repeat(64);
  const id=validation.candidateModelId, active=sqlite.prepare("SELECT * FROM models WHERE id='boat-active'").get() as any;
  const metrics={promotionEligible:false,promotionReason:'initial baseline requires a separate human decision',
    initialBaselineEligible:true,initialBaselineReason:null,initialBaselineValidation:validation,
    boatVenueSchemaVersion:'boat-venue-v2',correctedTrainingDataSha256:'f'.repeat(64),boatArtifactSha256:validation.artifact.pickleSha256};
  sqlite.prepare("INSERT INTO models(id,sport,bet_type,version,algorithm,status,train_from,train_to,valid_from,valid_to,test_from,test_to,n_train,metrics_json,trained_at,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id,'boat','win',validation.artifact.version,'fixture','candidate','2026-01-01','2026-03-11','2026-03-12','2026-03-26','2026-03-27','2026-04-10',2100,JSON.stringify(metrics),validation.validatedAt,'synthetic validation fixture');
  validation.candidateRegistryIdentity={id,version:validation.artifact.version,status:'candidate'};
  validation.activeModelSnapshot.models=sqlite.prepare("SELECT id,version,status,metrics_json FROM models WHERE sport='boat' AND bet_type='win' AND id<>? ORDER BY id,version,status").all(id).map((m:any)=>({id:m.id,version:m.version,status:m.status,metricsSha256:sha256Text(m.metrics_json??''),artifactCompatibility:'incompatible'}));
  validation.activeModelSnapshot.snapshotSha256=sha256Json(validation.activeModelSnapshot.models);
  const fingerprintPayload={...validation}; delete fingerprintPayload.fingerprint; delete fingerprintPayload.validatedAt;
  delete fingerprintPayload.initialBaselineEligible; delete fingerprintPayload.initialBaselineReason;
  validation.fingerprint=sha256Json(fingerprintPayload); metrics.initialBaselineValidation=validation;
  sqlite.prepare('UPDATE models SET metrics_json=? WHERE id=?').run(JSON.stringify(metrics),id);
  const rejectIdentity=async(schema:string|undefined,source:string|undefined)=>{
    if(schema===undefined) delete validation.boatVenueSchemaVersion; else validation.boatVenueSchemaVersion=schema;
    if(source===undefined) delete validation.correctedTrainingDataSha256; else validation.correctedTrainingDataSha256=source;
    const fp={...validation}; delete fp.fingerprint; delete fp.validatedAt;
    delete fp.initialBaselineEligible; delete fp.initialBaselineReason;
    validation.fingerprint=sha256Json(fp); metrics.initialBaselineValidation=validation;
    sqlite.prepare('UPDATE models SET metrics_json=? WHERE id=?').run(JSON.stringify(metrics),id);
    const response=await app.request(`/api/models/${id}/promote`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'initial_baseline',validationFingerprint:validation.fingerprint,confirmed:true})},env());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({error:'validated artifact identity is incomplete'});
  };
  await rejectIdentity(undefined,'f'.repeat(64));
  await rejectIdentity('boat-base-v1','f'.repeat(64));
  await rejectIdentity('boat-venue-v2',undefined);
  await rejectIdentity('boat-venue-v2','e'.repeat(64));
  validation.boatVenueSchemaVersion='boat-venue-v2'; validation.correctedTrainingDataSha256='f'.repeat(64);
  const finalFingerprint={...validation}; delete finalFingerprint.fingerprint; delete finalFingerprint.validatedAt;
  delete finalFingerprint.initialBaselineEligible; delete finalFingerprint.initialBaselineReason;
  validation.fingerprint=sha256Json(finalFingerprint); metrics.initialBaselineValidation=validation;
  sqlite.prepare('UPDATE models SET metrics_json=? WHERE id=?').run(JSON.stringify(metrics),id);
  const payload={mode:'initial_baseline',validationFingerprint:validation.fingerprint,confirmed:true};
  const promoted=await app.request(`/api/models/${id}/promote`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)},env());
  expect(promoted.status).toBe(200); expect((await promoted.json() as any).status).toBe('active');
  expect(sqlite.prepare("SELECT status FROM models WHERE id='boat-active'").get()).toMatchObject({status:'retired'});

  const tamperedId='boat-win-tampered-validation';
  const tampered={...validation,candidateModelId:tamperedId,candidateRegistryIdentity:{id:tamperedId,version:validation.artifact.version,status:'candidate'}};
  const badMetrics={...metrics,initialBaselineValidation:tampered};
  sqlite.prepare("INSERT INTO models(id,sport,bet_type,version,algorithm,status,metrics_json,trained_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(tamperedId,'boat','win','tampered-fixture-version','fixture','candidate',JSON.stringify(badMetrics),validation.validatedAt);
  const rejected=await app.request(`/api/models/${tamperedId}/promote`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,validationFingerprint:tampered.fingerprint})},env());
  expect(rejected.status).toBe(400); expect(await rejected.json()).toMatchObject({error:'initial-baseline validation contents do not match their fingerprint'});
  expect(sqlite.prepare('SELECT status FROM models WHERE id=?').get(tamperedId)).toMatchObject({status:'candidate'});
  expect(active.status).toBe('active');
 });
 it('rejects stale odds and does not use not-yet-observed predictions for virtual bets',async()=>{
  const races=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' AND status='scheduled' AND sport='boat' ORDER BY id LIMIT 2").all() as {id:string}[];
  const entry=sqlite.prepare('SELECT number FROM entries WHERE race_id=? ORDER BY number LIMIT 1').get(races[0].id) as {number:number};
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('stale-odds',?,'win',?,10,?,'test','sample')").run(races[0].id,String(entry.number),jstIso(Date.now()-11*60_000));
  const manual=await app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId:races[0].id,betType:'win',selection:String(entry.number),stake:100})},env());
  expect(manual.status).toBe(400);
  expect(await manual.json()).toMatchObject({error:'odds are unavailable'});

  const futureEntry=sqlite.prepare('SELECT number FROM entries WHERE race_id=? ORDER BY number LIMIT 1').get(races[1].id) as {number:number};
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('fresh-odds-future-pred',?,'win',?,10,?,'test','sample')").run(races[1].id,String(futureEntry.number),jstIso(Date.now()-1000));
  sqlite.prepare('DELETE FROM predictions WHERE race_id=? AND number=?').run(races[1].id,futureEntry.number);
  sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES('future-prediction',?,'boat-active',?,0.5,0.01,?,'sample')").run(races[1].id,futureEntry.number,jstIso(Date.now()+60_000));
  expect(await autoBet(DB,true)).toBe(0);
  const lateManual=await app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId:races[1].id,betType:'win',selection:String(futureEntry.number),stake:100})},env());
  expect(lateManual.status).toBe(400);
  expect(await lateManual.json()).toMatchObject({error:'active model prediction is unavailable'});
 });
 it('fails closed for legacy boat models without validated runtime provenance',async()=>{
  sqlite.prepare("UPDATE models SET metrics_json='{}' WHERE id='boat-active'").run();
  const race=sqlite.prepare("SELECT id,race_date FROM races WHERE sport='boat' AND status='scheduled' AND data_origin='sample' LIMIT 1").get() as {id:string;race_date:string};
  const entry=sqlite.prepare('SELECT number FROM entries WHERE race_id=? ORDER BY number LIMIT 1').get(race.id) as {number:number};
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('legacy-odds',?,'win',?,10,?,'test','sample')").run(race.id,String(entry.number),jstIso(Date.now()-1000));
  sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES('legacy-prediction',?,'boat-active',?,0.8,0.01,?,'sample')").run(race.id,entry.number,jstIso(Date.now()-2000));
  expect(await autoBet(DB,true)).toBe(0);
  const manual=await app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId:race.id,betType:'win',selection:String(entry.number),stake:100})},env());
  expect(manual.status).toBe(400); expect(await manual.json()).toMatchObject({error:'active model prediction is unavailable'});
  const detail=await (await app.request(`/api/races/${race.id}`,{},env())).json() as any;
  expect(detail.model).toBeNull(); expect(detail.entries.find((x:any)=>x.number===entry.number).probability).toBeNull();
  const rankings=await (await app.request(`/api/rankings?sport=boat&date=${race.race_date}&origin=sample`,{},env())).json() as any[];
  expect(rankings).toEqual([]);
 });
 it('performance breakdown groups bets by expected ROI bands',async()=>{
  const race=sqlite.prepare("SELECT id,sport FROM races WHERE data_origin='sample' LIMIT 1").get() as any;
  const add=(id:string,roi:number|null)=>sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,expected_roi,edge_label,placed_at,status,data_origin) VALUES(?,?,'boat','win',?,100,'manual',?,'NEUTRAL',?,'lost','sample')").run(id,race.id,id,roi,jstIso());
  add('roi-high',0.25); add('roi-mid',0.10); add('roi-neutral',0); add('roi-low',-0.1); add('roi-unknown',null);
  const response=await app.request('/api/performance/breakdown',{},env());
  expect(response.status).toBe(200); const result=await response.json() as any;
  expect(result.byEdge.map((x:any)=>x.bucket)).toEqual(['20%以上','5〜20%','0〜5%','< 0%','不明']);
  expect(result.byEdge.every((x:any)=>x.bets>0&&x.stake>=100)).toBe(true);
 });
 it('performance endpoints honour the origin filter and calibrate only finished races',async()=>{
  const ov=async(o:string)=>(await (await app.request(`/api/performance/overview?origin=${o}`,{},env())).json()) as any;
  expect((await ov('sample')).betCount).toBeGreaterThan(0);
  expect((await ov('real')).betCount).toBe(0);
  const venue=sqlite.prepare("SELECT venue_id FROM races WHERE sport='boat' LIMIT 1").get() as {venue_id:string};
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at) VALUES('late-prediction-race','boat',?,'2099-01-01',1,'2099-01-01T12:00:00Z','finished','real','2099-01-01T12:00:00Z')").run(venue.venue_id);
  sqlite.prepare("INSERT INTO results(race_id,finish_order,number,data_origin) VALUES('late-prediction-race',1,1,'real')").run();
  sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES('late-prediction','late-prediction-race','boat-active',1,0.99,0.01,'2099-01-01T12:01:00Z','real')").run();
  const bd=await (await app.request('/api/performance/breakdown?origin=real',{},env())).json() as any;
  expect(bd.bySport).toEqual([]); expect(bd.calibration).toEqual([]); expect(bd.oddsDrift.bets).toBe(0);
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at) VALUES('legacy-calibration-race','boat',?,'2099-01-01',2,'2099-01-01T12:00:00Z','finished','real','2099-01-01T12:00:00Z')").run(venue.venue_id);
  sqlite.prepare("INSERT INTO results(race_id,finish_order,number,data_origin) VALUES('legacy-calibration-race',1,1,'real')").run();
  sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES('legacy-valid-prediction','legacy-calibration-race','boat-active',1,0.99,0.01,'2099-01-01T11:59:00Z','real')").run();
  sqlite.prepare("UPDATE models SET metrics_json='{}' WHERE id='boat-active'").run();
  const legacyCalibration=await (await app.request('/api/performance/breakdown?origin=real',{},env())).json() as any;
  expect(legacyCalibration.calibration).toEqual([]);
  sqlite.prepare("UPDATE models SET metrics_json=json_set('{}','$.boatVenueSchemaVersion','boat-venue-v2','$.correctedTrainingDataSha256',?,'$.boatArtifactSha256',?) WHERE id='boat-active'").run('f'.repeat(64),'a'.repeat(64));
  const all=await (await app.request('/api/performance/breakdown?origin=sample',{},env())).json() as any;
  const n=all.calibration.reduce((a:number,x:any)=>a+x.count,0);
  const finished=sqlite.prepare("SELECT COUNT(*) n FROM predictions p JOIN races race ON race.id=p.race_id AND race.data_origin=p.data_origin JOIN models m ON m.id=p.model_id AND m.sport=race.sport AND m.bet_type='win' AND (race.sport<>'boat' OR (json_extract(m.metrics_json,'$.boatVenueSchemaVersion')='boat-venue-v2' AND length(json_extract(m.metrics_json,'$.correctedTrainingDataSha256'))=64 AND json_extract(m.metrics_json,'$.correctedTrainingDataSha256') NOT GLOB '*[^a-f0-9]*' AND length(json_extract(m.metrics_json,'$.boatArtifactSha256'))=64 AND json_extract(m.metrics_json,'$.boatArtifactSha256') NOT GLOB '*[^a-f0-9]*')) JOIN results r ON r.race_id=p.race_id AND r.number=p.number AND r.data_origin=race.data_origin WHERE race.data_origin='sample' AND race.status='finished' AND race.post_time IS NOT NULL AND julianday(p.predicted_at)<=julianday(race.post_time) AND p.predicted_at=(SELECT p2.predicted_at FROM predictions p2 WHERE p2.race_id=p.race_id AND p2.model_id=p.model_id AND p2.number=p.number AND p2.data_origin=race.data_origin AND julianday(p2.predicted_at)<=julianday(race.post_time) ORDER BY julianday(p2.predicted_at) DESC LIMIT 1)").get() as {n:number};
  expect(n).toBe(finished.n);
 });
 it('quarantines explicitly marked bets from settlement, listings, performance, and bankroll while reporting their totals',async()=>{
  const race=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' AND sport='boat' AND status='finished' LIMIT 1").get() as {id:string};
  sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,predicted_prob,odds_at_bet,expected_roi,edge_label,placed_at,status,payout,profit,settled_at,data_origin) VALUES('quarantined-ledger',?,'boat','win','1',100,'manual',0.5,2,0,'NEUTRAL',?,'won',500,400,?,'sample')").run(race.id,jstIso(),jstIso());
  sqlite.prepare("INSERT INTO data_repair_audit_marks(repair_id,race_id,record_type,record_id,reason) VALUES('repair-test',?,'bet','quarantined-ledger','source correction')").run(race.id);
  sqlite.prepare("INSERT INTO data_repair_audit_marks(repair_id,race_id,record_type,record_id,reason) VALUES('repair-test',?,'prediction','quarantined-prediction','source correction')").run(race.id);
  const listed=await (await app.request('/api/bets',{},env())).json() as any[];
  expect(listed.some(x=>x.id==='quarantined-ledger')).toBe(false);
  const summary=await (await app.request('/api/bets/quarantine-summary?origin=sample',{},env())).json() as any;
  expect(summary).toMatchObject({count:1,stake:100,payout:500,profit:400});
  const overview=await (await app.request('/api/performance/overview?origin=sample',{},env())).json() as any;
  expect(overview.quarantined).toMatchObject({count:1,stake:100,payout:500,profit:400});
  expect(await settleOpen(DB)).toBe(0);
  expect(sqlite.prepare("SELECT status FROM bets WHERE id='quarantined-ledger'").get()).toEqual({status:'won'});
  sqlite.prepare("INSERT INTO settings(key,value) VALUES('auto_bet_paused','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
  expect(await autoBet(DB,true)).toBe(0);
 });
 it('accepts dead heats and wide payouts from real data',async()=>{
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('09','boat','津')").run();
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at) VALUES('boat-20990101-09-01','boat','09','2099-01-01',1,'scheduled','real','x')").run();
  const post=(e:string,b:unknown)=>app.request(`/api/ingest/${e}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:JSON.stringify(b)},env());
  expect((await post('results',[{race_id:'boat-20990101-09-01',finish_order:1,number:1,data_origin:'real'},{race_id:'boat-20990101-09-01',finish_order:1,number:2,data_origin:'real'}])).status).toBe(200);
  expect((await post('payouts',[{race_id:'boat-20990101-09-01',bet_type:'wide',selection:'1-2',payout:150,data_origin:'real'}])).status).toBe(200);
  expect((await post('races',[{id:'boat-20990101-09-02',sport:'boat',venue_id:'09',race_date:'2099-01-01',race_no:2,status:'scheduled',data_origin:'real'}])).status).toBe(200);
 });
 it('accepts only timestamped observations from the matching official beforeinfo race page',async()=>{
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('09','boat','津')").run();
  const day=jstDate(),raceId=`boat-${day.replaceAll('-','')}-09-01`;
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at) VALUES(?,'boat','09',?,1,'scheduled','real',?)").run(raceId,day,jstIso());
  const post=(rows:unknown[])=>app.request('/api/ingest/prerace-observations',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:JSON.stringify(rows)},env());
  const fetchedAt=jstIso(Date.now()-1000),observedAt=jstIso(Date.now()-2000);
  const observation={id:`${raceId}:exhibition:1:${fetchedAt}`,race_id:raceId,kind:'exhibition',entry_number:1,
   source_url:`https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${day.replaceAll('-','')}&jcd=09&rno=1`,source_sha256:'a'.repeat(64),
   source_observed_at:observedAt,source_observation_label:null,fetched_at:fetchedAt,available_at:fetchedAt,
   values_json:JSON.stringify({exhibition_time:6.72,tilt:-0.5}),data_origin:'real'};
  expect((await post([observation])).status).toBe(200);
  expect(sqlite.prepare('SELECT kind,entry_number,data_origin FROM boatrace_prerace_observations WHERE race_id=?').get(raceId))
   .toMatchObject({kind:'exhibition',entry_number:1,data_origin:'real'});
  const weather={...observation,id:`${raceId}:weather:0:${fetchedAt}`,kind:'weather',entry_number:0,
   values_json:JSON.stringify({wind_direction:'北',wind_direction_class:'is-wind12',wind_speed:2})};
  expect((await post([weather])).status).toBe(200);
  const badWind={...weather,id:'bad-wind-class',values_json:JSON.stringify({wind_direction_class:'is-wind13'})};
  expect((await post([badWind])).status).toBe(400);
  const bad={...observation,id:'wrong-source',source_url:observation.source_url.replace('beforeinfo','raceresult')};
  expect((await post([bad])).status).toBe(400);
  expect(sqlite.prepare('SELECT COUNT(*) n FROM boatrace_prerace_observations WHERE id=?').get('wrong-source')).toMatchObject({n:0});
 });
 it('requires the proxy header for read APIs when PROXY_TOKEN is set',async()=>{
  const e={...env(),PROXY_TOKEN:'p'};
  const forbidden=await app.request('/api/models',{},e);
  expect(forbidden.status).toBe(403); expect(forbidden.headers.get('X-ROI-API-Revision')).toBe('ten-minute-results-settlement-v1');
  expect(await forbidden.json()).toMatchObject({error:'forbidden'});
  const allowed=await app.request('/api/models',{headers:{'X-ROI-Proxy':'p'}},e);
  expect(allowed.status).toBe(200); expect(allowed.headers.get('X-ROI-API-Revision')).toBe('ten-minute-results-settlement-v1');
  expect((await app.request('/api/health',{},e)).status).toBe(200);
  expect((await app.request('/api/ingest/venues',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:'[]'},e)).status).toBe(200);
 });
 it('caches successful authenticated reads with query-separated keys and fresh bypass',async()=>{
  const values=new Map<string,Response>(); let puts=0,deletes=0,prepareCount=0,failMatch=false,failPut=false;
  const fakeCache={
   match:async(request:Request)=>{if(failMatch)throw new Error('cache unavailable');const response=values.get(request.url);return response?.clone();},
   put:async(request:Request,response:Response)=>{puts++;if(failPut)throw new Error('cache write failed');values.set(request.url,response.clone());},
   delete:async(request:Request)=>{deletes++;return values.delete(request.url);},
  };
  vi.stubGlobal('caches',{default:fakeCache});
  const countingDb={prepare:(sql:string)=>{prepareCount++;return DB.prepare(sql);}};
  const e={...env({PROXY_TOKEN:'proxy'}),DB:countingDb};
  const unauthorized=await app.request('/api/models',{},e);
  expect(unauthorized.status).toBe(403); expect(puts).toBe(0);
  const headers={'X-ROI-Proxy':'proxy'};
  const miss=await app.request('/api/models?view=a',{headers},e);
  expect(miss.status).toBe(200); expect(miss.headers.get('X-ROI-Read-Cache')).toBe('MISS');
  expect(miss.headers.get('Cache-Control')).toBe('private, no-store');
  expect([...values.values()][0].headers.get('Cache-Control')).toBe('public, max-age=10');
  const cacheKeyUrl=new URL([...values.keys()][0]);
  expect(cacheKeyUrl.hostname).toBe('localhost'); expect(cacheKeyUrl.pathname).toBe('/__roi_read_cache_v1/api/models');
  const afterFirst=prepareCount;
  const hit=await app.request('/api/models?view=a',{headers},e);
  expect(hit.status).toBe(200); expect(hit.headers.get('Cache-Control')).toBe('private, no-store'); expect(hit.headers.get('X-ROI-Read-Cache')).toBe('HIT');
  expect(hit.headers.get('X-ROI-API-Revision')).toBe('ten-minute-results-settlement-v1');
  expect(prepareCount).toBe(afterFirst);
  expect((await app.request('/api/models?view=a',{},e)).status).toBe(403); // warm cache never bypasses auth
  expect((await app.request('/api/models?view=b',{headers},e)).status).toBe(200);
  expect(prepareCount).toBeGreaterThan(afterFirst);
  const beforeErrorPuts=puts;
  expect((await app.request('/api/races?origin=real',{headers},e)).status).toBe(400);
  expect(puts).toBe(beforeErrorPuts);

  const betsUrl='/api/bets?origin=real&sport=boat';
  const betsMiss=await app.request(betsUrl,{headers},e);
  expect(betsMiss.status).toBe(200); expect(betsMiss.headers.get('X-ROI-Read-Cache')).toBe('MISS');
  const betsKey=[...values.keys()].find(key=>new URL(key).pathname==='/__roi_read_cache_v1/api/bets')!;
  expect(values.get(betsKey)?.headers.get('Cache-Control')).toBe('public, max-age=5');
  const beforeBetsHit=prepareCount;
  const betsHit=await app.request(betsUrl,{headers},e);
  expect(betsHit.headers.get('X-ROI-Read-Cache')).toBe('HIT'); expect(prepareCount).toBe(beforeBetsHit);
  expect((await app.request('/api/bets?origin=real&sport=horse',{headers},e)).headers.get('X-ROI-Read-Cache')).toBe('MISS');
  expect((await app.request('/api/bets?origin=real&sport=boat',{},e)).status).toBe(403);

  const overviewUrl='/api/performance/overview?origin=real&sport=boat';
  const overviewMiss=await app.request(overviewUrl,{headers},e);
  expect(overviewMiss.status).toBe(200); expect(overviewMiss.headers.get('X-ROI-Read-Cache')).toBe('MISS');
  const overviewKey=[...values.keys()].find(key=>new URL(key).pathname==='/__roi_read_cache_v1/api/performance/overview')!;
  expect(values.get(overviewKey)?.headers.get('Cache-Control')).toBe('public, max-age=10');
  const beforeOverviewHit=prepareCount;
  expect((await app.request(overviewUrl,{headers},e)).headers.get('X-ROI-Read-Cache')).toBe('HIT');
  expect(prepareCount).toBe(beforeOverviewHit);
  const beforeBypass=prepareCount;
  const bypass=await app.request(overviewUrl,{headers:{...headers,'X-ROI-Cache-Bypass':'1'}},e);
  expect(bypass.status).toBe(200); expect(bypass.headers.get('X-ROI-Read-Cache')).toBe('BYPASS');
  expect(bypass.headers.get('Cache-Control')).toBe('private, no-store');
  expect(prepareCount).toBeGreaterThan(beforeBypass); expect(deletes).toBeGreaterThan(0);

  const beforeExcluded=puts;
  expect((await app.request('/api/performance/breakdown?origin=real',{headers},e)).status).toBe(200);
  expect(puts).toBe(beforeExcluded);
  const beforeFallback=prepareCount; failMatch=true;
  expect((await app.request('/api/models?view=c',{headers},e)).status).toBe(200);
  expect(prepareCount).toBeGreaterThan(beforeFallback);
  failMatch=false; failPut=true;
  const beforePutFailure=prepareCount;
  expect((await app.request('/api/models?view=d',{headers},e)).headers.get('Cache-Control')).toBe('private, no-store');
  expect(prepareCount).toBeGreaterThan(beforePutFailure);
 });
 it('blocks boat win runtime, promotion, rollback and rebuy without venue-v2 and corrected-data SHA metadata',async()=>{
  const race=sqlite.prepare("SELECT r.id FROM races r WHERE r.data_origin='sample' AND r.sport='boat' AND r.status='scheduled' LIMIT 1").get() as any;
  const selection=addBetInputs(race.id,'legacy-model');
  const legacyMetrics={boatFeatureSchemaVersion:'boat-base-v1',boatArtifactSha256:'a'.repeat(64),promotionEligible:true};
  sqlite.prepare('UPDATE models SET metrics_json=? WHERE id=\'boat-active\'').run(JSON.stringify(legacyMetrics));
  const buy=await app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId:race.id,betType:'win',selection,stake:100})},env());
  expect(buy.status).toBe(400);
  const legacyCandidate='boat-legacy-candidate';
  sqlite.prepare("INSERT INTO models(id,sport,bet_type,version,algorithm,status,metrics_json) VALUES(?,'boat','win','old','fixture','candidate',?)").run(legacyCandidate,JSON.stringify(legacyMetrics));
  expect((await app.request(`/api/models/${legacyCandidate}/promote`,{method:'POST'},env())).status).toBe(400);
  const legacyRetired='boat-legacy-retired';
  sqlite.prepare("INSERT INTO models(id,sport,bet_type,version,algorithm,status,metrics_json) VALUES(?,'boat','win','old-retired','fixture','retired',?)").run(legacyRetired,JSON.stringify(legacyMetrics));
  expect((await app.request('/api/models/boat-active/rollback',{method:'POST'},env())).status).toBe(400);
  expect(sqlite.prepare('SELECT status FROM models WHERE id=?').get(legacyRetired)).toMatchObject({status:'retired'});
 });
 it('collection source is disabled when its latest run was skipped',async()=>{
  sqlite.prepare("INSERT INTO collection_runs(id,source,sport,target_date,started_at,status,records) VALUES('run-success','boat-official','boat','2099-01-01','2099-01-01T00:00:00Z','success',10)").run();
  sqlite.prepare("INSERT INTO collection_runs(id,source,sport,target_date,started_at,status,records) VALUES('run-skipped','boat-official','boat','2099-01-01','2099-01-02T00:00:00Z','skipped',0)").run();
  const response=await app.request('/api/collection/status',{},env());
  const result=await response.json() as any;
  expect(result.sources.find((x:any)=>x.source==='boat-official').enabled).toBe(false);
 });
 it('reports truthful result-wait reasons and date-scoped result collection telemetry in bet history',async()=>{
  const venueId=(sqlite.prepare("SELECT venue_id FROM races WHERE data_origin='sample' LIMIT 1").get() as any).venue_id;
  const makeRace=(id:string,status:string,postTime:string|null,raceDate='2099-01-01')=>{
   sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,status,post_time,data_origin,updated_at) VALUES(?,'boat',?,?,?,?,?, 'real','2099-01-01T00:00:00Z')").run(id,venueId,raceDate,Number(id.slice(-2)),status,postTime);
   for(let number=1;number<=2;number++)sqlite.prepare("INSERT INTO entries(id,race_id,number,name,features_json,available_at,data_origin) VALUES(?,?,?,?,'{}','2099-01-01T00:00:00Z','real')").run(`${id}-${number}`,id,number,`Entry ${number}`);
   sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES(?,?,'boat','win','1',100,'manual','INSUFFICIENT_DATA','2099-01-01T00:00:00Z','open','real')").run(`${id}-bet`,id);
  };
  makeRace('boat-20990101-01-01','scheduled','2099-01-01T12:00:00Z');
  makeRace('boat-20990101-01-02','finished',null);
  makeRace('boat-20990101-01-03','finished',null);
  makeRace('boat-20990101-01-04','finished',null);
  makeRace('boat-20990102-01-05','finished',null,'2099-01-02');
  makeRace('boat-20990103-01-06','finished',null,'2099-01-03');
  makeRace('boat-20990103-01-07','cancelled',null,'2099-01-03');
  const elapsedPostTime=jstIso(Date.now()-60_000);
  makeRace('boat-20990104-01-08','closed',elapsedPostTime,'2099-01-04');
  makeRace('boat-20990105-01-09','scheduled',elapsedPostTime,'2099-01-05');
  makeRace('boat-20990106-01-10','scheduled','not-a-timestamp','2099-01-06');
  sqlite.prepare("UPDATE entries SET features_json='{\"finish_code\":\"失格\"}' WHERE race_id='boat-20990103-01-06' AND number=1").run();
  sqlite.prepare("INSERT INTO results(race_id,finish_order,number,data_origin) VALUES('boat-20990101-01-03',1,1,'real'),('boat-20990101-01-03',2,2,'real'),('boat-20990101-01-04',1,1,'real'),('boat-20990101-01-04',2,2,'real')").run();
  sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES('boat-20990101-01-04','win','1',230,1,'real')").run();
  const runAt=(minutesAgo:number)=>new Date(Date.now()-minutesAgo*60_000).toISOString();
  const lastSuccessAt=runAt(20),lastSuccessFinishedAt=runAt(19),latestAttemptAt=runAt(5);
  const runs=sqlite.prepare('INSERT INTO collection_runs(id,source,sport,target_date,started_at,finished_at,status,records) VALUES(?,?,\'boat\',\'2099-01-01\',?,?,?,?)');
  runs.run('run-result-success','mbrace-boat',lastSuccessAt,lastSuccessFinishedAt,'success',4);
  runs.run('run-odds-only','boatrace-odds',runAt(10),runAt(9),'failed',0);
  // Latest matching attempt is failed; prior success remains separately visible. Odds telemetry is not result telemetry.
  runs.run('run-result-failed-latest','mbrace-boat',latestAttemptAt,runAt(4),'failed',0);
  runs.run('run-result-future','mbrace-boat','2099-01-06T00:00:00Z','2099-01-06T00:01:00Z','success',99);
  const sampleRace=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' LIMIT 1").get() as any;
  sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES('sample-wait-bet',?,'boat','win','1',100,'manual','INSUFFICIENT_DATA','2099-01-01T00:00:00Z','open','sample')").run(sampleRace.id);
  const response=await app.request('/api/bets?origin=all',{},env());
  expect(response.status).toBe(200);
  const bets=await response.json() as any[];
  const byId=Object.fromEntries(bets.map((bet:any)=>[bet.id,bet]));
  expect(byId['boat-20990101-01-01-bet'].resultWaitReason).toBe('notstarted');
  expect(byId['boat-20990101-01-02-bet']).toMatchObject({resultWaitReason:'collectionfailed',resultCollectionSource:'mbrace-boat',resultCollectionStatus:'failed',resultCollectionLastAttemptAt:latestAttemptAt,resultCollectionLastSuccessAt:lastSuccessFinishedAt});
  expect(byId['boat-20990101-01-03-bet'].resultWaitReason).toBe('payoutmissing');
  expect(byId['boat-20990101-01-04-bet'].resultWaitReason).toBe('settlementpending');
  expect(byId['boat-20990102-01-05-bet'].resultWaitReason).toBe('officialresultmissing');
  expect(byId['boat-20990103-01-06-bet'].resultWaitReason).toBe('disqualified');
  expect(byId['boat-20990103-01-07-bet'].resultWaitReason).toBe('cancelled');
  expect(byId['boat-20990104-01-08-bet'].resultWaitReason).toBe('officialresultmissing');
  expect(byId['boat-20990105-01-09-bet'].resultWaitReason).toBe('officialresultmissing');
  expect(byId['boat-20990106-01-10-bet'].resultWaitReason).toBe('unknown');
  expect(byId['sample-wait-bet'].resultWaitReason).toBe('sampledata');
 });
});

describe('collection status quality compatibility',()=>{
 it('reports quality exclusions independently, retains mixed failures and keeps the collector enabled',async()=>{
  const runAt=(minutesAgo:number)=>new Date(Date.now()-minutesAgo*60_000).toISOString();
  const insert=sqlite.prepare("INSERT INTO collection_runs(id,source,sport,target_date,started_at,status,records,error,reason) VALUES(?,'boatrace-odds-worker','boat','2026-10-11',?,?,?,?,?)");
  insert.run('old','2026-10-11T00:00:00Z','failed',0,'race-a: odds pool not stable (overround out of range)',null);
  const mixedAt=runAt(30);
  insert.run('mixed',mixedAt,'partial',0,'race-b: odds pool not stable (overround out of range); race-c: HTTP 503',null);
  insert.run('new',runAt(10),'skipped',0,null,'quality_excluded: race-d: odds pool not stable (overround out of range), valid=6/6, sum=0.8');
  const r=await app.request('/api/collection/status',{},env());
  expect(r.status).toBe(200);const body=await r.json() as any;
  expect(body.errors.filter((e:any)=>e.source==='boatrace-odds-worker')).toEqual([{at:mixedAt,source:'boatrace-odds-worker',error:'race-c: HTTP 503'}]);
  expect(body.qualityExclusions.filter((e:any)=>e.source==='boatrace-odds-worker')).toHaveLength(2);
  expect(body.sources.find((s:any)=>s.source==='boatrace-odds-worker')).toMatchObject({enabled:true,qualityExclusions:3,successRate:0});
 });
 it('deletes only old pure quality-only logs in bounded batches',async()=>{
  const now=Date.now(), iso=(minutesAgo:number)=>new Date(now-minutesAgo*60_000).toISOString();
  const insert=sqlite.prepare("INSERT INTO collection_runs(id,source,sport,target_date,started_at,status,records,error,reason) VALUES(?,'boatrace-odds-worker','boat','2026-10-11',?,?,?,?,?)");
  insert.run('expired-pure',iso(61),'failed',0,'race-a: odds pool not stable (overround out of range)',null);
  insert.run('within-hour-pure',iso(59.8),'failed',0,'race-b: odds pool not stable (overround out of range)',null);
  insert.run('expired-mixed',iso(90),'partial',0,'race-c: odds pool not stable (overround out of range); race-d: HTTP 503',null);
  insert.run('expired-with-records',iso(90.1),'partial',3,'race-e: odds pool not stable (overround out of range)',null);
  insert.run('recent-pure',iso(20),'failed',0,'race-f: odds pool not stable (overround out of range)',null);
  await cron(DB,false);
  expect(sqlite.prepare("SELECT id FROM collection_runs WHERE id LIKE 'expired-%' OR id LIKE '%-pure' ORDER BY id").all().map((r:any)=>r.id)).toEqual(['expired-mixed','expired-with-records','recent-pure','within-hour-pure']);
 });
 it('deletes eligible old quality logs despite an exhausted legacy budget ledger',async()=>{
  sqlite.prepare("INSERT INTO collection_runs(id,source,sport,target_date,started_at,status,records,error) VALUES('budget-protected','boatrace-odds-worker','boat','2026-10-11',?,'failed',0,'race: odds pool not stable (overround out of range)')").run(new Date(Date.now()-2*60*60_000).toISOString());
  sqlite.prepare("UPDATE settings SET value=? WHERE key='roi_d1_write_budget_utc'").run(JSON.stringify({date:new Date().toISOString().slice(0,10),reserved:20_000,oddsReserved:0,essentialReserved:16_000,optionalReserved:4_000}));
  await cron(DB,false);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM collection_runs WHERE id='budget-protected'").get()).toMatchObject({n:0});
 });
 it('limits each cleanup run to ten quality-only rows',async()=>{
  const insert=sqlite.prepare("INSERT INTO collection_runs(id,source,sport,target_date,started_at,status,records,error) VALUES(?,'boatrace-odds-worker','boat','2026-10-11',?,'failed',0,'race: odds pool not stable (overround out of range)')");
  const oldEnoughAt=Date.now()-2*60*60_000;
  // Minute spacing keeps the natural-key timestamps distinct under a frozen clock.
  for(let i=0;i<12;i++)insert.run(`batch-${i}`,new Date(oldEnoughAt-i*60_000).toISOString());
  await cron(DB,false);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM collection_runs WHERE id LIKE 'batch-%'").get()).toMatchObject({n:2});
 });
 it('evaluates all overlapping experimental T-60 races once including :00, :01 and :05 ticks',async()=>{
  const raceDate=jstDate(new Date()),base=Date.parse(`${raceDate}T10:00:00+09:00`),modelId='boat-trifecta-schedule-fixture',artifactSha='a'.repeat(64),manifestSha='b'.repeat(64),metadataSha='c'.repeat(64);
  const metadata={id:modelId,status:'candidate',trainingMode:'experimental',experimentalOnly:true,sport:'boat',betType:'trifecta',boatFeatureSchemaVersion:'boat-prerace-v2-no-weather-experimental-v1',ticketBetType:'trifecta',ticketArtifactSha256:artifactSha};
  const manifest={schema:'edgelab-experimental-trifecta-artifact-v1',modelId,trainingMode:'experimental',experimentalOnly:true,
   files:{[`${modelId}.pkl`]:{sha256:artifactSha},[`${modelId}.json`]:{sha256:metadataSha}}};
  sqlite.prepare(`INSERT INTO experimental_models(id,status,manifest_schema,sport,bet_type,training_mode,schema_version,artifact_sha256,manifest_sha256,metadata_sha256,trained_at,artifact_manifest_json,manifest_json,registered_at)
   VALUES(?,'candidate','edgelab-experimental-trifecta-artifact-v1','boat','trifecta','experimental','boat-prerace-v2-no-weather-experimental-v1',?,?,?,?,?,?,?)`)
   .run(modelId,artifactSha,manifestSha,metadataSha,jstIso(base-300_000),JSON.stringify(manifest),JSON.stringify(metadata),jstIso(base-300_000));
  sqlite.prepare("INSERT OR IGNORE INTO venues(id,sport,name) VALUES('99','boat','Experimental schedule fixture')").run();
  const ticks=[base,base,base,base,base,base+60_000,base+5*60_000];
  ticks.forEach((tick,i)=>{
   const raceId=`boat-${raceDate.replaceAll('-','')}-99-${String(i+1).padStart(2,'0')}`;
   sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at,betting_cutoff_at,betting_cutoff_source,betting_cutoff_observed_at)
    VALUES(?,'boat','99',?,?,?,'scheduled','real',?,?,'boatrace-racelist-cutoff-v1',?)`).run(raceId,raceDate,i+1,jstIso(tick+300_000),jstIso(tick),jstIso(tick+60_000),jstIso(tick-1_000));
   for(let n=1;n<=6;n++)sqlite.prepare("INSERT INTO entries(id,race_id,number,name,features_json,available_at,data_origin) VALUES(?,?,?,?,?,?,'real')")
    .run(`${raceId}-e${n}`,raceId,n,`Boat ${n}`,JSON.stringify({racer_id:String(1000+n)}),jstIso(tick-300_000));
  });
  vi.useFakeTimers();
  for(const tick of ticks){
   vi.setSystemTime(tick);
   const scheduled=worker.scheduled({cron:'* * * * *',scheduledTime:tick} as ScheduledController,
    env({ENABLE_BOATRACE_RESULTS_SCRAPE:tick===ticks[2]?'true':'false'}));
   await vi.advanceTimersByTimeAsync(60_000);
   await scheduled;
  }
  const decisions=sqlite.prepare('SELECT race_id,outcome,reason FROM experimental_paper_decisions ORDER BY race_id').all();
  expect(decisions).toHaveLength(ticks.length);
  expect(decisions).toEqual(ticks.map((_,i)=>({
   race_id:`boat-${raceDate.replaceAll('-','')}-99-${String(i+1).padStart(2,'0')}`,outcome:'abstained',reason:'experimental_forecast_missing_or_invalid'})));
 });
 it('reports only complete real current-day pre-cutoff forecast coverage',async()=>{
  const modelId='boat-trifecta-exp-noweather-coverage',sha='a'.repeat(64),asOf=Date.now();
  sqlite.prepare(`INSERT INTO experimental_models(id,status,manifest_schema,sport,bet_type,training_mode,schema_version,artifact_sha256,manifest_sha256,metadata_sha256,trained_at,artifact_manifest_json,manifest_json,registered_at)
    VALUES(?,'candidate','edgelab-experimental-trifecta-artifact-v1','boat','trifecta','experimental','boat-prerace-v2-no-weather-experimental-v1',?,?,?,?,?,?,?)`)
    .run(modelId,sha,'b'.repeat(64),'c'.repeat(64),jstIso(asOf-300_000),'{}','{}',jstIso(asOf));
  const raceId=`boat-${jstDate().replaceAll('-','')}-99-99`;
  sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at,betting_cutoff_at,betting_cutoff_source)
    VALUES(?,'boat','b01',?,99,'scheduled','real',?,?,'boatrace-racelist-cutoff-v1')`).run(raceId,jstDate(),jstIso(asOf),jstIso(asOf+180_000));
  const insert=sqlite.prepare(`INSERT INTO experimental_ticket_predictions(id,race_id,model_id,selection,probability,prob_std,predicted_at,feature_schema_version,artifact_sha256,data_origin)
    VALUES(?,?,?,?,?,0.01,?,'ticket-selection-v1',?,'real')`);
  for(let x=1;x<=6;x++)for(let y=1;y<=6;y++)for(let z=1;z<=6;z++)if(x!==y&&x!==z&&y!==z){
    const selection=`${x}-${y}-${z}`;insert.run(selection,raceId,modelId,selection,1/120,jstIso(asOf),sha);
  }
  const read=async()=>await (await app.request('/api/performance/experimental',{},env())).json() as any;
  expect((await read()).forecastCoverage).toMatchObject({date:jstDate(),storedRaceCount:1,races:[{raceId,predictedAt:jstIso(asOf),predictionCount:120}]});
  sqlite.prepare("DELETE FROM experimental_ticket_predictions WHERE selection='1-2-3'").run();
  expect((await read()).forecastCoverage.storedRaceCount).toBe(0);
 });
 it('resolves the exact latest experimental decision model through an authenticated no-store endpoint',async()=>{
  const register=(id:string,status:string,registeredAt:string,sha:string)=>sqlite.prepare(`INSERT INTO experimental_models(id,status,manifest_schema,sport,bet_type,training_mode,schema_version,artifact_sha256,manifest_sha256,metadata_sha256,trained_at,artifact_manifest_json,manifest_json,registered_at)
   VALUES(?,?,'edgelab-experimental-trifecta-artifact-v1','boat','trifecta','experimental','boat-prerace-v2-no-weather-experimental-v1',?,?,?,?,?,?,?)`)
   .run(id,status,sha,'b'.repeat(64),'c'.repeat(64),jstIso(Date.now()-60_000),'{}','{}',registeredAt);
  const registeredAt=jstIso();
  register('boat-trifecta-exp-noweather-a','candidate',registeredAt,'a'.repeat(64));
  register('boat-trifecta-exp-noweather-z','experimental',registeredAt,'d'.repeat(64));
  expect((await app.request('/api/ingest/experimental-trifecta/forecast-model',{},env())).status).toBe(401);
  const response=await app.request('/api/ingest/experimental-trifecta/forecast-model',{headers:{Authorization:'Bearer test-token'}},env());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({model:{modelId:'boat-trifecta-exp-noweather-z',artifactSha256:'d'.repeat(64)}});
 });
});


it('exports only bounded previous-day open real boat race IDs without writes',async()=>{
 const yesterday=new Date();yesterday.setUTCDate(yesterday.getUTCDate()-1);const day=jstDate(yesterday);
 const raceId=`boat-${day.replaceAll('-','')}-99-01`;
 addValidatedTrifectaFixture(raceId,'tri-open-id-fixture');
 sqlite.prepare('UPDATE races SET race_date=? WHERE id=?').run(day,raceId);
 sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,placed_at,status,data_origin,edge_label) VALUES('open-id-bet',?,'boat','trifecta','1-2-3',100,'manual',?,'open','real','POSITIVE_EDGE')").run(raceId,jstIso());
 const budgetBefore=sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get();
 expect((await app.request(`/api/ingest/open-bet-race-ids?date=${day}`,{},env())).status).toBe(401);
 const response=await app.request(`/api/ingest/open-bet-race-ids?date=${day}`,{headers:{Authorization:'Bearer test-token'}},env());
 expect(response.status).toBe(200);expect(await response.json()).toEqual({date:day,raceIds:[raceId]});
 sqlite.prepare("UPDATE bets SET status='lost' WHERE id='open-id-bet'").run();
 const cleared=await app.request(`/api/ingest/open-bet-race-ids?date=${day}`,{headers:{Authorization:'Bearer test-token'}},env());
 expect(await cleared.json()).toEqual({date:day,raceIds:[]});
 expect((await app.request('/api/ingest/open-bet-race-ids?date=2001-01-01',{headers:{Authorization:'Bearer test-token'}},env())).status).toBe(400);
 expect(sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get()).toEqual(budgetBefore);
});

it('rejects external forecast submission after native inference is enabled without writing predictions',async()=>{
 const before=sqlite.prepare('SELECT COUNT(*) n FROM experimental_ticket_predictions').get();
 const response=await app.request('/api/ingest/experimental-trifecta/forecast',{
  method:'POST',headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:'{}',
 },{...env(),ENABLE_NATIVE_EXPERIMENTAL_FORECAST:'true'});
 expect(response.status).toBe(409);
 expect(await response.json()).toEqual({error:'worker native forecast generation is enabled'});
 expect(sqlite.prepare('SELECT COUNT(*) n FROM experimental_ticket_predictions').get()).toEqual(before);
});

it('keeps the experimental trifecta model and performance ledger separate from normal models',async()=>{
 const normalBefore=Number((await (await app.request('/api/performance/overview',{},env())).json() as any).betCount);
 const modelId='boat-trifecta-exp-fixture',artifactSha='d'.repeat(64),trainedAt=jstIso(Date.now()-60_000);
 const metadata={id:modelId,status:'candidate',trainingMode:'experimental',experimentalOnly:true,sport:'boat',betType:'trifecta',featureColumns:['lane_exhibition_time'],
  boatFeatureSchemaVersion:'boat-prerace-v2-no-weather-experimental-v1',ticketModelSchemaVersion:'ticket-selection-v1',
  ticketPredictionSemantics:'exact-selection-probability-v1',ticketBetType:'trifecta',ticketArtifactSha256:artifactSha,trainedAt,
  trainingEvidence:{trainingRaceCount:2,sourceArrivalVerifiedRaceCount:2,verifiedT60CutoffRaceCount:2,sixFreshExhibitionRaceCount:2,complete120T60OddsRaceCount:2,consistentPayoutRaceCount:2,raceIdSetSha256:'e'.repeat(64)},
  metrics:{independentValidationPerformed:false,evaluationQualified:false,promotionEligible:false,profitabilityProven:false,pointInTimeEvidenceComplete:true}};
 const metadataJson=JSON.stringify(metadata,null,2)+'\n',metadataSha=createHash('sha256').update(metadataJson,'utf8').digest('hex');
 const manifest={schema:'edgelab-experimental-trifecta-artifact-v1',modelId,trainingMode:'experimental',experimentalOnly:true,
  boatFeatureSchemaVersion:'boat-prerace-v2-no-weather-experimental-v1',trainingRaceIdSetSha256:'e'.repeat(64),
  files:{[`${modelId}.pkl`]:{sha256:artifactSha,sizeBytes:100},[`${modelId}.json`]:{sha256:metadataSha,sizeBytes:Buffer.byteLength(metadataJson)}}};
 const manifestSha256=sha256Json(manifest);
 const post=()=>app.request('/api/ingest/experimental-trifecta/model',{method:'POST',headers:{Authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify({manifest,manifestSha256,metadataJson})},env());
 expect((await post()).status).toBe(200);
 expect((await post()).status).toBe(200);
 expect(sqlite.prepare('SELECT status,training_mode,artifact_sha256 FROM experimental_models WHERE id=?').get(modelId)).toMatchObject({status:'candidate',training_mode:'experimental',artifact_sha256:artifactSha});
 const performance=await app.request('/api/performance/experimental',{},env());
 expect(performance.status).toBe(200);expect(await performance.json()).toMatchObject({state:'ready',experimentKey:'boat-trifecta-small-sample-v1',bankroll:{initial:100000,available:100000},sizing:{perRaceCombinedCap:1000,dailyCap:null}});
 const normal=await app.request('/api/performance/overview',{},env());expect(((await normal.json()) as any).betCount).toBe(normalBefore);
});

it('lists placed experimental paper tickets separately from ordinary bet history and metrics',async()=>{
 const placedRace='boat-20990101-99-41',abstainedRace='boat-20990101-99-42',voidRace='boat-20990101-99-43',modelId='boat-trifecta-history-fixture',artifactSha='a'.repeat(64);
 addValidatedTrifectaFixture(placedRace,'history-normal-fixture');
 addValidatedTrifectaFixture(abstainedRace,'history-abstained-fixture');
 addValidatedTrifectaFixture(voidRace,'history-void-fixture');
 const artifactManifest={schema:'edgelab-experimental-trifecta-artifact-v1',modelId,trainingMode:'experimental',experimentalOnly:true,
  files:{[`${modelId}.pkl`]:{sha256:artifactSha}}};
 const metadata={experimentalOnly:true,trainingMode:'experimental',status:'candidate',
  boatFeatureSchemaVersion:'boat-prerace-v2-no-weather-experimental-v1',ticketBetType:'trifecta',ticketArtifactSha256:artifactSha};
 sqlite.prepare(`INSERT INTO experimental_models(id,status,manifest_schema,sport,bet_type,training_mode,schema_version,artifact_sha256,manifest_sha256,metadata_sha256,trained_at,artifact_manifest_json,manifest_json,registered_at)
  VALUES(?,'candidate','edgelab-experimental-trifecta-artifact-v1','boat','trifecta','experimental','boat-prerace-v2-no-weather-experimental-v1',?,?,?,?,?,?,?)`)
  .run(modelId,artifactSha,'b'.repeat(64),'c'.repeat(64),jstIso(Date.now()-60_000),JSON.stringify(artifactManifest),JSON.stringify(metadata),jstIso());
 const placedDecision='history-placed-decision',abstainedDecision='history-abstained-decision',voidDecision='history-void-decision',placedAt=jstIso(Date.now()-2_000),voidPlacedAt=jstIso(Date.now()-1_000),settledAt=jstIso(Date.now()-500);
 sqlite.prepare(`INSERT INTO experimental_paper_decisions(id,experiment_key,race_id,model_id,decision_at,outcome,total_stake,sizing_method,snapshot_json)
  VALUES(?,'boat-trifecta-small-sample-v1',?,?,?,'placed',200,'fractional-kelly-portfolio','{}'),
        (?,'boat-trifecta-small-sample-v1',?,?,?,'abstained',0,'fractional-kelly-portfolio','{}'),
        (?,'boat-trifecta-small-sample-v1',?,?,?,'placed',100,'fractional-kelly-portfolio','{}')`)
  .run(placedDecision,placedRace,modelId,placedAt,abstainedDecision,abstainedRace,modelId,placedAt,voidDecision,voidRace,modelId,voidPlacedAt);
 const insertTicket=sqlite.prepare(`INSERT INTO experimental_paper_bets(id,decision_id,race_id,model_id,selection,stake,probability,prob_std,odds_at_bet,expected_roi,placed_at,status,payout,profit,settled_at,data_origin)
  VALUES(?,?,?,?,?,?,?,0.01,20,1,?,?,?, ?,?,'real')`);
 insertTicket.run('history-exp-1',placedDecision,placedRace,modelId,'1-2-3',100,0.2,placedAt,'won',500,400,settledAt);
 insertTicket.run('history-exp-2',placedDecision,placedRace,modelId,'1-3-2',100,0.1,placedAt,'open',null,null,null);
 insertTicket.run('history-exp-void',voidDecision,voidRace,modelId,'2-3-4',100,0.05,voidPlacedAt,'open',null,null,null);
 sqlite.prepare(`INSERT INTO experimental_paper_bet_reconciliations(bet_id,experiment_key,original_stake,refund_amount,repair_reason,repaired_at,refund_applied_at)
  VALUES(?,'boat-trifecta-small-sample-v1',100,100,'invalid_stake_unit',?,?)`)
  .run('history-exp-2',settledAt,settledAt);
 sqlite.prepare(`INSERT INTO experimental_paper_bet_reconciliations(bet_id,experiment_key,original_stake,refund_amount,repair_reason,repaired_at,refund_applied_at)
  VALUES(?,'boat-trifecta-small-sample-v1',100,100,'invalid_stake_unit',?,?)`).run('history-exp-void',settledAt,settledAt);
 sqlite.prepare("INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,1,1,'real'),(?,2,2,'real'),(?,3,3,'real')").run(placedRace,placedRace,placedRace);
 sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,data_origin) VALUES(?,'trifecta','1-2-3',500,'real')").run(placedRace);
 const normalBefore=Number(((await (await app.request('/api/performance/overview',{},env())).json()) as any).betCount);

 const response=await app.request('/api/bets/experimental',{},env());
 expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
 const rows=await response.json() as any[];
 expect(rows).toHaveLength(3);
 expect(rows[0]).toMatchObject({id:'history-exp-void',recordKind:'experimental_paper',decisionId:voidDecision,status:'void',payout:100,profit:0,repairReason:'invalid_stake_unit'});
 expect(rows.find(row=>row.id==='history-exp-2')).toEqual({id:'history-exp-2',recordKind:'experimental_paper',experimentKey:'boat-trifecta-small-sample-v1',decisionId:placedDecision,
  raceId:placedRace,sport:'boat',betType:'trifecta',selection:'1-3-2',stake:100,predictedProb:0.1,probabilityStd:0.01,oddsAtBet:20,expectedRoi:1,
  modelId,placedAt,status:'void',payout:100,profit:0,settledAt,repairReason:'invalid_stake_unit',dataOrigin:'real',venueName:'Ticket fixture',raceNo:41,raceDate:'2099-01-01',finalOdds:null,officialSelection:'1-2-3'});
 expect(rows.find(row=>row.id==='history-exp-1')).toMatchObject({id:'history-exp-1',recordKind:'experimental_paper',status:'won',payout:500,profit:400,settledAt,
  raceId:placedRace,raceNo:41,raceDate:'2099-01-01',finalOdds:5});
 expect(rows.find(row=>row.id==='history-exp-2')).not.toHaveProperty('edgeLabel');expect(rows.find(row=>row.id==='history-exp-2').finalOdds).toBeNull();
 // A losing ticket, even with an inconsistent matching payout row, has no confirmed odds.
 sqlite.prepare("UPDATE experimental_paper_bets SET status='lost' WHERE id='history-exp-1'").run();
 const lostRows=await (await app.request('/api/bets/experimental',{},env())).json() as any[];
 expect(lostRows.find(row=>row.id==='history-exp-1').finalOdds).toBeNull();
 sqlite.prepare("UPDATE experimental_paper_bets SET status='won' WHERE id='history-exp-1'").run();
 // Results must agree with the payout selection; a payout alone is not sufficient.
 sqlite.prepare("UPDATE results SET number=4 WHERE race_id=? AND number=1").run(placedRace);
 const mismatchRows=await (await app.request('/api/bets/experimental',{},env())).json() as any[];
 expect(mismatchRows.find(row=>row.id==='history-exp-1').finalOdds).toBeNull();
 sqlite.prepare("UPDATE results SET number=1 WHERE race_id=? AND number=4").run(placedRace);
 expect(rows.some(row=>row.raceId===abstainedRace)).toBe(false);
 const ordinary=await app.request('/api/bets?origin=all',{},env());
 expect((await ordinary.json() as any[]).some(row=>String(row.id).startsWith('history-exp-'))).toBe(false);
 const normalAfter=Number(((await (await app.request('/api/performance/overview',{},env())).json()) as any).betCount);
 expect(normalAfter).toBe(normalBefore);
 const experimentalPerformance=await app.request('/api/performance/experimental',{},env());
 const experimentBody=await experimentalPerformance.json() as any;
 expect(experimentBody.metrics).toMatchObject({races:1,bets:1,stake:100,payout:500,profit:400});
 expect(experimentBody.decisions.find((row:any)=>row.raceId===placedRace)).toMatchObject({outcome:'placed',stake:100,probability:0.2});
 expect(experimentBody.decisions.find((row:any)=>row.raceId===voidRace)).toMatchObject({outcome:'void',reason:'invalid_stake_unit',stake:0,probability:null,odds:null});

 // The combined overview is SQL-aggregated, not limited by the ticket-history endpoint's 500-row cap.
 const insertNormal=sqlite.prepare(`INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,placed_at,status,payout,profit,settled_at,data_origin,edge_label)
   VALUES(?,?,'boat','trifecta',?,100,'manual',?,?,?, ?,?,'real','INSUFFICIENT_DATA')`);
 for(let i=0;i<501;i++)insertNormal.run(`aggregate-normal-${i}`,placedRace,`1-${i}-3`,new Date(Date.now()-10_000+i).toISOString(),i<497?'lost':'open',i<497?0:null,i<497?-100:null,i<497?settledAt:null);
 sqlite.prepare('UPDATE experimental_paper_bets SET settled_at=? WHERE id=?').run(new Date(Date.now()+10_000).toISOString(),'history-exp-1');
 const scoped=await (await app.request('/api/performance/overview?origin=real&sport=boat&scope=purchase-history',{},env())).json() as any;
 expect(scoped).toMatchObject({betCount:502,settledCount:498,totalProfit:-49300,roi:500/49800,maxDrawdown:49700,maxDrawdownPct:0.497});
 expect(scoped.equityCurve).toHaveLength(499);
 const ordinaryOnly=await (await app.request('/api/performance/overview?origin=real&sport=boat',{},env())).json() as any;
 expect(ordinaryOnly).toMatchObject({betCount:501,totalProfit:-49700});
});

it('settles only fully evidenced experimental trifecta outcomes and credits the separate bankroll',async()=>{
 const raceId='boat-20990101-99-01',modelId='boat-trifecta-settlement-fixture';
 addValidatedTrifectaFixture(raceId,'normal-fixture-for-experimental-settlement');
 sqlite.prepare("UPDATE races SET status='finished' WHERE id=?").run(raceId);
 const artifactSha='f'.repeat(64),raceSetSha='e'.repeat(64),trainedAt=jstIso(Date.now()-60_000);
 const metadata={id:modelId,status:'candidate',trainingMode:'experimental',experimentalOnly:true,sport:'boat',betType:'trifecta',
  boatFeatureSchemaVersion:'boat-prerace-v2-no-weather-experimental-v1',ticketArtifactSha256:artifactSha};
 const manifest={schema:'edgelab-experimental-trifecta-artifact-v1',modelId,trainingMode:'experimental',experimentalOnly:true,
  boatFeatureSchemaVersion:'boat-prerace-v2-no-weather-experimental-v1',trainingRaceIdSetSha256:raceSetSha,
  files:{[`${modelId}.pkl`]:{sha256:artifactSha},[`${modelId}.json`]:{sha256:'a'.repeat(64)}}};
 sqlite.prepare(`INSERT INTO experimental_models(id,status,manifest_schema,sport,bet_type,training_mode,schema_version,artifact_sha256,manifest_sha256,metadata_sha256,trained_at,artifact_manifest_json,manifest_json,registered_at)
  VALUES(?,'candidate','edgelab-experimental-trifecta-artifact-v1','boat','trifecta','experimental','boat-prerace-v2-no-weather-experimental-v1',?,?,?,?,?,?,?)`)
  .run(modelId,artifactSha,'b'.repeat(64),'a'.repeat(64),trainedAt,JSON.stringify(manifest),JSON.stringify(metadata),jstIso());
 sqlite.prepare('UPDATE experimental_bankroll SET available_balance=99800 WHERE experiment_key=?').run('boat-trifecta-small-sample-v1');
 sqlite.prepare(`INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,?,?,'real')`).run(raceId,1,1);
 for(let n=2;n<=6;n++)sqlite.prepare(`INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,?,?,'real')`).run(raceId,n,n);
 sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,data_origin) VALUES(?,'trifecta','1-2-3',1000,'real')").run(raceId);
 const decisionId='exp-settlement-decision';sqlite.prepare(`INSERT INTO experimental_paper_decisions(id,experiment_key,race_id,model_id,decision_at,outcome,total_stake,sizing_method,snapshot_json)
  VALUES(?,'boat-trifecta-small-sample-v1',?,?,?,'placed',200,'fractional-kelly-portfolio','{}')`).run(decisionId,raceId,modelId,jstIso());
 const bet=sqlite.prepare(`INSERT INTO experimental_paper_bets(id,decision_id,race_id,model_id,selection,stake,probability,prob_std,odds_at_bet,expected_roi,placed_at,status,data_origin)
  VALUES(?,?,?,?,?, ?,0.2,0.01,20,1,?,'open','real')`);
 bet.run('exp-win',decisionId,raceId,modelId,'1-2-3',100,jstIso());bet.run('exp-loss',decisionId,raceId,modelId,'4-5-6',100,jstIso());
 sqlite.prepare(`INSERT INTO experimental_paper_bet_reconciliations(bet_id,experiment_key,original_stake,refund_amount,repair_reason,repaired_at,refund_applied_at)
  VALUES(?,'boat-trifecta-small-sample-v1',100,100,'invalid_stake_unit',?,?)`).run('exp-loss',jstIso(),jstIso());
 expect(await settleOpen(DB)).toBe(1);
 expect(sqlite.prepare('SELECT status,payout,profit FROM experimental_paper_bets WHERE id=?').get('exp-win')).toMatchObject({status:'won',payout:1000,profit:900});
 expect(sqlite.prepare('SELECT status,payout,profit FROM experimental_paper_bets WHERE id=?').get('exp-loss')).toMatchObject({status:'open',payout:null,profit:null});
 expect(sqlite.prepare('SELECT available_balance FROM experimental_bankroll WHERE experiment_key=?').get('boat-trifecta-small-sample-v1')).toMatchObject({available_balance:100800});
});

it('admits an experimental portfolio only with live-cutoff archive and full source odds',async()=>{
 const at=Date.now(),raceDate=jstDate(new Date(at)),raceId=`boat-${raceDate.replaceAll('-','')}-99-01`,modelId='boat-trifecta-forecast-fixture';
 sqlite.prepare("INSERT OR IGNORE INTO venues(id,sport,name) VALUES('99','boat','Experimental source fixture')").run();
 sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at,betting_cutoff_at,betting_cutoff_source,betting_cutoff_observed_at)
  VALUES(?,'boat','99',?,1,?,'scheduled','real',? ,?,'boatrace-racelist-cutoff-v1',?)`).run(raceId,raceDate,jstIso(at+180_000),jstIso(at),jstIso(at+60_000),jstIso(at-1_000));
 for(let n=0;n<24;n++)sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at,betting_cutoff_at,betting_cutoff_source,betting_cutoff_observed_at)
  VALUES(?,'boat','99',?,? ,?,'scheduled','real',?,?, 'boatrace-racelist-cutoff-v1',?)`).run(`${raceId}-past-${n}`,raceDate,n+2,jstIso(at-60_000),jstIso(at-180_000),jstIso(at-120_000+n*1000),jstIso(at-120_000));
 for(let n=1;n<=6;n++)sqlite.prepare("INSERT INTO entries(id,race_id,number,name,available_at,features_json,data_origin) VALUES(?,?,?,?,?,?,'real')").run(`${raceId}-e${n}`,raceId,n,`Boat ${n}`,jstIso(at-60_000),JSON.stringify({racer_id:String(1000+n)}));
 const selections:string[]=[];for(let a=1;a<=6;a++)for(let b=1;b<=6;b++)for(let d=1;d<=6;d++)if(a!==b&&a!==d&&b!==d)selections.push(`${a}-${b}-${d}`);
 const archive={schema:'boat-prerace-capture-v1',race:{id:raceId,date:raceDate,venueCode:'99',raceNo:1,lanes:[1,2,3,4,5,6]},capturedAt:jstIso(at-2_000),archivedAt:jstIso(at),
  beforeinfo:{url:'https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd='+raceDate.replaceAll('-','')+'&jcd=99&rno=1',sha256:'1'.repeat(64),capturedAt:jstIso(at-2_000),exhibitions:Array.from({length:6},(_,i)=>({lane:i+1,exhibitionTime:6.8+i/10}))},
  raceList:{url:'https://www.boatrace.jp/owpc/pc/race/racelist?hd='+raceDate.replaceAll('-','')+'&jcd=99&rno=1',sha256:'2'.repeat(64),capturedAt:jstIso(at-2_000),cutoffAt:jstIso(at+60_000),entries:Array.from({length:6},(_,i)=>({lane:i+1,registrationNumber:String(1001+i)}))},
  trifectaOdds:{url:`https://www.boatrace.jp/owpc/pc/race/odds3t?hd=${raceDate.replaceAll('-','')}&jcd=99&rno=1`,sha256:'3'.repeat(64),capturedAt:jstIso(at-2_000),qualityStatus:'verified-complete-v1',final:false,odds:selections.map(selection=>({selection,odds:200}))}};
 const archiveId=`${raceId}:capture:${at-2000}`;
 sqlite.prepare("INSERT INTO boatrace_prerace_capture_archives(id,race_id,race_date,captured_at,archive_json,data_origin) VALUES(?,?,?,?,?,'real')").run(archiveId,raceId,raceDate,jstIso(at-2_000),JSON.stringify(archive));
 // A later capture must not replace the source snapshot that existed at prediction time.
 const laterArchive={...archive,capturedAt:jstIso(at+2_000)};
 sqlite.prepare("INSERT INTO boatrace_prerace_capture_archives(id,race_id,race_date,captured_at,archive_json,data_origin) VALUES(?,?,?,?,?,'real')").run(`${raceId}:capture:${at+2_000}`,raceId,raceDate,jstIso(at+2_000),JSON.stringify(laterArchive));
 const artifactSha='4'.repeat(64),trainedAt=jstIso(at-600_000),raceSetSha='5'.repeat(64);
 const metadata={id:modelId,status:'candidate',trainingMode:'experimental',experimentalOnly:true,sport:'boat',betType:'trifecta',featureColumns:['lane_exhibition_time'],
  boatFeatureSchemaVersion:'boat-prerace-v2-no-weather-experimental-v1',ticketModelSchemaVersion:'ticket-selection-v1',ticketPredictionSemantics:'exact-selection-probability-v1',ticketBetType:'trifecta',ticketArtifactSha256:artifactSha,trainedAt,
  trainingEvidence:{sourceArrivalVerifiedRaceCount:1,verifiedT60CutoffRaceCount:1,sixFreshExhibitionRaceCount:1,complete120T60OddsRaceCount:1,consistentPayoutRaceCount:1,raceIdSetSha256:raceSetSha},
  metrics:{independentValidationPerformed:false,evaluationQualified:false,promotionEligible:false,profitabilityProven:false,pointInTimeEvidenceComplete:true}};
 const metadataJson=JSON.stringify(metadata,null,2)+'\n',metadataSha=createHash('sha256').update(metadataJson,'utf8').digest('hex');
 const manifest={schema:'edgelab-experimental-trifecta-artifact-v1',modelId,trainingMode:'experimental',experimentalOnly:true,boatFeatureSchemaVersion:metadata.boatFeatureSchemaVersion,trainingRaceIdSetSha256:raceSetSha,
  files:{[`${modelId}.pkl`]:{sha256:artifactSha,sizeBytes:100},[`${modelId}.json`]:{sha256:metadataSha,sizeBytes:Buffer.byteLength(metadataJson)}}};
 const registration=await app.request('/api/ingest/experimental-trifecta/model',{method:'POST',headers:{Authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify({manifest,manifestSha256:sha256Json(manifest),metadataJson})},env());
 expect(registration.status).toBe(200);
 const forecast={schema:'edgelab-experimental-trifecta-forecast-v1',modelId,artifactSha256:artifactSha,trainingMode:'experimental',experimentalOnly:true,ticketModelSchemaVersion:'ticket-selection-v1',ticketPredictionSemantics:'exact-selection-probability-v1',boatFeatureSchemaVersion:metadata.boatFeatureSchemaVersion,
  races:[{raceId,predictedAt:jstIso(at),predictions:selections.map(selection=>({selection,probability:1/120,prob_std:0.001}))}]};
 const tooEarly={...forecast,races:[{...forecast.races[0],predictedAt:jstIso(at-5*60_000-1)}]};
 const tooEarlyResponse=await app.request('/api/ingest/experimental-trifecta/forecast',{method:'POST',headers:{Authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify(tooEarly)},env());
 expect(tooEarlyResponse.status).toBe(400);
 expect(await tooEarlyResponse.json()).toMatchObject({error:'experimental forecast is outside a verified pre-cutoff prediction window'});
 const decision=await app.request('/api/ingest/experimental-trifecta/forecast',{method:'POST',headers:{Authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify(forecast)},env());
 expect(decision.status).toBe(200);expect(await decision.json()).toMatchObject({stored:[{raceId,modelId,predictionCount:120}],decision:'worker T-60 timing gate'});
 expect(sqlite.prepare('SELECT COUNT(*) n FROM experimental_paper_bets WHERE race_id=?').get(raceId)).toMatchObject({n:0});
 sqlite.prepare('DELETE FROM experimental_ticket_predictions WHERE race_id=?').run(raceId);
 const outsideDecisionWindow=jstIso(at-5*60_000-1);
 for(const selection of selections)sqlite.prepare(`INSERT INTO experimental_ticket_predictions(id,race_id,model_id,selection,probability,prob_std,predicted_at,feature_schema_version,artifact_sha256,data_origin)
  VALUES(?,?,?,?,?, ?,?,'ticket-selection-v1',?,'real')`).run(`stale-${selection}`,raceId,modelId,selection,1/120,0.001,outsideDecisionWindow,artifactSha);
 const staleReport=await experimentalPaperDecision(DB,at+1_000);
 expect(staleReport).toMatchObject({evaluated:1,placedRaces:0,abstainedByReason:{experimental_forecast_missing_or_invalid:1}});
 sqlite.prepare('DELETE FROM experimental_paper_decisions WHERE race_id=?').run(raceId);
 sqlite.prepare('DELETE FROM experimental_ticket_predictions WHERE race_id=?').run(raceId);
 const restored=await app.request('/api/ingest/experimental-trifecta/forecast',{method:'POST',headers:{Authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify(forecast)},env());
 expect(restored.status).toBe(200);
 const multiRace={...forecast,races:[...forecast.races,...forecast.races]};
 expect((await app.request('/api/ingest/experimental-trifecta/forecast',{method:'POST',headers:{Authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify(multiRace)},env())).status).toBe(400);
 vi.spyOn(Date,'now').mockReturnValue(at+11_001);
 expect(await experimentalPaperDecision(DB,at+1_000)).toMatchObject({evaluated:1,placedRaces:0});
 expect(sqlite.prepare('SELECT COUNT(*) n FROM experimental_paper_decisions WHERE race_id=?').get(raceId)).toMatchObject({n:0});
 vi.restoreAllMocks();
 // This fixture yields an approximately 22-yen portfolio budget at this
 // balance; the decision must abstain rather than place an invalid ticket.
 sqlite.prepare('UPDATE experimental_bankroll SET available_balance=535 WHERE experiment_key=?').run('boat-trifecta-small-sample-v1');
 const belowMinimum=await experimentalPaperDecision(DB,at+1_000);
 expect(belowMinimum).toMatchObject({evaluated:1,placedRaces:0,placedBets:0,abstainedByReason:{minimum_virtual_stake_not_reached:1}});
 expect(sqlite.prepare('SELECT total_stake,outcome,reason FROM experimental_paper_decisions WHERE race_id=?').get(raceId))
  .toMatchObject({total_stake:0,outcome:'abstained',reason:'minimum_virtual_stake_not_reached'});
 expect(sqlite.prepare('SELECT COUNT(*) n FROM experimental_paper_bets WHERE race_id=?').get(raceId)).toMatchObject({n:0});
 sqlite.prepare('DELETE FROM experimental_paper_decisions WHERE race_id=?').run(raceId);
 sqlite.prepare('UPDATE experimental_bankroll SET available_balance=100000 WHERE experiment_key=?').run('boat-trifecta-small-sample-v1');
 const report=await experimentalPaperDecision(DB,at+1_000);
 expect(report).toMatchObject({evaluated:1,placedRaces:1});
 const result:any=sqlite.prepare('SELECT total_stake FROM experimental_paper_decisions WHERE race_id=?').get(raceId);
 expect(Number(result.total_stake)).toBeGreaterThan(0);expect(Number(result.total_stake)).toBeLessThanOrEqual(1000);
 expect(sqlite.prepare('SELECT available_balance FROM experimental_bankroll WHERE experiment_key=?').get('boat-trifecta-small-sample-v1')).toMatchObject({available_balance:100000-Number(result.total_stake)});
 expect(sqlite.prepare('SELECT COUNT(*) n FROM experimental_ticket_predictions WHERE race_id=?').get(raceId)).toMatchObject({n:120});
 expect(sqlite.prepare('SELECT SUM(stake) stake FROM experimental_paper_bets WHERE race_id=?').get(raceId)).toMatchObject({stake:result.total_stake});
 const placedStakes=sqlite.prepare('SELECT stake FROM experimental_paper_bets WHERE race_id=?').all(raceId) as Array<{stake:number}>;
 expect(placedStakes.every(x=>x.stake>=100&&x.stake%100===0)).toBe(true);
 const repeated=await app.request('/api/ingest/experimental-trifecta/forecast',{method:'POST',headers:{Authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify(forecast)},env());
 expect((await repeated.json() as any).stored).toHaveLength(1);
 expect(await experimentalPaperDecision(DB,at+1_000)).toMatchObject({evaluated:0,placedRaces:0});
 expect(sqlite.prepare('SELECT SUM(stake) stake FROM experimental_paper_bets WHERE race_id=?').get(raceId)).toMatchObject({stake:result.total_stake});
});
