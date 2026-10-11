import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { app, settleOpen, autoBet, autoBetWithReport, recordPaperAbstention, cron } from '../src/index.js';
import { D1SqliteAdapter } from './d1-adapter.js';
import { payoutYen, settleValues } from '../src/services/logic.js';
import { readWriteBudget, reserveWriteBudget } from '../src/services/writeBudget.js';

const root=resolve(import.meta.dirname,'../../..');
let sqlite: Sqlite.Database, DB: D1SqliteAdapter;
const env=(extra:Record<string,unknown>={})=>({DB,INGEST_TOKEN:'test-token',ENABLE_AUTO_BET:'true',...extra});
const jstIso=(ms=Date.now())=>new Date(ms+9*60*60*1000).toISOString().replace('Z','+09:00');
const jstDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const setPaperCutoff=(raceId:string,decisionAt:number)=>sqlite.prepare('UPDATE races SET race_date=?,post_time=?,betting_cutoff_at=?,betting_cutoff_source=?,betting_cutoff_observed_at=? WHERE id=?').run(jstDate(),jstIso(decisionAt+240_000),jstIso(decisionAt+60_000),'boatrace-racelist-cutoff-v1',jstIso(decisionAt-30_000),raceId);
const canonicalJson=(value:any):string=>Array.isArray(value)?`[${value.map(canonicalJson).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`:JSON.stringify(value)??'null';
const sha256Json=(value:unknown)=>createHash('sha256').update(canonicalJson(value),'utf8').digest('hex');
const sha256Text=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
beforeEach(()=>{
 sqlite=new Sqlite(':memory:'); DB=new D1SqliteAdapter(sqlite);
 for (const f of readdirSync(resolve(root,'db/migrations')).filter(f=>f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(resolve(root,'db/migrations',f),'utf8'));
 sqlite.prepare("INSERT INTO settings(key,value) VALUES('roi_d1_write_budget_utc',?)").run(JSON.stringify({date:new Date().toISOString().slice(0,10),reserved:0,oddsReserved:0}));
 sqlite.exec(readFileSync(resolve(root,'db/seed/sample.sql'),'utf8'));
 sqlite.prepare("UPDATE models SET metrics_json=json_set(CASE WHEN json_valid(metrics_json) THEN metrics_json ELSE '{}' END,'$.boatVenueSchemaVersion','boat-venue-v2','$.correctedTrainingDataSha256',?,'$.boatArtifactSha256',?) WHERE id='boat-active'").run('f'.repeat(64),'a'.repeat(64));
 sqlite.prepare("UPDATE races SET post_time=? WHERE data_origin='sample' AND status='scheduled'").run(jstIso(Date.now()+60*60_000));
});
afterEach(()=>{vi.unstubAllGlobals();sqlite.close();});
const addBetInputs=(raceId:string,prefix:string)=>{
 const entry=sqlite.prepare('SELECT number FROM entries WHERE race_id=? ORDER BY number LIMIT 1').get(raceId) as {number:number};
 sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES(?,?,'win',?,10,?,'test','sample')").run(`${prefix}-odds`,raceId,String(entry.number),jstIso(Date.now()-5000));
 sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES(?,?,'boat-active',?,0.5,0.01,?,'sample')").run(`${prefix}-prediction`,raceId,entry.number,jstIso(Date.now()-10000));
 return String(entry.number);
};
const addValidatedTrifectaFixture=(raceId='boat-20990101-99-01',modelId='boat-trifecta-validated')=>{
 const artifactSha256='b'.repeat(64);
 const metrics={ticketModelSchemaVersion:'ticket-selection-v1',ticketPredictionSemantics:'exact-selection-probability-v1',ticketBetType:'trifecta',ticketArtifactSha256:artifactSha256,promotionEligible:true,
  ticketValidation:{status:'independently_validated',independentReviewId:'offline-ticket-audit-1',policyVersion:'ticket-selection-v1',betType:'trifecta',artifactSha256,reportSha256:'c'.repeat(64),dataOrigin:'real',completeCombinationCoverage:true,probabilitiesNormalized:true,outOfSampleValidated:true,pointInTimeSafe:true,validatedAt:jstIso()}};
 sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('99','boat','Ticket fixture')").run();
 sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at) VALUES(?,'boat','99','2099-01-01',1,?,'scheduled','real',?)").run(raceId,jstIso(Date.now()+60*60_000),jstIso());
 const numbers=[1,2,3,4,5,6];
 for(const number of numbers)sqlite.prepare("INSERT INTO entries(id,race_id,number,name,available_at,data_origin) VALUES(?,?,?,? ,?,'real')").run(`${raceId}-${number}`,raceId,number,`Runner ${number}`,jstIso(Date.now()-60_000));
 sqlite.prepare("INSERT INTO models(id,sport,bet_type,version,algorithm,status,metrics_json,trained_at) VALUES(?,'boat','trifecta','v1','fixture','active',?,?)").run(modelId,JSON.stringify(metrics),jstIso(Date.now()-60_000));
 const oddsUrl='https://www.boatrace.jp/owpc/pc/race/odds3t?hd=20990101&jcd=99&rno=1',capturedAt=jstIso(Date.now()-5000),predictedAt=jstIso(Date.now()-10_000),sha='d'.repeat(64);
 const selections:string[]=[];
 for(const a of numbers)for(const b of numbers)for(const c of numbers)if(a!==b&&a!==c&&b!==c)selections.push(`${a}-${b}-${c}`);
 for(let i=0;i<selections.length;i++){
  const selection=selections[i];
  sqlite.prepare("INSERT INTO ticket_predictions(id,race_id,model_id,bet_type,selection,probability,prob_std,predicted_at,data_origin,feature_schema_version,artifact_sha256) VALUES(?,?,?,'trifecta',?,?,0.001,?,'real','ticket-selection-v1',?)").run(`tp-${i}`,raceId,modelId,selection,1/120,predictedAt,artifactSha256);
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin,source_url,source_sha256,quality_status) VALUES(?,?,'trifecta',?,200,?,'boatrace-trifecta-official-v1','real',?,?,'verified-complete-v1')").run(`to-${i}`,raceId,selection,capturedAt,oddsUrl,sha);
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
 it('health and date-filtered sample races respond',async()=>{
  expect((await app.request('/api/health',{},env())).status).toBe(200);
  // サンプルは生成日を「今日」として作られるため、シード内の最新日付を使う（実行日に依存させない）
  const today=(sqlite.prepare("SELECT MAX(race_date) d FROM races WHERE data_origin='sample'").get() as {d:string}).d;
  const r=await app.request(`/api/races?sport=horse&date=${today}&origin=sample`,{},env());
  expect(r.status).toBe(200); const rows=await r.json() as any[]; expect(rows.length).toBeGreaterThanOrEqual(12); expect(rows.every(x=>x.dataOrigin==='sample')).toBe(true);
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
  expect(snapshot.pred