import { createHash } from 'node:crypto';
import Sqlite from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1SqliteAdapter } from './d1-adapter.js';
import { collectTrifectaOdds } from '../src/services/collectBoatraceTrifectaOdds.js';

const root=resolve(import.meta.dirname,'../../..');
let sqlite:Sqlite.Database,DB:D1SqliteAdapter;
const jstIso=(ms=Date.now())=>new Date(ms+9*60*60*1000).toISOString().replace('Z','+09:00');
function livePage(raceDate:string,raceNo=3){
  const firsts=[1,2,3,4,5,6];
  const head=`<thead><tr>${firsts.map(n=>`<th>${n}</th>`).join('')}</tr></thead>`;
  const body:string[]=[];
  for(let group=0;group<5;group++)for(let row=0;row<4;row++){
    const cells=firsts.map(columnFirst=>{
      const seconds=firsts.filter(n=>n!==columnFirst),second=seconds[group];
      const thirds=firsts.filter(n=>n!==columnFirst&&n!==second),third=thirds[row];
      return `${row===0?`<td rowspan="4">${second}</td>`:''}<td>${third}</td><td class="oddsPoint">${12+group+row+columnFirst/10}</td>`;
    }).join('');
    body.push(`<tr>${cells}</tr>`);
  }
  return `<div class="tab3"><a href="/owpc/pc/race/racelist?rno=${raceNo}&amp;jcd=09&amp;hd=${raceDate.replaceAll('-','')}">出走表</a><a href="/owpc/pc/race/raceresult?rno=${raceNo}&amp;jcd=09&amp;hd=${raceDate.replaceAll('-','')}">結果</a></div><p class="tab4_time">オッズ更新時間 13:00</p><span>3連単オッズ</span><table>${head}<tbody>${body.join('')}</tbody></table>`;
}
beforeEach(()=>{
  sqlite=new Sqlite(':memory:');DB=new D1SqliteAdapter(sqlite);
  for(const file of readdirSync(resolve(root,'db/migrations')).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(resolve(root,'db/migrations',file),'utf8'));
  const raceDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('09','boat','Test venue')").run();
  sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at) VALUES('boat-collector-test','boat','09',?,3,?,'scheduled','real',?)").run(raceDate,jstIso(Date.now()+10*60_000),jstIso());
  for(let number=1;number<=6;number++)sqlite.prepare("INSERT INTO entries(id,race_id,number,name,available_at,data_origin) VALUES(?,?,?,? ,?,'real')").run(`collector-${number}`,'boat-collector-test',number,`Runner ${number}`,jstIso());
});
afterEach(()=>sqlite.close());

describe('trifecta odds collector provenance',()=>{
  it('stores a complete live official page hash and uses the shared per-cron fetch budget',async()=>{
    const date=sqlite.prepare("SELECT race_date FROM races WHERE id='boat-collector-test'").get() as {race_date:string};
    const body=livePage(date.race_date),bytes=new TextEncoder().encode(body),requestBudget={used:48,max:49},pauses:number[]=[];
    const result=await collectTrifectaOdds(DB,new Date(),{requestBudget,sleep:async(ms)=>{pauses.push(ms)},fetch:async()=>({ok:true,status:200,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)})});
    expect(result).toMatchObject({status:'success',records:120,targets:1,attempted:1});
    expect(requestBudget.used).toBe(49);
    expect(pauses).toEqual([3000]); // shared budget means a prior win fetch also requires spacing
    const evidence=sqlite.prepare("SELECT COUNT(*) n,MIN(source_sha256) hash,MAX(source_sha256) hash2,MIN(quality_status) quality,MIN(source) source,MIN(source_url) url FROM odds_snapshots WHERE race_id='boat-collector-test' AND bet_type='trifecta'").get() as any;
    expect(evidence).toMatchObject({n:120,hash:createHash('sha256').update(bytes).digest('hex'),hash2:createHash('sha256').update(bytes).digest('hex'),quality:'verified-complete-v1',source:'boatrace-trifecta-official-v1',url:expect.stringContaining('/odds3t?')});
  });

  it('waits at least three seconds between pages and stores no odds for a malformed market',async()=>{
    const date=sqlite.prepare("SELECT race_date FROM races WHERE id='boat-collector-test'").get() as {race_date:string};
    sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at) VALUES('boat-collector-test-2','boat','09',?,4,?,'scheduled','real',?)").run(date.race_date,jstIso(Date.now()+11*60_000),jstIso());
    for(let number=1;number<=6;number++)sqlite.prepare("INSERT INTO entries(id,race_id,number,name,available_at,data_origin) VALUES(?,?,?,? ,?,'real')").run(`collector2-${number}`,'boat-collector-test-2',number,`Runner ${number}`,jstIso());
    const good=new TextEncoder().encode(livePage(date.race_date,3)),bad=new TextEncoder().encode(livePage(date.race_date,4).replace('3連単オッズ','unrecognized market'));
    const pauses:number[]=[],fetches:{url:string}[]=[];
    const result=await collectTrifectaOdds(DB,new Date(),{maxRequests:2,sleep:async(ms)=>{pauses.push(ms)},fetch:async(input)=>{
      fetches.push({url:input});const bytes=input.includes('rno=3')?good:bad;
      return {ok:true,status:200,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
    }});
    expect(result).toMatchObject({status:'partial',records:120,targets:2,failed:1,attempted:2});
    expect(pauses).toEqual([3000]);expect(fetches).toHaveLength(2);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM odds_snapshots WHERE race_id='boat-collector-test'").get()).toMatchObject({n:120});
    expect(sqlite.prepare("SELECT COUNT(*) n FROM odds_snapshots WHERE race_id='boat-collector-test-2'").get()).toMatchObject({n:0});
  });
});
