import Sqlite from 'better-sqlite3';
import { readdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { D1SqliteAdapter } from './d1-adapter.js';
import { collectResults,selectResultsTargets,RESULTS_SOURCE } from '../src/services/collectBoatraceResults.js';
import { boatraceResultPage } from './fixtures/boatraceResultPage.js';
import { finalTrifectaPage } from './fixtures/finalTrifectaPage.js';
import { beforeinfoUrl } from '../src/services/boatraceBeforeinfo.js';
import { raceListUrl } from '../src/services/boatraceRaceList.js';
import worker,{app,settleOpen} from '../src/index.js';
const root=resolve(import.meta.dirname,'../../..');
const now=new Date('2026-10-11T04:00:00Z'),raceDate='2026-10-11';
let sqlite:Sqlite.Database,DB:D1SqliteAdapter;
const id=(raceNo=1,venueCode='09')=>`boat-20261011-${venueCode}-${String(raceNo).padStart(2,'0')}`;
function seed(raceNo=1,origin='real',status='open',postTime='2026-10-11T03:00:00Z',venueCode='09') {
  const raceId=origin==='sample'?`sample-${id(raceNo,venueCode)}`:id(raceNo,venueCode);
  sqlite.prepare("INSERT OR IGNORE INTO venues(id,sport,name) VALUES(?,'boat',?)").run(venueCode,`Synthetic ${venueCode}`);
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at) VALUES(?,'boat',?,?,?,?,'scheduled',?,?)").run(raceId,venueCode,raceDate,raceNo,postTime,origin,now.toISOString());
  for(let number=1;number<=6;number++)sqlite.prepare("INSERT INTO entries(id,race_id,number,name,features_json,available_at,data_origin) VALUES(?,?,?,?,?,?,?)").run(`${raceId}-${number}`,raceId,number,`Synthetic ${number}`,JSON.stringify({racer_id:String(4000+number)}),'2026-10-10T23:00:00Z',origin);
  sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES(?,?,'boat','win','1',100,'manual','INSUFFICIENT_DATA','2026-10-11T02:00:00Z',?,?)").run(`${raceId}-bet`,raceId,status,origin);
  return raceId;
}
const page=(raceNo=1,venueCode='09')=>boatraceResultPage({raceDate,venueCode,raceNo});
const fetchPage=async(input:string)=>{const url=new URL(input);return new Response(page(Number(url.searchParams.get('rno')),url.searchParams.get('jcd')??'09'),{headers:{'content-type':'text/html; charset=utf-8'}})};
function seedT60Archive(raceNo=1){
  const raceId=seed(raceNo);sqlite.prepare('DELETE FROM bets WHERE race_id=?').run(raceId);
  const cutoff=new Date('2026-10-11T03:00:00Z').toISOString(),captured=new Date('2026-10-11T02:58:00Z').toISOString();
  sqlite.prepare("UPDATE races SET betting_cutoff_at=?,betting_cutoff_source='boatrace-racelist-cutoff-v1',betting_cutoff_observed_at=? WHERE id=?").run(cutoff,new Date('2026-10-11T02:57:00Z').toISOString(),raceId);
  const selections:string[]=[];for(let a=1;a<=6;a++)for(let b=1;b<=6;b++)for(let c=1;c<=6;c++)if(a!==b&&a!==c&&b!==c)selections.push(`${a}-${b}-${c}`);
  const archive={schema:'boat-prerace-capture-v1',race:{id:raceId,date:raceDate,venueCode:'09',raceNo,lanes:[1,2,3,4,5,6]},capturedAt:captured,
    beforeinfo:{url:beforeinfoUrl(raceNo,'09',raceDate),sha256:'1'.repeat(64),capturedAt:captured,exhibitions:Array.from({length:6},(_,i)=>({lane:i+1,exhibitionTime:6.8+i/10}))},
    raceList:{url:raceListUrl(raceNo,'09',raceDate),sha256:'2'.repeat(64),capturedAt:captured,cutoffAt:cutoff,entries:Array.from({length:6},(_,i)=>({lane:i+1,registrationNumber:String(4001+i)}))},
    trifectaOdds:{url:`https://www.boatrace.jp/owpc/pc/race/odds3t?hd=20261011&jcd=09&rno=${raceNo}`,sha256:'3'.repeat(64),capturedAt:captured,qualityStatus:'verified-complete-v1',final:false,odds:selections.map(selection=>({selection,odds:20}))}};
  sqlite.prepare("INSERT INTO boatrace_prerace_capture_archives(id,race_id,race_date,captured_at,archive_json,data_origin) VALUES(?,?,?,?,?,'real')").run(`${raceId}:capture:${Date.parse(captured)}`,raceId,raceDate,captured,JSON.stringify(archive));
  return raceId;
}
beforeEach(()=>{
  sqlite=new Sqlite(':memory:');DB=new D1SqliteAdapter(sqlite);
  for(const file of readdirSync(resolve(root,'db/migrations')).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(resolve(root,'db/migrations',file),'utf8'));
  sqlite.prepare("INSERT INTO settings(key,value) VALUES('roi_d1_write_budget_utc',?)").run(JSON.stringify({date:now.toISOString().slice(0,10),reserved:0,oddsReserved:0}));
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('09','boat','Synthetic')").run();
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();sqlite.close();});

describe('purchased real boat results',()=>{
  it('atomically records normal official results, evidence and existing settlement without modifying purchase snapshots',async()=>{
    seed();const requestBudget={used:48,max:49},pauses:number[]=[];
    const result=await collectResults(DB,now,{requestBudget,fetch:fetchPage,sleep:async ms=>{pauses.push(ms)}});
    expect(result).toMatchObject({status:'success',records:8,verified:1,targets:1,attempted:1});
    expect(requestBudget.used).toBe(49);expect(pauses).toEqual([3000]);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM results').get()).toMatchObject({n:6});
    const log=sqlite.prepare('SELECT source,reason FROM collection_runs').get() as {source:string;reason:string};
    expect(log.source).toBe(RESULTS_SOURCE);expect(JSON.parse(log.reason)).toMatchObject({raceId:id(),quality:'verified-official-outcome-v2',sha256:createHash('sha256').update(page()).digest('hex')});
    expect(await settleOpen(DB)).toBe(1);
    expect(sqlite.prepare('SELECT status,profit,odds_at_bet FROM bets').get()).toMatchObject({status:'won',profit:330,odds_at_bet:null});
  });
  it('collects official results for an experimental-only purchase',async()=>{
    const raceId=seed();sqlite.prepare('DELETE FROM bets WHERE race_id=?').run(raceId);
    const modelId='fixture-model',hash='a'.repeat(64);
    sqlite.prepare(`INSERT INTO experimental_models(id,status,manifest_schema,sport,bet_type,training_mode,schema_version,artifact_sha256,manifest_sha256,metadata_sha256,trained_at,artifact_manifest_json,manifest_json,registered_at)
      VALUES(?,'candidate','edgelab-experimental-trifecta-artifact-v1','boat','trifecta','experimental','boat-prerace-v2-no-weather-experimental-v1',?,?,?,?,?,?,?)`)
      .run(modelId,hash,hash,hash,'2026-10-11T01:00:00Z',JSON.stringify({schema:'edgelab-experimental-trifecta-artifact-v1',modelId,trainingMode:'experimental',experimentalOnly:true,files:{[`${modelId}.pkl`]:{sha256:hash}}}),JSON.stringify({experimentalOnly:true,trainingMode:'experimental',status:'candidate',boatFeatureSchemaVersion:'boat-prerace-v2-no-weather-experimental-v1',ticketBetType:'trifecta',ticketArtifactSha256:hash}),'2026-10-11T01:00:00Z');
    sqlite.prepare(`INSERT INTO experimental_paper_decisions(id,experiment_key,race_id,model_id,decision_at,outcome,total_stake,sizing_method,snapshot_json)
      VALUES('experimental-result-decision','boat-trifecta-small-sample-v1',?,?,'2026-10-11T02:00:00Z','placed',100,'fractional-kelly-portfolio','{}')`).run(raceId,modelId);
    sqlite.prepare(`INSERT INTO experimental_paper_bets(id,decision_id,race_id,model_id,selection,stake,probability,prob_std,odds_at_bet,expected_roi,placed_at,status,data_origin)
      VALUES('experimental-result-ticket','experimental-result-decision',?,?,'1-2-3',100,0.1,0.01,20,1,'2026-10-11T02:00:00Z','open','real')`).run(raceId,modelId);
    expect(await selectResultsTargets(DB,now)).toEqual([expect.objectContaining({id:raceId})]);
    const experimentalCollection=await collectResults(DB,now,{fetch:async url=>url.includes('/odds3t?')?new Response(finalTrifectaPage(raceDate,'09',1)):
      new Response(boatraceResultPage({raceDate,venueCode:'09',raceNo:1,finishOrder:[1,2,5,3,4,'転']})),sleep:async()=>{}});
    expect(experimentalCollection).toMatchObject({status:'success',verified:1,attempted:2});
    expect(sqlite.prepare("SELECT payout FROM payouts WHERE race_id=? AND bet_type='trifecta'").get(raceId)).toMatchObject({payout:3770});
    expect(JSON.parse((sqlite.prepare('SELECT reason FROM collection_runs WHERE id=?').get(`boat-result:${raceId}`) as {reason:string}).reason).nonRefundableNumbers).toEqual([6]);
    expect(await selectResultsTargets(DB,new Date(now.getTime()+3600000))).toEqual([]);
    expect(await settleOpen(DB)).toBe(1);
    const history=await (await app.request('/api/bets/experimental',{}, {DB} as any)).json() as any[];
    expect(history[0]).toMatchObject({status:'lost',finalOdds:37.7,oddsAtBet:20});
  });
  it('records multiple capsize finishers and settles tickets only with official no-refund evidence',async()=>{
    const raceId=seed();sqlite.prepare("UPDATE bets SET selection='3' WHERE id=?").run(`${raceId}-bet`);
    sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES(?,?,'boat','win','6',100,'manual','INSUFFICIENT_DATA','2026-10-11T02:01:00Z','open','real')").run(`${raceId}-terminal-bet`,raceId);
    sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES(?,?,'boat','trifecta','1-5-6',100,'manual','INSUFFICIENT_DATA','2026-10-11T02:02:00Z','open','real')").run(`${raceId}-terminal-trifecta`,raceId);
    const fetch=async()=>new Response(boatraceResultPage({raceDate,venueCode:'09',raceNo:1,finishOrder:[1,2,3,4,'転','転']}));
    expect(await collectResults(DB,now,{fetch})).toMatchObject({status:'success',records:8,verified:1});
    expect(sqlite.prepare('SELECT number,finish_order FROM results ORDER BY finish_order').all()).toHaveLength(4);
    expect(sqlite.prepare('SELECT features_json FROM entries WHERE race_id=? AND number IN (5,6) ORDER BY number').all(raceId)).toHaveLength(2);
    const provenance=JSON.parse((sqlite.prepare('SELECT reason FROM collection_runs').get() as {reason:string}).reason);
    expect(provenance).toMatchObject({raceId,url:`https://www.boatrace.jp/owpc/pc/race/raceresult?rno=1&jcd=09&hd=20261011`,quality:'verified-official-outcome-v2',sha256:expect.stringMatching(/^[a-f0-9]{64}$/),refundTablePresent:true,refundPolicy:'official-post-start-capsize-v1',nonRefundableNumbers:[5,6],terminalEntries:[{number:5,finishCode:'転覆'},{number:6,finishCode:'転覆'}]});
    const settled=await settleOpen(DB);
    expect(sqlite.prepare('SELECT id,status FROM bets ORDER BY id').all()).toEqual([
      {id:`${raceId}-bet`,status:'lost'}, {id:`${raceId}-terminal-bet`,status:'lost'},
      {id:`${raceId}-terminal-trifecta`,status:'lost'},
    ]);
    expect(settled).toBe(3);
    expect(sqlite.prepare('SELECT id,status FROM bets ORDER BY id').all()).toEqual([
      {id:`${raceId}-bet`,status:'lost'}, {id:`${raceId}-terminal-bet`,status:'lost'},
      {id:`${raceId}-terminal-trifecta`,status:'lost'},
    ]);
    expect(await selectResultsTargets(DB,new Date(now.getTime()+3600000))).toEqual([]);
  });
  it('keeps a capsize ticket open when the refund table is missing',async()=>{
    const raceId=seed();sqlite.prepare("UPDATE bets SET selection='6' WHERE id=?").run(`${raceId}-bet`);
    const source=boatraceResultPage({raceDate,venueCode:'09',raceNo:1,finishOrder:[1,2,5,3,4,'転']});
    const page=source.replace(/<div class="table1"><table><thead><tr><th>返還<\/th><\/tr><\/thead><tbody>[\s\S]*?<\/tbody><\/table><\/div>/,'');
    expect(await collectResults(DB,now,{fetch:async()=>new Response(page)})).toMatchObject({status:'success',verified:1});
    const provenance=JSON.parse((sqlite.prepare('SELECT reason FROM collection_runs').get() as {reason:string}).reason);
    expect(provenance.nonRefundableNumbers??[]).toEqual([]);
    expect(await settleOpen(DB)).toBe(0);
    expect(sqlite.prepare('SELECT status FROM bets').get()).toMatchObject({status:'open'});
  });
  it('keeps other terminal finish codes open without an official capsize proof',async()=>{
    const raceId=seed();sqlite.prepare("UPDATE bets SET selection='6' WHERE id=?").run(`${raceId}-bet`);
    const fetch=async()=>new Response(boatraceResultPage({raceDate,venueCode:'09',raceNo:1,finishOrder:[1,2,5,3,4,'転']}));
    await collectResults(DB,now,{fetch});
    const record=JSON.parse((sqlite.prepare('SELECT reason FROM collection_runs').get() as {reason:string}).reason);
    sqlite.prepare('UPDATE collection_runs SET reason=? WHERE id=?').run(JSON.stringify({...record,nonRefundableNumbers:[6],terminalEntries:[{number:6,finishCode:'F'}]}),`boat-result:${raceId}`);
    sqlite.prepare('UPDATE entries SET features_json=? WHERE race_id=? AND number=6').run(JSON.stringify({racer_id:'4006',finish_code:'F'}),raceId);
    expect(await settleOpen(DB)).toBe(0);
    expect(sqlite.prepare('SELECT status FROM bets').get()).toMatchObject({status:'open'});
  });
  it.each(['url','future-fetch-time'])('rejects a terminal settlement when successful-source %s provenance is invalid',async field=>{
    const raceId=seed();sqlite.prepare("UPDATE bets SET selection='6' WHERE id=?").run(`${raceId}-bet`);
    const fetch=async()=>new Response(boatraceResultPage({raceDate,venueCode:'09',raceNo:1,finishOrder:[1,2,5,3,4,'転']}));
    await collectResults(DB,now,{fetch});
    const record=JSON.parse((sqlite.prepare('SELECT reason FROM collection_runs').get() as {reason:string}).reason);
    const changed=field==='url'?{...record,url:'https://www.boatrace.jp/wrong'}:{...record,fetchedAt:new Date(Date.now()+60_000).toISOString()};
    sqlite.prepare('UPDATE collection_runs SET reason=? WHERE id=?').run(JSON.stringify(changed),`boat-result:${raceId}`);
    expect(await settleOpen(DB)).toBe(0);
    expect(sqlite.prepare('SELECT status FROM bets').get()).toMatchObject({status:'open'});
  });
  it('targets only elapsed real open purchased races, excludes audit/quarantine and future races',async()=>{
    seed(1);seed(2,'sample');seed(3,'real','won');seed(4,'real','open','2026-10-11T04:30:00Z');seed(5);seed(6);
    sqlite.prepare("INSERT INTO data_repair_quarantined_races(race_id,reason,repair_id,marked_at) VALUES(?,?,?,?)").run(id(5),'fixture','fixture',now.toISOString());
    sqlite.prepare("INSERT INTO data_repair_audit_marks(repair_id,race_id,record_type,record_id,reason,marked_at) VALUES('fixture',?,'bet',?,?,?)").run(id(6),`${id(6)}-bet`,'fixture',now.toISOString());
    expect((await selectResultsTargets(DB,now)).map(x=>x.id)).toEqual([id()]);
  });
  it('adds only bounded verified-cutoff R2 archive IDs as lower-priority unbought label targets',async()=>{
    const archived=seed(7);sqlite.prepare('DELETE FROM bets WHERE race_id=?').run(archived);
    sqlite.prepare("UPDATE races SET betting_cutoff_at=?,betting_cutoff_source='boatrace-racelist-cutoff-v1' WHERE id=?")
      .run('2026-10-11T03:00:00Z',archived);
    const unlisted=seed(8);sqlite.prepare('DELETE FROM bets WHERE race_id=?').run(unlisted);
    sqlite.prepare("UPDATE races SET betting_cutoff_at=?,betting_cutoff_source='boatrace-racelist-cutoff-v1' WHERE id=?")
      .run('2026-10-11T03:00:00Z',unlisted);
    const wrongCutoff=seed(9);sqlite.prepare('DELETE FROM bets WHERE race_id=?').run(wrongCutoff);
    sqlite.prepare('UPDATE races SET betting_cutoff_at=? WHERE id=?').run('2026-10-11T03:00:00Z',wrongCutoff);
    const targets=await selectResultsTargets(DB,now,8,false,[archived,wrongCutoff]);
    expect(targets.map(row=>row.id)).toContain(archived);
    expect(targets.map(row=>row.id)).not.toContain(unlisted);
    expect(targets.map(row=>row.id)).not.toContain(wrongCutoff);
  });
  it('targets a historical-only open virtual race while excluding unrelated races',async()=>{
    seed(2);seed(3,'real','won');
    sqlite.prepare('DELETE FROM bets WHERE race_id=?').run(id(2));
    sqlite.prepare(`INSERT INTO historical_trifecta_experiment_decisions(id,experiment_key,race_id,model_id,decision_at,outcome,total_stake,snapshot_json)
      VALUES('hist-decision','boat-trifecta-historical-base-v1',?,'boat-trifecta-historical-base-20261014','2026-10-11T02:00:00Z','placed',100,'{}')`).run(id(2));
    sqlite.prepare(`INSERT INTO historical_trifecta_experiment_bets(id,decision_id,race_id,model_id,selection,stake,probability,prob_std,odds_at_bet,expected_roi,placed_at,status,data_origin)
      VALUES('hist-bet','hist-decision',?,'boat-trifecta-historical-base-20261014','1-2-3',100,0.1,0.01,200,19,'2026-10-11T02:00:00Z','open','real')`).run(id(2));
    expect((await selectResultsTargets(DB,now)).map(x=>x.id)).toEqual([id(2)]);
    expect(await collectResults(DB,now,{fetch:fetchPage,sleep:async()=>{}})).toMatchObject({status:'success',verified:1,attempted:1});
    expect(JSON.parse((sqlite.prepare('SELECT reason FROM collection_runs WHERE id=?').get(`boat-result:${id(2)}`) as {reason:string}).reason)).toMatchObject({quality:'verified-official-outcome-v2'});
  });
  it('collects purchased results with missing, invalid, or exhausted legacy reservation state',async()=>{
    seed();sqlite.prepare("DELETE FROM settings WHERE key='roi_d1_write_budget_utc'").run();
    const fetcher=vi.fn(fetchPage);
    expect(await collectResults(DB,now,{fetch:fetcher})).toMatchObject({status:'success',attempted:1,verified:1});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key='boat_results_ten_minute'").get()).toMatchObject({n:1});
    expect(sqlite.prepare('SELECT COUNT(*) n FROM results').get()).toMatchObject({n:6});
  });
  it('fails closed on malformed results without entry changes or settlement',async()=>{
    seed();const before=sqlite.prepare('SELECT features_json FROM entries ORDER BY number').all();
    expect(await collectResults(DB,now,{fetch:async()=>new Response('<html>not published</html>')})).toMatchObject({status:'failed',records:0,attempted:1});
    expect(sqlite.prepare('SELECT COUNT(*) n FROM results').get()).toMatchObject({n:0});expect(sqlite.prepare('SELECT features_json FROM entries ORDER BY number').all()).toEqual(before);expect(await settleOpen(DB)).toBe(0);
  });
  it('does not overwrite conflicting stored outcomes',async()=>{
    seed();sqlite.prepare("INSERT INTO results(race_id,number,finish_order,data_origin) VALUES(?,1,2,'real')").run(id());
    expect(await collectResults(DB,now,{fetch:fetchPage})).toMatchObject({status:'failed',records:0});expect(sqlite.prepare('SELECT finish_order FROM results').get()).toMatchObject({finish_order:2});
  });
  it('rejects a persisted race identity mismatch and leaves an already-settled purchase unchanged',async()=>{
    const mismatched=seed(1);sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('10','boat','Mismatch')").run();sqlite.prepare("UPDATE races SET venue_id='10' WHERE id=?").run(mismatched);
    const fetcher=vi.fn(fetchPage);
    expect(await collectResults(DB,now,{fetch:fetcher})).toMatchObject({status:'failed',verified:0});
    expect(fetcher).not.toHaveBeenCalled();
    sqlite.prepare("UPDATE bets SET status='lost' WHERE race_id=?").run(mismatched);
    const settled=seed(2);sqlite.prepare("UPDATE bets SET status='lost',payout=0,profit=-100,settled_at='2026-10-11T03:30:00Z' WHERE race_id=?").run(settled);
    expect(await collectResults(DB,new Date(now.getTime()+10*60_000),{fetch:fetcher})).toMatchObject({status:'skipped'});
    expect(sqlite.prepare('SELECT status,payout,profit,settled_at FROM bets WHERE race_id=?').get(settled)).toMatchObject({status:'lost',payout:0,profit:-100,settled_at:'2026-10-11T03:30:00Z'});
  });
  it('prevents duplicate ten-minute runs, rotates failed targets fairly, and keeps one log per race',async()=>{
    seed(1);seed(2);const fetcher=vi.fn(async(_input:string)=>new Response('not ready'));
    await collectResults(DB,now,{maxAttempts:1,fetch:fetcher});
    await collectResults(DB,now,{maxAttempts:1,fetch:fetcher});expect(fetcher).toHaveBeenCalledTimes(1);
    await collectResults(DB,new Date(now.getTime()+3600000),{maxAttempts:1,fetch:fetcher});expect(fetcher.mock.calls[1][0]).toContain('rno=2');
    await collectResults(DB,new Date(now.getTime()+7200000),{maxAttempts:1,fetch:fetcher});expect(sqlite.prepare('SELECT COUNT(*) n FROM collection_runs').get()).toMatchObject({n:2});
  });
  it('shares capped fetch attempts and three-second spacing including its single network retry',async()=>{
    seed(1);seed(2);const requestBudget={used:47,max:49},pauses:number[]=[];
    const fetcher=vi.fn(async()=>new Response('unavailable',{status:503}));
    expect(await collectResults(DB,now,{requestBudget,fetch:fetcher,sleep:async ms=>{pauses.push(ms)}})).toMatchObject({attempted:2});
    expect(requestBudget.used).toBe(49);expect(fetcher).toHaveBeenCalledTimes(2);expect(pauses).toEqual([3000,3000]);
  });
  it('does not refetch completed result evidence while settlement is waiting',async()=>{
    seed();await collectResults(DB,now,{fetch:fetchPage});const fetcher=vi.fn(fetchPage);
    expect(await collectResults(DB,new Date(now.getTime()+3600000),{fetch:fetcher})).toMatchObject({status:'skipped',attempted:0});expect(fetcher).not.toHaveBeenCalled();
  });
  it('attributes result collection only to the exact purchased race, never another race or odds source',async()=>{
    seed(1);seed(2);await collectResults(DB,now,{maxAttempts:1,fetch:fetchPage});
    const response=await app.request('/api/bets?origin=real',{}, {DB});const bets=await response.json() as {raceId:string;resultCollectionSource:string|null}[];
    expect(bets.find(x=>x.raceId===id())?.resultCollectionSource).toBe(RESULTS_SOURCE);expect(bets.find(x=>x.raceId===id(2))?.resultCollectionSource).toBeNull();
  });
  it('does not fetch when saved racer registration metadata is missing',async()=>{
    seed();sqlite.prepare("UPDATE entries SET features_json='{}' WHERE number=1").run();const fetcher=vi.fn(fetchPage);
    expect(await collectResults(DB,now,{fetch:fetcher})).toMatchObject({records:0,attempted:0});expect(fetcher).not.toHaveBeenCalled();
    const log=sqlite.prepare('SELECT reason FROM collection_runs').get() as {reason:string};expect(JSON.parse(log.reason).reason).toBe('saved-registry-incomplete');
  });
  it.each(['registry','quarantine','settled','postTime','terminalFinishCode'])('rejects %s authority changes during fetch in the guarded atomic write',async change=>{
    seed();const fetcher=async(input:string)=>{
      if(change==='registry')sqlite.prepare("UPDATE entries SET features_json='{}' WHERE number=1").run();
      if(change==='quarantine')sqlite.prepare("INSERT INTO data_repair_quarantined_races(race_id,repair_id,reason) VALUES(?,'fixture','fixture')").run(id());
      if(change==='settled')sqlite.prepare("UPDATE bets SET status='lost' WHERE race_id=?").run(id());
      if(change==='postTime')sqlite.prepare("UPDATE races SET post_time='2099-01-01T00:00:00Z' WHERE id=?").run(id());
      if(change==='terminalFinishCode')sqlite.prepare('UPDATE entries SET features_json=? WHERE race_id=? AND number=6').run('{"racer_id":"4006","finish_code":"F"}',id());
      return fetchPage(input);
    };
    expect(await collectResults(DB,now,{fetch:fetcher})).toMatchObject({status:'failed',records:0});
    expect(sqlite.prepare('SELECT COUNT(*) n FROM results').get()).toMatchObject({n:0});expect(sqlite.prepare('SELECT COUNT(*) n FROM payouts').get()).toMatchObject({n:0});
    const log=sqlite.prepare('SELECT status,reason FROM collection_runs').get() as {status:string;reason:string};expect(log.status).toBe('failed');expect(JSON.parse(log.reason).reason).toBe('source-state-changed');
  });
  it('continues through attempt-budgeted batches and rotates a persistently unsupported oldest race',async()=>{
    for(let index=0;index<20;index++)seed(index%12+1,'real','open',undefined,index<12?'01':'02');
    const fetcher=vi.fn(async(input:string)=>{const url=new URL(input);return url.searchParams.get('jcd')==='01'&&url.searchParams.get('rno')==='1'
      ?new Response('unavailable',{status:403}):fetchPage(input)});
    const budget={used:0,max:49};
    const first=await collectResults(DB,now,{requestBudget:budget,fetch:fetcher,sleep:async()=>{}});
    expect(first).toMatchObject({targets:15,verified:14,attempted:16,batches:4});
    expect(budget.used).toBe(16);
    expect(first.targets).toBeGreaterThan(8);

    const next=await collectResults(DB,new Date(now.getTime()+3600000),{fetch:fetcher,sleep:async()=>{}});
    expect(next).toMatchObject({targets:6,verified:5,failed:1,attempted:7});
    expect(fetcher.mock.calls.filter(([url])=>{const parsed=new URL(url);return parsed.searchParams.get('jcd')==='01'&&parsed.searchParams.get('rno')==='1'})).toHaveLength(4);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM results WHERE data_origin=\'real\'').get()).toMatchObject({n:19*6});
    expect(sqlite.prepare('SELECT COUNT(*) n FROM results WHERE race_id=?').get(id(1,'01'))).toMatchObject({n:0});
    expect(sqlite.prepare('SELECT COUNT(*) n FROM collection_runs').get()).toMatchObject({n:20});
  });
  it.each([
    {code:'http-status',httpStatus:403,response:()=>new Response('private upstream body',{status:403})},
    {code:'http-redirect-rejected',httpStatus:302,response:()=>new Response(null,{status:302,headers:{location:'https://evil.example/private'}})},
    {code:'body-missing',httpStatus:204,response:()=>new Response(null,{status:204})},
    {code:'body-too-large',httpStatus:200,response:()=>new Response('x',{headers:{'content-length':String(512*1024+1)}})},
    {code:'utf8-rejected',httpStatus:200,response:()=>new Response(new Uint8Array([255]))},
    {code:'body-read-failed',httpStatus:200,response:()=>new Response(new ReadableStream({start(controller){controller.error(new Error('private upstream error'));}}))},
  ])('safe fetch diagnostics: $code do not follow redirects or leak upstream data',async scenario=>{
    seed();const fetcher=vi.fn(async(_input:string,init?:RequestInit)=>{expect(init?.redirect).toBe('manual');return scenario.response();});
    const result=await collectResults(DB,now,{fetch:fetcher,sleep:async()=>{}});
    expect(result).toMatchObject({status:'failed',verified:0,attempted:2,fetchFailures:[{code:scenario.code,httpStatus:scenario.httpStatus,count:2}]});
    expect(fetcher).toHaveBeenCalledTimes(2);
    const log=sqlite.prepare('SELECT reason FROM collection_runs').get() as {reason:string};
    expect(JSON.parse(log.reason).fetchFailure).toEqual({code:scenario.code,httpStatus:scenario.httpStatus});
    expect(JSON.stringify(result)+log.reason).not.toMatch(/private upstream|evil\.example|private upstream error/);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM results').get()).toMatchObject({n:0});
  });
  it.each(['TimeoutError','TypeError'])('safe fetch diagnostics: rejected %s reveals only a fixed class',async name=>{
    seed();const fetcher=vi.fn(async()=>{const error=new Error('sensitive arbitrary message');error.name=name;throw error;});
    const result=await collectResults(DB,now,{fetch:fetcher,sleep:async()=>{}});
    expect(result).toMatchObject({attempted:2,verified:0,fetchFailures:[{code:name==='TimeoutError'?'fetch-timeout':'fetch-rejected',count:2}]});
    expect(JSON.stringify(result)).not.toContain('sensitive arbitrary message');
  });
  it('uses an evidence-backed finite 30-second result timeout without adding source attempts',async()=>{
    seed();const timeout=vi.spyOn(AbortSignal,'timeout');
    try {
      const result=await collectResults(DB,now,{fetch:async(_input,init)=>{expect(init?.signal).toBeInstanceOf(AbortSignal);expect(init?.signal?.aborted).toBe(false);return new Response('not published');}});
      expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);expect(result.attempted).toBe(1);
    } finally {timeout.mockRestore();}
  });
  it.each([
    {status:403,headers:new Headers()},
    {status:302,headers:new Headers({location:'https://invalid.example/no-follow'})},
    {status:200,headers:new Headers({'content-length':String(512*1024+1)})},
  ])('cancels an early rejected $status response body before retrying',async scenario=>{
    seed();let canceled=0;
    const fetcher=vi.fn(async()=>new Response(new ReadableStream({cancel(){canceled++;}}),scenario));
    const result=await collectResults(DB,now,{fetch:fetcher,sleep:async()=>{}});
    expect(result.attempted).toBe(2);expect(canceled).toBe(2);expect(fetcher).toHaveBeenCalledTimes(2);expect(result.verified).toBe(0);
  });
  it('manual result route requires authentication, confirmation and enabled flag without weakening ingest auth',async()=>{
    seed();const fetcher=vi.fn(fetchPage);vi.stubGlobal('fetch',fetcher);
    const env={DB,PROXY_TOKEN:'test-proxy',INGEST_TOKEN:'test-ingest',ENABLE_BOATRACE_RESULTS_SCRAPE:'true'};
    const init=(headers:Record<string,string>={},body:unknown={confirmed:true})=>({method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
    expect((await app.request('/api/admin/collect-boat-results',init(),env)).status).toBe(401);
    expect((await app.request('/api/admin/collect-boat-results',init({'X-ROI-Proxy':'wrong'}),env)).status).toBe(401);
    expect((await app.request('/api/admin/collect-boat-results',init({'X-ROI-Proxy':'test-proxy'},{}),env)).status).toBe(400);
    expect((await app.request('/api/admin/collect-boat-results',init({'X-ROI-Proxy':'test-proxy'}),{...env,ENABLE_BOATRACE_RESULTS_SCRAPE:'false'})).status).toBe(403);
    expect((await app.request('/api/ingest/results',init({'X-ROI-Proxy':'test-proxy'},[]),env)).status).toBe(401);
    expect((await app.request('/api/admin/settle',init(),env)).status).toBe(401);
    expect((await app.request('/api/admin/settle',init({'X-ROI-Proxy':'test-proxy'},{}),env)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();expect(sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key='boat_results_manual_until'").get()).toMatchObject({n:0});
  });
  it('manual result route bypasses only the scheduled marker and leaves settlement to the second invocation',async()=>{
    seed();vi.useFakeTimers();vi.setSystemTime(now);vi.stubGlobal('fetch',fetchPage);
    const window=`${now.toISOString().slice(0,13)}:00`;
    sqlite.prepare("INSERT INTO settings(key,value) VALUES('boat_results_ten_minute',?)").run(window);
    const env={DB,PROXY_TOKEN:'test-proxy',ENABLE_BOATRACE_RESULTS_SCRAPE:'true'};
    const init={method:'POST',headers:{'content-type':'application/json','X-ROI-Proxy':'test-proxy'},body:JSON.stringify({confirmed:true})};
    const response=await app.request('/api/admin/collect-boat-results',init,env);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({verified:1,targets:1,attempted:1});
    expect(sqlite.prepare('SELECT status FROM bets').get()).toMatchObject({status:'open'});
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='boat_results_ten_minute'").get()).toMatchObject({value:window});
    const settlement=await app.request('/api/admin/settle',init,env);
    expect(await settlement.json()).toEqual({settled:1});expect(sqlite.prepare('SELECT status,profit FROM bets').get()).toMatchObject({status:'won',profit:330});
  });
  it('manual result mode runs with no legacy reservation ledger while preserving its lock',async()=>{
    seed();sqlite.prepare("DELETE FROM settings WHERE key='roi_d1_write_budget_utc'").run();const fetcher=vi.fn(fetchPage);
    expect(await collectResults(DB,now,{mode:'manual',fetch:fetcher})).toMatchObject({status:'success',attempted:1,verified:1});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(Date.parse((sqlite.prepare("SELECT value FROM settings WHERE key='boat_results_manual_until'").get() as {value:string}).value)).toBeGreaterThan(now.getTime());
  });
  it('manual result mode blocks concurrent duplicate and throttles completed runs for sixty seconds',async()=>{
    seed();vi.useFakeTimers();vi.setSystemTime(now);
    let resolveResponse!:(response:Response)=>void;const pending=new Promise<Response>(resolve=>{resolveResponse=resolve;});const fetcher=vi.fn(async()=>pending);
    const first=collectResults(DB,now,{mode:'manual',fetch:fetcher});
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
    expect(await collectResults(DB,now,{mode:'manual',fetch:fetcher})).toMatchObject({status:'skipped',attempted:0,reason:'manual run in progress or throttled'});
    resolveResponse(new Response('not published'));await first;
    expect(await collectResults(DB,new Date(now.getTime()+59_000),{mode:'manual',fetch:fetcher})).toMatchObject({status:'skipped',attempted:0});
    expect(fetcher).toHaveBeenCalledTimes(1);
    const retry=await collectResults(DB,new Date(now.getTime()+61_000),{mode:'manual',fetch:async()=>new Response('not published')});expect(retry.attempted).toBe(1);
  });
  it('manual result mode shares attempt-based batch progression and stays within its five-minute lease',async()=>{
    for(let raceNo=1;raceNo<=5;raceNo++)seed(raceNo);let queries=0;const prepare=DB.prepare.bind(DB);
    DB.prepare=(sql:string)=>{queries++;return prepare(sql);};
    expect(await collectResults(DB,now,{mode:'manual',fetch:fetchPage,sleep:async()=>{}})).toMatchObject({targets:5,verified:5,attempted:5,batches:2});expect(queries).toBeLessThan(80);
  });
  it('manual result route also preserves ingest-bearer operator authentication',async()=>{
    seed();vi.useFakeTimers();vi.setSystemTime(now);vi.stubGlobal('fetch',fetchPage);
    const response=await app.request('/api/admin/collect-boat-results',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer test-ingest'},body:JSON.stringify({confirmed:true})},{DB,INGEST_TOKEN:'test-ingest',PROXY_TOKEN:'test-proxy',ENABLE_BOATRACE_RESULTS_SCRAPE:'true'});
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({verified:1,attempted:1});
  });
  it('collects and exports only source-proven numeric K labels for a prior T-60 archive',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const raceId=seedT60Archive();
    vi.stubGlobal('fetch',fetchPage);
    const trigger=await app.request('/api/admin/collect-boat-results',{method:'POST',headers:{Authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify({confirmed:true,labelOnly:true})},{DB,INGEST_TOKEN:'test-token',ENABLE_BOATRACE_RESULTS_SCRAPE:'true'});
    expect(trigger.status).toBe(200);
    expect(await trigger.json()).toMatchObject({status:'success',verified:1,targets:1,attempted:1});
    expect(sqlite.prepare('SELECT COUNT(*) n FROM bets WHERE race_id=?').get(raceId)).toMatchObject({n:0});
    const unauth=await app.request(`/api/ingest/experimental-trifecta/training-results?date=${raceDate}`,{}, {DB});
    expect(unauth.status).toBe(401);
    const response=await app.request(`/api/ingest/experimental-trifecta/training-results?date=${raceDate}`,{headers:{Authorization:'Bearer test-token'}},{DB,INGEST_TOKEN:'test-token'});
    expect(response.status).toBe(200);
    const exported=await response.json() as any;
    expect(exported).toMatchObject({schema:'boat-official-k-result-label-export-v1',date:raceDate,labels:[{
      raceId,raceDate,venueId:'09',raceNo:1,source:{url:`https://www.boatrace.jp/owpc/pc/race/raceresult?rno=1&jcd=09&hd=20261011`,
        sha256:createHash('sha256').update(page()).digest('hex'),fetchedAt:now.toISOString(),quality:'verified-official-outcome-v2'}
    }]});
    expect(exported.labels[0].results).toHaveLength(6);
    expect(exported.labels[0].payouts).toHaveLength(1);
    expect(Object.keys(exported.labels[0])).not.toContain('entries');
    const terminalRace=seedT60Archive(2);
    vi.setSystemTime(new Date(now.getTime()+61_000));
    expect(await collectResults(DB,new Date(now.getTime()+61_000),{mode:'manual',labelOnly:true,maxAttempts:8,
      fetch:async(input:string)=>new Response(boatraceResultPage({raceDate,venueCode:'09',raceNo:Number(new URL(input).searchParams.get('rno')),finishOrder:[1,2,5,3,4,'転']})),sleep:async()=>{}})).toMatchObject({status:'success',verified:1});
    const strictExport=await app.request(`/api/ingest/experimental-trifecta/training-results?date=${raceDate}`,{headers:{Authorization:'Bearer test-token'}},{DB,INGEST_TOKEN:'test-token'});
    expect((await strictExport.json() as any).labels.map((x:any)=>x.raceId)).toEqual([raceId]);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM results WHERE race_id=?').get(terminalRace)).toMatchObject({n:5});
    expect(sqlite.prepare("SELECT features_json FROM entries WHERE race_id=? AND number=6").get(terminalRace)).toMatchObject({features_json:expect.not.stringContaining('finish_code')});
  });
  it('keeps the flag off by default and collects every ten-minute boundary',async()=>{
    seed();vi.useFakeTimers();vi.setSystemTime(now);const fetcher=vi.fn(fetchPage);vi.stubGlobal('fetch',fetcher);
    await worker.scheduled({cron:'* * * * *',scheduledTime:now.getTime()+60000} as ScheduledController,{DB,ENABLE_BOATRACE_RESULTS_SCRAPE:'true'});
    await worker.scheduled({cron:'* * * * *',scheduledTime:now.getTime()+10*60000} as ScheduledController,{DB});expect(fetcher).not.toHaveBeenCalled();
    await worker.scheduled({cron:'* * * * *',scheduledTime:now.getTime()+10*60000} as ScheduledController,{DB,ENABLE_BOATRACE_RESULTS_SCRAPE:'true'});expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
