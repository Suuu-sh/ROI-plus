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
const TRUSTED_CUTOFF_SOURCE = 'boatrace-racelist-cutoff-v1';
const FEATURE_SCHEMA = 'boat-prerace-v2-no-weather-experimental-v1';
const TICKET_SCHEMA = 'ticket-selection-v1';
const PREDICTION_SEMANTICS = 'exact-selection-probability-v1';
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_HISTORY_RACES = 1_000;
const MAX_CANDIDATES = 180;
const officialBFileUrl = (date: string) => `https://www1.mbrace.or.jp/od2/B/${date.slice(0, 7).replace('-', '')}/b${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}.lzh`;

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

async function historyRacesAfterSnapshot(db: Db, snapshot: NativeExperimentalHistorySnapshot,
                                         targetDate: string, predictedAt: number, racerIds: string[]) {
  const races = await all<Record<string, unknown>>(db, `SELECT r.* FROM races r
    JOIN collection_runs cr ON cr.id='boat-result:'||r.id AND cr.source=? AND cr.sport='boat' AND cr.status='success'
    WHERE r.sport='boat' AND r.data_origin='real' AND r.status='finished'
      AND r.race_date>? AND r.race_date<?
      AND EXISTS(SELECT 1 FROM entries target_entry WHERE target_entry.race_id=r.id AND target_entry.data_origin='real'
        AND json_valid(target_entry.features_json)
        AND json_extract(target_entry.features_json,'$.racer_id') IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
    ORDER BY r.race_date,r.id LIMIT ?`, RESULT_WORKER_SOURCE, snapshot.throughRaceDate,
  targetDate, JSON.stringify(racerIds), MAX_HISTORY_RACES + 1);
  if (races.length > MAX_HISTORY_RACES) return null;
  const ids = races.map(row => String(row.id));
  if (!ids.length) return [];
  const encodedIds = JSON.stringify(ids);
  const [entries, results, proofs] = await Promise.all([
    all<Record<string, unknown>>(db, `SELECT * FROM entries WHERE data_origin='real'
      AND race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id,number`, encodedIds),
    all<Record<string, unknown>>(db, `SELECT * FROM results WHERE data_origin='real'
      AND race_id IN (SELECT value FROM json_each(?)) ORDER BY race_id,number`, encodedIds),
    all<{ id: string; reason: string | null }>(db, `SELECT id,reason FROM collection_runs
      WHERE source=? AND status='success' AND id IN (SELECT 'boat-result:'||value FROM json_each(?))`,
    RESULT_WORKER_SOURCE, encodedIds),
  ]);
  const raceById = new Map(races.map(row => [String(row.id), row]));
  const entryByRace = new Map<string, Array<Record<string, unknown>>>();
  const resultByRace = new Map<string, Array<Record<string, unknown>>>();
  for (const row of entries) entryByRace.set(String(row.race_id), [...(entryByRace.get(String(row.race_id)) ?? []), row]);
  for (const row of results) resultByRace.set(String(row.race_id), [...(resultByRace.get(String(row.race_id)) ?? []), row]);
  const proofByRace = new Map<string, Record<string, unknown>>();
  for (const proof of proofs) {
    const raceId = proof.id.slice('boat-result:'.length);
    try {
      const parsed: unknown = JSON.parse(String(proof.reason ?? ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) proofByRace.set(raceId, parsed as Record<string, unknown>);
    } catch { /* malformed result-worker evidence is excluded */ }
  }
  const history: NativeRaceFeatureInput['historyRaces'] = [];
  for (const raceId of ids) {
    const race = raceById.get(raceId)!;
    const proof = proofByRace.get(raceId);
    const fetchedAt = validInstant(proof?.fetchedAt);
    const dbResults = resultByRace.get(raceId) ?? [];
    const proofResults = proof?.results;
    const expectedResultUrl = `https://www.boatrace.jp/owpc/pc/race/raceresult?rno=${race.race_no}&jcd=${race.venue_id}&hd=${String(race.race_date).replaceAll('-', '')}`;
    if (proof?.raceId !== raceId || proof.quality !== 'verified-official-outcome-v2'
        || proof.url !== expectedResultUrl || typeof proof.sha256 !== 'string' || !SHA256.test(proof.sha256)
        || fetchedAt === null || fetchedAt > predictedAt || !Array.isArray(proofResults)
        || proofResults.length !== 6 || dbResults.length !== 6) continue;
    const historyEntries = entryByRace.get(raceId) ?? [];
    if (!sourceBoundEntries(historyEntries, String(race.race_date), fetchedAt)) continue;
    const resultMap = new Map(dbResults.map(row => [Number(row.number), Number(row.finish_order)]));
    const proofMap = new Map(proofResults.map((row: any) => [Number(row.number), Number(row.finishOrder)]));
    if (resultMap.size !== 6 || proofMap.size !== 6
        || [...resultMap.entries()].some(([lane, order]) => proofMap.get(lane) !== order)
        || [...resultMap.values()].sort((a, b) => a - b).join(',') !== '1,2,3,4,5,6') continue;
    const provenResults = dbResults.map(row => ({ ...row, available_at: proof.fetchedAt }));
    history.push({ race, entries: entryByRace.get(raceId) ?? [], results: provenResults });
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
