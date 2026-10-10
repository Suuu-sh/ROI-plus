import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { app, settleOpen, autoBet } from '../src/index.js';
import { D1SqliteAdapter } from './d1-adapter.js';

const root=resolve(import.meta.dirname,'../../..');
let sqlite: Sqlite.Database, DB: D1SqliteAdapter;
const env=(extra:Record<string,unknown>={})=>({DB,INGEST_TOKEN:'test-token',ENABLE_AUTO_BET:'true',...extra});
const jstIso=(ms=Date.now())=>new Date(ms+9*60*60*1000).toISOString().replace('Z','+09:00');
const jstDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const canonicalJson=(value:any):string=>Array.isArray(value)?`[${value.map(canonicalJson).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`:JSON.stringify(value)??'null';
const sha256Json=(value:unknown)=>createHash('sha256').update(canonicalJson(value),'utf8').digest('hex');
const sha256Text=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
beforeEach(()=>{
 sqlite=new Sqlite(':memory:'); DB=new D1SqliteAdapter(sqlite);
 for (const f of readdirSync(resolve(root,'db/migrations')).filter(f=>f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(resolve(root,'db/migrations',f),'utf8'));
 sqlite.exec(readFileSync(resolve(root,'db/seed/sample.sql'),'utf8'));
 sqlite.prepare("UPDATE models SET metrics_json=json_set(CASE WHEN json_valid(metrics_json) THEN metrics_json ELSE '{}' END,'$.boatFeatureSchemaVersion','boat-base-v1','$.boatArtifactSha256',?) WHERE id='boat-active'").run('a'.repeat(64));
 sqlite.prepare("UPDATE races SET post_time=? WHERE data_origin='sample' AND status='scheduled'").run(jstIso(Date.now()+60*60_000));
});
afterEach(()=>sqlite.close());
const addBetInputs=(raceId:string,prefix:string)=>{
 const entry=sqlite.prepare('SELECT number FROM entries WHERE race_id=? ORDER BY number LIMIT 1').get(raceId) as {number:number};
 sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES(?,?,'win',?,10,?,'test','sample')").run(`${prefix}-odds`,raceId,String(entry.number),jstIso(Date.now()-5000));
 sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES(?,?,'boat-active',?,0.5,0.01,?,'sample')").run(`${prefix}-prediction`,raceId,entry.number,jstIso(Date.now()-10000));
 return String(entry.number);
};
describe('EdgeLab API',()=>{
 it('health and date-filtered sample races respond',async()=>{
  expect((await app.request('/api/health',{},env())).status).toBe(200);
  // サンプルは生成日を「今日」として作られるため、シード内の最新日付を使う（実行日に依存させない）
  const today=(sqlite.prepare("SELECT MAX(race_date) d FROM races WHERE data_origin='sample'").get() as {d:string}).d;
  const r=await app.request(`/api/races?sport=horse&date=${today}&origin=sample`,{},env());
  expect(r.status).toBe(200); const rows=await r.json() as any[]; expect(rows.length).toBeGreaterThanOrEqual(12); expect(rows.every(x=>x.dataOrigin==='sample')).toBe(true);
 });
 it('ingest requires bearer and upserts idempotently',async()=>{
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('venue-99','boat','API fixture')").run();
  const race={id:'boat-20990101-99-01',sport:'boat',venue_id:'venue-99',race_date:'2099-01-01',race_no:1,status:'scheduled',data_origin:'real',updated_at:'2099-01-01T00:00:00Z'};
  const body=JSON.stringify([race]);
  expect((await app.request('/api/ingest/races',{method:'POST',headers:{'content-type':'application/json'},body},{DB,INGEST_TOKEN:'test-token'})).status).toBe(401);
  const req=()=>app.request('/api/ingest/races',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body},env());
  expect((await req()).status).toBe(200); expect((await req()).status).toBe(200);
  expect(sqlite.prepare('SELECT COUNT(*) n FROM races WHERE id=?').get(race.id)).toMatchObject({n:1});
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
 it('ingest preserves terminal races and manually managed model rows',async()=>{
  const post=(endpoint:string,body:unknown)=>app.request(`/api/ingest/${endpoint}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:JSON.stringify(body)},env());
  const race=sqlite.prepare("SELECT * FROM races WHERE data_origin='sample' AND status='finished' LIMIT 1").get() as any;
  expect((await post('races',[{...race,status:'scheduled'}])).status).toBe(200);
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
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('validation-o',?,'win',?,3,?,'test','sample')").run(race.id,String(entry.number),jstIso(Date.now()-5000));
  sqlite.prepare("UPDATE settings SET value='-1000000000' WHERE key='initial_bankroll'").run();
  expect((await post(body(race.id,100,String(entry.number)))).status).toBe(400);
 });
 it('manual bet snapshots prediction and odds; settlement uses 100 yen payout',async()=>{
  const race=sqlite.prepare("SELECT r.id FROM races r WHERE r.data_origin='sample' AND r.status='scheduled' AND r.sport='boat' LIMIT 1").get() as any;
  const entry=sqlite.prepare('SELECT number FROM entries WHERE race_id=? LIMIT 1').get(race.id) as any;
  sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES('test-p',?,'boat-active',?,0.4,0.01,?,'sample')").run(race.id,entry.number,jstIso(Date.now()-10000));
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('test-o',?,'win',?,3.0,?,'sample','sample')").run(race.id,String(entry.number),jstIso(Date.now()-5000));
  const resp=await app.request('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({raceId:race.id,betType:'win',selection:String(entry.number),stake:100})},env());
  expect(resp.status).toBe(201);const bet=await resp.json() as any;expect(bet.expectedRoi).toBeCloseTo(.2);
  sqlite.prepare("UPDATE races SET status='finished' WHERE id=?").run(race.id);
  const field=sqlite.prepare('SELECT number FROM entries WHERE race_id=? AND data_origin=\'sample\' ORDER BY number').all(race.id) as {number:number}[];
  for(const [i,runner] of field.entries())sqlite.prepare('INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,?,?,\'sample\')').run(race.id,i+1,runner.number);
  sqlite.prepare("INSERT INTO payouts(race_id,bet_type,selection,payout,popularity,data_origin) VALUES(?,'win',?,450,1,'sample')").run(race.id,String(entry.number));
  expect(await settleOpen(DB)).toBe(1);
  const settled=sqlite.prepare('SELECT * FROM bets WHERE id=?').get(bet.id) as any;expect(settled.status).toBe('won');expect(settled.payout).toBe(450);expect(settled.profit).toBe(350);expect(settled.final_odds).toBe(4.5);
 });
 it('auto bets reserve available bankroll and stop at the cap, including existing open stakes',async()=>{
  sqlite.exec('DELETE FROM bets');
  sqlite.prepare("UPDATE settings SET value='200' WHERE key='initial_bankroll'").run();
  const races=sqlite.prepare("SELECT id FROM races WHERE data_origin='sample' AND status='scheduled' AND sport='boat' LIMIT 2").all() as {id:string}[];
  expect(races).toHaveLength(2);
  for(const [i,race] of races.entries())addBetInputs(race.id,`auto-cap-${i}`);
  sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES('existing-open',?,'boat','win','99',100,'manual','INSUFFICIENT_DATA',?,'open','sample')").run(races[0].id,jstIso());

  expect(await autoBet(DB,true)).toBe(1);
  expect(await autoBet(DB,true)).toBe(0);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE mode='auto' AND status='open'").get()).toMatchObject({n:1});
  expect(sqlite.prepare("SELECT SUM(stake) stake FROM bets WHERE status='open'").get()).toMatchObject({stake:200});
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
 it('settles unmatched bets only after complete same-origin outcomes and winner payouts; cancelled bets are void',async()=>{
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
  expect(sqlite.prepare('SELECT status,payout,profit,final_odds FROM bets WHERE id=\'void-bet\'').get()).toMatchObject({status:'void',payout:0,profit:0,final_odds:null});
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
 it('auto-bets only once per race and promote/rollback exchange active model',async()=>{
  const race=sqlite.prepare("SELECT r.id FROM races r WHERE r.data_origin='sample' AND r.status='scheduled' AND r.sport='boat' LIMIT 1").get() as any;
  const first=sqlite.prepare('SELECT number FROM entries WHERE race_id=? LIMIT 1').get(race.id) as any;
  sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('auto-odds',?,'win',?,10,?,'sample','sample')").run(race.id,String(first.number),jstIso(Date.now()-5000));
  sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES('auto-p',?,'boat-active',?,0.5,0.01,?,'sample')").run(race.id,first.number,jstIso(Date.now()-10000));
  expect(await autoBet(DB,true)).toBeGreaterThan(0);expect(await autoBet(DB,true)).toBe(0);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM bets WHERE race_id=? AND mode='auto'").get(race.id)).toMatchObject({n:1});
  const model=sqlite.prepare("SELECT id FROM models WHERE sport='horse' AND status='candidate' LIMIT 1").get() as any;
  expect((await app.request(`/api/models/${model.id}/promote`,{method:'POST'},env())).status).toBe(200);
  expect((await app.request(`/api/models/${model.id}/rollback`,{method:'POST'},env())).status).toBe(200);
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
  const id=validation.candidateModelId, active=sqlite.prepare("SELECT * FROM models WHERE id='boat-active'").get() as any;
  const metrics={promotionEligible:false,promotionReason:'initial baseline requires a separate human decision',
    initialBaselineEligible:true,initialBaselineReason:null,initialBaselineValidation:validation,
    boatFeatureSchemaVersion:'boat-base-v1',boatArtifactSha256:validation.artifact.pickleSha256};
  sqlite.prepare("INSERT INTO models(id,sport,bet_type,version,algorithm,status,train_from,train_to,valid_from,valid_to,test_from,test_to,n_train,metrics_json,trained_at,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id,'boat','win',validation.artifact.version,'fixture','candidate','2026-01-01','2026-03-11','2026-03-12','2026-03-26','2026-03-27','2026-04-10',2100,JSON.stringify(metrics),validation.validatedAt,'synthetic validation fixture');
  validation.candidateRegistryIdentity={id,version:validation.artifact.version,status:'candidate'};
  validation.activeModelSnapshot.models=sqlite.prepare("SELECT id,version,status,metrics_json FROM models WHERE sport='boat' AND bet_type='win' AND id<>? ORDER BY id,version,status").all(id).map((m:any)=>({id:m.id,version:m.version,status:m.status,metricsSha256:sha256Text(m.metrics_json??''),artifactCompatibility:'incompatible'}));
  validation.activeModelSnapshot.snapshotSha256=sha256Json(validation.activeModelSnapshot.models);
  const fingerprintPayload={...validation}; delete fingerprintPayload.fingerprint; delete fingerprintPayload.validatedAt;
  delete fingerprintPayload.initialBaselineEligible; delete fingerprintPayload.initialBaselineReason;
  validation.fingerprint=sha256Json(fingerprintPayload); metrics.initialBaselineValidation=validation;
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
  sqlite.prepare("UPDATE models SET metrics_json=json_set('{}','$.boatFeatureSchemaVersion','boat-base-v1','$.boatArtifactSha256',?) WHERE id='boat-active'").run('a'.repeat(64));
  const all=await (await app.request('/api/performance/breakdown?origin=sample',{},env())).json() as any;
  const n=all.calibration.reduce((a:number,x:any)=>a+x.count,0);
  const finished=sqlite.prepare("SELECT COUNT(*) n FROM predictions p JOIN races race ON race.id=p.race_id AND race.data_origin=p.data_origin JOIN models m ON m.id=p.model_id AND m.sport=race.sport AND m.bet_type='win' AND (race.sport<>'boat' OR (json_extract(m.metrics_json,'$.boatFeatureSchemaVersion')='boat-base-v1' AND length(json_extract(m.metrics_json,'$.boatArtifactSha256'))=64 AND json_extract(m.metrics_json,'$.boatArtifactSha256') NOT GLOB '*[^a-f0-9]*')) JOIN results r ON r.race_id=p.race_id AND r.number=p.number AND r.data_origin=race.data_origin WHERE race.data_origin='sample' AND race.status='finished' AND race.post_time IS NOT NULL AND julianday(p.predicted_at)<=julianday(race.post_time) AND p.predicted_at=(SELECT p2.predicted_at FROM predictions p2 WHERE p2.race_id=p.race_id AND p2.model_id=p.model_id AND p2.number=p.number AND p2.data_origin=race.data_origin AND julianday(p2.predicted_at)<=julianday(race.post_time) ORDER BY julianday(p2.predicted_at) DESC LIMIT 1)").get() as {n:number};
  expect(n).toBe(finished.n);
 });
 it('accepts dead heats and wide payouts from real data',async()=>{
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('09','boat','津')").run();
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at) VALUES('boat-20990101-09-01','boat','09','2099-01-01',1,'scheduled','real','x')").run();
  const post=(e:string,b:unknown)=>app.request(`/api/ingest/${e}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:JSON.stringify(b)},env());
  expect((await post('results',[{race_id:'boat-20990101-09-01',finish_order:1,number:1,data_origin:'real'},{race_id:'boat-20990101-09-01',finish_order:1,number:2,data_origin:'real'}])).status).toBe(200);
  expect((await post('payouts',[{race_id:'boat-20990101-09-01',bet_type:'wide',selection:'1-2',payout:150,data_origin:'real'}])).status).toBe(200);
  expect((await post('races',[{id:'boat-20990101-09-02',sport:'boat',venue_id:'09',race_date:'2099-01-01',race_no:2,status:'scheduled',data_origin:'real'}])).status).toBe(200);
 });
 it('requires the proxy header for read APIs when PROXY_TOKEN is set',async()=>{
  const e={...env(),PROXY_TOKEN:'p'};
  expect((await app.request('/api/models',{},e)).status).toBe(403);
  expect((await app.request('/api/models',{headers:{'X-ROI-Proxy':'p'}},e)).status).toBe(200);
  expect((await app.request('/api/health',{},e)).status).toBe(200);
  expect((await app.request('/api/ingest/venues',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-token'},body:'[]'},e)).status).toBe(200);
 });
 it('collection source is disabled when its latest run was skipped',async()=>{
  sqlite.prepare("INSERT INTO collection_runs(id,source,sport,target_date,started_at,status,records) VALUES('run-success','boat-official','boat','2099-01-01','2099-01-01T00:00:00Z','success',10)").run();
  sqlite.prepare("INSERT INTO collection_runs(id,source,sport,target_date,started_at,status,records) VALUES('run-skipped','boat-official','boat','2099-01-01','2099-01-02T00:00:00Z','skipped',0)").run();
  const response=await app.request('/api/collection/status',{},env());
  const result=await response.json() as any;
  expect(result.sources.find((x:any)=>x.source==='boat-official').enabled).toBe(false);
 });
});
