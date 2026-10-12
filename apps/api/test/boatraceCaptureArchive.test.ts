import Sqlite from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { collectBoatraceCaptureArchives } from '../src/services/collectBoatraceCaptureArchives.js';
import { D1SqliteAdapter } from './d1-adapter.js';

const root=resolve(import.meta.dirname,'../../..');
const FIXED_NOW=Date.parse('2026-10-11T03:00:00Z'); // 12:00 JST; the official fixture cutoff is 15:19.
const jstIso=(ms:number)=>new Date(ms+9*60*60*1000).toISOString().replace('Z','+09:00');
let sqlite:Sqlite.Database,DB:D1SqliteAdapter;
let beforeinfo:string;

function oddsPage(day:string,raceNo:number){
  const firsts=[1,2,3,4,5,6];
  const head=`<thead><tr>${firsts.map(number=>`<th>${number}</th>`).join('')}</tr></thead>`;
  const rows:string[]=[];
  for(let group=0;group<5;group++)for(let row=0;row<4;row++){
    const cells=firsts.map(first=>{
      const seconds=firsts.filter(number=>number!==first),second=seconds[group];
      const thirds=firsts.filter(number=>number!==first&&number!==second),third=thirds[row];
      return `${row===0?`<td rowspan="4">${second}</td>`:''}<td>${third}</td><td>${12+group+row+first/10}</td>`;
    }).join('');
    rows.push(`<tr>${cells}</tr>`);
  }
  return `<div class="tab3"><a href="/owpc/pc/race/racelist?rno=${raceNo}&amp;jcd=01&amp;hd=${day.replaceAll('-','')}">出走表</a><a href="/owpc/pc/race/raceresult?rno=${raceNo}&amp;jcd=01&amp;hd=${day.replaceAll('-','')}">結果</a></div><p>オッズ更新時間 12:00</p><span>3連単オッズ</span><table>${head}<tbody>${rows.join('')}</tbody></table>`;
}

function addRace(raceNo=1,postOffsetMs=10*60_000){
  const date='2026-10-11',id=`boat-20261011-01-${String(raceNo).padStart(2,'0')}`;
  sqlite.prepare("INSERT OR IGNORE INTO venues(id,sport,name) VALUES('01','boat','Archive fixture')").run();
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at) VALUES(?,'boat','01',?,?,?,'scheduled','real',?)")
    .run(id,date,raceNo,jstIso(FIXED_NOW+postOffsetMs),jstIso(FIXED_NOW));
  for(let lane=1;lane<=6;lane++)sqlite.prepare("INSERT INTO entries(id,race_id,number,name,available_at,data_origin) VALUES(?,?,?,? ,?,'real')")
    .run(`${id}-entry-${lane}`,id,lane,`Runner ${lane}`,jstIso(FIXED_NOW-60_000));
  return id;
}

function fetchFor(day:string,raceNo:number,replaceOdds?:(html:string)=>string,replaceBeforeinfo?:(html:string)=>string){
  const odds=replaceOdds?replaceOdds(oddsPage(day,raceNo)):oddsPage(day,raceNo);
  const identityCorrected=raceNo===1?beforeinfo:beforeinfo.replaceAll('rno=1',`rno=${raceNo}`);
  const before=replaceBeforeinfo?replaceBeforeinfo(identityCorrected):identityCorrected;
  return async(input:string)=>new Response(input.includes('/beforeinfo?')?before:odds,{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
}

beforeEach(()=>{
  sqlite=new Sqlite(':memory:');DB=new D1SqliteAdapter(sqlite);
  for(const file of readdirSync(resolve(root,'db/migrations')).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(resolve(root,'db/migrations',file),'utf8'));
  sqlite.prepare("INSERT INTO settings(key,value) VALUES('roi_d1_write_budget_utc',?)")
    .run(JSON.stringify({date:'2026-10-11',reserved:0,oddsReserved:0,essentialReserved:0,optionalReserved:0,collectionReserved:0}));
  beforeinfo=readFileSync(resolve(root,'ml/tests/fixtures/boatrace_beforeinfo_actual_fragment.html'),'utf8');
});
afterEach(()=>sqlite.close());

describe('data-only prerace capture archive',()=>{
  it('stores one immutable row with both source hashes and all 120 odds without model or ticket writes',async()=>{
    const raceId=addRace(),requestBudget={used:0,max:49},pauses:number[]=[];
    const result=await collectBoatraceCaptureArchives(DB,new Date(FIXED_NOW),{
      now:()=>FIXED_NOW,requestBudget,sleep:async ms=>{pauses.push(ms)},fetch:fetchFor('2026-10-11',1),
    });
    expect(result).toMatchObject({status:'success',targets:1,attempted:2,records:1,failures:[]});
    expect(requestBudget.used).toBe(2);expect(pauses).toEqual([3000]);
    const row=sqlite.prepare('SELECT id,race_id,captured_at,archive_json FROM boatrace_prerace_capture_archives').get() as any;
    const archive=JSON.parse(row.archive_json);
    expect(row.race_id).toBe(raceId);
    expect(archive).toMatchObject({schema:'boat-prerace-capture-v1',race:{id:raceId,lanes:[1,2,3,4,5,6]},beforeinfo:{parserVersion:'boatrace-beforeinfo-v1',cutoffAt:'2026-10-11T15:19:00+09:00'},trifectaOdds:{parserVersion:'boatrace-trifecta-odds-v1',qualityStatus:'verified-complete-v1'}});
    expect(archive.beforeinfo.exhibitions).toHaveLength(6);
    expect(archive.beforeinfo.exhibitions[0]).toMatchObject({lane:1,exhibitionTime:6.78,tilt:-0.5,weight:53.3,startCourse:1,startTime:0.11,falseStart:false});
    expect(archive.beforeinfo.exhibitions[5].falseStart).toBe(true);
    expect(archive.beforeinfo.weatherObservedAt).toBeNull();
    expect(archive.beforeinfo.weatherObservationLabel).toBe('20:49現在');
    expect(archive.trifectaOdds.odds).toHaveLength(120);
    expect(archive.beforeinfo.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(archive.trifectaOdds.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(archive.beforeinfo.capturedAt).toBe(archive.trifectaOdds.capturedAt);
    expect(()=>sqlite.prepare('UPDATE boatrace_prerace_capture_archives SET archive_json=? WHERE id=?').run('{}',row.id)).toThrow(/immutable/);
    expect(()=>sqlite.prepare('DELETE FROM boatrace_prerace_capture_archives WHERE id=?').run(row.id)).toThrow(/immutable/);
    expect(Number((sqlite.prepare('SELECT COUNT(*) n FROM odds_snapshots').get() as any).n)).toBe(0);
    expect(Number((sqlite.prepare('SELECT COUNT(*) n FROM ticket_predictions').get() as any).n)).toBe(0);
    expect(Number((sqlite.prepare('SELECT COUNT(*) n FROM predictions').get() as any).n)).toBe(0);
    expect(Number((sqlite.prepare('SELECT COUNT(*) n FROM bets').get() as any).n)).toBe(0);
  });

  it('rejects incomplete markets, records a fixed failure reason, and rotates to the next race',async()=>{
    const first=addRace(1,10*60_000),second=addRace(2,11*60_000);
    const broken=fetchFor('2026-10-11',1,html=>html.replace('3連単オッズ','unrecognized market'));
    const initial=await collectBoatraceCaptureArchives(DB,new Date(FIXED_NOW),{
      maxRaces:1,now:()=>FIXED_NOW,fetch:broken,sleep:async()=>{},
    });
    expect(initial).toMatchObject({status:'failed',targets:1,records:0,failures:[{raceId:first,reason:'trifecta_market_incomplete'}]});
    expect(sqlite.prepare('SELECT COUNT(*) n FROM boatrace_prerace_capture_archives').get()).toMatchObject({n:0});
    const logged=sqlite.prepare("SELECT error,reason FROM collection_runs WHERE source='boatrace-prerace-archive-worker-v1'").get() as any;
    expect(logged.error).toContain(`${first}:trifecta_market_incomplete`);
    const calls:string[]=[];
    const next=await collectBoatraceCaptureArchives(DB,new Date(FIXED_NOW+60_000),{
      maxRaces:1,now:()=>FIXED_NOW+60_000,sleep:async()=>{},fetch:async url=>{calls.push(url);return fetchFor('2026-10-11',2)(url);},
    });
    expect(next).toMatchObject({status:'success',targets:1,records:1});
    expect(calls[0]).toContain('rno=2');
    expect(sqlite.prepare('SELECT race_id FROM boatrace_prerace_capture_archives').get()).toMatchObject({race_id:second});
  });

  it('advances past six-row candidates with an invalid lane set so later races are not starved',async()=>{
    const invalid=addRace(1,10*60_000),second=addRace(2,11*60_000);
    sqlite.prepare('UPDATE entries SET number=7 WHERE race_id=? AND number=6').run(invalid);
    const first=await collectBoatraceCaptureArchives(DB,new Date(FIXED_NOW),{
      maxRaces:1,now:()=>FIXED_NOW,sleep:async()=>{},fetch:fetchFor('2026-10-11',1),
    });
    expect(first).toMatchObject({status:'skipped',reason:'no_valid_six_lane_races',failures:[{raceId:invalid,reason:'entry_lane_set_not_six'}]});
    const secondRun=await collectBoatraceCaptureArchives(DB,new Date(FIXED_NOW+60_000),{
      maxRaces:1,now:()=>FIXED_NOW+60_000,sleep:async()=>{},fetch:fetchFor('2026-10-11',2),
    });
    expect(secondRun).toMatchObject({status:'success',records:1});
    expect(sqlite.prepare('SELECT race_id FROM boatrace_prerace_capture_archives').get()).toMatchObject({race_id:second});
  });

  it('fails closed before fetching when the existing odds write allowance is exhausted',async()=>{
    const raceId=addRace();
    sqlite.prepare("UPDATE settings SET value=? WHERE key='roi_d1_write_budget_utc'")
      .run(JSON.stringify({date:'2026-10-11',reserved:4_000,oddsReserved:4_000,essentialReserved:0,optionalReserved:4_000,collectionReserved:0}));
    let fetched=false;
    const result=await collectBoatraceCaptureArchives(DB,new Date(FIXED_NOW),{now:()=>FIXED_NOW,fetch:async()=>{fetched=true;throw new Error('unexpected');}});
    expect(result).toMatchObject({status:'skipped',reason:'d1_write_budget_unavailable_or_exhausted',targets:1,attempted:0,records:0});
    expect(fetched).toBe(false);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM boatrace_prerace_capture_archives').get()).toMatchObject({n:0});
    expect(sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key='boatrace_capture_archive_lock'").get()).toMatchObject({n:0});
    expect(sqlite.prepare('SELECT id FROM races WHERE id=?').get(raceId)).toBeTruthy();
  });

  it('exports a single date through existing bearer auth with a bounded cursor page',async()=>{
    const first=addRace(),second=addRace(2,11*60_000);
    const fetch=async(input:string)=>{
      const raceNo=Number(new URL(input).searchParams.get('rno'));
      return fetchFor('2026-10-11',raceNo)(input);
    };
    await collectBoatraceCaptureArchives(DB,new Date(FIXED_NOW),{now:()=>FIXED_NOW,sleep:async()=>{},fetch});
    const path='/api/ingest/prerace-capture-archives?date=2026-10-11&limit=1';
    expect((await app.request(path,{}, {DB,INGEST_TOKEN:'test-token'})).status).toBe(401);
    const response=await app.request(path,{headers:{authorization:'Bearer test-token'}},{DB,INGEST_TOKEN:'test-token'});
    expect(response.status).toBe(200);
    const pageOne=await response.json() as any;
    expect(pageOne).toMatchObject({schema:'boat-prerace-capture-export-v1',date:'2026-10-11',limit:1,archives:[{raceId:first}]});
    const wrapper=pageOne.archives[0];
    expect(wrapper.archiveSha256).toBe(createHash('sha256').update(wrapper.archiveJson,'utf8').digest('hex'));
    expect(JSON.parse(wrapper.archiveJson)).toMatchObject({schema:'boat-prerace-capture-v1'});
    expect(pageOne.nextCursor).toMatch(new RegExp(`^${first}:capture:\\d{13}$`));
    const pageTwo=await app.request(`${path}&cursor=${encodeURIComponent(pageOne.nextCursor)}`,{headers:{authorization:'Bearer test-token'}},{DB,INGEST_TOKEN:'test-token'});
    expect(await pageTwo.json()).toMatchObject({archives:[{raceId:second}],nextCursor:null});
    expect((await app.request('/api/ingest/prerace-capture-archives?date=2026-10-11&limit=26',{headers:{authorization:'Bearer test-token'}},{DB,INGEST_TOKEN:'test-token'})).status).toBe(400);
  });
});
