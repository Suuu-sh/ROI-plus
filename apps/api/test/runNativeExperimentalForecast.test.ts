import { describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { D1SqliteAdapter } from './d1-adapter.js';
import { beforeinfoUrl } from '../src/services/boatraceBeforeinfo.js';
import { raceListUrl } from '../src/services/boatraceRaceList.js';
import { trifectaOddsUrl } from '../src/services/boatraceTrifectaOdds.js';
import { runNativeExperimentalForecast, type NativeExperimentalHistorySnapshot } from '../src/services/runNativeExperimentalForecast.js';

const root = resolve(import.meta.dirname, '../../..');
const sha = 'a'.repeat(64);
const zoned = (time: number) => new Date(time).toISOString();

describe('Worker-native experimental forecast orchestration', () => {
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
