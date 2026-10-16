import { describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { D1SqliteAdapter } from './d1-adapter.js';
import { beforeinfoUrl } from '../src/services/boatraceBeforeinfo.js';
import { raceListUrl } from '../src/services/boatraceRaceList.js';
import { trifectaOddsUrl } from '../src/services/boatraceTrifectaOdds.js';
import { historyRacesAfterSnapshot, runNativeExperimentalForecast, type NativeExperimentalHistorySnapshot } from '../src/services/runNativeExperimentalForecast.js';

const root = resolve(import.meta.dirname, '../../..');
const sha = 'a'.repeat(64);
const zoned = (time: number) => new Date(time).toISOString();

describe('Worker-native experimental forecast orchestration', () => {
  it('accepts K-file history only after strict source, identity, rank, and point-in-time checks; prefers HTML proof', async()=>{
    const sqlite=new Sqlite(':memory:');for(const file of readdirSync(resolve(root,'db/migrations')).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(resolve(root,'db/migrations',file),'utf8'));
    const db=new D1SqliteAdapter(sqlite),date='2026-10-16',target='2026-10-17',predicted=Date.parse('2026-10-17T12:00:00Z'),bUrl='https://www1.mbrace.or.jp/od2/B/202610/b261016.lzh',kUrl='https://www1.mbrace.or.jp/od2/K/202610/k261016.lzh';
    const raceIds=['k-valid','html-preferred','id-mismatch','future-proof','partial-rank','pre-race-proof','pre-cutoff-proof'];
    const insertVenue=sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES(?,'boat',?)");for(let venue=1;venue<=raceIds.length;venue++)insertVenue.run(String(venue).padStart(2,'0'),`test${venue}`);
    const insertRace=sqlite.prepare("INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,betting_cutoff_at,status,data_origin,updated_at) VALUES(?,'boat',?,?,1,?,?,'finished','real',?)");
    const insertEntry=sqlite.prepare("INSERT INTO entries(id,race_id,number,name,features_json,available_at,data_origin) VALUES(?,?,?,? ,?,?,'real')");
    const insertResult=sqlite.prepare("INSERT INTO results(race_id,number,finish_order,data_origin) VALUES(?,?,?,'real')");
    for(const [index,raceId] of raceIds.entries()){const postTime=raceId==='pre-race-proof'?zoned(predicted-60000):raceId==='pre-cutoff-proof'?zoned(predicted-180000):null;const cutoff=raceId==='pre-cutoff-proof'?zoned(predicted-60000):null;insertRace.run(raceId,String(index+1).padStart(2,'0'),date,postTime,cutoff,zoned(predicted-100000));for(let lane=1;lane<=6;lane++){const racerId=String(1000+lane);insertEntry.run(`${raceId}-${lane}`,raceId,lane,`racer${lane}`,JSON.stringify({racer_id:racerId,source_url:bUrl,source_sha256:sha,source_available_at:zoned(predicted-200000)}),zoned(predicted-200000));insertResult.run(raceId,lane,lane);}}
    const proofFor=(raceId:string,fetchAt:number,mutate?:'id'|'partial')=>({raceId,laneIdentities:Array.from({length:6},(_,i)=>({number:i+1,racerId:String(1001+i+(mutate==='id'&&i===0?1:0))})),results:Array.from({length:mutate==='partial'?5:6},(_,i)=>({number:i+1,finishOrder:i+1}))});
    const addK=(fileHash:string,fetchAt:number,rows:Array<[string,'id'|'partial'|undefined]>,unrelated=0)=>{const extras=Array.from({length:unrelated},(_,i)=>({raceId:`unrelated-${i}`,laneIdentities:[],results:[]}));const body={schema:'boat-k-file-result-proof-v1',quality:'official-k-file-parser-v1',kind:'K',targetDate:date,url:kUrl,sha256:fileHash,fetchedAt:zoned(fetchAt),parserVersion:'boatrace-bk-ts-v1',r2Key:`boat-program-files/${date}/k/${fileHash}.lzh`,manifestKey:`boat-program-manifests/${date}/k/${fileHash}-boatrace-bk-ts-v1.json`,raceProofs:[...rows.map(([raceId,mutate])=>proofFor(raceId,fetchAt,mutate)),...extras]};sqlite.prepare("INSERT INTO collection_runs(id,source,sport,target_date,started_at,status,reason) VALUES(?, 'boatrace-k-file-worker-v1','boat',?,?,'success',?)").run(`boat-k-file:${date}:${fileHash}`,date,zoned(fetchAt),JSON.stringify(body));};
    const kAt=predicted-10000;addK(sha,kAt,[['k-valid',undefined],['html-preferred',undefined],['id-mismatch','id'],['partial-rank','partial']],150);addK('b'.repeat(64),predicted+1,[['future-proof',undefined]]);addK('c'.repeat(64),predicted-120000,[['pre-race-proof',undefined],['pre-cutoff-proof',undefined]]);
    const htmlAt=kAt-1000,htmlResultUrl=`https://www.boatrace.jp/owpc/pc/race/raceresult?rno=1&jcd=02&hd=20261016`;
    const htmlBody={raceId:'html-preferred',quality:'verified-official-outcome-v2',url:htmlResultUrl,sha256:sha,fetchedAt:zoned(htmlAt),results:Array.from({length:6},(_,i)=>({number:i+1,finishOrder:i+1}))};
    sqlite.prepare("INSERT INTO collection_runs(id,source,sport,target_date,started_at,status,reason) VALUES(?, 'boatrace-results-worker-v1','boat',?,?,'success',?)").run('boat-result:html-preferred',date,zoned(htmlAt),JSON.stringify(htmlBody));
    sqlite.prepare("INSERT INTO collection_runs(id,source,sport,target_date,started_at,status,reason) VALUES(?, 'boatrace-k-file-worker-v1','boat',?,?,'success',?)").run(`boat-k-file:${date}:malformed`,date,zoned(predicted-300000),'not-json');
    const snapshot:NativeExperimentalHistorySnapshot={schema:'native-racer-history-v1',asOf:zoned(Date.parse('2026-10-16T00:00:00Z')),throughRaceDate:'2026-10-15',totals:{}};
    const projectedReasons:string[]=[];
    const projectedDb:any={prepare(sql:string){const statement=db.prepare(sql);return{bind(...values:unknown[]){const bound=statement.bind(...values);return{all:async()=>{const result=await bound.all();if(sql.includes("json_set(kc.reason,'$.raceProofs'"))projectedReasons.push(...result.results.map((row:any)=>String(row.reason)));return result;},first:()=>bound.first(),run:()=>bound.run()};}};}};
    const history=await historyRacesAfterSnapshot(projectedDb,snapshot,target,predicted,Array.from({length:6},(_,i)=>String(1001+i)));
    expect(history?.map(row=>row.race.id).sort()).toEqual(['html-preferred','k-valid']);
    expect(history?.find(row=>row.race.id==='k-valid')?.results[0]?.available_at).toBe(zoned(kAt));
    expect(history?.find(row=>row.race.id==='html-preferred')?.results[0]?.available_at).toBe(zoned(htmlAt));
    expect(projectedReasons.length).toBeGreaterThan(0);
    const projectedCounts=projectedReasons.map(reason=>JSON.parse(reason).raceProofs?.length).filter((count):count is number=>typeof count==='number');
    expect(projectedCounts.length).toBeGreaterThan(0);expect(Math.max(...projectedCounts)).toBeLessThanOrEqual(raceIds.length);
    sqlite.close();
  });

  it('generates a source-bound 120-row forecast and delegates storage once', async () => {
    const sqlite = new Sqlite(':memory:');
    for (const file of readdirSync(resolve(root, 'db/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(resolve(root, 'db/migrations', file), 'utf8'));
    }
    const db = new D1SqliteAdapter(sqlite);
    const now = Date.parse('2026-10-16T03:00:00.000Z');
    const target = now + 5_000, cutoff = target + 60_000, raceId = 'native-test-race';
    const day = '2026-10-16', modelId = 'boat-trifecta-exp-noweather-20261013-10559e2c79ce';
    const bundle = JSON.parse(readFileSync(resolve(root, 'apps/api/src/models/experimental-worker-model.json'), 'utf8'));
    const metadata = {
      id: modelId, status: 'candidate', trainingMode: 'experimental', experimentalOnly: true,
      ticketArtifactSha256: '386ff046f73d0f604a293d2c7318acc794857d9448f1addaf3f164863a91bdda', boatFeatureSchemaVersion: 'boat-prerace-v2-no-weather-experimental-v1',
      ticketModelSchemaVersion: 'ticket-selection-v1', ticketPredictionSemantics: 'exact-selection-probability-v1',
      metrics: { promotionEligible: false, profitabilityProven: false },
    };
    const artifactSha = bundle.artifactSha256;
    const manifest = { schema: 'edgelab-experimental-trifecta-artifact-v1', modelId,
      trainingMode: 'experimental', experimentalOnly: true, files: { [modelId + '.pkl']: { sha256: artifactSha } } };
    sqlite.prepare(`INSERT INTO experimental_models(id,status,manifest_schema,sport,bet_type,training_mode,schema_version,artifact_sha256,manifest_sha256,metadata_sha256,trained_at,artifact_manifest_json,manifest_json,registered_at)
      VALUES(?, 'candidate','edgelab-experimental-trifecta-artifact-v1','boat','trifecta','experimental','boat-prerace-v2-no-weather-experimental-v1',?,?,?, ?,?,?,?)`)
      .run(modelId, artifactSha, sha, sha, zoned(now - 86400_000), JSON.stringify(manifest), JSON.stringify(metadata), zoned(now - 86400_000));
    sqlite.prepare(`INSERT INTO venues(id,sport,name) VALUES('01','boat','test')`).run();
    sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at,betting_cutoff_at,betting_cutoff_source,betting_cutoff_observed_at)
      VALUES(?, 'boat','01',?,1,?,'scheduled','real',?,?, 'boatrace-racelist-cutoff-v1',?)`)
      .run(raceId, day, zoned(cutoff + 3_600_000), zoned(now), zoned(cutoff), zoned(now - 1_000));
    const sourceUrl = `https://www1.mbrace.or.jp/od2/B/202610/b261016.lzh`;
    const entryFeatures = Array.from({ length: 6 }, (_, i) => ({ racer_id: String(1000 + i), national_2rate: 30 + i,
      local_2rate: 25 + i, age: 30 + i, source_available_at: zoned(now - 60_000), source_sha256: sha, source_url: sourceUrl }));
    const entryInsert = sqlite.prepare(`INSERT INTO entries(id,race_id,number,name,weight_carried,racer_class,national_win_rate,local_win_rate,motor_2rate,boat_2rate,features_json,available_at,data_origin)
      VALUES(?,?,?,?,?,'A1',3,2,30,31,?,?,'real')`);
    entryFeatures.forEach((features, i) => entryInsert.run(`entry-${i + 1}`, raceId, i + 1, `racer-${i + 1}`, 50, JSON.stringify(features), zoned(now - 60_000)));
    const capture = zoned(now - 2_000), cutoffAt = zoned(cutoff);
    const archive = { schema: 'boat-prerace-capture-v1', race: { id: raceId, date: day, venueCode: '01', raceNo: 1, lanes: [1,2,3,4,5,6] }, capturedAt: capture,
      raceList: { url: raceListUrl(1,'01',day), sha256: sha, capturedAt: capture, cutoffAt, entries: entryFeatures.map((_, i) => ({ lane:i+1, registrationNumber:String(1000+i) })) },
      beforeinfo: { url: beforeinfoUrl(1,'01',day), sha256: sha, capturedAt: capture, exhibitions: entryFeatures.map((_, i) => ({ lane:i+1, exhibitionTime:6.8+i/100 })) },
      trifectaOdds: { url: trifectaOddsUrl(1,'01',day), sha256: sha, capturedAt: capture, qualityStatus:'verified-complete-v1', final:false,
        odds: Array.from({ length: 6 }, (_, a) => Array.from({ length: 6 }, (_, b) => Array.from({ length: 6 }, (_, c) => [a,b,c])))
          .flat(2).filter(([a,b,c]) => a!==b && a!==c && b!==c).map(([a,b,c]) => ({ selection:`${a+1}-${b+1}-${c+1}`, odds:200 })) } };
    sqlite.prepare(`INSERT INTO boatrace_prerace_capture_archives(id,race_id,race_date,captured_at,archive_json,data_origin) VALUES(?,?,?,?,?,'real')`)
      .run('native-test-archive', raceId, day, capture, JSON.stringify(archive));
    const irrelevantRace = sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at)
      VALUES(?,'boat','01',?,?,'finished','real',?)`);
    const irrelevantRun = sqlite.prepare(`INSERT INTO collection_runs(id,source,sport,target_date,started_at,status)
      VALUES(?,'boatrace-results-worker-v1','boat',?,?,'success')`);
    for (let i = 0; i < 1_001; i++) {
      const date = new Date(Date.UTC(2026, 9, 2 + Math.floor(i / 72))).toISOString().slice(0, 10);
      const pastRace = `irrelevant-${i}`;
      irrelevantRace.run(pastRace, date, (i % 72) + 1, zoned(now));
      irrelevantRun.run(`boat-result:${pastRace}`, date, zoned(now + i));
    }
    const historySnapshot: NativeExperimentalHistorySnapshot = { schema:'native-racer-history-v1', asOf:zoned(now - 86_400_000), throughRaceDate:'2026-10-01', totals:{} };
    let storedBody: any;
    const result = await runNativeExperimentalForecast(db, bundle, historySnapshot, {
      now: () => now, storeForecast: async body => { storedBody = body; return { status:200 }; }, log: () => undefined,
    });
    expect(result).toMatchObject({ status:'completed', evaluated:1, stored:1 });
    expect(storedBody.races[0].predictions).toHaveLength(120);
    expect(storedBody.races[0].predictedAt).toBe(zoned(now));
    const repeated = await runNativeExperimentalForecast(db, bundle, historySnapshot, {
      now: () => now, storeForecast: async () => { throw new Error('same archive must not be stored twice'); }, log: () => undefined,
    });
    expect(repeated).toMatchObject({ status:'no-eligible-races', stored:0 });
    sqlite.close();
  });
});
