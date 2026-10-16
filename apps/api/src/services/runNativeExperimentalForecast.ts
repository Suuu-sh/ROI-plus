import { all, first, type Db } from '../repo/db.js';
import { boatArchiveEvidenceValid } from './boatArchiveEvidence.js';
import { BOATRACE_CUTOFF_MAX_AGE_MS } from './boatraceCutoff.js';
import {
  buildNativeExperimentalFeatures,
  predictNativeExactTrifecta,
  validateNativeExperimentalModel,
  type NativeExperimentalModel,
  type NativeRaceFeatureInput,
} from './nativeExperimentalForecast.js';

const RESULT_WORKER_SOURCE = 'boatrace-results-worker-v1';
const K_FILE_SOURCE = 'boatrace-k-file-worker-v1';
const K_FILE_SCHEMA = 'boat-k-file-result-proof-v1';
const PROGRAM_PARSER_VERSION = 'boatrace-bk-ts-v1';
const TRUSTED_CUTOFF_SOURCE = 'boatrace-racelist-cutoff-v1';
const FEATURE_SCHEMA = 'boat-prerace-v2-no-weather-experimental-v1';
const TICKET_SCHEMA = 'ticket-selection-v1';
const PREDICTION_SEMANTICS = 'exact-selection-probability-v1';
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_HISTORY_RACES = 1_000;
const MAX_CANDIDATES = 180;
const officialBFileUrl = (date: string) => `https://www1.mbrace.or.jp/od2/B/${date.slice(0, 7).replace('-', '')}/b${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}.lzh`;
const officialKFileUrl = (date: string) => `https://www1.mbrace.or.jp/od2/K/${date.slice(0, 7).replace('-', '')}/k${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}.lzh`;

export interface NativeExperimentalHistorySnapshot {
  schema: 'native-racer-history-v1';
  asOf: string;
  throughRaceDate: string;
  totals: Record<string, { starts: number; wins: number }>;
}

export interface NativeForecastBody {
  schema: 'edgelab-experimental-trifecta-forecast-v1';
  modelId: string;
  artifactSha256: string;
  trainingMode: 'experimental';
  experimentalOnly: true;
  ticketModelSchemaVersion: typeof TICKET_SCHEMA;
  ticketPredictionSemantics: typeof PREDICTION_SEMANTICS;
  boatFeatureSchemaVersion: typeof FEATURE_SCHEMA;
  races: Array<{
    raceId: string;
    predictedAt: string;
    predictions: Array<{ selection: string; probability: number; prob_std: number | null }>;
  }>;
}

export type NativeForecastStore = (body: NativeForecastBody) => Promise<void | { status?: number }>;
export type NativeForecastLog = (line: string) => void;

export interface NativeForecastRunOptions {
  now?: () => number;
  storeForecast: NativeForecastStore;
  log?: NativeForecastLog;
}

export interface NativeForecastRunResult {
  status: 'no-model' | 'model-mismatch' | 'no-eligible-races' | 'completed' | 'storage-rejected';
  evaluated: number;
  stored: number;
}

type RegistryModel = {
  id: string;
  status: string;
  artifact_sha256: string;
  trained_at: string;
  manifest_json: string;
};

const validInstant = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const isoNow = (timestamp: number) => new Date(timestamp).toISOString();
const jstDate = (timestamp: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(timestamp));

function sourceBoundEntries(entries: Array<Record<string, unknown>>, raceDate: string, predictedAt: number): boolean {
  if (entries.length !== 6 || entries.some((entry, index) => Number(entry.number) !== index + 1
      || entry.data_origin !== 'real')) return false;
  const features = entries.map(entry => {
    const availableAt = validInstant(entry.available_at);
    let extra: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(String(entry.features_json ?? '{}'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed as Record<string, unknown>;
    } catch { return null; }
    const sourceAvailableAt = validInstant(extra.source_available_at);
    const digest = extra.source_sha256;
    return { entry, extra, availableAt, sourceAvailableAt, digest };
  });
  if (features.some(row => !row) || features.some(row => {
    if (!row) return true;
    const { entry, extra, availableAt, sourceAvailableAt, digest } = row;
    if (availableAt === null || sourceAvailableAt === null || typeof digest !== 'string') return true;
    return availableAt > predictedAt || sourceAvailableAt > predictedAt || sourceAvailableAt !== availableAt
      || extra.source_url !== officialBFileUrl(raceDate) || !SHA256.test(digest);
  })) return false;
  return new Set(features.map(row => row?.digest)).size === 1;
}

function archiveObservations(archive: Record<string, any>, archiveId: string, raceId: string) {
  const beforeinfo = archive.beforeinfo;
  if (!beforeinfo || !Array.isArray(beforeinfo.exhibitions)) return [];
  const fields: Record<string, string> = {
    exhibitionTime: 'exhibition_time', tilt: 'tilt', weight: 'weight',
    startCourse: 'start_exhibition_course', startTime: 'start_exhibition',
    falseStart: 'start_exhibition_false_start',
  };
  return beforeinfo.exhibitions.map((row: Record<string, unknown>) => {
    const values: Record<string, unknown> = {};
    for (const [source, target] of Object.entries(fields)) values[target] = row[source] ?? null;
    const capturedAt = beforeinfo.capturedAt;
    return {
      id: `${archiveId}:exhibition:${row.lane}`, race_id: raceId, kind: 'exhibition',
      entry_number: row.lane, source_url: beforeinfo.url, source_sha256: beforeinfo.sha256,
      source_observed_at: null, source_observation_label: null,
      fetched_at: capturedAt, available_at: capturedAt,
      values_json: JSON.stringify(values), data_origin: 'real',
    };
  });
}

function validRegistryMetadata(row: RegistryModel): boolean {
  if (!SHA256.test(row.artifact_sha256)) return false;
  try {
    const metadata = JSON.parse(row.manifest_json);
    return metadata && metadata.id === row.id && metadata.status === 'candidate'
      && metadata.trainingMode === 'experimental' && metadata.experimentalOnly === true
      && metadata.ticketArtifactSha256 === row.artifact_sha256
      && metadata.boatFeatureSchemaVersion === FEATURE_SCHEMA
      && metadata.ticketModelSchemaVersion === TICKET_SCHEMA
      && metadata.ticketPredictionSemantics === PREDICTION_SEMANTICS
      && metadata.metrics?.promotionEligible === false && metadata.metrics?.profitabilityProven === false;
  } catch { return false; }
}

export async function historyRacesAfterSnapshot(db: Db, snapshot: NativeExperimentalHistorySnapshot,
                                         targetDate: string, predictedAt: number, racerIds: string[]) {
  const races = await all<Record<string, unknown>>(db, `SELECT r.* FROM races r
    WHERE r.sport='boat' AND r.data_origin='real' AND r.status='finished'
      AND r.race_date>? AND r.race_date<?
      AND (EXISTS(SELECT 1 FROM collection_runs cr WHERE cr.id='boat-result:'||r.id AND cr.source=? AND cr.sport='boat' AND cr.status='success')
        OR EXISTS(SELECT 1 FROM collection_runs kc,json_each(CASE WHEN json_valid(kc.reason) THEN kc.reason ELSE '{}' END,'$.raceProofs') kp WHERE kc.source=? AND kc.sport='boat' AND kc.status='success' AND kc.target_date=r.race_date AND json_valid(kc.reason) AND json_extract(kp.value,'$.raceId')=r.id))
      AND EXISTS(SELECT 1 FROM entries target_entry WHERE target_entry.race_id=r.id AND target_entry.data_origin='real'
        AND json_valid(target_entry.features_json)
        AND json_extract(target_entry.features_json,'$.racer_id') IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
    ORDER BY r.race_date,r.id LIMIT ?`, snapshot.throughRaceDate, targetDate, RESULT_WORKER_SOURCE, K_FILE_SOURCE,
  JSON.stringify(racerIds), MAX_HISTORY_RACES + 1);
  if (races.length > MAX_HISTORY_RACES) return null;
  const ids = races.map(row => String(row.id));
  if (!ids.length) return [];
  const encodedIds = JSON.stringify(ids);
  const [entries, results, proofs] = await Promise.all([
    all<Record<string, unknown>>(db, `SELECT * FROM entries WHERE data_origin='real'
      AND race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id,number`, encodedIds),
    all<Record<string, unknown>>(db, `SELECT * FROM results WHERE data_origin='real'
      AND race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id,number`, encodedIds),
    all<{ id: string; source:string; target_date:string; started_at:string; reason: string | null }>(db, `SELECT id,source,target_date,started_at,reason FROM collection_runs
      WHERE source=? AND status='success' AND id IN (SELECT 'boat-result:'||value FROM json_each(?))
      UNION ALL
      SELECT kc.id,kc.source,kc.target_date,kc.started_at,
        json_set(kc.reason,'$.raceProofs',json(COALESCE((SELECT json_group_array(json(kp2.value))
          FROM json_each(CASE WHEN json_valid(kc.reason) THEN kc.reason ELSE '{}' END,'$.raceProofs') kp2
          WHERE json_extract(kp2.value,'$.raceId') IN (SELECT value FROM json_each(?))), '[]'))) AS reason
      FROM collection_runs kc
      WHERE kc.source=? AND kc.sport='boat' AND kc.status='success' AND kc.target_date>? AND kc.target_date<? AND json_valid(kc.reason)
        AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(kc.reason) THEN kc.reason ELSE '{}' END,'$.raceProofs') kp
          WHERE json_extract(kp.value,'$.raceId') IN (SELECT value FROM json_each(?)))`,
    RESULT_WORKER_SOURCE, encodedIds,encodedIds,K_FILE_SOURCE,snapshot.throughRaceDate,targetDate,encodedIds),
  ]);
  const raceById = new Map(races.map(row => [String(row.id), row]));
  const entryByRace = new Map<string, Array<Record<string, unknown>>>();
  const resultByRace = new Map<string, Array<Record<string, unknown>>>();
  for (const row of entries) entryByRace.set(String(row.race_id), [...(entryByRace.get(String(row.race_id)) ?? []), row]);
  for (const row of results) resultByRace.set(String(row.race_id), [...(resultByRace.get(String(row.race_id)) ?? []), row]);
  const proofByRace = new Map<string, Array<{source:string;startedAt:string;proof:Record<string,unknown>}>>();
  for (const proof of proofs) {
    try {
      const parsed: unknown = JSON.parse(String(proof.reason ?? ''));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const body=parsed as Record<string,unknown>;
      if(proof.source===RESULT_WORKER_SOURCE){const raceId=proof.id.slice('boat-result:'.length);proofByRace.set(raceId,[...(proofByRace.get(raceId)??[]),{source:proof.source,startedAt:proof.started_at,proof:body}]);}
      else if(proof.source===K_FILE_SOURCE&&Array.isArray(body.raceProofs))for(const item of body.raceProofs){if(item&&typeof item==='object'&&!Array.isArray(item)){const raceId=String((item as Record<string,unknown>).raceId??'');proofByRace.set(raceId,[...(proofByRace.get(raceId)??[]),{source:proof.source,startedAt:proof.started_at,proof:{...body,raceProof:item}}]);}}
    } catch { /* malformed result-worker evidence is excluded */ }
  }
  const history: NativeRaceFeatureInput['historyRaces'] = [];
  for (const raceId of ids) {
    const race = raceById.get(raceId)!;
    const candidates=proofByRace.get(raceId)??[];
    const dbResults = resultByRace.get(raceId) ?? [];
    if(dbResults.length!==6)continue;
    const historyEntries = entryByRace.get(raceId) ?? [];
    const resultMap = new Map(dbResults.map(row => [Number(row.number), Number(row.finish_order)]));
    if(resultMap.size!==6||[...resultMap.values()].sort((a,b)=>a-b).join(',')!=='1,2,3,4,5,6')continue;
    const valid: Array<{source:string;fetchedAt:string}> = [];
    for(const candidate of candidates){
      const proof=candidate.proof;let fetchedAt: number|null=null;let proofResults: any[]=[];
      if(candidate.source===RESULT_WORKER_SOURCE){
        fetchedAt=validInstant(proof.fetchedAt);proofResults=Array.isArray(proof.results)?proof.results:[];
        const expected=`https://www.boatrace.jp/owpc/pc/race/raceresult?rno=${race.race_no}&jcd=${race.venue_id}&hd=${String(race.race_date).replaceAll('-','')}`;
        if(proof.raceId!==raceId||proof.quality!=='verified-official-outcome-v2'||proof.url!==expected||typeof proof.sha256!=='string'||!SHA256.test(proof.sha256))continue;
      }else{
        const raceProof=proof.raceProof as Record<string,unknown>|undefined;fetchedAt=validInstant(proof.fetchedAt);proofResults=Array.isArray(raceProof?.results)?raceProof!.results as any[]:[];
        const date=String(race.race_date);
        if(proof.schema!==K_FILE_SCHEMA||proof.quality!=='official-k-file-parser-v1'||proof.kind!=='K'||proof.targetDate!==date||proof.url!==officialKFileUrl(date)||proof.parserVersion!==PROGRAM_PARSER_VERSION||typeof proof.sha256!=='string'||!SHA256.test(proof.sha256)||proof.r2Key!==`boat-program-files/${date}/k/${proof.sha256}.lzh`||proof.manifestKey!==`boat-program-manifests/${date}/k/${proof.sha256}-${PROGRAM_PARSER_VERSION}.json`||candidate.startedAt!==proof.fetchedAt||!raceProof||raceProof.raceId!==raceId||!Array.isArray(raceProof.laneIdentities)||raceProof.laneIdentities.length!==6)continue;
        const ids=new Map((raceProof.laneIdentities as any[]).map(row=>[Number(row.number),String(row.racerId)]));
        if(ids.size!==6||historyEntries.length!==6||historyEntries.some(entry=>{let parsed:any={};try{parsed=JSON.parse(String(entry.features_json??'{}'));}catch{return true;}return ids.get(Number(entry.number))!==parsed.racer_id;}))continue;
      }
      if(fetchedAt===null||fetchedAt>predictedAt||proofResults.length!==6||!sourceBoundEntries(historyEntries,String(race.race_date),fetchedAt))continue;
      if(candidate.source===K_FILE_SOURCE){
        const postTime=race.post_time,cutoff=race.betting_cutoff_at;
        const postAt=postTime==null?null:validInstant(String(postTime)),cutoffAt=cutoff==null?null:validInstant(String(cutoff));
        if((postTime!=null&&postAt===null)||(cutoff!=null&&cutoffAt===null)||(postAt!==null&&fetchedAt<postAt)||(cutoffAt!==null&&fetchedAt<cutoffAt))continue;
      }
      const proofMap=new Map(proofResults.map((row:any)=>[Number(row.number),Number(row.finishOrder)]));
      if(proofMap.size!==6||[...resultMap.entries()].some(([lane,order])=>proofMap.get(lane)!==order))continue;
      valid.push({source:candidate.source,fetchedAt:String(proof.fetchedAt)});
    }
    const selected=valid.find(item=>item.source===RESULT_WORKER_SOURCE)??valid[0];
    if(!selected)continue;
    history.push({race,entries:historyEntries,results:dbResults.map(row=>({...row,available_at:selected.fetchedAt}))});
  }
  return history;
}

/** Generate one SHA-bound current T-60 forecast and delegate all persistence gates to the shared ingest storage path. */
export async function runNativeExperimentalForecast(
  db: Db,
  bundle: unknown,
  historySnapshot: NativeExperimentalHistorySnapshot,
  options: NativeForecastRunOptions,
): Promise<NativeForecastRunResult> {
  const log = options.log ?? ((line: string) => console.info(line));
  const result = (status: NativeForecastRunResult['status'], evaluated = 0, stored = 0): NativeForecastRunResult =>
    ({ status, evaluated, stored });
  const model = await first<RegistryModel>(db, `SELECT id,status,artifact_sha256,trained_at,manifest_json
    FROM experimental_models WHERE status IN ('candidate','experimental')
    ORDER BY registered_at DESC,id DESC LIMIT 1`);
  if (!model) return result('no-model');
  if (!validRegistryMetadata(model)) return result('model-mismatch');
  let nativeModel: NativeExperimentalModel;
  try { nativeModel = validateNativeExperimentalModel(bundle, model.id, model.artifact_sha256); }
  catch { return result('model-mismatch'); }

  const predictedAtMs = (options.now ?? Date.now)();
  const predictedAt = isoNow(predictedAtMs);
  if (!Number.isFinite(predictedAtMs) || Date.parse(model.trained_at) >= predictedAtMs) return result('model-mismatch');
  const day = jstDate(predictedAtMs);
  const candidates = await all<Record<string, unknown>>(db, `SELECT r.* FROM races r
    WHERE r.sport='boat' AND r.race_date=? AND r.status='scheduled' AND r.data_origin='real'
      AND r.betting_cutoff_source=? AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM experimental_paper_decisions d
        WHERE d.experiment_key='boat-trifecta-small-sample-v1' AND d.race_id=r.id)
    ORDER BY r.betting_cutoff_at,r.id LIMIT ?`, day, TRUSTED_CUTOFF_SOURCE, MAX_CANDIDATES);
  const due = candidates.filter(race => {
    const cutoff = validInstant(race.betting_cutoff_at);
    const observed = validInstant(race.betting_cutoff_observed_at);
    const postTime = validInstant(race.post_time);
    if (cutoff === null || observed === null || postTime === null) return false;
    const target = cutoff - 60_000;
      return target >= predictedAtMs && target - predictedAtMs <= 5 * 60_000
      && observed <= predictedAtMs && predictedAtMs - observed <= BOATRACE_CUTOFF_MAX_AGE_MS
      && observed <= target && postTime > predictedAtMs;
  });
  if (!due.length) return result('no-eligible-races');
  if (due.length > 10) return result('no-eligible-races');

  const snapshot = historySnapshot;
  let stored = 0;
  for (const race of due) {
    const raceId = String(race.id);
    const entries = await all<Record<string, unknown>>(db, `SELECT * FROM entries
      WHERE race_id=? AND data_origin='real' ORDER BY number`, raceId);
    if (!sourceBoundEntries(entries, String(race.race_date), predictedAtMs)) continue;
    const racerIds = entries.map(entry => {
      try { return String((JSON.parse(String(entry.features_json ?? '{}')) as Record<string, unknown>).racer_id ?? ''); }
      catch { return ''; }
    });
    if (racerIds.some(id => !/^\d{4,5}$/.test(id)) || new Set(racerIds).size !== 6) continue;
    const incrementalHistory = await historyRacesAfterSnapshot(db, snapshot, day, predictedAtMs, racerIds);
    if (!incrementalHistory) continue;
    const archiveRows = await all<{ id: string; captured_at: string; archive_json: string }>(db, `SELECT id,captured_at,archive_json
      FROM boatrace_prerace_capture_archives WHERE race_id=? AND data_origin='real'
        AND julianday(captured_at)<=julianday(?) AND julianday(captured_at)>=julianday(?)
        ORDER BY julianday(captured_at) DESC,id DESC LIMIT 12`, raceId, predictedAt,
    isoNow(predictedAtMs - 5 * 60_000));
    if (!archiveRows.length) continue;
    const latestCaptured = validInstant(archiveRows[0].captured_at);
    if (latestCaptured === null || predictedAtMs - latestCaptured > 5 * 60_000) continue;
    const observations: Array<Record<string, unknown>> = [];
    let newestArchiveValid = false;
    for (const archiveRow of archiveRows) {
      const capturedAt = validInstant(archiveRow.captured_at);
      if (capturedAt === null || capturedAt > predictedAtMs || predictedAtMs - capturedAt > 30 * 60_000) continue;
      let archive: Record<string, any>;
      try {
        const parsed: unknown = JSON.parse(archiveRow.archive_json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        archive = parsed as Record<string, any>;
      } catch { continue; }
      if (!boatArchiveEvidenceValid(archive, race, entries)
          || archive.capturedAt !== archiveRow.captured_at
          || archive.trifectaOdds?.capturedAt !== archiveRow.captured_at
          || [archive.beforeinfo?.capturedAt, archive.raceList?.capturedAt, archive.trifectaOdds?.capturedAt]
            .some(value => { const time = validInstant(value); return time === null || time > predictedAtMs; })) continue;
      if (archiveRow === archiveRows[0]) newestArchiveValid = true;
      observations.push(...archiveObservations(archive, archiveRow.id, raceId));
    }
    if (!newestArchiveValid || observations.length < 6) continue;
    const newestRow = archiveRows[0];
    let newestArchive: Record<string, any>;
    try { newestArchive = JSON.parse(newestRow.archive_json); } catch { continue; }
    const markerKey = `native_forecast:${model.id}:${raceId}`;
    const priorMarker = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key=?', markerKey);
    try {
      const marker = JSON.parse(String(priorMarker?.value ?? 'null'));
      if (marker?.modelId === model.id && marker?.archiveId === newestRow.id
          && marker?.sourceSha256 === newestArchive.beforeinfo?.sha256) continue;
    } catch { /* malformed marker is ignored; current evidence will be regenerated */ }
    const featureInput: NativeRaceFeatureInput = {
      race, entries, observations, historyRaces: incrementalHistory,
      historySnapshot: snapshot, predictedAt,
    };
    let predictions: NativeForecastBody['races'][number]['predictions'];
    try {
      predictions = predictNativeExactTrifecta(nativeModel, buildNativeExperimentalFeatures(featureInput))
        .map(row => ({ selection: row.selection, probability: row.probability, prob_std: row.probStd }));
    } catch { continue; }
    const body: NativeForecastBody = {
      schema: 'edgelab-experimental-trifecta-forecast-v1', modelId: model.id,
      artifactSha256: model.artifact_sha256, trainingMode: 'experimental', experimentalOnly: true,
      ticketModelSchemaVersion: TICKET_SCHEMA, ticketPredictionSemantics: PREDICTION_SEMANTICS,
      boatFeatureSchemaVersion: FEATURE_SCHEMA,
      races: [{ raceId, predictedAt, predictions }],
    };
    try {
      const saved = await options.storeForecast(body);
      if (saved && saved.status !== undefined && saved.status !== 200) {
        log(JSON.stringify({ event: 'experimental-forecast-native', source: 'worker-native', status: 'storage-rejected',
          raceId, predictedAt, predictionCount: predictions.length }));
        return result('storage-rejected', 1, stored);
      }
      stored++;
      const markerValue = JSON.stringify({ modelId: model.id, archiveId: newestRow.id,
        sourceSha256: newestArchive.beforeinfo?.sha256, predictedAt });
      await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .bind(markerKey, markerValue).run();
      log(JSON.stringify({ event: 'experimental-forecast-native', source: 'worker-native', status: 'stored',
        raceId, predictedAt, predictionCount: predictions.length }));
    } catch {
      log(JSON.stringify({ event: 'experimental-forecast-native', source: 'worker-native', status: 'storage-rejected',
        raceId, predictedAt, predictionCount: predictions.length }));
      return result('storage-rejected', 1, stored);
    }
  }
  return stored ? result('completed', due.length, stored) : result('no-eligible-races', due.length);
}
