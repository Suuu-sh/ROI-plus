import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { D1SqliteAdapter } from './d1-adapter.js';
import { parseBoatraceProgramText, syncBoatraceProgramFile } from '../src/services/boatraceProgramSync.js';

const fixture = (name: string) => readFile(new URL(`../../../data/fixtures/boatrace/${name}`, import.meta.url), 'utf8');
const root = resolve(import.meta.dirname, '../../..');
function createDb() {
  const sqlite = new Sqlite(':memory:');
  for (const file of readdirSync(resolve(root, 'db/migrations')).filter(name => name.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(resolve(root, 'db/migrations', file), 'utf8'));
  return { sqlite, db: new D1SqliteAdapter(sqlite) };
}
function syntheticBText(date:string) {
  const [year,month,day]=date.split('-');
  const lines=[`24BBGN\nボートレース大村　${year}年  ${Number(month)}月  ${Number(day)}日`];
  for(const venue of ['24','21','20','19','18']) {
    if(venue!=='24')lines.push(`${venue}BBGN`);
    for(let race=1;race<=12;race++) {
      lines.push(` ${race}R 予選 H1800m  12:00`);
      for(let lane=1;lane<=6;lane++)lines.push(`${lane} ${String(1000+venue.charCodeAt(0)+lane).slice(-4)}架空選手 30長崎55B1 5.00 30.00 4.00 20.00 50 30.00 60 35.00`);
    }
  }
  return lines.join('\n');
}

describe('Worker B/K program parser', () => {
  it('parses B fixture rows with stable official identities and missing fields', async () => {
    const parsed = parseBoatraceProgramText('B', await fixture('b260901.utf8.txt'), '2026-09-01');
    expect(parsed.races).toHaveLength(2);
    expect(parsed.entries).toHaveLength(12);
    expect(parsed.races[0]).toMatchObject({ id:'boat-20260901-24-01', race_date:'2026-09-01', status:'scheduled', post_time:'2026-09-01T12:00:00+09:00' });
    expect(parsed.entries[0]).toMatchObject({ race_id:'boat-20260901-24-01', number:1, features_json:expect.stringContaining('racer_id') });
    expect(parsed.entries[0].exhibition_time).toBeNull();
  });

  it('parses K fixture results and payouts without treating result ST as pre-race data', async () => {
    const parsed = parseBoatraceProgramText('K', await fixture('k260901.utf8.txt'), '2026-09-01');
    expect(parsed.races).toHaveLength(2);
    expect(parsed.entries).toHaveLength(12);
    expect(parsed.results).toHaveLength(12);
    expect(parsed.payouts).toHaveLength(6);
    expect(parsed.races[0]).toMatchObject({ id:'boat-20260901-24-01', status:'finished' });
    expect(parsed.entries[0]).toMatchObject({ number:1, start_exhibition:null, exhibition_time:6.9 });
    expect(parsed.results[0]).toMatchObject({ finish_order:1, number:1 });
    expect(parsed.payouts[0]).toMatchObject({ bet_type:'win', selection:'1', payout:100 });
  });

  it('uses the embedded source date rather than guessing from the scheduled invocation', () => {
    const parsed = parseBoatraceProgramText('B', 'ボートレース大村 2026年 9月 1日\n24BBGN\n1R Ｈ1800m', '2026-09-02');
    expect(parsed.races[0]?.race_date).toBe('2026-09-01');
  });

  it('resumes a large B import without refetching, uses bounded chunks, and keeps the first observed evidence immutable', async () => {
    const {sqlite,db:baseDb}=createDb();
    const statements:string[]=[],batchSizes:number[]=[];
    const db:any={prepare(sql:string){statements.push(sql);return baseDb.prepare(sql);},batch:(items:any[])=>{batchSizes.push(items.length);return baseDb.batch(items);}};
    const objects=new Map<string,{body:Uint8Array;metadata?:Record<string,string>}>();
    const bucket:any={
      head:async(key:string)=>objects.has(key)?{size:objects.get(key)!.body.length,customMetadata:objects.get(key)!.metadata}:null,
      get:async(key:string)=>{const item=objects.get(key);return item?{size:item.body.length,text:async()=>new TextDecoder().decode(item.body),arrayBuffer:async()=>item.body.buffer}:null;},
      put:async(key:string,value:Uint8Array|string,options:any={})=>{const body=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);objects.set(key,{body,metadata:options.customMetadata});},
    };
    const bytes=new Uint8Array([1,2,3,4]);
    const fetcher=vi.fn(async()=>new Response(bytes,{headers:{'content-length':String(bytes.length)}}));
    let now=Date.parse('2026-10-16T18:10:00Z');
    const invoke=()=>syncBoatraceProgramFile(db,bucket,new Date(now),'B',{targetDate:'2026-10-17',now:()=>now,fetch:fetcher as typeof fetch,minGapMs:0,decodeArchive:async()=>({text:syntheticBText('2026-10-17')})});
    // The actual local date must match the requested target date; run on Oct 17 JST.
    now=Date.parse('2026-10-16T18:10:00Z');
    const first=await invoke();
    expect(first).toMatchObject({status:'partial',reason:'source-sync-in-progress',sourceSha256:expect.any(String),fetchedAt:expect.any(String)});
    const cursor=JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key='boatrace-program-sync:B:2026-10-17'").get() as any).value as string);
    expect(cursor.offset).toBe(400);
    expect(batchSizes.slice(-5)).toEqual([80,80,80,80,80]);
    now+=60_000;
    const second=await invoke();
    expect(second).toMatchObject({status:'partial',reason:'source-sync-in-progress',sourceSha256:first.sourceSha256,fetchedAt:first.fetchedAt});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(batchSizes.slice(-5)).toEqual([80,80,80,80,80]);
    now+=60_000;
    const third=await invoke();
    expect(third).toMatchObject({status:'success',sourceSha256:first.sourceSha256,fetchedAt:first.fetchedAt});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((sqlite.prepare("SELECT json_extract(reason,'$.kind') AS kind FROM collection_runs WHERE source='boatrace-program-files-worker-v1' AND target_date='2026-10-17'").get() as any)?.kind).toBe('B');
    now+=60_000;
    const sameArchiveAgain=await invoke();
    expect(sameArchiveAgain).toMatchObject({status:'partial',sourceSha256:first.sourceSha256,fetchedAt:first.fetchedAt});
    expect(fetcher).toHaveBeenCalledTimes(2);
    now+=60_000;
    const immutable=await invoke();
    expect(immutable).toMatchObject({status:'success',sourceSha256:first.sourceSha256,fetchedAt:first.fetchedAt});
    expect(fetcher).toHaveBeenCalledTimes(2);
    const feature=JSON.parse((sqlite.prepare("SELECT features_json FROM entries WHERE race_id='boat-20261017-24-01' AND number=1").get() as any).features_json as string);
    expect(feature).toMatchObject({source_sha256:first.sourceSha256,source_available_at:first.fetchedAt,source_url:expect.stringContaining('/od2/B/')});
    const manifests=[...objects.entries()].filter(([key])=>key.includes('boat-program-manifests/'));
    expect(manifests).toHaveLength(1);
    const stored=JSON.parse(new TextDecoder().decode(manifests[0]![1].body));
    expect(stored.fetchedAt).toBe(first.fetchedAt);
    expect(statements.find(sql=>sql.includes("json_extract(reason,'$.kind')"))).toContain("json_extract(reason,'$.kind')=?");
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM races WHERE race_date='2026-10-17'").get() as any).count).toBe(60);
    sqlite.close();
  });
});
