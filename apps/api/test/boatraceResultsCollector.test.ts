import Sqlite from 'better-sqlite3';
import { readdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { D1SqliteAdapter } from './d1-adapter.js';
import { collectResults,selectResultsTargets,RESULTS_SOURCE } from '../src/services/collectBoatraceResults.js';
import { boatraceResultPage } from './fixtures/boatraceResultPage.js';
import worker,{app,settleOpen} from '../src/index.js';
const root=resolve(import.meta.dirname,'../../..');
const now=new Date('2026-10-11T04:00:00Z'),raceDate='2026-10-11';
let sqlite:Sqlite.Database,DB:D1SqliteAdapter;
const id=(raceNo=1)=>`boat-20261011-09-${String(raceNo).padStart(2,'0')}`;
function seed(raceNo=1,origin='real',status='open',postTime='2026-10-11T03:00:00Z') {
  const raceId=origin==='sample'?`sample-${id(raceNo)}`:id(raceNo);
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at) VALUES(?,'boat','09',?,?,?,'scheduled',?,?)").run(raceId,raceDate,raceNo,postTime,origin,now.toISOString());
  for(let number=1;number<=6;number++)sqlite.prepare("INSERT INTO entries(id,race_id,number,name,features_json,available_at,data_origin) VALUES(?,?,?,?,?,?,?)").run(`${raceId}-${number}`,raceId,number,`Synthetic ${number}`,JSON.stringify({racer_id:String(4000+number)}),'2026-10-10T23:00:00Z',origin);
  sqlite.prepare("INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,edge_label,placed_at,status,data_origin) VALUES(?,?,'boat','win','1',100,'manual','INSUFFICIENT_DATA','2026-10-11T02:00:00Z',?,?)").run(`${raceId}-bet`,raceId,status,origin);
  return raceId;
}
const page=(raceNo=1)=>boatraceResultPage({raceDate,venueCode:'09',raceNo});
const fetchPage=async(input:string)=>new Response(page(Number(new URL(input).searchParams.get('rno'))),{headers:{'content-type':'text/html; charset=utf-8'}});
beforeEach(()=>{
  sqlite=new Sqlite(':memory:');DB=new D1SqliteAdapter(sqlite);
  for(const file of readdirSync(resolve(root,'db/migrations')).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(resolve(root,'db/migrations',file),'utf8'));
  sqlite.prepare("INSERT INTO settings(key,value) VALUES('roi_d1_write_budget_utc',?)").run(JSON.stringify({date:now.toISOString().slice(0,10),reserved:0,oddsReserved:0}));
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('09','boat','Synthetic')").run();
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();sqlite.close();});

describe('purchased real boat hourly results',()=>{
  it('atomically records normal official results, evidence and existing settlement without modifying purchase snapshots',async()=>{
    seed();const requestBudget={used:48,max:49},pauses:number[]=[];
    const result=await collectResults(DB,now,{requestBudget,fetch:fetchPage,sleep:async ms=>{pauses.push(ms)}});
    expect(result).toMatchObject({status:'success',records:8,verified:1,targets:1,attempted:1});
    expect(requestBudget.used).toBe(49);expect(pauses).toEqual([3000]);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM results').get()).toMatchObject({n:6});
    const log=sqlite.prepare('SELECT source,reason FROM collection_runs').get() as {source:string;reason:string};
    expect(log.source).toBe(RESULTS_SOURCE);expect(JSON.parse(log.reason)).toMatchObject({raceId:id(),quality:'verified-normal-v1',sha256:createHash('sha256').update(page()).digest('hex')});
    expect(await settleOpen(DB)).toBe(1);
    expect(sqlite.prepare('SELECT status,profit,odds_at_bet FROM bets').get()).toMatchObject({status:'won',profit:330,odds_at_bet:null});
  });
  it('targets only elapsed real open purchased races, excludes audit/quarantine and future races',async()=>{
    seed(1);seed(2,'sample');seed(3,'real','won');seed(4,'real','open','2026-10-11T04:30:00Z');seed(5);seed(6);
    sqlite.prepare("INSERT INTO data_repair_quarantined_races(race_id,reason,repair_id,marked_at) VALUES(?,?,?,?)").run(id(5),'fixture','fixture',now.toISOString());
    sqlite.prepare("INSERT INTO data_repair_audit_marks(repair_id,race_id,record_type,record_id,reason,marked_at) VALUES('fixture',?,'bet',?,?,?)").run(id(6),`${id(6)}-bet`,'fixture',now.toISOString());
    expect((await selectResultsTargets(DB,now)).map(x=>x.id)).toEqual([id()]);
  });
  it.each(['missing','invalid','exhausted'])('does not fetch, lock or log with %s daily allowance',async state=>{
    seed();
    if(state==='missing')sqlite.prepare("DELETE FROM settings WHERE key='roi_d1_write_budget_utc'").run();
    else sqlite.prepare("UPDATE settings SET value=? WHERE key='roi_d1_write_budget_utc'").run(state==='invalid'?'bad':JSON.stringify({date:'2026-10-11',reserved:20000,essentialReserved:16000,optionalReserved:4000,oddsReserved:0}));
    const fetcher=vi.fn(fetchPage);expect(await collectResults(DB,now,{fetch:fetcher})).toMatchObject({status:'skipped',attempted:0});expect(fetcher).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key='boat_results_hour'").get()).toMatchObject({n:0});expect(sqlite.prepare('SELECT COUNT(*) n FROM collection_runs').get()).toMatchObject({n:0});
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
  it('prevents duplicate hourly runs, rotates failed targets fairly, and keeps one log per race',async()=>{
    seed(1);seed(2);const fetcher=vi.fn(async(_input:string)=>new Response('not ready'));
    await collectResults(DB,now,{maxRequests:1,fetch:fetcher});
    await collectResults(DB,now,{maxRequests:1,fetch:fetcher});expect(fetcher).toHaveBeenCalledTimes(1);
    await collectResults(DB,new Date(now.getTime()+3600000),{maxRequests:1,fetch:fetcher});expect(fetcher.mock.calls[1][0]).toContain('rno=2');
    await collectResults(DB,new Date(now.getTime()+7200000),{maxRequests:1,fetch:fetcher});expect(sqlite.prepare('SELECT COUNT(*) n FROM collection_runs').get()).toMatchObject({n:2});
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
    seed(1);seed(2);await collectResults(DB,now,{maxRequests:1,fetch:fetchPage});
    const response=await app.request('/api/bets?origin=real',{}, {DB});const bets=await response.json() as {raceId:string;resultCollectionSource:string|null}[];
    expect(bets.find(x=>x.raceId===id())?.resultCollectionSource).toBe(RESULTS_SOURCE);expect(bets.find(x=>x.raceId===id(2))?.resultCollectionSource).toBeNull();
  });
  it('does not fetch when saved racer registration metadata is missing',async()=>{
    seed();sqlite.prepare("UPDATE entries SET features_json='{}' WHERE number=1").run();const fetcher=vi.fn(fetchPage);
    expect(await collectResults(DB,now,{fetch:fetcher})).toMatchObject({records:0,attempted:0});expect(fetcher).not.toHaveBeenCalled();
    const log=sqlite.prepare('SELECT reason FROM collection_runs').get() as {reason:string};expect(JSON.parse(log.reason).reason).toBe('saved-registry-incomplete');
  });
  it.each(['registry','quarantine','settled','postTime'])('rejects %s authority changes during fetch in the guarded atomic write',async change=>{
    seed();const fetcher=async(input:string)=>{
      if(change==='registry')sqlite.prepare("UPDATE entries SET features_json='{}' WHERE number=1").run();
      if(change==='quarantine')sqlite.prepare("INSERT INTO data_repair_quarantined_races(race_id,repair_id,reason) VALUES(?,'fixture','fixture')").run(id());
      if(change==='settled')sqlite.prepare("UPDATE bets SET status='lost' WHERE race_id=?").run(id());
      if(change==='postTime')sqlite.prepare("UPDATE races SET post_time='2099-01-01T00:00:00Z' WHERE id=?").run(id());
      return fetchPage(input);
    };
    expect(await collectResults(DB,now,{fetch:fetcher})).toMatchObject({status:'failed',records:0});
    expect(sqlite.prepare('SELECT COUNT(*) n FROM results').get()).toMatchObject({n:0});expect(sqlite.prepare('SELECT COUNT(*) n FROM payouts').get()).toMatchObject({n:0});
    const log=sqlite.prepare('SELECT status,reason FROM collection_runs').get() as {status:string;reason:string};expect(log.status).toBe('failed');expect(JSON.parse(log.reason).reason).toBe('source-state-changed');
  });
  it('bounds the four-target pass to fewer than 50 D1 statements including reservations and atomic batches',async()=>{
    for(let raceNo=1;raceNo<=5;raceNo++)seed(raceNo);
    let queries=0;const prepare=DB.prepare.bind(DB);
    DB.prepare=(sql:string)=>{queries++;return prepare(sql);};
    const result=await collectResults(DB,now,{fetch:fetchPage,sleep:async()=>{}});
    expect(result).toMatchObject({targets:4,records:32,verified:4,attempted:4});
    expect(queries).toBe(33);expect(queries).toBeLessThan(50);
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
  it('keeps the flag off by default and only collects at hourly boundaries',async()=>{
    seed();vi.useFakeTimers();vi.setSystemTime(now);const fetcher=vi.fn(fetchPage);vi.stubGlobal('fetch',fetcher);
    await worker.scheduled({cron:'* * * * *',scheduledTime:now.getTime()+60000} as ScheduledController,{DB,ENABLE_BOATRACE_RESULTS_SCRAPE:'true'});
    await worker.scheduled({cron:'* * * * *',scheduledTime:now.getTime()+5*60000} as ScheduledController,{DB});expect(fetcher).not.toHaveBeenCalled();
    await worker.scheduled({cron:'* * * * *',scheduledTime:now.getTime()+5*60000} as ScheduledController,{DB,ENABLE_BOATRACE_RESULTS_SCRAPE:'true'});expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
