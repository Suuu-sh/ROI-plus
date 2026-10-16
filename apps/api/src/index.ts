import { normalHistorySnapshot, resetNormalHistory, validSnapshot } from './services/resetNormalHistory.js';
import { fetchPurchaseOdds, purchaseOddsContext, type PurchaseOdds, type PurchaseOddsContext } from './services/purchaseOdds.js';
import { finalTrifectaOdds } from './services/finalTrifectaOdds.js';
import { loadTrifectaSettlementEvidence, loadVerifiedRefundOutcome, verifiedNoRefundCapsize, verifiedNoRefundCapsizeRecord, verifiedOfficialRefundOutcomeSql, verifiedSelectedTerminalOutcomeSql, verifiedTrifectaOutcome } from './services/trifectaSettlement.js';
import { collectionIssues } from './services/collectionIssues.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { all, first, run, type Db, type Statement } from './repo/db.js';
import { candidate, betId, payoutYen, settleValues, validateYenStake } from './services/logic.js';
import { collectOdds } from './services/collectBoatraceOdds.js';
import { collectTrifectaOdds } from './services/collectBoatraceTrifectaOdds.js';
import { collectBoatraceCaptureArchives } from './services/collectBoatraceCaptureArchives.js';
import { collectResults, resultUrl, RESULTS_SOURCE } from './services/collectBoatraceResults.js';
import { BOATRACE_CUTOFF_MAX_AGE_MS } from './services/boatraceCutoff.js';
import { canonicalTicketSelection, isCompleteTicketDistribution } from '@edgelab/shared';
import { sizeExperimentalPortfolioResult } from './services/experimentalSizing.js';
import { historicalTrifectaExperimentDecision, historicalTrifectaExperimentPerformance,
  historicalTrifectaExperimentBets, settleHistoricalTrifectaExperimentOpen } from './services/historicalTrifectaExperiment.js';
import { exportHistoricalArchive, historicalArchiveCoverage, historicalArchiveKey, listHistoricalArchiveObjects,
  listHistoricalLabelTargetRaceIds, matchesVerifiedResultPairs, parseHistoricalArchiveKey, persistHistoricalObservations, validHistoricalArchiveDate } from './services/historicalTrifectaArchive.js';
import { primaryPaperTiming } from './services/paperTiming.js';
import { buildExperimentalStakeComparison } from './services/experimentalStakeComparison.js';
import { splitRowsForD1 } from './services/d1Batch.js';
import { boatArchiveEvidenceValid } from './services/boatArchiveEvidence.js';
import { estimateIngestWriteUnits, estimateWorkerWriteUnits, readWriteBudget, reserveWriteBudget, reserveWriteBudgets, utcDate, type IngestTable, type WriteCategory } from './services/writeBudget.js';
import { runForecastWatchdog } from './services/forecastWatchdog.js';
import { readDailyCloudPipelineStatus, runDailyCloudPipeline } from './services/dailyCloudPipeline.js';
import { runNativeDailyLearner } from './services/runNativeDailyLearner.js';
import { syncBoatraceProgramFile } from './services/boatraceProgramSync.js';
import { runNativeExperimentalForecast, type NativeExperimentalHistorySnapshot } from './services/runNativeExperimentalForecast.js';
import nativeExperimentalModel from './models/experimental-worker-model.json';
import nativeRacerHistory from './models/native-racer-history.json';
import type { Sport, DataOrigin, BetType, TicketCandidate } from '@edgelab/shared';

interface Env { DB: Db; TRIFECTA_ARCHIVE?: R2Bucket; FORECAST_LEARNER?: Fetcher; INGEST_TOKEN?: string; FORECAST_GITHUB_TOKEN?: string; ENABLE_NATIVE_EXPERIMENTAL_FORECAST?: string; ENABLE_NATIVE_DAILY_PIPELINE?: string; ENABLE_AUTO_BET?: string; ENABLE_BOATRACE_ODDS_SCRAPE?: string; ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE?: string; ENABLE_BOATRACE_RESULTS_SCRAPE?: string; ENABLE_HISTORICAL_TRIFECTA_ARCHIVE?: string; PROXY_TOKEN?: string; }
type Ctx = { Bindings: Env };
const SAFE_BOAT_SCHEMA = 'boat-venue-v2';
const TICKET_MODEL_SCHEMA = 'ticket-selection-v1';
const TICKET_PROBABILITY_SEMANTICS = 'exact-selection-probability-v1';
const PRIMARY_PAPER_PHASE = 'primary_t60' as const;
const PRIMARY_PAPER_OFFSET_MS = 60_000;
const PRIMARY_PAPER_TOLERANCE_MS = 10_000;
const TRUSTED_CUTOFF_SOURCE = 'boatrace-racelist-cutoff-v1' as const;
const MISSING_CUTOFF_PROBE_BEFORE_POST_MS = 2 * 60_000;
const MISSING_CUTOFF_PROBE_AFTER_POST_MS = 3 * 60_000;
const PAPER_COMPARISON_PHASES = {
  t30: { phase: 'comparison_t30', status: 'unavailable', reason: 'minute-level collection and ten-minute decisions cannot observe second offsets' },
  t10: { phase: 'comparison_t10', status: 'unavailable', reason: 'minute-level collection and ten-minute decisions cannot observe second offsets' },
} as const;
// A full field is represented by either an official numeric finish or an
// explicit non-finisher code parsed from the official K result file.
const terminalFinishCodeSql = `(json_valid(e.features_json) AND (
  json_extract(e.features_json,'$.finish_code') IN ('F','L','K','欠場','欠','失格','転覆','転','妨害','落水','エンスト','不完走')
  OR json_extract(e.features_json,'$.finish_code') GLOB 'K[0-9]'))`;
const isTerminalFinishCode = (value: unknown): boolean =>
  typeof value === 'string' && (['F','L','K','欠場','欠','失格','転覆','転','妨害','落水','エンスト','不完走'].includes(value)
    || /^K\d$/.test(value));
async function hasVerifiedCapsizeNoRefund(db: Db, race: {id:string;race_date:string;venue_id:string;race_no:number}, number: number): Promise<boolean> {
  return verifiedNoRefundCapsize(db,race,number);
}
const app = new Hono<Ctx>().basePath('/api');
// Static deployment diagnostic only: no build SHA, account data, or secrets.
// Register first so it also marks CORS, proxy-guard, auth, and cache responses.
app.use('*', async (c, next) => {
  await next();
  c.header('X-ROI-API-Revision', 'ten-minute-results-settlement-v1');
});
app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','OPTIONS'], allowHeaders: ['Content-Type','Authorization','X-ROI-Cache-Bypass'], exposeHeaders: ['X-ROI-Read-Cache'] }));
// 本番では閲覧系 API を、Cloudflare Access で保護された画面 Worker（Service Binding）経由に限定する。
// PROXY_TOKEN 未設定（ローカル開発・テスト）では制限しない。ingest は従来どおり INGEST_TOKEN で認証。
app.use('*', async (c, next) => {
  const proxy = c.env.PROXY_TOKEN;
  const path = new URL(c.req.url).pathname;
  if (!proxy || path === '/api/health' || path.startsWith('/api/ingest/') || path === '/api/admin/settle' || path === '/api/admin/collect-boat-results') return next();
  if (c.req.header('X-ROI-Proxy') !== proxy) return c.json({ error: 'forbidden' }, 403);
  return next();
});
// Cache only authenticated, read-only dashboard data. Keep URLs (including the
// complete query string) as keys; purchase-sensitive writes and admin/ingest
// routes intentionally bypass this cache. Cache API failures must never fail a read.
function readCacheTtl(path: string): number | null {
  if (path === '/api/bets') return 5;
  if (path === '/api/performance/overview') return 10;
  if (path === '/api/races' || path === '/api/rankings' || path === '/api/models'
    || path === '/api/collection/status' || /^\/api\/races\/[^/]+$/.test(path)) return 10;
  return null;
}
app.use('*', async (c, next) => {
  const ttl = readCacheTtl(new URL(c.req.url).pathname);
  if (c.req.method !== 'GET' || !c.env.PROXY_TOKEN || ttl === null) return next();
  const keyUrl = new URL(c.req.url);
  keyUrl.pathname = `/__roi_read_cache_v1${keyUrl.pathname}`;
  const key = new Request(keyUrl.toString(), { method: 'GET' });
  if (c.req.header('X-ROI-Cache-Bypass') === '1') {
    try { await (globalThis.caches as CacheStorage & { default?: Cache } | undefined)?.default?.delete(key); } catch { /* Best-effort local invalidation. */ }
    await next();
    const headers = new Headers(c.res.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-ROI-Read-Cache', 'BYPASS');
    c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
    return;
  }
  let cache: Cache | undefined;
  let cached: Response | undefined;
  try {
    cache = (globalThis.caches as CacheStorage & { default?: Cache } | undefined)?.default;
    cached = await cache?.match(key);
  } catch { /* Cache is an optimization only. */ }
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-ROI-Read-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
  }

  // Do not wrap next() in a cache-error handler: application failures must
  // propagate normally and must never cause the route to be executed twice.
  await next();
  const responseHeaders = new Headers(c.res.headers);
  responseHeaders.set('Cache-Control', 'private, no-store');
  responseHeaders.set('X-ROI-Read-Cache', 'MISS');
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: responseHeaders });
  if (c.res.status !== 200 || !c.res.headers.get('content-type')?.includes('application/json')) return;
  const storeHeaders = new Headers(c.res.headers);
  storeHeaders.set('Cache-Control', `public, max-age=${ttl}`);
  storeHeaders.delete('X-ROI-Read-Cache');
  try {
    await cache?.put(key, new Response(c.res.clone().body, { status: c.res.status, statusText: c.res.statusText, headers: storeHeaders }));
  } catch { /* Ignore cache write errors; return the fresh D1 response. */ }
});
// Persist timestamps with a consistent JST offset; selection queries use
// julianday() so comparisons remain correct when imported ISO offsets differ.
const isoJstAt = (timestamp: number) => new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
const now = () => isoJstAt(Date.now());
const ODDS_MAX_AGE_MS = 10 * 60 * 1000;
const oddsFreshAfter = (timestamp = Date.now()) => isoJstAt(timestamp - ODDS_MAX_AGE_MS);
const reserveWorkerWrites = (db: Db, rows: number) => reserveWriteBudget(db, utcDate(), estimateWorkerWriteUnits(rows), 'essential');
const manualBetPlacedAt = (id: string) => {
  const suffix = (BigInt(`0x${id.replaceAll('-', '').slice(0, 16)}`) % 1_000_000_000_000_000_000n).toString().padStart(18, '0');
  return now().replace(/(\.\d{3})(\+09:00)$/, (_match, millis, offset) => `${millis}${suffix}${offset}`);
};
const reserveManualBetWrites = async (db: Db, rows: number) => {
  for (let attempt = 0; attempt < 3; attempt++) if (await reserveWorkerWrites(db, rows)) return true;
  return false;
};
const reserveOptionalWorkerWrites = (db: Db, rows: number) => reserveWriteBudget(db, utcDate(), estimateWorkerWriteUnits(rows), 'optional');
const validSport = (v: string | null): v is Sport => v === 'horse' || v === 'boat';
const originFilter = (v: string | null | undefined) => v === 'sample' || v === 'real' ? v : null;
const jsonError = (c: any, message: string, status = 400) => c.json({ error: message }, status);
async function setting(db: Db, key: string, fallback: string): Promise<string> {
  return (await first<{value:string}>(db, 'SELECT value FROM settings WHERE key=?', key))?.value ?? fallback;
}
const availableBankrollSql = `(COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key='initial_bankroll'), 100000)
  + COALESCE((SELECT SUM(CASE WHEN b.status IN ('won','lost') THEN b.profit ELSE 0 END) FROM bets b WHERE NOT EXISTS(SELECT 1 FROM data_repair_audit_marks q WHERE q.record_type='bet' AND q.record_id=b.id)), 0)
  - COALESCE((SELECT SUM(CASE WHEN b.status='open' THEN b.stake ELSE 0 END) FROM bets b WHERE NOT EXISTS(SELECT 1 FROM data_repair_audit_marks q WHERE q.record_type='bet' AND q.record_id=b.id)), 0))`;
const nonQuarantinedBet = (alias = 'b') => `NOT EXISTS(SELECT 1 FROM data_repair_audit_marks q WHERE q.record_type='bet' AND q.record_id=${alias}.id)`;
function auth(c: any) { const token = c.env.INGEST_TOKEN; return !!token && c.req.header('Authorization') === `Bearer ${token}`; }
// Trusted frontend Service Binding adds this secret header; never accept a
// missing/empty token as authenticated and do not weaken ingest bearer auth.
function proxyAuth(c: any) { const token=c.env.PROXY_TOKEN;return !!token&&c.req.header('X-ROI-Proxy')===token; }
function parseList(body: unknown): Record<string, unknown>[] | null {
  const rows = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as any).items) ? (body as any).items : null;
  return rows && rows.every((x: unknown) => x && typeof x === 'object' && !Array.isArray(x)) ? rows as Record<string, unknown>[] : null;
}
const jstRaceDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const isIsoCalendarDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function raceDateWindow() {
  const today = jstRaceDate(), yesterday = new Date(`${today}T00:00:00+09:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return new Set([today, jstRaceDate(yesterday)]);
}
const ingestTables: Record<string,{table:string; required:string[]; conflict:string}> = {
  venues:{table:'venues',required:['id','sport','name'],conflict:'id'},
  races:{table:'races',required:['id','sport','venue_id','race_date','race_no','status','data_origin'],conflict:'id'},
  entries:{table:'entries',required:['id','race_id','number','name','available_at','data_origin'],conflict:'race_id,number'},
  odds:{table:'odds_snapshots',required:['id','race_id','bet_type','selection','captured_at','data_origin'],conflict:'race_id,bet_type,selection,captured_at'},
  results:{table:'results',required:['race_id','finish_order','number','data_origin'],conflict:'race_id,number'},
  payouts:{table:'payouts',required:['race_id','bet_type','selection','payout','data_origin'],conflict:'race_id,bet_type,selection'},
  predictions:{table:'predictions',required:['id','race_id','model_id','number','probability','predicted_at','data_origin'],conflict:'race_id,model_id,number,predicted_at'},
  'ticket-predictions':{table:'ticket_predictions',required:['id','race_id','model_id','bet_type','selection','probability','predicted_at','data_origin','feature_schema_version','artifact_sha256'],conflict:'race_id,model_id,bet_type,selection,predicted_at'},
  'prerace-observations':{table:'boatrace_prerace_observations',required:['id','race_id','kind','entry_number','source_url','source_sha256','fetched_at','available_at','values_json','data_origin'],conflict:'race_id,kind,entry_number,fetched_at'},
  models:{table:'models',required:['id','sport','bet_type','version','algorithm','status'],conflict:'id'},
  'collection-runs':{table:'collection_runs',required:['id','source','sport','target_date','started_at','status'],conflict:'id'},
};
const allowedColumns: Record<string,string[]> = {
  venues:'id sport name'.split(' '),
  races:'id sport venue_id race_date race_no name distance surface track_condition weather wind_speed wave_height post_time betting_cutoff_at betting_cutoff_source betting_cutoff_observed_at status data_origin updated_at'.split(' '),
  entries:'id race_id number frame name jockey trainer weight_carried horse_weight racer_class national_win_rate local_win_rate motor_no motor_2rate boat_no boat_2rate exhibition_time start_exhibition features_json available_at data_origin'.split(' '),
  odds_snapshots:'id race_id bet_type selection odds captured_at source data_origin source_url source_sha256 quality_status'.split(' '),
  results:'race_id finish_order number data_origin'.split(' '),
  payouts:'race_id bet_type selection payout popularity data_origin'.split(' '),
  predictions:'id race_id model_id number probability prob_std predicted_at data_origin'.split(' '),
  ticket_predictions:'id race_id model_id bet_type selection probability prob_std predicted_at data_origin feature_schema_version artifact_sha256'.split(' '),
  boatrace_prerace_observations:'id race_id kind entry_number source_url source_sha256 source_observed_at source_observation_label fetched_at available_at values_json data_origin'.split(' '),
  models:'id sport bet_type version algorithm status train_from train_to valid_from valid_to test_from test_to n_train metrics_json trained_at notes'.split(' '),
  collection_runs:'id source sport target_date started_at finished_at status records error reason'.split(' '),
};
const updateColumns: Record<string,string[]> = {
  venues:['sport','name'],
  races:'sport venue_id race_date race_no name distance surface track_condition weather wind_speed wave_height post_time betting_cutoff_at betting_cutoff_source betting_cutoff_observed_at status data_origin updated_at'.split(' '),
  entries:'frame name jockey trainer weight_carried horse_weight racer_class national_win_rate local_win_rate motor_no motor_2rate boat_no boat_2rate exhibition_time start_exhibition features_json available_at data_origin'.split(' '),
  odds_snapshots:'odds source data_origin source_url source_sha256 quality_status'.split(' '), results:['finish_order','data_origin'], predictions:'probability prob_std data_origin'.split(' '),
  ticket_predictions:'probability prob_std data_origin feature_schema_version artifact_sha256'.split(' '),
  boatrace_prerace_observations:'source_sha256 source_observed_at source_observation_label available_at values_json'.split(' '),
  payouts:'payout popularity data_origin'.split(' '),
  models:'sport bet_type version algorithm status train_from train_to valid_from valid_to test_from test_to n_train metrics_json trained_at notes'.split(' '),
  collection_runs:'source sport target_date started_at finished_at status records error reason'.split(' '),
};
async function ingest(c: any, name: string) {
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  const config = ingestTables[name], rows = parseList(await c.req.json().catch(()=>null));
  if (!config || !rows || rows.length > 500 || rows.some(r => config.required.some(k => r[k] === undefined))) return jsonError(c, 'invalid payload (maximum 500 rows)');
  if (name === 'collection-runs' && rows.some(r => r.source === RESULTS_SOURCE && typeof r.id === 'string' && r.id.startsWith('boat-result:')))
    return jsonError(c, 'official result-worker evidence is server-owned', 403);
  if ((name === 'venues' && rows.length > 50) || (name === 'models' && rows.length > 20)) return jsonError(c, 'small reference/model batches only');
  const table = config.table, allowed = allowedColumns[table], updates = updateColumns[table];
  const db: Db = c.env.DB, statements: Statement[] = [];
  if (['entries','odds_snapshots','results','payouts','predictions','ticket_predictions','boatrace_prerace_observations'].includes(table)) {
    const raceIds=[...new Set(rows.map(r=>typeof r.race_id==='string'?r.race_id:null).filter((x):x is string=>!!x))];
    if (raceIds.length) {
      const quarantined=await first<any>(db,'SELECT COUNT(*) count FROM data_repair_quarantined_races q JOIN json_each(?) ids ON ids.value=q.race_id',JSON.stringify(raceIds));
      if (Number(quarantined?.count??0)>0) return jsonError(c, 'source data for a quarantined race cannot be ingested');
    }
  }
  const currentWindow = raceDateWindow();
  const rowCategory = new Map<Record<string, unknown>, WriteCategory>();
  // Historical backfill is disabled at the API boundary. Date classification
  // comes from the persisted race row where available, never a client priority claim.
  for (const row of rows) {
    let raceDate: string | null = null;
    let raceId: string | null = null;
    if (table === 'races') {
      raceId = typeof row.id === 'string' ? row.id : null;
      const existing = raceId ? await first<any>(db, 'SELECT race_date,data_origin FROM races WHERE id=?', raceId) : null;
      if (raceId && await first<any>(db,'SELECT race_id FROM data_repair_quarantined_races WHERE race_id=?',raceId)) return jsonError(c, 'race is quarantined by a source-repair audit');
      if (existing && row.race_date !== undefined && row.race_date !== existing.race_date) return jsonError(c, 'race date cannot be changed for an existing race', 409);
      if (existing && row.data_origin !== existing.data_origin) return jsonError(c, 'ingest data origin must match the persisted race', 409);
      const hasCutoff = row.betting_cutoff_at !== undefined && row.betting_cutoff_at !== null;
      const hasCutoffSource = row.betting_cutoff_source !== undefined && row.betting_cutoff_source !== null;
      const hasCutoffObservedAt = row.betting_cutoff_observed_at !== undefined && row.betting_cutoff_observed_at !== null;
      if ((hasCutoff || hasCutoffSource || hasCutoffObservedAt) && (row.sport !== 'boat' || !hasCutoff || !hasCutoffSource || !hasCutoffObservedAt
          || row.betting_cutoff_source !== TRUSTED_CUTOFF_SOURCE
          || typeof row.betting_cutoff_at !== 'string' || !Number.isFinite(Date.parse(row.betting_cutoff_at))
          || typeof row.betting_cutoff_observed_at !== 'string' || !Number.isFinite(Date.parse(row.betting_cutoff_observed_at)))) {
        return jsonError(c, 'betting cutoff requires valid time and observation timestamps with explicit official racelist cutoff provenance');
      }
      raceDate = typeof existing?.race_date === 'string' ? existing.race_date : typeof row.race_date === 'string' ? row.race_date : null;
    } else if (['entries','odds_snapshots','results','payouts','predictions','ticket_predictions','boatrace_prerace_observations'].includes(table)) {
      raceId = typeof row.race_id === 'string' ? row.race_id : null;
      const race = raceId ? await first<any>(db, 'SELECT sport,venue_id,race_date,race_no,data_origin FROM races WHERE id=?', raceId) : null;
      raceDate = typeof race?.race_date === 'string' ? race.race_date : null;
      if (!raceDate) return jsonError(c, 'ingest race must already exist', 409);
      if (row.data_origin !== race.data_origin) return jsonError(c, 'ingest data origin must match the persisted race', 409);
      if (table === 'boatrace_prerace_observations') {
        const fetchedAt = typeof row.fetched_at === 'string' ? Date.parse(row.fetched_at) : NaN;
        const availableAt = typeof row.available_at === 'string' ? Date.parse(row.available_at) : NaN;
        const sourceObservedAt = row.source_observed_at == null ? null : Date.parse(String(row.source_observed_at));
        const hasTimezone = (value: unknown) => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/i.test(value);
        const sourceUrl = typeof row.source_url === 'string' ? row.source_url : '';
        let validUrl = false;
        try {
          const url = new URL(sourceUrl);
          validUrl = url.protocol === 'https:' && url.hostname === 'www.boatrace.jp'
            && url.pathname === '/owpc/pc/race/beforeinfo'
            && url.searchParams.get('hd') === String(race?.race_date ?? '').replaceAll('-', '')
            && url.searchParams.get('jcd') === String(race?.venue_id ?? '')
            && url.searchParams.get('rno') === String(race?.race_no ?? '');
        } catch { validUrl = false; }
        let values: any;
        try { values = JSON.parse(String(row.values_json)); } catch { values = null; }
        const valueKeys = values && typeof values === 'object' && !Array.isArray(values) ? Object.keys(values) : [];
        const allowedValues = row.kind === 'weather'
          ? ['weather','wind_speed','wind_direction','wind_direction_class','air_temperature','water_temperature','wave_height']
          : ['exhibition_time','tilt','weight','adjustment_weight','start_exhibition','start_exhibition_course','start_exhibition_false_start','propeller_changed'];
        const observationsValid = race?.sport === 'boat' && race?.data_origin === 'real' && row.data_origin === 'real'
          && ['weather','exhibition'].includes(String(row.kind))
          && ((row.kind === 'weather' && Number(row.entry_number) === 0)
            || (row.kind === 'exhibition' && Number.isInteger(Number(row.entry_number)) && Number(row.entry_number) >= 1 && Number(row.entry_number) <= 6))
          && validUrl && /^[a-f0-9]{64}$/.test(String(row.source_sha256))
          && hasTimezone(row.fetched_at) && hasTimezone(row.available_at)
          && (row.source_observed_at == null || hasTimezone(row.source_observed_at))
          && Number.isFinite(fetchedAt) && Number.isFinite(availableAt) && fetchedAt === availableAt
          && fetchedAt <= Date.now() + 300_000
          && (sourceObservedAt === null || (Number.isFinite(sourceObservedAt) && sourceObservedAt <= fetchedAt && sourceObservedAt <= Date.now() + 300_000))
          && (row.source_observation_label == null || (typeof row.source_observation_label === 'string' && row.source_observation_label.length <= 32))
          && !!valueKeys.length && valueKeys.every(key => allowedValues.includes(key))
          && (values.wind_direction_class == null || (row.kind === 'weather' && typeof values.wind_direction_class === 'string'
            && /^is-wind(?:[1-9]|1[0-2])$/.test(values.wind_direction_class)))
          && valueKeys.every(key => values[key] == null || (typeof values[key] === 'number' ? Number.isFinite(values[key]) : typeof values[key] === 'string' || typeof values[key] === 'boolean'));
        if (!observationsValid) return jsonError(c, 'pre-race observation requires a matching official page, real race, observation timestamp, and typed values');
      }
    } else if (table === 'collection_runs') {
      raceDate = typeof row.target_date === 'string' ? row.target_date : null;
    }
    const openBet = raceId && ['races','entries','results','payouts'].includes(table)
      ? await first<any>(db, `SELECT 1 FROM bets b JOIN races r ON r.id=b.race_id AND r.data_origin=b.data_origin WHERE b.race_id=? AND b.status='open' AND ${nonQuarantinedBet('b')} LIMIT 1`, raceId)
      : null;
    const earliestAcceptedDate = [...currentWindow].sort()[0];
    if (raceDate && raceDate < earliestAcceptedDate && !openBet) {
      return c.json({ error: 'historical ingest is disabled; only today/yesterday data and open-bet settlement inputs are accepted', code: 'historical_ingest_disabled' }, 409);
    }
    const currentRaceData = !!raceDate && currentWindow.has(raceDate);
    let category: WriteCategory = 'optional';
    if (table === 'collection_runs' || table === 'boatrace_prerace_observations') category = 'collection';
    else if (openBet) category = 'essential';
    else if (currentRaceData && ['races','entries','results','payouts'].includes(table)) category = 'essential';
    else if (currentRaceData && ['predictions','ticket_predictions'].includes(table)) {
      const modelId = row.model_id;
      const model = typeof modelId === 'string' ? await first<any>(db, 'SELECT status FROM models WHERE id=?', modelId) : null;
      if (model?.status === 'active') category = 'essential';
    }
    rowCategory.set(row, category);
  }
  const changedByCategory: Record<'essential' | 'optional' | 'collection', Partial<Record<IngestTable, number>>> = { essential: {}, optional: {}, collection: {} };
  const sideEffectsByCategory: Record<'essential' | 'optional' | 'collection', number> = { essential: 0, optional: 0, collection: 0 };
  for (const row of rows) {
    if (table === 'races' && await first<any>(db,'SELECT race_id FROM data_repair_quarantined_races WHERE race_id=?',row.id)) return jsonError(c, 'race is quarantined by a source-repair audit');
    const generatedUpdatedAt = table === 'races' && row.updated_at === undefined;
    if (generatedUpdatedAt) row.updated_at = now();
    if (table === 'models' && (row.status === 'active' || row.status === 'retired')) {
      const existing = await first<any>(c.env.DB, 'SELECT status FROM models WHERE id=?', row.id);
      if (!existing || existing.status !== row.status) return jsonError(c, 'ingest cannot change model lifecycle status');
    }
    if (table === 'models' && !['candidate','untrained','active','retired'].includes(String(row.status))) return jsonError(c, 'invalid model status');
    if (table === 'ticket_predictions') {
      const model = await first<any>(db, 'SELECT sport,bet_type,metrics_json,trained_at FROM models WHERE id=?', String(row.model_id));
      let metrics: any;
      try { metrics = JSON.parse(model?.metrics_json || '{}'); } catch { return jsonError(c, 'ticket model metadata is invalid'); }
      const selection = typeof row.selection === 'string' ? canonicalTicketSelection(String(row.bet_type) as BetType, row.selection) : null;
      if (!model || model.sport !== (await first<any>(db, 'SELECT sport FROM races WHERE id=?', String(row.race_id)))?.sport
          || model.bet_type !== row.bet_type || row.bet_type === 'win'
          || metrics.ticketModelSchemaVersion !== TICKET_MODEL_SCHEMA
          || metrics.ticketPredictionSemantics !== TICKET_PROBABILITY_SEMANTICS
          || metrics.ticketBetType !== row.bet_type
          || typeof metrics.ticketArtifactSha256 !== 'string'
          || !/^[a-f0-9]{64}$/.test(metrics.ticketArtifactSha256)
          || row.feature_schema_version !== TICKET_MODEL_SCHEMA
          || row.artifact_sha256 !== metrics.ticketArtifactSha256
          || !selection || selection !== row.selection
          || typeof row.predicted_at !== 'string' || !Number.isFinite(Date.parse(row.predicted_at)) || Date.parse(row.predicted_at) > Date.now()
          || !model.trained_at || !Number.isFinite(Date.parse(model.trained_at)) || Date.parse(model.trained_at) >= Date.parse(row.predicted_at)
          || typeof row.probability !== 'number' || !Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1
          || (row.prob_std !== undefined && row.prob_std !== null && (!Number.isFinite(row.prob_std) || Number(row.prob_std) < 0))) {
        return jsonError(c, 'ticket prediction does not match a compatible exact-type model contract');
      }
    }
    const cols = Object.keys(row).filter(k => allowed.includes(k) && row[k] !== undefined);
    if (config.required.some(k => !cols.includes(k))) return jsonError(c, 'missing required fields');
    // IDs and server-generated updated_at are not natural-key data; avoid
    // manufacturing writes when an upstream retry repeats an identical row.
    const updateCols = updates.filter(k=>cols.includes(k) && k !== 'id');
    const businessUpdateCols = updateCols.filter(k => k !== 'updated_at');
    const keyCols = config.conflict.split(',');
    const keyValues = keyCols.map(k => row[k]);
    const previous = await first<any>(db, `SELECT * FROM ${table} WHERE ${keyCols.map(k=>`${k}=?`).join(' AND ')}`, ...keyValues);
    let changed = !previous;
    if (previous) {
      if (table === 'models' && (previous.status === 'active' || previous.status === 'retired')) changed = false;
      else changed = businessUpdateCols.some(k => {
        if (table === 'races' && k === 'status' && ['finished','cancelled'].includes(previous.status)) return false;
        return previous[k] !== row[k] && !(previous[k] == null && row[k] == null);
      });
    }
    if (changed) {
      const ingestTable = table as IngestTable;
      const rowPriority = rowCategory.get(row);
      const category = rowPriority === 'essential' || rowPriority === 'collection' ? rowPriority : 'optional';
      changedByCategory[category][ingestTable] = (changedByCategory[category][ingestTable] ?? 0) + 1;
    }
    const updateSet = updateCols.map(k=>`${k}=excluded.${k}`);
    if (table === 'races' && cols.includes('status')) updateSet[updateSet.indexOf('status=excluded.status')] = "status=CASE WHEN races.status IN ('finished','cancelled') THEN races.status ELSE excluded.status END";
    const guardExpr = (k: string) => table === 'races' && k === 'status'
      ? `CASE WHEN races.status IN ('finished','cancelled') THEN races.status ELSE excluded.status END IS NOT races.status`
      : `${table}.${k} IS NOT excluded.${k}`;
    const noOpGuard = businessUpdateCols.length ? `(${businessUpdateCols.map(guardExpr).join(' OR ')})` : '0';
    const updateWhere = table === 'models' ? ` WHERE models.status NOT IN ('active','retired') AND ${noOpGuard}` : ` WHERE ${noOpGuard}`;
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')}) ON CONFLICT(${config.conflict}) DO UPDATE SET ${updateSet.join(',') || `${config.conflict.split(',')[0]}=excluded.${config.conflict.split(',')[0]}`}${updateWhere}`;
    if (changed) statements.push(db.prepare(sql).bind(...cols.map(k=>row[k])));
  }
  // 結果・払戻の入ったレースを確定にする（D1 の書き込み行数を抑えるためレース単位で1回、未確定のものだけ）
  if (name === 'payouts' || name === 'results') {
    for (const id of new Set(rows.map(r => String(r.race_id)))) {
      const race = await first<any>(db, "SELECT 1 FROM races WHERE id=? AND status NOT IN ('finished','cancelled')", id);
      if (race) { statements.push(db.prepare("UPDATE races SET status='finished' WHERE id=? AND status NOT IN ('finished','cancelled')").bind(id));
        const category = rowCategory.get(rows.find(r => String(r.race_id) === id)!) === 'essential' ? 'essential' : 'optional';
        sideEffectsByCategory[category]++; }
    }
  }
  const changedRows = (Object.values(changedByCategory.essential).reduce((sum, count) => sum + (count ?? 0), 0) +
    Object.values(changedByCategory.collection).reduce((sum, count) => sum + (count ?? 0), 0) +
    Object.values(changedByCategory.optional).reduce((sum, count) => sum + (count ?? 0), 0) + sideEffectsByCategory.essential + sideEffectsByCategory.optional);
  const reservations = (['essential','collection','optional'] as const).flatMap(category => {
    const counts = changedByCategory[category], sideEffects = sideEffectsByCategory[category];
    const rowsInCategory = Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0) + sideEffects;
    return rowsInCategory > 0 ? [{ units: estimateIngestWriteUnits(counts, sideEffects), category }] : [];
  });
  if (reservations.length && !await reserveWriteBudgets(db, utcDate(), reservations)) {
    const budget = await readWriteBudget(db);
    return c.json({ error: 'daily D1 write budget unavailable or exhausted', code: budget.state === 'missing' || budget.state === 'invalid' ? 'd1_write_budget_unavailable' : 'd1_write_budget_exhausted', budget }, 429);
  }
  // D1 batch は1トランザクションで実行される（行ごとの往復を避ける）
  if (statements.length) {
    if (db.batch) await db.batch(statements); else for (const s of statements) await s.run();
  }
  return c.json({ upserted: rows.length, changed: changedRows });
}
async function settleOpen(db: Db) {
  const bets = await all<any>(db, `SELECT b.*, r.status AS race_status, r.data_origin AS race_origin,r.race_date,r.venue_id,r.race_no,r.betting_cutoff_at FROM bets b JOIN races r ON r.id=b.race_id WHERE b.status='open' AND r.status IN ('finished','cancelled') AND b.data_origin=r.data_origin AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id) AND ${nonQuarantinedBet()}`);
  let settled = 0;
  const refundOutcomeCache=new Map<string,Promise<any>>();
  for (const b of bets) {
    if (b.race_status === 'cancelled') {
      if (!await reserveWorkerWrites(db, 1)) break;
      const result = await run(db, `UPDATE bets SET status='void',payout=stake,profit=0,final_odds=1,settled_at=? WHERE id=? AND status='open'`, now(), b.id);
      settled += Number(result.meta?.changes ?? 0); continue;
    }
    if(b.race_origin==='real'){
      let pending=refundOutcomeCache.get(String(b.race_id));
      if(!pending){pending=loadVerifiedRefundOutcome(db,{id:b.race_id,race_date:b.race_date,venue_id:b.venue_id,race_no:b.race_no,betting_cutoff_at:b.betting_cutoff_at});refundOutcomeCache.set(String(b.race_id),pending);}
      const refundOutcome=await pending;
      if(refundOutcome){
        if(!['win','trifecta'].includes(b.bet_type))continue;
        const selected=String(b.selection).split('-').map(Number);
        const isRefund=selected.some(number=>refundOutcome.refundNumbers.includes(number));
        const officialPayout=refundOutcome.payouts.find((row:any)=>row.betType===b.bet_type);
        if(!officialPayout)continue;
        const won=!isRefund&&String(b.selection)===officialPayout.selection;
        const status=isRefund?'void':won?'won':'lost';
        const payout=isRefund?Number(b.stake):won?payoutYen(Number(b.stake),Number(officialPayout.payout)):0;
        const finalOdds=isRefund?1:won?Number(officialPayout.payout)/100:null;
        if(!await reserveWorkerWrites(db,1))break;
        const result=await run(db,"UPDATE bets SET status=?,payout=?,profit=?,final_odds=?,settled_at=? WHERE id=? AND status='open'",
          status,payout,isRefund?0:payout-Number(b.stake),finalOdds,now(),b.id);
        if(Number(result.meta?.changes??0)>0){
          if(!isRefund&&b.expected_roi>0&&finalOdds!==null&&b.predicted_prob*finalOdds-1<=0)await run(db,"UPDATE bets SET ev_lost=1 WHERE id=? AND ev_lost<>1",b.id);
          settled++;
        }
        continue;
      }
    }
    const integrity = await first<any>(db, `SELECT
      (SELECT COUNT(*) FROM entries e WHERE e.race_id=? AND e.data_origin=?) entry_count,
      (SELECT COUNT(*) FROM entries e WHERE e.race_id=? AND e.data_origin=? AND ${terminalFinishCodeSql} AND NOT EXISTS(
        SELECT 1 FROM results res WHERE res.race_id=e.race_id AND res.number=e.number AND res.data_origin=e.data_origin
      )) terminal_entry_count,
      (SELECT COUNT(*) FROM entries e WHERE e.race_id=? AND e.data_origin=? AND ${terminalFinishCodeSql} AND EXISTS(
        SELECT 1 FROM results res WHERE res.race_id=e.race_id AND res.number=e.number AND res.data_origin=e.data_origin
      )) terminal_result_conflict_count,
      (SELECT COUNT(*) FROM results res WHERE res.race_id=? AND res.data_origin=?) result_count,
      (SELECT COUNT(DISTINCT res.number) FROM results res WHERE res.race_id=? AND res.data_origin=?) distinct_result_count,
      (SELECT COUNT(*) FROM results res WHERE res.race_id=? AND res.data_origin=? AND EXISTS(
        SELECT 1 FROM entries e WHERE e.race_id=res.race_id AND e.number=res.number AND e.data_origin=res.data_origin
      )) matched_result_count,
      (SELECT COUNT(*) FROM results res WHERE res.race_id=? AND res.data_origin=? AND res.finish_order=1) winner_count,
      (SELECT COUNT(*) FROM results res JOIN payouts p ON p.race_id=res.race_id
        AND p.data_origin=res.data_origin AND p.bet_type='win'
        AND p.selection=CAST(res.number AS TEXT) AND p.payout>0
        WHERE res.race_id=? AND res.data_origin=? AND res.finish_order=1) paid_winner_count,
      (SELECT COUNT(*) FROM payouts p WHERE p.race_id=? AND p.data_origin=? AND p.bet_type=? AND p.payout>0) ticket_payout_count,
      (SELECT COUNT(*) FROM payouts p WHERE p.race_id=? AND p.data_origin=? AND p.bet_type='win' AND p.payout>0 AND NOT EXISTS(
        SELECT 1 FROM results res WHERE res.race_id=p.race_id AND res.data_origin=p.data_origin AND res.finish_order=1 AND p.selection=CAST(res.number AS TEXT))) nonwinner_win_payout_count,
      (SELECT CASE WHEN json_valid(e.features_json) THEN json_extract(e.features_json,'$.finish_code') END FROM entries e WHERE e.race_id=? AND e.data_origin=? AND CAST(e.number AS TEXT)=? LIMIT 1) selected_finish_code`,
      b.race_id,b.data_origin,b.race_id,b.data_origin,b.race_id,b.data_origin,b.race_id,b.data_origin,b.race_id,b.data_origin,b.race_id,b.data_origin,
      b.race_id,b.data_origin,b.race_id,b.data_origin,b.race_id,b.data_origin,b.bet_type,b.race_id,b.data_origin,b.race_id,b.data_origin,b.selection);
    if (!integrity || integrity.entry_count <= 0
        || (b.bet_type !== 'trifecta' && integrity.result_count + integrity.terminal_entry_count !== integrity.entry_count)
        || integrity.terminal_result_conflict_count > 0
        || integrity.distinct_result_count !== integrity.result_count
        || integrity.matched_result_count !== integrity.result_count
        || integrity.winner_count <= 0
        || (b.bet_type === 'win' && integrity.nonwinner_win_payout_count > 0)
        || (b.bet_type === 'win' ? integrity.paid_winner_count !== integrity.winner_count : integrity.ticket_payout_count <= 0)) continue;
    if (b.bet_type === 'trifecta') {
      const [partialOrder, entries] = await Promise.all([
        all<any>(db, 'SELECT number,finish_order FROM results WHERE race_id=? AND data_origin=? ORDER BY finish_order,number', b.race_id, b.data_origin),
        all<any>(db, 'SELECT number,features_json FROM entries WHERE race_id=? AND data_origin=? ORDER BY number', b.race_id, b.data_origin),
      ]);
      const trifectaPayouts = await all<any>(db, "SELECT selection,payout FROM payouts WHERE race_id=? AND data_origin=? AND bet_type='trifecta' AND payout>0", b.race_id, b.data_origin);
      const mappedEntries=entries.map((entry:any)=>{
        let finishCode:string|null=null;try{const parsed=JSON.parse(entry.features_json??'{}');if(typeof parsed.finish_code==='string')finishCode=parsed.finish_code;}catch{/* malformed metadata stays unknown */}
        return {number:Number(entry.number),finishCode};
      });
      const verifiedTerminalNumbers:number[]=[];
      for(const entry of mappedEntries){
        if(isTerminalFinishCode(entry.finishCode)&&String(b.selection).split('-').includes(String(entry.number))
          &&await verifiedNoRefundCapsize(db,{id:b.race_id,race_date:b.race_date,venue_id:b.venue_id,race_no:b.race_no},entry.number))verifiedTerminalNumbers.push(entry.number);
      }
      const outcome = verifiedTrifectaOutcome(String(b.selection), mappedEntries,
        partialOrder.map((row:any)=>({number:Number(row.number),finishOrder:Number(row.finish_order)})),
        trifectaPayouts.map((row:any)=>({selection:String(row.selection),payout:Number(row.payout)})),verifiedTerminalNumbers);
      if (!outcome) continue;
    } else if (b.bet_type !== 'win') {
      // Other ticket settlement semantics require their own exact outcome
      // contract; leave historical/manual rows open rather than guessing.
      continue;
    }
    const pay = await first<any>(db, 'SELECT payout FROM payouts WHERE race_id=? AND data_origin=? AND bet_type=? AND selection=? AND payout>0', b.race_id, b.data_origin, b.bet_type, b.selection);
    // A recorded false-start / disqualification does not establish whether
    // this exact ticket was refunded. Do not turn missing refund evidence into
    // a loss; keep that bet open while other, fully evidenced picks can settle.
    if (b.bet_type === 'win' && isTerminalFinishCode(integrity.selected_finish_code) && !pay) {
      // Only a parsed after-start capsize plus an empty official refund table
      // proves this ticket lost. Other terminal outcomes remain unresolved.
      if (integrity.selected_finish_code !== '転覆' && integrity.selected_finish_code !== '転') continue;
      if (!await hasVerifiedCapsizeNoRefund(db,{id:b.race_id,race_date:b.race_date,venue_id:b.venue_id,race_no:b.race_no},Number(b.selection))) continue;
    }
    const values = settleValues(b.stake, pay?.payout ?? null, !!pay);
    if(!pay&&b.bet_type==='trifecta'&&b.data_origin==='real') {
      const proof=await first<any>(db,"SELECT reason FROM collection_runs WHERE id=? AND source='boatrace-results-worker-v1' AND status='success'",`boat-result:${b.race_id}`);
      const order=await all<any>(db,"SELECT number FROM results WHERE race_id=? AND data_origin='real' ORDER BY finish_order",b.race_id);
      values.finalOdds=finalTrifectaOdds(proof?.reason,{id:b.race_id,race_date:b.race_date,venue_id:b.venue_id,race_no:b.race_no},b.selection,order.slice(0,3).map(x=>x.number).join('-'));
    }
    const evLost = b.expected_roi > 0 && values.finalOdds !== null && b.predicted_prob * values.finalOdds - 1 <= 0;
    if (!await reserveWorkerWrites(db, evLost ? 2 : 1)) break;
    const result = await run(db, `UPDATE bets SET status=?,payout=?,profit=?,final_odds=?,settled_at=? WHERE id=? AND status='open'`, pay ? 'won' : 'lost', values.payout, values.profit, values.finalOdds, now(), b.id);
    if (Number(result.meta?.changes ?? 0) > 0) {
      if (evLost) await run(db, `UPDATE bets SET ev_lost=1 WHERE id=? AND ev_lost<>1`, b.id);
      settled++;
    }
  }
  return settled + await settleExperimentalOpen(db) + await settleHistoricalTrifectaExperimentOpen(db);
}
async function settleExperimentalOpen(db: Db) {
 const open=await all<any>(db,`SELECT b.*,r.race_date,r.venue_id,r.race_no,r.betting_cutoff_at FROM experimental_paper_bets b JOIN races r ON r.id=b.race_id
   WHERE b.status='open' AND r.status='finished' AND r.data_origin='real'
   AND NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q WHERE q.bet_id=b.id)
   AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
   AND (((SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin='real')=6
   AND (SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin='real')+
       (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin='real' AND ${terminalFinishCodeSql})=6
   AND NOT EXISTS(SELECT 1 FROM entries e JOIN results x ON x.race_id=e.race_id AND x.number=e.number AND x.data_origin=e.data_origin
     WHERE e.race_id=r.id AND e.data_origin='real' AND ${terminalFinishCodeSql})
   AND (SELECT COUNT(DISTINCT x.number) FROM results x WHERE x.race_id=r.id AND x.data_origin='real')=(SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin='real')
   AND (SELECT COUNT(DISTINCT x.finish_order) FROM results x WHERE x.race_id=r.id AND x.data_origin='real')=(SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin='real')
   AND COALESCE((SELECT MIN(x.finish_order) FROM results x WHERE x.race_id=r.id AND x.data_origin='real'),0)=1
   AND (SELECT MAX(x.finish_order) FROM results x WHERE x.race_id=r.id AND x.data_origin='real')=(SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin='real')
   AND (SELECT COUNT(*) FROM payouts p WHERE p.race_id=r.id AND p.data_origin='real' AND p.bet_type='trifecta' AND p.payout>0)=1
   AND EXISTS(SELECT 1 FROM payouts p WHERE p.race_id=r.id AND p.data_origin='real' AND p.bet_type='trifecta' AND p.payout>0
     AND p.selection=(SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=1)||'-'||
       (SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=2)||'-'||
       (SELECT CAST(x.number AS TEXT) FROM results x WHERE x.race_id=r.id AND x.data_origin='real' AND x.finish_order=3))
   AND ${verifiedSelectedTerminalOutcomeSql}) OR ${verifiedOfficialRefundOutcomeSql})
   ORDER BY b.placed_at,b.id`);

 const races=[...new Map(open.map((b:any)=>[String(b.race_id),{id:String(b.race_id),race_date:String(b.race_date),venue_id:String(b.venue_id),race_no:Number(b.race_no)}])).values()];
 const evidence=await loadTrifectaSettlementEvidence(db,races);
 const settlements:any[]=[];
 const refundOutcomeCache=new Map<string,Promise<any>>();
 for(const bet of open){
   let sourceProof:any;try{sourceProof=JSON.parse(evidence.proofs.get(String(bet.race_id))?.reason??'{}')}catch{sourceProof=null;}
   if(sourceProof?.quality==='verified-official-refund-outcome-v1'){
     let pending=refundOutcomeCache.get(String(bet.race_id));
     if(!pending){pending=loadVerifiedRefundOutcome(db,{id:bet.race_id,race_date:bet.race_date,venue_id:bet.venue_id,race_no:bet.race_no,betting_cutoff_at:bet.betting_cutoff_at});refundOutcomeCache.set(String(bet.race_id),pending);}
     const refund=await pending;
     if(refund){
       const selection=String(bet.selection).split('-').map(Number),isRefund=selection.some(n=>refund.refundNumbers.includes(n));
       const official=refund.payouts.find((row:any)=>row.betType==='trifecta');
       if(!official)continue;
       const won=!isRefund&&String(bet.selection)===official.selection,status=isRefund?'void':won?'won':'lost';
       const payout=isRefund?Number(bet.stake):won?payoutYen(Number(bet.stake),official.payout):0;
       settlements.push({bet,status,payout,credit:isRefund?Number(bet.stake):payout});
       continue;
     }
   }
   const order=evidence.results.get(String(bet.race_id))??[];
   const entries=evidence.entries.get(String(bet.race_id))??[];
   const payouts=evidence.payouts.get(String(bet.race_id))??[];
   const mappedEntries=entries.map((entry:any)=>{
     let finishCode:string|null=null;try{const parsed=JSON.parse(entry.features_json??'{}');if(typeof parsed.finish_code==='string')finishCode=parsed.finish_code;}catch{/* malformed metadata stays unknown */}
     return {number:Number(entry.number),finishCode};
   });
   const verifiedTerminalNumbers:number[]=[];
   for(const entry of mappedEntries){
     if(isTerminalFinishCode(entry.finishCode)&&String(bet.selection).split('-').includes(String(entry.number))
       &&verifiedNoRefundCapsizeRecord(evidence.proofs.get(String(bet.race_id)),{id:bet.race_id,race_date:bet.race_date,venue_id:bet.venue_id,race_no:bet.race_no},entry.number))verifiedTerminalNumbers.push(entry.number);
   }
   const outcome=verifiedTrifectaOutcome(String(bet.selection),mappedEntries,
     order.map((row:any)=>({number:Number(row.number),finishOrder:Number(row.finish_order)})),
     payouts.map((row:any)=>({selection:String(row.selection),payout:Number(row.payout)})),verifiedTerminalNumbers);
   if(!outcome)continue;
   const won=outcome.won,payout=won?payoutYen(Number(bet.stake),outcome.payoutPer100):0;
   settlements.push({bet,status:won?'won':'lost',payout,credit:payout});
 }
 if(!db.batch)return 0;
 let settled=0;
 for(let start=0;start<settlements.length;start+=40){
   const chunk=settlements.slice(start,start+40);
   if(!await reserveWorkerWrites(db,chunk.length*2))break;
   const settledAt=now(),statements:Statement[]=[];
   for(const item of chunk){
     const {bet,status,payout,credit}=item;
     statements.push(db.prepare("UPDATE experimental_paper_bets SET status=?,payout=?,profit=?,settled_at=? WHERE id=? AND status='open'").bind(status,payout,payout-Number(bet.stake),settledAt,bet.id));
     statements.push(db.prepare("UPDATE experimental_bankroll SET available_balance=available_balance+?,updated_at=? WHERE experiment_key='boat-trifecta-small-sample-v1' AND changes()>0").bind(credit,settledAt));
   }
   const results=await db.batch(statements) as any[];
   for(let i=0;i<chunk.length;i++)settled+=Number(results?.[i*2]?.meta?.changes??0);
 }
 return settled;
}
async function experimentalPaperDecision(db: Db, decisionAt=Date.now(), oddsContext:PurchaseOddsContext=purchaseOddsContext()) {
 const report={evaluated:0,placedRaces:0,placedBets:0,abstainedByReason:{} as Record<string,number>,timingDroppedByReason:{} as Record<string,number>};
 const noteTimingDrop=(reason:string)=>{report.timingDroppedByReason[reason]=(report.timingDroppedByReason[reason]??0)+1;};
 const model=await first<any>(db,"SELECT * FROM experimental_models WHERE status IN ('candidate','experimental') ORDER BY registered_at DESC,id DESC LIMIT 1");
 if(!model)return report;
 let metadata:any;try{metadata=JSON.parse(model.manifest_json)}catch{return report;}
 if(metadata.trainingMode!=='experimental'||metadata.experimentalOnly!==true||metadata.ticketArtifactSha256!==model.artifact_sha256
    ||metadata.boatFeatureSchemaVersion!=='boat-prerace-v2-no-weather-experimental-v1')return report;
 const date=jstRaceDate(new Date(decisionAt));
 const eligibleCutoffFrom=isoJstAt(decisionAt+PRIMARY_PAPER_OFFSET_MS-PRIMARY_PAPER_TOLERANCE_MS);
 const eligibleCutoffTo=isoJstAt(decisionAt+PRIMARY_PAPER_OFFSET_MS+PRIMARY_PAPER_TOLERANCE_MS);
 const races=await all<any>(db,"SELECT * FROM races WHERE sport='boat' AND data_origin='real' AND status='scheduled' AND race_date=? AND betting_cutoff_source=? AND julianday(betting_cutoff_at) BETWEEN julianday(?) AND julianday(?) AND NOT EXISTS (SELECT 1 FROM experimental_paper_decisions d WHERE d.experiment_key='boat-trifecta-small-sample-v1' AND d.race_id=races.id) ORDER BY betting_cutoff_at,id LIMIT 180",date,TRUSTED_CUTOFF_SOURCE,eligibleCutoffFrom,eligibleCutoffTo);
 for(const race of races){
   const timing=primaryPaperTiming(race.betting_cutoff_at,decisionAt,race.betting_cutoff_source,race.betting_cutoff_observed_at);
   if(!timing.eligible)continue;
   const prior=await first<any>(db,'SELECT id FROM experimental_paper_decisions WHERE experiment_key=\'boat-trifecta-small-sample-v1\' AND race_id=?',race.id);
   if(prior)continue;
   report.evaluated++;
   const targetAt=isoJstAt(Number(timing.targetMs));
   const latest=await first<any>(db,`SELECT MAX(predicted_at) predicted_at FROM experimental_ticket_predictions WHERE race_id=? AND model_id=? AND data_origin='real'
     AND feature_schema_version='ticket-selection-v1' AND artifact_sha256=? AND julianday(predicted_at)<=julianday(?) AND julianday(predicted_at)>=julianday(?)`,race.id,model.id,model.artifact_sha256,targetAt,isoJstAt(Number(timing.targetMs)-5*60_000));
   const predictionAt=latest?.predicted_at??null;
   let predictions:any[]=predictionAt?await all<any>(db,`SELECT selection,probability,prob_std,predicted_at FROM experimental_ticket_predictions WHERE race_id=? AND model_id=? AND data_origin='real' AND predicted_at=?`,race.id,model.id,predictionAt):[];
   const lanes=await all<any>(db,"SELECT number,features_json FROM entries WHERE race_id=? AND data_origin='real' ORDER BY number",race.id),numbers=lanes.map(x=>Number(x.number));
   let reason:string|null=null,archiveRow:any=null,archive:any=null,odds:any[]=[],purchaseOdds:PurchaseOdds|null=null;
   if(numbers.length!==6||numbers.some((x,i)=>x!==i+1))reason='official_entries_incomplete';
   else if(predictions.length!==120||predictions.some((p:any)=>!Number.isFinite(p.probability)||!Number.isFinite(p.prob_std)||p.prob_std<0)
       ||!isCompleteTicketDistribution('trifecta',numbers,predictions.map((p:any)=>p.selection),predictions.map((p:any)=>Number(p.probability))))reason='experimental_forecast_missing_or_invalid';
   else if(Date.parse(model.trained_at)>=Date.parse(predictionAt))reason='forecast_predates_model';
   if(!reason){
     archiveRow=await first<any>(db,'SELECT id,captured_at,archive_json FROM boatrace_prerace_capture_archives WHERE race_id=? AND data_origin=\'real\' AND julianday(captured_at)<=julianday(?) ORDER BY julianday(captured_at) DESC LIMIT 1',race.id,isoJstAt(decisionAt));
     if(!archiveRow||decisionAt-Date.parse(archiveRow.captured_at)>5*60_000)reason='official_archive_missing_or_stale';
     else{try{archive=JSON.parse(archiveRow.archive_json)}catch{reason='official_archive_invalid';}}
   }
   if(!reason){
     if(!experimentalArchiveEvidenceValid(archive,race,lanes)||archive.trifectaOdds.capturedAt!==archiveRow.captured_at
        ||Date.parse(archive.beforeinfo.capturedAt)>decisionAt||Date.parse(archive.raceList.capturedAt)>decisionAt
        ||Date.parse(archive.trifectaOdds.capturedAt)>decisionAt)reason='official_archive_identity_or_odds_invalid';
     else {
       purchaseOdds=await fetchPurchaseOdds(race,oddsContext);
       if(!purchaseOdds)reason='purchase_odds_fetch_failed_or_window_elapsed';
       else odds=purchaseOdds.odds;
     }
   }
   const oddsBySelection=new Map(odds.map((x:any)=>[x.selection,Number(x.odds)]));
   const tickets=!reason?predictions.map((p:any)=>({selection:p.selection,probability:Number(p.probability),probStd:Number(p.prob_std),odds:Number(oddsBySelection.get(p.selection))})):[];
   const balance=await first<any>(db,"SELECT available_balance FROM experimental_bankroll WHERE experiment_key='boat-trifecta-small-sample-v1'");
   const sizing=reason?{stakes:[],abstentionReason:null}:sizeExperimentalPortfolioResult(tickets,Number(balance?.available_balance??0));
   const stakes=sizing.stakes;
   const totalStake=stakes.reduce((sum,x)=>sum+x.stake,0),outcome=totalStake?'placed':'abstained';
   const abstentionReason=reason??sizing.abstentionReason??'no_conservative_positive_edge';
   const decisionId=crypto.randomUUID();
   const snapshot={phase:'experimental_t60',cutoffAt:race.betting_cutoff_at,cutoffSource:race.betting_cutoff_source,cutoffObservedAt:race.betting_cutoff_observed_at,targetAt,predictedAt:predictionAt,
     purchaseOdds,captureArchiveId:archiveRow?.id??null,sourceHashes:archive?{beforeinfo:archive.beforeinfo.sha256,racelist:archive.raceList.sha256,odds:purchaseOdds?.sha256??null}:null,
     predictionCount:predictions.length,predictionDigest:predictions.length?await sha256Json(predictions):null,
     sizing:{method:'fractional-kelly-portfolio',fraction:0.25,uncertaintyMultiplier:1.96,minimumTicketStake:100,stakeUnit:100,perRaceCombinedCap:1000,dailyCap:null,balanceGuard:'nonnegative-virtual-balance'},tickets:stakes};
   if(!db.batch)return report;
   if(!await reserveWorkerWrites(db,predictions.length+stakes.length+3))continue;
   const commitAt=Date.now();
   if(!primaryPaperTiming(race.betting_cutoff_at,commitAt,race.betting_cutoff_source,race.betting_cutoff_observed_at).eligible){noteTimingDrop('commit_window_elapsed');continue;}
   if(totalStake>0&&(!purchaseOdds||Date.parse(purchaseOdds.capturedAt)>commitAt||!archive||commitAt-Date.parse(archiveRow?.captured_at??'')>5*60_000
      ||Date.parse(archive?.beforeinfo?.capturedAt??'')>commitAt||Date.parse(archive?.raceList?.capturedAt??'')>commitAt
      ||Date.parse(archive?.trifectaOdds?.capturedAt??'')>commitAt)){noteTimingDrop('purchase_evidence_stale_before_commit');continue;}
   const committedAt=isoJstAt(commitAt);
   const statements:Statement[]=[];
   if(totalStake>0)statements.push(db.prepare(`UPDATE experimental_bankroll SET available_balance=available_balance-?,updated_at=? WHERE experiment_key='boat-trifecta-small-sample-v1' AND available_balance>=? AND NOT EXISTS(SELECT 1 FROM experimental_paper_decisions WHERE experiment_key='boat-trifecta-small-sample-v1' AND race_id=?)
      AND EXISTS(SELECT 1 FROM races r WHERE r.id=? AND r.status='scheduled' AND r.betting_cutoff_at=? AND r.betting_cutoff_source=?
        AND ABS((julianday(r.betting_cutoff_at)-julianday('now'))*86400-60)<=10
        AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id))`).bind(totalStake,committedAt,totalStake,race.id,race.id,race.betting_cutoff_at,TRUSTED_CUTOFF_SOURCE));
   statements.push(totalStake>0
     ?db.prepare(`INSERT INTO experimental_paper_decisions(id,experiment_key,race_id,model_id,capture_archive_id,decision_at,outcome,reason,total_stake,sizing_method,snapshot_json)
       SELECT ?,'boat-trifecta-small-sample-v1',?,?,?,?,'placed',NULL,?,'fractional-kelly-portfolio',? WHERE changes()>0 AND NOT EXISTS(SELECT 1 FROM experimental_paper_decisions WHERE experiment_key='boat-trifecta-small-sample-v1' AND race_id=?)`).bind(decisionId,race.id,model.id,archiveRow.id,committedAt,totalStake,JSON.stringify(snapshot),race.id)
     :db.prepare(`INSERT INTO experimental_paper_decisions(id,experiment_key,race_id,model_id,capture_archive_id,decision_at,outcome,reason,total_stake,sizing_method,snapshot_json)
       VALUES(?,'boat-trifecta-small-sample-v1',?,?,?,?,?,?,0,'fractional-kelly-portfolio',?) ON CONFLICT(experiment_key,race_id) DO NOTHING`).bind(decisionId,race.id,model.id,archiveRow?.id??null,committedAt,'abstained',abstentionReason,JSON.stringify(snapshot)));
   if(totalStake>0){
     for(const chunk of splitRowsForD1(stakes,11,1)){
       const values:any[]=[];const cols='id,decision_id,race_id,model_id,selection,stake,probability,prob_std,odds_at_bet,expected_roi,placed_at';
       const selects=chunk.map((x:any,index:number)=>{values.push(crypto.randomUUID(),decisionId,race.id,model.id,x.selection,x.stake,x.probability,x.probStd,x.odds,x.expectedRoi,committedAt);return `SELECT ${index===0?cols.split(',').map((name:string)=>`? AS ${name}`).join(','):'?,?,?,?,?,?,?,?,?,?,?'}`;}).join(' UNION ALL ');
       statements.push(db.prepare(`INSERT INTO experimental_paper_bets(id,decision_id,race_id,model_id,selection,stake,probability,prob_std,odds_at_bet,expected_roi,placed_at,status,data_origin)
         SELECT id,decision_id,race_id,model_id,selection,stake,probability,prob_std,odds_at_bet,expected_roi,placed_at,'open','real' FROM (${selects}) WHERE EXISTS(SELECT 1 FROM experimental_paper_decisions WHERE id=?)`).bind(...values,decisionId));
     }
   }
   if(!primaryPaperTiming(race.betting_cutoff_at,Date.now(),race.betting_cutoff_source,race.betting_cutoff_observed_at).eligible){noteTimingDrop('pre_batch_window_elapsed');continue;}
   const results=await db.batch(statements) as any[];
   const decisionChanges=Number(results?.[totalStake>0?1:0]?.meta?.changes??0);
   if(decisionChanges&&totalStake){report.placedRaces++;report.placedBets+=stakes.length;}
   else if(decisionChanges){report.abstainedByReason[abstentionReason]=(report.abstainedByReason[abstentionReason]??0)+1;}
 }
 return report;
}
function validProbability(value: unknown): boolean {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1;
}
function validUncertainty(value: unknown): boolean {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0;
}
function paperAbstentionReason(rows: any[]): string {
  if (!rows.length) return 'active_model_prediction_unavailable';
  if (rows.some(row => !validProbability(row.probability))) return 'invalid_probability';
  if (rows.some(row => !validUncertainty(row.prob_std))) return 'invalid_prediction_uncertainty';
  if (!rows.some(row => Number.isFinite(Number(row.odds)) && Number(row.odds) > 0 && Number.isFinite(Date.parse(row.odds_captured_at)))) return 'odds_missing_or_stale';
  return 'no_qualifying_edge';
}
async function recordPaperAbstention(db: Db, raceId: string, cutoffAt: string | null, cutoffSource: string | null, cutoffObservedAt: string | null, inputAsOfAt: number, reason: string, writeReserved = false) {
  if (!writeReserved && !await reserveWorkerWrites(db, 1)) return 'budget_unavailable' as const;
  const cutoffMs = cutoffAt ? Date.parse(cutoffAt) : Number.NaN;
  const trustedCutoff = cutoffSource === TRUSTED_CUTOFF_SOURCE && Number.isFinite(cutoffMs);
  const targetAt = trustedCutoff ? isoJstAt(cutoffMs - PRIMARY_PAPER_OFFSET_MS) : null;
  const result = await run(db, `INSERT INTO paper_decisions(race_id,phase,cutoff_at,target_at,cutoff_observed_at,input_as_of_at,decided_at,outcome,reason,cutoff_source)
    SELECT ?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'abstained',
      CASE WHEN ?<>'missing_or_invalid_cutoff' AND ? IS NOT NULL AND (julianday(?) - julianday('now'))*86400<50 THEN 'missed_timing' ELSE ? END,?
    WHERE NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=? AND b.mode='auto')
    ON CONFLICT(race_id,phase) DO NOTHING`, raceId, PRIMARY_PAPER_PHASE,
    trustedCutoff ? cutoffAt : null, targetAt, trustedCutoff && cutoffObservedAt && Number.isFinite(Date.parse(cutoffObservedAt)) ? cutoffObservedAt : null,
    isoJstAt(inputAsOfAt), reason, trustedCutoff ? cutoffAt : null,
    trustedCutoff ? cutoffAt : null, reason, trustedCutoff ? cutoffSource : null, raceId);
  return Number(result.meta?.changes ?? 0) > 0 ? 'recorded' as const : 'duplicate' as const;
}
type AutoBetTimingReport = {
  phase: typeof PRIMARY_PAPER_PHASE;
  targetOffsetSeconds: number;
  toleranceSeconds: number;
  acceptedSecondsBeforeCutoff: { min: number; max: number };
  evaluatedRaceCount: number;
  purchasedRaceCount: number;
  boughtBetCount: number;
  abstainedByReason: Record<string, number>;
  unrecordedAbstentionCount: number;
  comparisons: typeof PAPER_COMPARISON_PHASES;
};
async function autoBetWithReport(db: Db, enabled: boolean, decisionAt = Date.now(), oddsContext:PurchaseOddsContext=purchaseOddsContext()) {
  const report: AutoBetTimingReport = { phase: PRIMARY_PAPER_PHASE, targetOffsetSeconds: 60, toleranceSeconds: 10,
    acceptedSecondsBeforeCutoff: { min: 50, max: 70 },
    evaluatedRaceCount: 0, purchasedRaceCount: 0, boughtBetCount: 0, abstainedByReason: {}, unrecordedAbstentionCount: 0,
    comparisons: PAPER_COMPARISON_PHASES };
  if (!enabled || (await setting(db, 'auto_bet_paused', 'false')) === 'true' || !Number.isFinite(decisionAt)) {
    return { bought: 0, report };
  }
  // Optional operator guard for a future scheduled start. Missing preserves
  // legacy behavior; malformed configured dates fail closed.
  const startDate = await setting(db, 'auto_bet_start_date', '');
  if (startDate && (!isIsoCalendarDate(startDate) || jstRaceDate(new Date(decisionAt)) < startDate)) {
    return { bought: 0, report };
  }
  const inputAsOfAt = decisionAt;
  const inputAsOfAtIso = isoJstAt(inputAsOfAt), freshAfter = oddsFreshAfter(inputAsOfAt), raceDate = jstRaceDate(new Date(inputAsOfAt));
  const nextRaceDate = jstRaceDate(new Date(decisionAt + 24 * 60 * 60_000));
  const noteAbstention = async (race: any, reason: string, writeReserved = false) => {
    const timing = primaryPaperTiming(race.betting_cutoff_at, Date.now(), race.betting_cutoff_source, race.betting_cutoff_observed_at);
    const finalReason = reason !== 'missing_or_invalid_cutoff' && timing.reason === 'missed_timing' ? 'missed_timing' : reason;
    report.abstainedByReason[finalReason] = (report.abstainedByReason[finalReason] ?? 0) + 1;
    const saved = await recordPaperAbstention(db, race.id, race.betting_cutoff_at ?? null, race.betting_cutoff_source ?? null,
      race.betting_cutoff_observed_at ?? null, inputAsOfAt, finalReason, writeReserved);
    if (saved === 'budget_unavailable') report.unrecordedAbstentionCount++;
  };
  // The legacy B-file post_time is only a bounded discovery window for an
  // explicit abstention. It is never substituted for the official cutoff.
  const missingCutoffs = await all<any>(db, `SELECT r.id,r.post_time,r.betting_cutoff_at,r.betting_cutoff_source,r.betting_cutoff_observed_at FROM races r WHERE r.race_date=? AND r.status='scheduled'
    AND julianday(r.post_time)>=julianday(?) AND julianday(r.post_time)<=julianday(?)
    AND (r.betting_cutoff_at IS NULL OR julianday(r.betting_cutoff_at) IS NULL OR r.betting_cutoff_source IS NULL OR r.betting_cutoff_source<>?
      OR r.betting_cutoff_observed_at IS NULL OR julianday(r.betting_cutoff_observed_at) IS NULL
      OR julianday(r.betting_cutoff_observed_at)<julianday(?) OR julianday(r.betting_cutoff_observed_at)>julianday(?))
    AND NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.mode='auto')
    AND NOT EXISTS(SELECT 1 FROM paper_decisions d WHERE d.race_id=r.id AND d.phase='primary_t60')
    AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id) ORDER BY julianday(r.post_time),r.id LIMIT 20`, raceDate,
    isoJstAt(inputAsOfAt - MISSING_CUTOFF_PROBE_BEFORE_POST_MS),isoJstAt(inputAsOfAt + MISSING_CUTOFF_PROBE_AFTER_POST_MS),TRUSTED_CUTOFF_SOURCE,
    isoJstAt(inputAsOfAt - BOATRACE_CUTOFF_MAX_AGE_MS),isoJstAt(inputAsOfAt + 5_000));
  for (const race of missingCutoffs) {
    const timing=primaryPaperTiming(race.betting_cutoff_at,inputAsOfAt,race.betting_cutoff_source,race.betting_cutoff_observed_at);
    await noteAbstention(race,timing.reason==='stale_cutoff_evidence'||timing.reason==='future_cutoff_observation'?timing.reason:'missing_or_invalid_cutoff');
  }

  // Minute cron evaluates the target window and catches only recent misses.
  // The short bounded lookback is enough to record a missed minute without
  // scanning historical races or allowing a late purchase.
  const recentRaces = await all<any>(db, `SELECT r.*,v.name venue_name FROM races r JOIN venues v ON v.id=r.venue_id WHERE r.race_date IN (?,?)
    AND r.betting_cutoff_source=? AND r.betting_cutoff_at IS NOT NULL
    AND julianday(r.betting_cutoff_at)>=julianday(?) AND julianday(r.betting_cutoff_at)<=julianday(?)
    AND NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.mode='auto')
    AND NOT EXISTS(SELECT 1 FROM paper_decisions d WHERE d.race_id=r.id AND d.phase='primary_t60')
    AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
    ORDER BY julianday(r.betting_cutoff_at),r.id LIMIT 100`, raceDate,nextRaceDate,TRUSTED_CUTOFF_SOURCE,
    isoJstAt(inputAsOfAt - 2 * 60_000),isoJstAt(inputAsOfAt + PRIMARY_PAPER_OFFSET_MS + PRIMARY_PAPER_TOLERANCE_MS));
  const dueRaces: any[] = [];
  for (const race of recentRaces) {
    const result = primaryPaperTiming(race.betting_cutoff_at, inputAsOfAt, race.betting_cutoff_source, race.betting_cutoff_observed_at);
    if (result.eligible && race.status === 'scheduled') dueRaces.push(race);
    else if (result.eligible) await noteAbstention(race, 'race_not_scheduled');
    else if (result.reason === 'missed_timing') await noteAbstention(race, 'missed_timing');
    else if (result.reason === 'stale_cutoff_evidence' || result.reason === 'future_cutoff_observation' || result.reason === 'missing_or_invalid_cutoff') await noteAbstention(race, result.reason);
  }
  report.evaluatedRaceCount = dueRaces.length;
  if (!dueRaces.length) return { bought: 0, report };

  const cfg = Number(await setting(db, 'unit_stake', '100')), minRoi = Number(await setting(db, 'min_expected_roi', '0.05')), maxStd = Number(await setting(db, 'max_prob_std', '0.05'));
  const maxPicks = Math.min(6, Math.max(1, Math.floor(Number(await setting(db, 'auto_bet_max_picks', '1')) || 1)));
  const raceBudget=Number(await setting(db,'auto_bet_race_budget',String(cfg)));
  if (!Number.isSafeInteger(cfg) || cfg <= 0 || !Number.isSafeInteger(raceBudget) || raceBudget <= 0 || raceBudget > 2_147_483_647) {
    for (const race of dueRaces) await noteAbstention(race, 'invalid_paper_budget');
    return { bought: 0, report };
  }
  const grouped = new Map<string, any[]>();
  const candidatesByRace = new Map<string, any[]>();
  for (const race of dueRaces) {
    if(!await first<any>(db,"SELECT id FROM ticket_predictions WHERE race_id=? AND data_origin='real' LIMIT 1",race.id)){candidatesByRace.set(race.id,[]);continue;}
    const market=await fetchPurchaseOdds(race,oddsContext);
    if(!market){await noteAbstention(race,'purchase_odds_fetch_failed_or_window_elapsed');continue;}
    const candidates = await ticketCandidatesForRace(db, race, maxStd, inputAsOfAt, race.betting_cutoff_at,market);
    candidatesByRace.set(race.id, candidates.map(t=>({...t,prob_std:t.probStd,odds_captured_at:t.oddsCapturedAt})));
    for (const t of candidates) {
      if (!t.buyEligible || t.expectedRoi < minRoi) continue;
      const list=grouped.get(race.id)??[];
      list.push({race_id:race.id,sport:race.sport,data_origin:race.data_origin,bet_type:t.betType,selection:t.selection,probability:t.probability,prob_std:t.probStd,model_id:t.modelId,model_status:'active',odds:t.odds,odds_captured_at:t.oddsCapturedAt,predicted_at:t.predictedAt});
      grouped.set(race.id,list);
    }
  }
  let n=0;
  for (const race of dueRaces) {
    if(!candidatesByRace.has(race.id))continue;
    const rows=grouped.get(race.id)??[];
    const ranked=rows.filter(row=>row.bet_type==='trifecta')
      .map(row=>({...row,edgeData:candidate(Number(row.probability),Number(row.odds),Number(row.prob_std),'active',maxStd)}))
      .filter(row=>validProbability(row.probability) && validUncertainty(row.prob_std) && Number.isFinite(Number(row.odds)) && Number(row.odds)>0
        && Number.isFinite(Date.parse(row.predicted_at)) && Date.parse(row.predicted_at)<=inputAsOfAt
        && Number.isFinite(Date.parse(row.odds_captured_at)) && Date.parse(row.odds_captured_at)<=Date.now()
        && row.edgeData.expectedRoi!==null && Number.isFinite(row.edgeData.expectedRoi))
      .sort((a,b)=>b.edgeData.expectedRoi-a.edgeData.expectedRoi || (String(a.selection)<String(b.selection)?-1:String(a.selection)>String(b.selection)?1:0));
    const eligible=ranked.filter(row=>row.edgeData.expectedRoi>=minRoi && ['HIGH_EDGE','POSITIVE_EDGE'].includes(row.edgeData.edge));
    const chosen=eligible.slice(0,Math.min(maxPicks,6,raceBudget));
    const selected=chosen.map((row,index)=>({...row,candidateRank:index+1,candidateCount:chosen.length}));
    if (!selected.length) {
      await noteAbstention(race, paperAbstentionReason(candidatesByRace.get(race.id) ?? []));
      continue;
    }
    const groupId=betId(), totalStake=raceBudget,baseStake=Math.floor(raceBudget/selected.length),remainder=raceBudget%selected.length;
    if (!await reserveWorkerWrites(db, selected.length * 2 + 1)) {
      report.abstainedByReason.d1_write_budget_unavailable = (report.abstainedByReason.d1_write_budget_unavailable ?? 0) + 1;
      report.unrecordedAbstentionCount++;
      continue;
    }
    // Candidate inputs remain frozen at inputAsOfAt. Recheck the wall clock
    // after all reads and the budget reservation, immediately before the D1
    // transaction, so a slow evaluation cannot place late and claim T-60.
    const committedAt = Date.now();
    const commitTiming = primaryPaperTiming(race.betting_cutoff_at, committedAt, race.betting_cutoff_source, race.betting_cutoff_observed_at);
    if (!commitTiming.eligible) {
      await noteAbstention(race, commitTiming.reason === 'missed_timing' ? 'missed_timing' : 'timing_window_elapsed', true);
      continue;
    }
    const payload=selected.map((row,index)=>({id:betId(),race_id:row.race_id,sport:row.sport,bet_type:'trifecta',selection:row.selection,stake:baseStake+(index<remainder?1:0),
      predicted_prob:Number(row.probability),odds_at_bet:Number(row.odds),expected_roi:row.edgeData.expectedRoi,edge_label:row.edgeData.edge,
      model_id:row.model_id,data_origin:row.data_origin,candidate_rank:row.candidateRank,
      candidate_count:row.candidateCount,odds_captured_at:row.odds_captured_at,predicted_at_at_bet:row.predicted_at,decision_phase:PRIMARY_PAPER_PHASE}));
    const betInsert=db.prepare(`INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,predicted_prob,odds_at_bet,expected_roi,edge_label,model_id,placed_at,status,data_origin,bet_group_id,candidate_rank,candidate_count,odds_captured_at,predicted_at_at_bet,decision_phase)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.race_id'),json_extract(value,'$.sport'),json_extract(value,'$.bet_type'),json_extract(value,'$.selection'),json_extract(value,'$.stake'),'auto',json_extract(value,'$.predicted_prob'),json_extract(value,'$.odds_at_bet'),json_extract(value,'$.expected_roi'),json_extract(value,'$.edge_label'),json_extract(value,'$.model_id'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),'open',json_extract(value,'$.data_origin'),?,json_extract(value,'$.candidate_rank'),json_extract(value,'$.candidate_count'),json_extract(value,'$.odds_captured_at'),json_extract(value,'$.predicted_at_at_bet'),json_extract(value,'$.decision_phase')
      FROM json_each(?) WHERE ${availableBankrollSql}>=? AND NOT EXISTS(SELECT 1 FROM bets WHERE race_id=? AND mode='auto')
        AND NOT EXISTS(SELECT 1 FROM paper_decisions WHERE race_id=? AND phase='primary_t60')
        AND EXISTS(SELECT 1 FROM races rr WHERE rr.id=? AND rr.status='scheduled' AND rr.betting_cutoff_at=? AND rr.betting_cutoff_source=? AND rr.betting_cutoff_observed_at=?
          AND julianday(rr.betting_cutoff_observed_at)<=julianday(?) AND julianday(rr.betting_cutoff_observed_at)>=julianday(?)
          AND julianday(rr.betting_cutoff_observed_at)>=julianday(strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes'))
          AND ABS((julianday(rr.betting_cutoff_at)-julianday(?))*86400-60)<=10
          AND ABS((julianday(rr.betting_cutoff_at)-julianday('now'))*86400-60)<=10)
      ON CONFLICT(race_id,bet_type,selection) WHERE mode='auto' DO NOTHING`).bind(groupId,JSON.stringify(payload),totalStake,race.id,race.id,race.id,race.betting_cutoff_at,TRUSTED_CUTOFF_SOURCE,race.betting_cutoff_observed_at,inputAsOfAtIso,isoJstAt(inputAsOfAt - BOATRACE_CUTOFF_MAX_AGE_MS),isoJstAt(committedAt));
    const snapshotJson=JSON.stringify({phase:PRIMARY_PAPER_PHASE,cutoffAt:race.betting_cutoff_at,cutoffSource:race.betting_cutoff_source,cutoffObservedAt:race.betting_cutoff_observed_at,targetAt:isoJstAt(Date.parse(race.betting_cutoff_at)-PRIMARY_PAPER_OFFSET_MS),inputAsOfAt:inputAsOfAtIso,purchaseOdds:await oddsContext.cache.get(race.id),
      selections:selected.map(row=>({betType:'trifecta',selection:row.selection,probability:Number(row.probability),probStd:Number(row.prob_std),odds:Number(row.odds),oddsCapturedAt:row.odds_captured_at,predictedAt:row.predicted_at,modelId:row.model_id}))});
    const decisionInsert=db.prepare(`INSERT INTO paper_decisions(race_id,phase,cutoff_at,target_at,cutoff_observed_at,input_as_of_at,decided_at,outcome,reason,bet_group_id,snapshot_json,cutoff_source)
      SELECT ?,? ,?,?,?,?,(SELECT MIN(placed_at) FROM bets WHERE bet_group_id=? AND mode='auto' AND decision_phase='primary_t60'),'placed',NULL,?,?,?
        WHERE EXISTS(SELECT 1 FROM bets WHERE bet_group_id=? AND mode='auto' AND decision_phase='primary_t60')
        AND NOT EXISTS(SELECT 1 FROM paper_decisions WHERE race_id=? AND phase='primary_t60')
      ON CONFLICT(race_id,phase) DO NOTHING`).bind(race.id,PRIMARY_PAPER_PHASE,race.betting_cutoff_at,isoJstAt(Date.parse(race.betting_cutoff_at)-PRIMARY_PAPER_OFFSET_MS),race.betting_cutoff_observed_at,inputAsOfAtIso,groupId,groupId,snapshotJson,TRUSTED_CUTOFF_SOURCE,groupId,race.id);
    let insertedCount=0;
    if (db.batch) {
      const results=await db.batch([betInsert,decisionInsert]) as any[];
      insertedCount=Number(results?.[0]?.meta?.changes??0);
    } else {
      const inserted=await betInsert.run(); insertedCount=Number(inserted.meta?.changes??0);
      if(insertedCount>0)await decisionInsert.run();
    }
    if (insertedCount>0) { n+=insertedCount; report.purchasedRaceCount++; }
    else {
      const frozen=await first<any>(db,'SELECT outcome FROM paper_decisions WHERE race_id=? AND phase=?',race.id,PRIMARY_PAPER_PHASE);
      const existingAuto=await first<any>(db,"SELECT id FROM bets WHERE race_id=? AND mode='auto'",race.id);
      if(!frozen&&!existingAuto)await noteAbstention(race,'insufficient_bankroll',true);
    }
  }
  report.boughtBetCount=n;
  return { bought: n, report };
}
async function autoBet(db: Db, enabled: boolean, decisionAt = Date.now()) {
  return (await autoBetWithReport(db, enabled, decisionAt)).bought;
}
async function collectScheduledOdds(db: Db, oddsEnabled: boolean, trifectaOddsEnabled: boolean, requestBudget={used:0,max:49}, excludedRaceIds:string[]=[]) {
  if (trifectaOddsEnabled) {
    // Reserve a small bounded slice for the opt-in parser before legacy win
    // collection; both collectors share the existing per-run 49-fetch cap.
    requestBudget.max=Math.min(49,requestBudget.used+20);
    await collectTrifectaOdds(db,new Date(),{maxRequests:10,requestBudget,excludedRaceIds});
  }
  requestBudget.max=49;
  if (oddsEnabled) await collectOdds(db, new Date(),{requestBudget});
}
async function cron(db: Db, autoEnabled: boolean, oddsEnabled = false, trifectaOddsEnabled = false) {
  // Evaluate against observations already available at decision time. A
  // collection pass in this invocation must not make a late snapshot eligible.
  const paper=await autoBetWithReport(db,autoEnabled);
  await collectScheduledOdds(db, oddsEnabled, trifectaOddsEnabled);
  const settled=await settleOpen(db);
  const cutoff=new Date(Date.now()-30*86400000).toISOString();
  const oldRows=await first<any>(db, `SELECT COUNT(*) count FROM odds_snapshots WHERE captured_at<? AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.race_id=odds_snapshots.race_id AND b.selection=odds_snapshots.selection AND b.odds_at_bet=odds_snapshots.odds AND b.placed_at>=odds_snapshots.captured_at)`, cutoff);
  const cleanupCount=Math.min(10,Number(oldRows?.count??0));
  if(cleanupCount>0&&await reserveOptionalWorkerWrites(db,cleanupCount)) await run(db, `DELETE FROM odds_snapshots WHERE rowid IN (SELECT rowid FROM odds_snapshots WHERE captured_at<? AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.race_id=odds_snapshots.race_id AND b.selection=odds_snapshots.selection AND b.odds_at_bet=odds_snapshots.odds AND b.placed_at>=odds_snapshots.captured_at) LIMIT 10)`, cutoff).catch(()=>{});
  await cleanupOldQualityRuns(db);
  return {settled,bought:paper.bought,paperTiming:paper.report};
}

// Quality-only collector telemetry is short-lived. Preserve mixed runs and
// anything that also saved records; delete at most ten rows per 10-minute cron.
async function cleanupOldQualityRuns(db: Db, now = Date.now()) {
  const cutoff = new Date(now - 60 * 60_000).toISOString();
  const candidates = await all<any>(db, `SELECT id,started_at,records,error,reason FROM collection_runs
    WHERE source IN ('boatrace-odds-worker','boatrace-trifecta-odds-worker')
      AND records=0 AND julianday(started_at) < julianday(?)
      AND (error LIKE '%odds pool not stable (overround out of range)%' OR reason LIKE 'quality_excluded: %')
    ORDER BY julianday(started_at) ASC LIMIT 100`, cutoff);
  const ids = candidates.filter(row => {
    const issues = collectionIssues(row);
    return Number.isFinite(Date.parse(row.started_at)) && issues.quality.length > 0 && !issues.error && Number(row.records ?? 0) === 0;
  }).slice(0, 10).map(row => row.id);
  if (!ids.length || !await reserveOptionalWorkerWrites(db, ids.length)) return 0;
  const placeholders = ids.map(() => '?').join(',');
  await run(db, `DELETE FROM collection_runs WHERE id IN (${placeholders})`, ...ids);
  return ids.length;
}
app.get('/health', async c=>c.json({ok:true,service:'edgelab-api',d1WriteBudget:await readWriteBudget(c.env.DB)}));
app.get('/ingest/write-budget', async c=>{
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  return c.json(await readWriteBudget(c.env.DB));
});
// Operator-only reset: exact protected backup snapshot required, no frontend access.
app.get('/ingest/normal-history/snapshot', async c => {
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  return c.json(await normalHistorySnapshot(c.env.DB));
});
app.post('/ingest/normal-history/reset', async c => {
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  const body = await c.req.json().catch(() => null);
  if (body?.confirmation !== 'RESET NORMAL PURCHASE HISTORY ONLY' || !validSnapshot(body?.snapshot)) return jsonError(c, 'explicit confirmation and backup snapshot required', 400);
  try { return c.json(await resetNormalHistory(c.env.DB, body.snapshot)); }
  catch { return jsonError(c, 'reset refused: snapshot changed or atomic database unavailable', 409); }
});

app.post('/ingest/write-budget/seed', async c=>{
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  return c.json({error:'application D1 write reservations are disabled',code:'d1_write_budget_disabled',budget:await readWriteBudget(c.env.DB)},410);
});
app.post('/ingest/write-budget/allowance', async c=>{
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  return c.json({error:'application D1 write reservations are disabled',code:'d1_write_budget_disabled',budget:await readWriteBudget(c.env.DB)},410);
});
// Only settlement-relevant previous-day IDs are exported to the daily sync.
// Learning history stays in the local dataset; this route does not mutate D1.
app.get('/ingest/open-bet-race-ids', async c=>{
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  const day=c.req.query('date')??'';
  const today=jstRaceDate(), previous=new Date(`${today}T00:00:00+09:00`);
  previous.setUTCDate(previous.getUTCDate()-1);
  if (!isIsoCalendarDate(day) || ![today,jstRaceDate(previous)].includes(day))
    return jsonError(c,'current or previous JST race date is required');
  const rows=await all<{id:string}>(c.env.DB,`SELECT DISTINCT r.id FROM races r JOIN bets b ON b.race_id=r.id
    WHERE r.race_date=? AND r.sport='boat' AND r.data_origin='real' AND b.data_origin='real' AND b.status='open'
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
    ORDER BY r.id LIMIT 501`,day);
  if(rows.length>=501)return c.json({code:'open_bet_race_bound_exceeded'},503);
  return c.json({date:day,raceIds:rows.map(row=>row.id)});
});
// Narrow, authenticated read surface for a one-shot same-day forecast. It
// returns only raw boat inputs available by a recent, caller-supplied cutoff;
// the Python model remains the sole inference implementation.
app.get('/ingest/today-boat-forecast-inputs', async c=>{
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  const day=c.req.query('date'), cutoff=c.req.query('cutoff'), nowMs=Date.now();
  const parsed=cutoff ? Date.parse(cutoff) : NaN;
  if (!day || day!==jstRaceDate() || !cutoff || !Number.isFinite(parsed) ||
      parsed>nowMs || nowMs-parsed>5*60_000 || !/(Z|[+-]\d{2}:\d{2})$/i.test(cutoff))
    return jsonError(c, 'current JST race date and recent non-future ISO cutoff are required');
  const races=await all<any>(c.env.DB,`SELECT r.id,r.sport,r.venue_id,r.race_date,r.race_no,r.post_time,r.status,
      r.wind_speed,r.wave_height,r.data_origin
    FROM races r
    WHERE r.sport='boat' AND r.race_date=? AND r.data_origin='real' AND r.status='scheduled'
      AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?)
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
    ORDER BY julianday(r.post_time),r.race_no`,day,cutoff);
  if(races.length>180)return jsonError(c,'eligible race input exceeds the one-day operator response bound',413);
  const entries=races.length ? await all<any>(c.env.DB,`SELECT e.id,e.race_id,e.number,e.frame,e.name,e.jockey,e.trainer,
      e.weight_carried,e.horse_weight,e.racer_class,e.national_win_rate,e.local_win_rate,
      e.motor_no,e.motor_2rate,e.boat_no,e.boat_2rate,e.exhibition_time,e.start_exhibition,
      e.features_json,e.available_at,e.data_origin
    FROM entries e JOIN races r ON r.id=e.race_id
    WHERE r.sport='boat' AND r.race_date=? AND r.data_origin='real' AND r.status='scheduled'
      AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?)
      AND e.data_origin='real' AND julianday(e.available_at)<=julianday(?)
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
    ORDER BY r.race_no,e.number`,day,cutoff,cutoff) : [];
  if(entries.length>1_000)return jsonError(c,'eligible entry input exceeds the one-day operator response bound',413);
  return c.json({date:day,cutoff,races,entries});
});
app.get('/ingest/today-boat-forecast-status', async c=>{
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  const day=c.req.query('date'), modelId=c.req.query('model_id');
  if(!day||day!==jstRaceDate()||modelId!=='boat-win-lgbm-20261010-14b4a90a')
    return jsonError(c,'approved current-day model and race date are required');
  const db=c.env.DB, cutoff=now(), freshAfter=oddsFreshAfter();
  const model=await first<any>(db,'SELECT id,status FROM models WHERE id=? AND sport=\'boat\' AND bet_type=\'win\'',modelId);
  const coverage=await first<any>(db,`SELECT COUNT(DISTINCT r.id) race_count,COUNT(e.id) entry_count
    FROM races r LEFT JOIN entries e ON e.race_id=r.id AND e.data_origin='real' AND julianday(e.available_at)<=julianday(?)
    WHERE r.sport='boat' AND r.race_date=? AND r.data_origin='real' AND r.status='scheduled'
      AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?)
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)`,cutoff,day,cutoff);
  const predictions=await first<any>(db,`SELECT COUNT(*) row_count,COUNT(DISTINCT p.race_id) race_count
    FROM predictions p JOIN races r ON r.id=p.race_id JOIN entries e ON e.race_id=p.race_id AND e.number=p.number AND e.data_origin='real'
    WHERE p.model_id=? AND p.data_origin='real' AND r.sport='boat' AND r.race_date=? AND r.status='scheduled'
      AND r.data_origin='real' AND julianday(r.post_time)>julianday(?) AND julianday(p.predicted_at)<=julianday(?)
      AND julianday(p.predicted_at)<=julianday(r.post_time)
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)`,modelId,day,cutoff,cutoff);
  const odds=await first<any>(db,`SELECT COUNT(*) row_count,COUNT(DISTINCT race_id) race_count
    FROM odds_snapshots o JOIN races r ON r.id=o.race_id
    WHERE o.data_origin='real' AND r.data_origin='real' AND r.sport='boat' AND r.race_date=? AND r.status='scheduled'
      AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?)
      AND o.bet_type='win' AND o.source IN ('boatrace-odds-tf','boatrace-odds-tf-final')
      AND julianday(o.captured_at)<=julianday(?) AND julianday(o.captured_at)>=julianday(?)
      AND julianday(o.captured_at)<=julianday(r.post_time)
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)`,day,cutoff,cutoff,freshAfter);
  return c.json({date:day,cutoff,model:model??null,eligible:coverage??{race_count:0,entry_count:0},predictions:predictions??{row_count:0,race_count:0},freshOfficialWinOdds:odds??{row_count:0,race_count:0},autoBetEnabled:await setting(db,'auto_bet_enabled','false'),autoBetPaused:await setting(db,'auto_bet_paused','true'),writeBudget:await readWriteBudget(db)});
});
// One explicit operator call may invoke only the existing bounded win-odds
// collector. It cannot settle bets, run auto-bet, or enable either feature.
app.post('/ingest/collect-win-odds', async c=>{
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  const body=await c.req.json().catch(()=>null) as any;
  const keys=body&&typeof body==='object'&&!Array.isArray(body)?Object.keys(body).sort():[];
  if(keys.length!==2||keys[0]!=='confirmed'||keys[1]!=='date'||body.confirmed!==true||body.date!==utcDate())
    return jsonError(c,'explicit current-UTC-day win-odds collection confirmation is required');
  if(c.env.ENABLE_BOATRACE_ODDS_SCRAPE!=='true')return jsonError(c,'official win-odds collector is disabled',409);
  const approved=await first<any>(c.env.DB,"SELECT status FROM models WHERE id='boat-win-lgbm-20261010-14b4a90a' AND sport='boat' AND bet_type='win'");
  if(approved?.status!=='active')return jsonError(c,'approved boat-win baseline must be active before operator odds collection',409);
  const outcome=await collectOdds(c.env.DB,new Date(),{maxRequests:30});
  return c.json(outcome);
});
app.get('/races', async c=>{
  const db=c.env.DB, sport=c.req.query('sport'), date=c.req.query('date'), origin=originFilter(c.req.query('origin'));
  if (sport && !validSport(sport)) return jsonError(c,'invalid sport');
  if (!date) return jsonError(c,'date is required');
  const rows=await all<any>(db,`SELECT r.*,v.name venue_name,(SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id) entry_count FROM races r JOIN venues v ON v.id=r.venue_id WHERE r.race_date=? AND (? IS NULL OR r.sport=?) AND (? IS NULL OR r.data_origin=?) AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id) ORDER BY r.sport,v.name,r.race_no`,date,sport||null,sport||null,origin,origin);
  const out=[];
  const maxStd=Number(await setting(db,'max_prob_std','0.05'));
  for(const r of rows){
    const candidates=await all<any>(db,`SELECT p.probability,p.prob_std,o.odds,m.status FROM predictions p JOIN races r ON r.id=p.race_id JOIN models m ON m.id=p.model_id AND m.status='active' AND m.sport=r.sport AND m.bet_type='win' AND (r.sport<>'boat' OR CASE WHEN json_valid(m.metrics_json) THEN (json_type(m.metrics_json,'$.boatArtifactSha256')='text' AND json_extract(m.metrics_json,'$.boatVenueSchemaVersion')='boat-venue-v2' AND length(json_extract(m.metrics_json,'$.correctedTrainingDataSha256'))=64 AND json_extract(m.metrics_json,'$.correctedTrainingDataSha256') NOT GLOB '*[^a-f0-9]*' AND length(json_extract(m.metrics_json,'$.boatArtifactSha256'))=64 AND json_extract(m.metrics_json,'$.boatArtifactSha256') NOT GLOB '*[^a-f0-9]*') ELSE 0 END) JOIN entries e ON e.race_id=p.race_id AND e.number=p.number JOIN odds_snapshots o ON o.race_id=p.race_id AND o.data_origin=r.data_origin AND o.selection=CAST(e.number AS TEXT) AND o.bet_type='win' AND o.captured_at=(SELECT o2.captured_at FROM odds_snapshots o2 WHERE o2.race_id=p.race_id AND o2.data_origin=r.data_origin AND o2.bet_type='win' AND o2.selection=CAST(e.number AS TEXT) AND julianday(o2.captured_at)<=julianday(?) AND julianday(o2.captured_at)>=julianday(?) AND julianday(o2.captured_at)<=julianday(r.post_time) ORDER BY julianday(o2.captured_at) DESC LIMIT 1) WHERE p.race_id=? AND r.status='scheduled' AND e.data_origin=r.data_origin AND p.data_origin=r.data_origin AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?) AND julianday(p.predicted_at)<=julianday(r.post_time) AND julianday(p.predicted_at)<=julianday(?)`,now(),oddsFreshAfter(),r.id,now(),now());
    const choices=candidates.map(b=>candidate(b.probability,b.odds,b.prob_std,b.status,maxStd)).sort((a,b)=>(b.expectedRoi??-Infinity)-(a.expectedRoi??-Infinity));
    const best=choices[0]; out.push({id:r.id,sport:r.sport,venueId:r.venue_id,venueName:r.venue_name,raceDate:r.race_date,raceNo:r.race_no,name:r.name,distance:r.distance,surface:r.surface,trackCondition:r.track_condition,weather:r.weather,postTime:r.post_time,status:r.status,dataOrigin:r.data_origin,entryCount:r.entry_count,topEdge:best?.edge??'INSUFFICIENT_DATA',bestExpectedRoi:best?.expectedRoi??null});
  }
  return c.json(out);
});
app.get('/races/:id', async c=>{
 const db=c.env.DB,r=await first<any>(db,'SELECT r.*,v.name venue_name FROM races r JOIN venues v ON v.id=r.venue_id WHERE r.id=? AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)',c.req.param('id')); if(!r)return jsonError(c,'not found',404);
 const maxStd=Number(await setting(db,'max_prob_std','0.05'));
 const entries=await all<any>(db,`SELECT e.*,o.odds,o.captured_at,p.probability,p.prob_std,p.predicted_at,m.id model_id,m.status model_status,res.finish_order FROM entries e JOIN races r ON r.id=e.race_id
 LEFT JOIN odds_snapshots o ON o.id=(SELECT o2.id FROM odds_snapshots o2 WHERE o2.race_id=e.race_id AND o2.data_origin=r.data_origin AND o2.bet_type='win' AND o2.selection=CAST(e.number AS TEXT) AND julianday(o2.captured_at)<=julianday(?) AND julianday(o2.captured_at)>=julianday(?) AND julianday(o2.captured_at)<=julianday(r.post_time) AND r.status='scheduled' AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?) ORDER BY julianday(o2.captured_at) DESC LIMIT 1)
  LEFT JOIN predictions p ON p.id=(SELECT p2.id FROM predictions p2 JOIN models pm ON pm.id=p2.model_id AND pm.status='active' AND pm.sport=r.sport AND pm.bet_type='win' AND (r.sport<>'boat' OR CASE WHEN json_valid(pm.metrics_json) THEN (json_type(pm.metrics_json,'$.boatArtifactSha256')='text' AND json_extract(pm.metrics_json,'$.boatVenueSchemaVersion')='boat-venue-v2' AND length(json_extract(pm.metrics_json,'$.correctedTrainingDataSha256'))=64 AND json_extract(pm.metrics_json,'$.correctedTrainingDataSha256') NOT GLOB '*[^a-f0-9]*' AND length(json_extract(pm.metrics_json,'$.boatArtifactSha256'))=64 AND json_extract(pm.metrics_json,'$.boatArtifactSha256') NOT GLOB '*[^a-f0-9]*') ELSE 0 END) WHERE p2.race_id=e.race_id AND p2.number=e.number AND p2.data_origin=r.data_origin AND julianday(p2.predicted_at)<=julianday(?) AND julianday(p2.predicted_at)<=julianday(r.post_time) AND r.status='scheduled' AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?) ORDER BY julianday(p2.predicted_at) DESC LIMIT 1)
 LEFT JOIN models m ON m.id=p.model_id LEFT JOIN results res ON res.race_id=e.race_id AND res.number=e.number AND res.data_origin=r.data_origin WHERE e.race_id=? AND e.data_origin=r.data_origin ORDER BY e.number`,now(),oddsFreshAfter(),now(),now(),now(),r.id);
 const model=entries.find(x=>x.model_id)?.model_id; const modelRow=model?await first<any>(db,'SELECT * FROM models WHERE id=?',model):null;
 const payouts=(await all<any>(db,`SELECT bet_type,selection,payout,popularity FROM payouts WHERE race_id=? ORDER BY CASE bet_type WHEN 'win' THEN 1 WHEN 'place' THEN 2 WHEN 'exacta' THEN 3 WHEN 'quinella' THEN 4 WHEN 'wide' THEN 5 WHEN 'trifecta' THEN 6 WHEN 'trio' THEN 7 ELSE 8 END,selection`,r.id)).map(p=>({betType:p.bet_type,selection:p.selection,payout:p.payout,popularity:p.popularity}));
 const entryViews=entries.map(x=>{const a=candidate(x.probability,x.odds,x.prob_std,x.model_status,maxStd);return {number:x.number,frame:x.frame,name:x.name,jockey:x.jockey,trainer:x.trainer,weightCarried:x.weight_carried,horseWeight:x.horse_weight,racerClass:x.racer_class,nationalWinRate:x.national_win_rate,localWinRate:x.local_win_rate,motorNo:x.motor_no,motor2Rate:x.motor_2rate,boatNo:x.boat_no,boat2Rate:x.boat_2rate,exhibitionTime:x.exhibition_time,startExhibition:x.start_exhibition,odds:x.odds,oddsCapturedAt:x.captured_at,probability:x.probability,probStd:x.prob_std,breakEvenProb:x.odds?1/x.odds:null,expectedRoi:a.expectedRoi,conservativeRoi:a.conservativeRoi,edge:a.edge,finishOrder:x.finish_order??null}});
 const best=entryViews.filter(x=>x.expectedRoi!==null).sort((a,b)=>(b.expectedRoi??-Infinity)-(a.expectedRoi??-Infinity))[0];
 const tickets=await ticketCandidatesForRace(db,r,maxStd);
 return c.json({id:r.id,sport:r.sport,venueId:r.venue_id,venueName:r.venue_name,raceDate:r.race_date,raceNo:r.race_no,name:r.name,distance:r.distance,surface:r.surface,trackCondition:r.track_condition,weather:r.weather,windSpeed:r.wind_speed,waveHeight:r.wave_height,postTime:r.post_time,status:r.status,dataOrigin:r.data_origin,entryCount:entries.length,topEdge:best?.edge??'INSUFFICIENT_DATA',bestExpectedRoi:best?.expectedRoi??null,model:modelRow?mapModel(modelRow):null,predictedAt:entries.find(x=>x.predicted_at)?.predicted_at??null,dataFreshnessMinutes:entries.find(x=>x.captured_at)?Math.max(0,(Date.now()-Date.parse(entries.find(x=>x.captured_at).captured_at))/60000):null,entries:entryViews,tickets,payouts});
});
function mapModel(m:any){return {id:m.id,sport:m.sport,betType:m.bet_type,version:m.version,algorithm:m.algorithm,status:m.status,trainFrom:m.train_from,trainTo:m.train_to,validFrom:m.valid_from,validTo:m.valid_to,testFrom:m.test_from,testTo:m.test_to,nTrain:m.n_train,metrics:JSON.parse(m.metrics_json||'{}'),trainedAt:m.trained_at,notes:m.notes};}
// Read-only historical evidence view. Unlike /races/:id, this route does not
// apply live candidate eligibility, active-model gates, or scheduled-race
// filtering. It reads one exact real boat race and at most one 121-row batch
// for each evidence table so stored history can be inspected without changing
// what can be bought or inferred from the live candidate endpoints.
app.get('/shadow/races/:id', async c=>{
 const id=c.req.param('id');
 if(!/^boat-\d{8}-\d{2}-\d{2}$/.test(id))return jsonError(c,'invalid real boat race id');
 const db=c.env.DB;
 const race=await first<any>(db,`SELECT r.id,r.sport,r.venue_id venueId,v.name venueName,r.race_date raceDate,r.race_no raceNo,
   r.post_time postTime,r.status,r.data_origin dataOrigin,(SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin='real') entryCount
   FROM races r JOIN venues v ON v.id=r.venue_id
   WHERE r.id=? AND r.sport='boat' AND r.data_origin='real'
     AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)`,id);
 if(!race)return jsonError(c,'not found',404);

 const predictionHeader=await first<any>(db,`SELECT p.model_id modelId,p.predicted_at predictedAt,m.version modelVersion,m.status modelStatus
   FROM ticket_predictions p LEFT JOIN models m ON m.id=p.model_id
   WHERE p.race_id=? AND p.bet_type='trifecta' AND p.data_origin='real'
   ORDER BY julianday(p.predicted_at) DESC,p.model_id LIMIT 1`,id);
 let predictionBatch=null;
 if(predictionHeader){
   const rows=await all<any>(db,`SELECT selection,probability,prob_std probStd,feature_schema_version featureSchemaVersion,artifact_sha256 artifactSha256
     FROM ticket_predictions
     WHERE race_id=? AND model_id=? AND bet_type='trifecta' AND data_origin='real' AND predicted_at=?
     ORDER BY selection LIMIT 121`,id,predictionHeader.modelId,predictionHeader.predictedAt);
   predictionBatch={...predictionHeader,rowCount:rows.length,rows};
 }

 const oddsHeader=await first<any>(db,`SELECT captured_at capturedAt,source,source_url sourceUrl,source_sha256 sourceSha256,quality_status qualityStatus
   FROM odds_snapshots
   WHERE race_id=? AND bet_type='trifecta' AND data_origin='real'
   ORDER BY julianday(captured_at) DESC LIMIT 1`,id);
 let oddsSnapshot=null;
 if(oddsHeader){
   const rows=await all<any>(db,`SELECT selection,odds FROM odds_snapshots
     WHERE race_id=? AND bet_type='trifecta' AND data_origin='real' AND captured_at=?
       AND source IS ? AND source_url IS ? AND source_sha256 IS ? AND quality_status IS ?
     ORDER BY selection LIMIT 121`,id,oddsHeader.capturedAt,oddsHeader.source,oddsHeader.sourceUrl,oddsHeader.sourceSha256,oddsHeader.qualityStatus);
   oddsSnapshot={...oddsHeader,rowCount:rows.length,rows};
 }
 c.header('Cache-Control','private, no-store');
 return c.json({race,predictionBatch,oddsSnapshot,pointInTimeAvailability:'not-recorded'});
});
app.get('/rankings',async c=>{
 const db=c.env.DB,sport=c.req.query('sport'),date=c.req.query('date'),origin=originFilter(c.req.query('origin')); if(sport&&!validSport(sport))return jsonError(c,'invalid sport'); if(!date)return jsonError(c,'date is required');
 const rows=await all<any>(db,`SELECT r.id race_id,r.sport,r.data_origin,r.race_no,r.post_time,v.name venue_name,e.number,e.name,p.probability,p.prob_std,p.model_id,m.status model_status,o.odds,o.captured_at,p.predicted_at FROM races r JOIN venues v ON v.id=r.venue_id JOIN entries e ON e.race_id=r.id AND e.data_origin=r.data_origin JOIN predictions p ON p.id=(SELECT p2.id FROM predictions p2 JOIN models pm ON pm.id=p2.model_id AND pm.status='active' AND pm.sport=r.sport AND pm.bet_type='win' AND (r.sport<>'boat' OR CASE WHEN json_valid(pm.metrics_json) THEN (json_type(pm.metrics_json,'$.boatArtifactSha256')='text' AND json_extract(pm.metrics_json,'$.boatVenueSchemaVersion')='boat-venue-v2' AND length(json_extract(pm.metrics_json,'$.correctedTrainingDataSha256'))=64 AND json_extract(pm.metrics_json,'$.correctedTrainingDataSha256') NOT GLOB '*[^a-f0-9]*' AND length(json_extract(pm.metrics_json,'$.boatArtifactSha256'))=64 AND json_extract(pm.metrics_json,'$.boatArtifactSha256') NOT GLOB '*[^a-f0-9]*') ELSE 0 END) WHERE p2.race_id=r.id AND p2.number=e.number AND p2.data_origin=r.data_origin AND julianday(p2.predicted_at)<=julianday(?) AND julianday(p2.predicted_at)<=julianday(r.post_time) ORDER BY julianday(p2.predicted_at) DESC LIMIT 1) JOIN models m ON m.id=p.model_id AND m.status='active' AND m.sport=r.sport AND m.bet_type='win' AND (r.sport<>'boat' OR CASE WHEN json_valid(m.metrics_json) THEN (json_type(m.metrics_json,'$.boatArtifactSha256')='text' AND json_extract(m.metrics_json,'$.boatVenueSchemaVersion')='boat-venue-v2' AND length(json_extract(m.metrics_json,'$.correctedTrainingDataSha256'))=64 AND json_extract(m.metrics_json,'$.correctedTrainingDataSha256') NOT GLOB '*[^a-f0-9]*' AND length(json_extract(m.metrics_json,'$.boatArtifactSha256'))=64 AND json_extract(m.metrics_json,'$.boatArtifactSha256') NOT GLOB '*[^a-f0-9]*') ELSE 0 END) JOIN odds_snapshots o ON o.race_id=r.id AND o.data_origin=r.data_origin AND o.bet_type='win' AND o.selection=CAST(e.number AS TEXT) AND o.captured_at=(SELECT o2.captured_at FROM odds_snapshots o2 WHERE o2.race_id=r.id AND o2.data_origin=r.data_origin AND o2.bet_type='win' AND o2.selection=CAST(e.number AS TEXT) AND julianday(o2.captured_at)<=julianday(?) AND julianday(o2.captured_at)>=julianday(?) AND julianday(o2.captured_at)<=julianday(r.post_time) ORDER BY julianday(o2.captured_at) DESC LIMIT 1) WHERE julianday(p.predicted_at)<=julianday(?) AND r.race_date=? AND r.status='scheduled' AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?) AND (? IS NULL OR r.sport=?) AND (? IS NULL OR r.data_origin=?) AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)`,now(),now(),oddsFreshAfter(),now(),date,now(),sport||null,sport||null,origin,origin);
 const maxStd=Number(await setting(db,'max_prob_std','0.05'));
 const winCandidates=rows.map(x=>({...candidate(x.probability,x.odds,x.prob_std,x.model_status,maxStd),raceId:x.race_id,sport:x.sport,venueName:x.venue_name,raceNo:x.race_no,postTime:x.post_time,number:x.number,name:x.name,probability:x.probability,probStd:x.prob_std,odds:x.odds,breakEvenProb:1/x.odds,modelId:x.model_id,dataFreshnessMinutes:Math.max(0,(Date.now()-Date.parse(x.captured_at))/60000),dataOrigin:x.data_origin}));
 const ticketRaces=await all<any>(db,`SELECT r.*,v.name venue_name FROM races r JOIN venues v ON v.id=r.venue_id WHERE r.race_date=? AND r.status='scheduled' AND (? IS NULL OR r.sport=?) AND (? IS NULL OR r.data_origin=?) AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)`,date,sport||null,sport||null,origin,origin);
 const tickets=(await Promise.all(ticketRaces.map((race:any)=>ticketCandidatesForRace(db,race,maxStd)))).flat();
 return c.json([...winCandidates,...tickets].sort((a,b)=>(b.expectedRoi??-Infinity)-(a.expectedRoi??-Infinity)));
});
app.post('/bets',async c=>{
 const db=c.env.DB, body=await c.req.json().catch(()=>null) as any;
 if(body?.betType==='trifecta'){
   if(typeof body.raceId!=='string'||typeof body.selection!=='string'||!validateYenStake(body.stake)
       ||typeof body.requestId!=='string'||! /^[A-Za-z0-9_-]{1,64}$/.test(body.requestId))return jsonError(c,'invalid request');
   const existing=await first<any>(db,'SELECT * FROM bets WHERE bet_group_id=?',body.requestId);
   if(existing){
     if(existing.race_id!==body.raceId||existing.bet_type!=='trifecta'||existing.mode!=='manual'||existing.selection!==body.selection||existing.stake!==body.stake)
       return jsonError(c,'requestId was already used for a different bet',409);
     return c.json(mapBet(existing));
   }
   const race=await first<any>(db,'SELECT * FROM races WHERE id=? AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=races.id)',body.raceId);
   if(!race)return jsonError(c,'race not found',404);
   if(race.status!=='scheduled'||!race.post_time||!Number.isFinite(Date.parse(race.post_time))||Date.parse(race.post_time)<=Date.now())return jsonError(c,'race is not scheduled');
   const venue=await first<any>(db,'SELECT name venue_name FROM venues WHERE id=?',race.venue_id);
   const maxStd=Number(await setting(db,'max_prob_std','0.05'));
   const ticket=(await ticketCandidatesForRace(db,{...race,venue_name:venue?.venue_name},maxStd)).find(x=>x.selection===body.selection);
   if(!ticket?.buyEligible)return jsonError(c,'ticket model or audited fresh odds are unavailable');
   const id=betId();
   const bet={id,race_id:race.id,sport:race.sport,bet_type:'trifecta',selection:ticket.selection,stake:body.stake,mode:'manual',predicted_prob:ticket.probability,odds_at_bet:ticket.odds,expected_roi:ticket.expectedRoi,edge_label:ticket.edge,model_id:ticket.modelId,placed_at:manualBetPlacedAt(id),status:'open',data_origin:'real',bet_group_id:body.requestId,odds_captured_at:ticket.oddsCapturedAt,predicted_at_at_bet:ticket.predictedAt};
   if(!await reserveManualBetWrites(db,1)){
     const repeated=await first<any>(db,'SELECT * FROM bets WHERE bet_group_id=?',body.requestId);
     if(repeated&&repeated.race_id===body.raceId&&repeated.bet_type==='trifecta'&&repeated.mode==='manual'&&repeated.selection===body.selection&&repeated.stake===body.stake)return c.json(mapBet(repeated));
     if(repeated)return jsonError(c,'requestId was already used for a different bet',409);
     const available=await first<any>(db,`SELECT ${availableBankrollSql} available`);
     if(Number(available?.available??0)<body.stake)return jsonError(c,'insufficient bankroll');
     const budget=await readWriteBudget(db);
     return c.json({error:'daily D1 write budget unavailable or exhausted',code:budget.state==='missing'||budget.state==='invalid'?'d1_write_budget_unavailable':'d1_write_budget_exhausted',budget},429);
   }
   const inserted=await run(db,`INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,predicted_prob,odds_at_bet,expected_roi,edge_label,model_id,placed_at,status,data_origin,bet_group_id,odds_captured_at,predicted_at_at_bet)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${availableBankrollSql} >= ? AND NOT EXISTS(SELECT 1 FROM bets WHERE bet_group_id=?)
   ON CONFLICT(bet_group_id,bet_type,selection) WHERE bet_group_id IS NOT NULL DO NOTHING`,...Object.values(bet),body.stake,body.requestId);
   if(!inserted.meta?.changes){
     const repeated=await first<any>(db,'SELECT * FROM bets WHERE bet_group_id=?',body.requestId);
     if(repeated&&repeated.race_id===body.raceId&&repeated.bet_type==='trifecta'&&repeated.mode==='manual'&&repeated.selection===body.selection&&repeated.stake===body.stake)return c.json(mapBet(repeated));
     if(repeated)return jsonError(c,'requestId was already used for a different bet',409);
     return jsonError(c,'insufficient bankroll');
   }
   return c.json(mapBet(bet),201);
 }
 const legacyRequest=!!body&&Array.isArray(body.selections)===false&&typeof body.selection==='string';
 const rawSelections=Array.isArray(body?.selections)?body.selections:(legacyRequest?[{selection:body.selection,stake:body.stake}]:null);
 if(!body||typeof body.raceId!=='string'||body.betType!=='win'||!rawSelections||rawSelections.length<1||rawSelections.length>6)return jsonError(c,'invalid request');
 if(body.requestId!==undefined&&(typeof body.requestId!=='string'||! /^[A-Za-z0-9_-]{1,64}$/.test(body.requestId)))return jsonError(c,'requestId must be 1-64 letters, numbers, hyphens, or underscores');
 const selections=rawSelections.map((x:any)=>({selection:x?.selection,stake:x?.stake}));
 if(selections.some((x:any)=>typeof x.selection!=='string'||!validateYenStake(x.stake))||new Set(selections.map((x:any)=>x.selection)).size!==selections.length)return jsonError(c,'selections require unique entries and positive integer yen stakes');
 const totalStake=selections.reduce((sum:number,x:any)=>sum+x.stake,0); if(!Number.isSafeInteger(totalStake)||totalStake>2_147_483_647)return jsonError(c,'total stake is too large');
 const groupId=body.requestId??betId();
 const existing=await all<any>(db,'SELECT * FROM bets WHERE bet_group_id=? ORDER BY selection',groupId);
 if(existing.length){
   const requested=[...selections].sort((a:any,b:any)=>a.selection.localeCompare(b.selection));
   if(existing.length!==requested.length||existing.some((b:any,i:number)=>b.race_id!==body.raceId||b.bet_type!=='win'||b.mode!=='manual'||b.selection!==requested[i].selection||b.stake!==requested[i].stake))return jsonError(c,'requestId was already used for a different bet group',409);
   return c.json(legacyRequest?mapBet(existing[0]):{groupId,bets:existing.map(mapBet)});
 }
 const race=await first<any>(db,'SELECT * FROM races WHERE id=? AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=races.id)',body.raceId); if(!race)return jsonError(c,'race not found',404); if(race.status!=='scheduled')return jsonError(c,'race is not scheduled');
 if(!race.post_time||!Number.isFinite(Date.parse(race.post_time))||Date.parse(race.post_time)<=Date.now())return jsonError(c,'race has started or start time is unavailable');
 const timestamp=now(), oddsCutoff=oddsFreshAfter();
 const rankedRows=await all<any>(db,`SELECT e.number,p.probability,p.prob_std,p.model_id,p.predicted_at,m.status model_status,o.odds,o.captured_at odds_captured_at
   FROM entries e JOIN predictions p ON p.id=(SELECT p2.id FROM predictions p2 JOIN models pm ON pm.id=p2.model_id AND pm.status='active' AND pm.sport=? AND pm.bet_type='win' AND (?<>'boat' OR CASE WHEN json_valid(pm.metrics_json) THEN (json_type(pm.metrics_json,'$.boatArtifactSha256')='text' AND json_extract(pm.metrics_json,'$.boatVenueSchemaVersion')='boat-venue-v2' AND length(json_extract(pm.metrics_json,'$.correctedTrainingDataSha256'))=64 AND json_extract(pm.metrics_json,'$.correctedTrainingDataSha256') NOT GLOB '*[^a-f0-9]*' AND length(json_extract(pm.metrics_json,'$.boatArtifactSha256'))=64 AND json_extract(pm.metrics_json,'$.boatArtifactSha256') NOT GLOB '*[^a-f0-9]*') ELSE 0 END) WHERE p2.race_id=e.race_id AND p2.number=e.number AND p2.data_origin=e.data_origin AND julianday(p2.predicted_at)<=julianday(?) AND julianday(p2.predicted_at)<=julianday(?) ORDER BY julianday(p2.predicted_at) DESC LIMIT 1)
   JOIN models m ON m.id=p.model_id JOIN odds_snapshots o ON o.id=(SELECT o2.id FROM odds_snapshots o2 WHERE o2.race_id=e.race_id AND o2.data_origin=e.data_origin AND o2.bet_type='win' AND o2.selection=CAST(e.number AS TEXT) AND julianday(o2.captured_at)<=julianday(?) AND julianday(o2.captured_at)>=julianday(?) AND julianday(o2.captured_at)<=julianday(?) ORDER BY julianday(o2.captured_at) DESC LIMIT 1)
   WHERE e.race_id=? AND e.data_origin=? AND p.data_origin=e.data_origin AND o.data_origin=e.data_origin`,race.sport,race.sport,timestamp,race.post_time,timestamp,oddsCutoff,race.post_time,body.raceId,race.data_origin);
 const maxStd=Number(await setting(db,'max_prob_std','0.05'));
 const ranked=rankedRows.map(row=>({...row,rankData:candidate(row.probability,row.odds,row.prob_std,row.model_status,maxStd)}))
   .filter(row=>row.rankData.expectedRoi!==null).sort((a,b)=>b.rankData.expectedRoi-a.rankData.expectedRoi||Number(a.number)-Number(b.number))
   .map((row,index)=>({...row,candidateRank:index+1,candidateCount:0}));
 for(const row of ranked)row.candidateCount=ranked.length;
 const picks=[];
 for(const input of selections){
   const row=ranked.find(x=>String(x.number)===input.selection);
   if(!row){
     const entry=await first<any>(db,'SELECT number FROM entries WHERE race_id=? AND data_origin=? AND CAST(number AS TEXT)=?',body.raceId,race.data_origin,input.selection);
     if(!entry)return jsonError(c,'selection not found');
     const pred=await first<any>(db,`SELECT p.id FROM predictions p JOIN models m ON m.id=p.model_id AND m.status='active' AND m.sport=? AND m.bet_type='win' AND (?<>'boat' OR CASE WHEN json_valid(m.metrics_json) THEN (json_type(m.metrics_json,'$.boatArtifactSha256')='text' AND json_extract(m.metrics_json,'$.boatVenueSchemaVersion')='boat-venue-v2' AND length(json_extract(m.metrics_json,'$.correctedTrainingDataSha256'))=64 AND json_extract(m.metrics_json,'$.correctedTrainingDataSha256') NOT GLOB '*[^a-f0-9]*' AND length(json_extract(m.metrics_json,'$.boatArtifactSha256'))=64 AND json_extract(m.metrics_json,'$.boatArtifactSha256') NOT GLOB '*[^a-f0-9]*') ELSE 0 END) WHERE p.race_id=? AND p.data_origin=? AND p.number=? AND julianday(p.predicted_at)<=julianday(?) AND julianday(p.predicted_at)<=julianday(?) ORDER BY julianday(p.predicted_at) DESC LIMIT 1`,race.sport,race.sport,body.raceId,race.data_origin,entry.number,timestamp,race.post_time);
     return jsonError(c,pred?'odds are unavailable':'active model prediction is unavailable');
   }
   picks.push({...row,selection:input.selection,stake:input.stake});
 }
 const payload=picks.map(row=>{
   const id=betId();
   return {id,race_id:race.id,sport:race.sport,selection:row.selection,stake:row.stake,
     predicted_prob:row.probability,odds_at_bet:row.odds,expected_roi:row.rankData.expectedRoi,edge_label:row.rankData.edge,model_id:row.model_id,
     placed_at:manualBetPlacedAt(id),data_origin:race.data_origin,candidate_rank:row.candidateRank,candidate_count:row.candidateCount,
     odds_captured_at:row.odds_captured_at,predicted_at_at_bet:row.predicted_at};
 });
 if(!await reserveManualBetWrites(db,payload.length*2)){
   const repeated=await all<any>(db,'SELECT * FROM bets WHERE bet_group_id=? ORDER BY selection',groupId);
   const requested=[...selections].sort((a:any,b:any)=>a.selection.localeCompare(b.selection));
   if(repeated.length){
     if(repeated.length===requested.length&&repeated.every((b:any,i:number)=>b.race_id===body.raceId&&b.bet_type==='win'&&b.mode==='manual'&&b.selection===requested[i].selection&&b.stake===requested[i].stake))return c.json(legacyRequest?mapBet(repeated[0]):{groupId,bets:repeated.map(mapBet)});
     return jsonError(c,'requestId was already used for a different bet group',409);
   }
   const available=await first<any>(db,`SELECT ${availableBankrollSql} available`);
   if(Number(available?.available??0)<totalStake)return jsonError(c,'insufficient bankroll');
   const budget=await readWriteBudget(db);
   return c.json({error:'daily D1 write budget unavailable or exhausted',code:budget.state==='missing'||budget.state==='invalid'?'d1_write_budget_unavailable':'d1_write_budget_exhausted',budget},429);
 }
 const inserted=await run(db,`INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,predicted_prob,odds_at_bet,expected_roi,edge_label,model_id,placed_at,status,data_origin,bet_group_id,candidate_rank,candidate_count,odds_captured_at,predicted_at_at_bet)
   SELECT json_extract(value,'$.id'),json_extract(value,'$.race_id'),json_extract(value,'$.sport'),'win',json_extract(value,'$.selection'),json_extract(value,'$.stake'),'manual',json_extract(value,'$.predicted_prob'),json_extract(value,'$.odds_at_bet'),json_extract(value,'$.expected_roi'),json_extract(value,'$.edge_label'),json_extract(value,'$.model_id'),json_extract(value,'$.placed_at'),'open',json_extract(value,'$.data_origin'),?,json_extract(value,'$.candidate_rank'),json_extract(value,'$.candidate_count'),json_extract(value,'$.odds_captured_at'),json_extract(value,'$.predicted_at_at_bet')
   FROM json_each(?) WHERE ${availableBankrollSql}>=? AND NOT EXISTS(SELECT 1 FROM bets WHERE bet_group_id=?)
   ON CONFLICT(bet_group_id,bet_type,selection) WHERE bet_group_id IS NOT NULL DO NOTHING`,groupId,JSON.stringify(payload),totalStake,groupId);
 if(!inserted.meta?.changes){
   const repeated=await all<any>(db,'SELECT * FROM bets WHERE bet_group_id=? ORDER BY selection',groupId);
   const requested=[...selections].sort((a:any,b:any)=>a.selection.localeCompare(b.selection));
   if(repeated.length===requested.length&&repeated.every((b:any,i:number)=>b.race_id===body.raceId&&b.bet_type==='win'&&b.mode==='manual'&&b.selection===requested[i].selection&&b.stake===requested[i].stake))return c.json(legacyRequest?mapBet(repeated[0]):{groupId,bets:repeated.map(mapBet)});
   return jsonError(c,repeated.length?'requestId was already used for a different bet group':'insufficient bankroll',repeated.length?409:400);
 }
 const bets=await all<any>(db,'SELECT * FROM bets WHERE bet_group_id=? ORDER BY candidate_rank',groupId);
 return c.json(legacyRequest?mapBet(bets[0]):{groupId,bets:bets.map(mapBet)},201);
});
const SHA256 = /^[a-f0-9]{64}$/;
function ticketMetadata(metrics: any, betType: string): boolean {
  return metrics?.ticketModelSchemaVersion === TICKET_MODEL_SCHEMA
    && metrics?.ticketPredictionSemantics === TICKET_PROBABILITY_SEMANTICS
    && metrics?.ticketBetType === betType
    && typeof metrics?.ticketArtifactSha256 === 'string' && SHA256.test(metrics.ticketArtifactSha256);
}
function ticketValidationEvidence(metrics: any, betType: string): boolean {
  const v = metrics?.ticketValidation;
  const validatedAt = typeof v?.validatedAt === 'string' ? Date.parse(v.validatedAt) : NaN;
  return ticketMetadata(metrics, betType) && metrics.promotionEligible === true && v?.status === 'independently_validated'
    && v?.policyVersion === TICKET_MODEL_SCHEMA && v?.betType === betType
    && v?.artifactSha256 === metrics.ticketArtifactSha256 && typeof v?.reportSha256 === 'string' && SHA256.test(v.reportSha256)
    && typeof v?.independentReviewId === 'string' && v.independentReviewId.length > 0
    && v?.dataOrigin === 'real' && v?.completeCombinationCoverage === true
    && v?.probabilitiesNormalized === true && v?.outOfSampleValidated === true && v?.pointInTimeSafe === true
    && Number.isFinite(validatedAt) && validatedAt <= Date.now() && Date.now() - validatedAt <= 30 * 86400_000;
}
function validatedTicketModel(model: any, betType: string): boolean {
  let metrics: any;
  try { metrics = JSON.parse(model?.metrics_json || '{}'); } catch { return false; }
  return model?.status === 'active' && model?.bet_type === betType && ticketValidationEvidence(metrics, betType);
}
function officialTrifectaUrl(sourceUrl: unknown, race: any): boolean {
  if (typeof sourceUrl !== 'string') return false;
  try {
    const u = new URL(sourceUrl);
    return u.protocol === 'https:' && u.hostname === 'www.boatrace.jp' && u.pathname === '/owpc/pc/race/odds3t'
      && u.searchParams.get('jcd') === String(race.venue_id)
      && u.searchParams.get('rno') === String(race.race_no)
      && u.searchParams.get('hd') === String(race.race_date).replaceAll('-', '');
  } catch { return false; }
}
function experimentalArchiveEvidenceValid(archive: any, race: any, entries: any[]) {
 return boatArchiveEvidenceValid(archive,race,entries);
}
async function ticketCandidatesForRace(db: Db, race: any, maxStd: number, decisionAt = Date.now(), cutoffAtOverride?: string | null, purchaseMarket?:PurchaseOdds): Promise<TicketCandidate[]> {
  // Initial support is exact-order trifecta only. Other ticket types stay absent
  // until a compatible model and audited odds source are registered.
  if (await first<any>(db,'SELECT race_id FROM data_repair_quarantined_races WHERE race_id=?',race.id)) return [];
  const cutoffAt = cutoffAtOverride ?? race.post_time;
  if (race.sport !== 'boat' || race.data_origin !== 'real' || race.status !== 'scheduled'
      || !cutoffAt || !Number.isFinite(Date.parse(cutoffAt)) || Date.parse(cutoffAt) <= decisionAt) return [];
  const decisionAtIso=isoJstAt(decisionAt), freshAfter=oddsFreshAfter(decisionAt);
  const runners = await all<any>(db, 'SELECT number FROM entries WHERE race_id=? AND data_origin=? ORDER BY number', race.id, race.data_origin);
  const numbers = runners.map((x: any) => Number(x.number));
  if (numbers.length !== 6 || new Set(numbers).size !== 6 || numbers.some((n: number) => !Number.isInteger(n) || n < 1 || n > 6)) return [];
  const models = await all<any>(db, "SELECT * FROM models WHERE sport='boat' AND bet_type='trifecta' AND status='active'");
  const output: TicketCandidate[] = [];
  for (const model of models) {
    if (!validatedTicketModel(model, 'trifecta')) continue;
    const latest = await first<any>(db, `SELECT MAX(predicted_at) predicted_at FROM ticket_predictions WHERE race_id=? AND model_id=? AND bet_type='trifecta' AND data_origin='real' AND julianday(predicted_at)<=julianday(?) AND julianday(predicted_at)<=julianday(?)`, race.id, model.id, decisionAtIso, cutoffAt);
    if (!latest?.predicted_at) continue;
    const predictions = await all<any>(db, `SELECT * FROM ticket_predictions WHERE race_id=? AND model_id=? AND bet_type='trifecta' AND data_origin='real' AND predicted_at=?`, race.id, model.id, latest.predicted_at);
    let metrics: any; try { metrics = JSON.parse(model.metrics_json || '{}'); } catch { continue; }
    if (!model.trained_at || !Number.isFinite(Date.parse(model.trained_at)) || Date.parse(model.trained_at) >= Date.parse(latest.predicted_at)) continue;
    if (predictions.some((p: any) => p.feature_schema_version !== TICKET_MODEL_SCHEMA || p.artifact_sha256 !== metrics.ticketArtifactSha256 || p.prob_std === null || p.prob_std === undefined)) continue;
    if (predictions.some((p: any) => p.probability === null || p.probability === undefined || !Number.isFinite(p.probability))) continue;
    if (!isCompleteTicketDistribution('trifecta', numbers, predictions.map((p: any) => p.selection), predictions.map((p: any) => Number(p.probability)))) continue;
    const latestOdds = purchaseMarket ? {captured_at:purchaseMarket.capturedAt,source_url:purchaseMarket.url,source_sha256:purchaseMarket.sha256} : await first<any>(db, `SELECT captured_at,source_url,source_sha256 FROM odds_snapshots WHERE race_id=? AND data_origin='real' AND bet_type='trifecta' AND source='boatrace-trifecta-official-v1' AND quality_status='verified-complete-v1' AND source_sha256 IS NOT NULL AND julianday(captured_at)>=julianday(?) AND julianday(captured_at)<=julianday(?) AND julianday(captured_at)<=julianday(?) ORDER BY julianday(captured_at) DESC LIMIT 1`, race.id, freshAfter, decisionAtIso, cutoffAt);
    if (!latestOdds || !SHA256.test(latestOdds.source_sha256) || !officialTrifectaUrl(latestOdds.source_url, race)) continue;
    const oddsRows = purchaseMarket ? purchaseMarket.odds : await all<any>(db, `SELECT selection,odds FROM odds_snapshots WHERE race_id=? AND data_origin='real' AND bet_type='trifecta' AND source='boatrace-trifecta-official-v1' AND quality_status='verified-complete-v1' AND captured_at=? AND source_url=? AND source_sha256=?`, race.id, latestOdds.captured_at, latestOdds.source_url, latestOdds.source_sha256);
    if (oddsRows.some((o: any) => o.odds === null || !Number.isFinite(o.odds) || o.odds <= 0)
        || !isCompleteTicketDistribution('trifecta', numbers, oddsRows.map((x: any) => x.selection), oddsRows.map(() => 1 / oddsRows.length))) continue;
    const oddsBySelection = new Map(oddsRows.map((o: any) => [o.selection, Number(o.odds)]));
    const predictionBySelection = new Map(predictions.map((p: any) => [p.selection, p]));
    for (const selection of [...predictionBySelection.keys()].sort()) {
      const p: any = predictionBySelection.get(selection), odds = oddsBySelection.get(selection);
      if (odds === undefined) continue;
      const score = candidate(p.probability, odds, p.prob_std, 'active', maxStd);
    output.push({ raceId: race.id, sport: race.sport, venueName: race.venue_name, raceNo: race.race_no, postTime: race.post_time,
        betType: 'trifecta', selection, probability: p.probability, probStd: p.prob_std, odds, oddsCapturedAt: latestOdds.captured_at,
        breakEvenProb: 1 / odds, expectedRoi: score.expectedRoi!, conservativeRoi: score.conservativeRoi!, edge: score.edge,
        modelId: model.id, modelVersion: model.version, modelArtifactSha256: metrics.ticketArtifactSha256,
        predictedAt: latest.predicted_at, oddsSource: 'boatrace-trifecta-official-v1', oddsSourceUrl: latestOdds.source_url,
        oddsSourceSha256: latestOdds.source_sha256,
        dataFreshnessMinutes: Math.max(0, (decisionAt - Date.parse(latestOdds.captured_at)) / 60000),
        dataOrigin: 'real', buyEligible: score.edge === 'HIGH_EDGE' || score.edge === 'POSITIVE_EDGE' });
    }
  }
  return output;
}
function resultWaitReason(b:any){
 if(b.data_origin==='sample')return 'sampledata';
 if(b.race_status==='cancelled')return 'cancelled';
 if(b.status!=='open')return null;
 if(b.finish_code==='F'||b.finish_code==='L')return 'refundmissing';
 if(b.finish_code==='失格'||b.finish_code==='転覆'||b.finish_code==='妨害'||b.finish_code==='落水'||b.finish_code==='エンスト'||b.finish_code==='不完走')return 'disqualified';
 if(b.finish_code==='欠場'||b.finish_code==='欠')return 'withdrawn';
 const postTime=b.post_time?Date.parse(b.post_time):Number.NaN;
 if(Number.isFinite(postTime)&&postTime>Date.now())return 'notstarted';
 if(!Number.isFinite(postTime)&&(b.race_status==='scheduled'||b.race_status==='closed'))return 'unknown';
 if(!b.entry_count||b.terminal_result_conflict_count>0||b.result_count+(b.terminal_entry_count??0)!==b.entry_count||b.distinct_result_count!==b.result_count||b.matched_result_count!==b.result_count||!b.winner_count){
   return b.result_collection_status==='failed'||b.result_collection_status==='partial'?'collectionfailed':'officialresultmissing';
 }
 if(b.paid_winner_count!==b.winner_count)return 'payoutmissing';
 return 'settlementpending';
}
function mapBet(b:any){return {id:b.id,raceId:b.race_id,sport:b.sport,betType:b.bet_type,selection:b.selection,stake:b.stake,mode:b.mode,predictedProb:b.predicted_prob,oddsAtBet:b.odds_at_bet,expectedRoi:b.expected_roi,edgeLabel:b.edge_label,modelId:b.model_id,placedAt:b.placed_at,status:b.status,payout:b.payout??null,profit:b.profit??null,finalOdds:b.final_odds??null,settledAt:b.settled_at??null,dataOrigin:b.data_origin,groupId:b.bet_group_id??null,candidateRank:b.candidate_rank??null,candidateCount:b.candidate_count??null,oddsCapturedAt:b.odds_captured_at??null,predictedAtAtBet:b.predicted_at_at_bet??null,decisionPhase:b.decision_phase??null,resultWaitReason:b.race_status==null?undefined:resultWaitReason(b),resultCollectionSource:b.result_collection_source??null,resultCollectionStatus:b.result_collection_status??null,resultCollectionLastAttemptAt:b.result_collection_last_attempt_at??null,resultCollectionLastSuccessAt:b.result_collection_last_success_at??null};}
async function quarantineSummary(db: Db, sport: string | null, origin: string | null) {
 return await first<any>(db, `SELECT COUNT(*) count,COALESCE(SUM(b.stake),0) stake,COALESCE(SUM(b.payout),0) payout,COALESCE(SUM(b.profit),0) profit FROM bets b WHERE EXISTS(SELECT 1 FROM data_repair_audit_marks q WHERE q.record_type='bet' AND q.record_id=b.id) AND (? IS NULL OR b.sport=?) AND (? IS NULL OR b.data_origin=?)`, sport, sport, origin, origin) ?? {count:0,stake:0,payout:0,profit:0};
}
app.get('/bets/quarantine-summary',async c=>{const sport=c.req.query('sport'),origin=originFilter(c.req.query('origin'));if(sport&&!validSport(sport))return jsonError(c,'invalid sport');return c.json(await quarantineSummary(c.env.DB,sport||null,origin));});
app.get('/bets/experimental',async c=>{
 const experimentKey='boat-trifecta-small-sample-v1';
 const rows=await all<any>(c.env.DB,`SELECT b.id,b.decision_id,b.race_id,b.selection,b.stake,b.probability,b.prob_std,b.odds_at_bet,b.expected_roi,
   b.model_id,b.placed_at,b.status,b.payout,b.profit,b.settled_at,d.experiment_key,v.name venue_name,r.race_no,r.race_date,
   q.repair_reason,q.repaired_at,r.venue_id,
   (SELECT cr.reason FROM collection_runs cr WHERE cr.id='boat-result:'||b.race_id AND cr.source='boatrace-results-worker-v1' AND cr.status='success') result_evidence,
   (SELECT p.payout FROM payouts p WHERE p.race_id=b.race_id AND p.bet_type='trifecta' AND p.selection=b.selection AND p.data_origin='real' AND p.payout>0) final_payout_per_100,
   (SELECT group_concat(number,'-') FROM (SELECT x.number FROM results x WHERE x.race_id=b.race_id AND x.data_origin='real' AND x.finish_order BETWEEN 1 AND 3 ORDER BY x.finish_order LIMIT 3)) official_selection
   FROM experimental_paper_bets b
   JOIN experimental_paper_decisions d ON d.id=b.decision_id AND d.experiment_key=? AND d.outcome='placed'
   JOIN races r ON r.id=b.race_id AND r.sport='boat' AND r.data_origin='real'
   JOIN venues v ON v.id=r.venue_id AND v.sport='boat'
   LEFT JOIN experimental_paper_bet_reconciliations q ON q.bet_id=b.id
   WHERE b.data_origin='real'
   ORDER BY julianday(b.placed_at) DESC,b.id DESC LIMIT 500`,experimentKey);
 c.header('Cache-Control','private, no-store');
 return c.json(rows.map(row=>({id:row.id,recordKind:'experimental_paper',experimentKey:row.experiment_key,decisionId:row.decision_id,
   raceId:row.race_id,sport:'boat',betType:'trifecta',selection:row.selection,stake:Number(row.stake),predictedProb:Number(row.probability),
   probabilityStd:Number(row.prob_std),oddsAtBet:Number(row.odds_at_bet),expectedRoi:Number(row.expected_roi),modelId:row.model_id,
   placedAt:row.placed_at,status:row.repair_reason?'void':row.status,
   payout:row.repair_reason?Number(row.stake):(row.payout==null?null:Number(row.payout)),
   profit:row.repair_reason?0:(row.profit==null?null:Number(row.profit)),
   settledAt:row.repair_reason?row.repaired_at:(row.settled_at??null),repairReason:row.repair_reason??null,
   dataOrigin:'real',venueName:row.venue_name,raceNo:Number(row.race_no),raceDate:row.race_date,
   finalOdds:row.repair_reason||!['won','lost'].includes(row.status)?null:(row.status==='won'&&row.selection===row.official_selection&&row.final_payout_per_100!=null?Number(row.final_payout_per_100)/100:finalTrifectaOdds(row.result_evidence,{id:row.race_id,race_date:row.race_date,venue_id:row.venue_id,race_no:row.race_no},row.selection,row.official_selection)),
   officialSelection:typeof row.official_selection==='string'&&row.official_selection.split('-').length===3?row.official_selection:null})));
});
app.get('/bets/historical-trifecta-experiment',async c=>{
 c.header('Cache-Control','private, no-store');
 return c.json(await historicalTrifectaExperimentBets(c.env.DB));
});
app.get('/paper/decisions',async c=>{
 const date=c.req.query('date')??jstRaceDate();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return jsonError(c,'date must be YYYY-MM-DD');
 const rows=await all<any>(c.env.DB,`SELECT d.race_id,d.phase,d.cutoff_at,d.cutoff_source,d.cutoff_observed_at,d.target_at,d.input_as_of_at,d.decided_at,d.outcome,d.reason,d.bet_group_id,d.snapshot_json
   FROM paper_decisions d JOIN races r ON r.id=d.race_id WHERE r.race_date=? ORDER BY julianday(d.decided_at),d.race_id,d.phase LIMIT 500`,date);
 return c.json({date,timing:{primary:{phase:PRIMARY_PAPER_PHASE,cutoffSource:TRUSTED_CUTOFF_SOURCE,targetOffsetSeconds:60,toleranceSeconds:10,
   acceptedSecondsBeforeCutoff:{min:50,max:70}},comparisons:PAPER_COMPARISON_PHASES},
   decisions:rows.map(row=>{let snapshot=null;try{snapshot=row.snapshot_json?JSON.parse(row.snapshot_json):null;}catch{}
    const cutoffMs=row.cutoff_at?Date.parse(row.cutoff_at):Number.NaN,decidedMs=Date.parse(row.decided_at),actualSecondsBeforeCutoff=Number.isFinite(cutoffMs)&&Number.isFinite(decidedMs)?(cutoffMs-decidedMs)/1000:null;
    return {raceId:row.race_id,phase:row.phase,cutoffAt:row.cutoff_at??null,cutoffSource:row.cutoff_source??null,cutoffObservedAt:row.cutoff_observed_at??null,targetAt:row.target_at??null,inputAsOfAt:row.input_as_of_at??null,decidedAt:row.decided_at,
      actualSecondsBeforeCutoff,targetDeltaSeconds:actualSecondsBeforeCutoff===null?null:60-actualSecondsBeforeCutoff,outcome:row.outcome,reason:row.reason??null,betGroupId:row.bet_group_id??null,snapshot};})});
});
app.get('/bets',async c=>{const sport=c.req.query('sport'),status=c.req.query('status'),origin=originFilter(c.req.query('origin'));if(sport&&!validSport(sport))return jsonError(c,'invalid sport');const rows=await all<any>(c.env.DB,`SELECT b.*,v.name venue_name,r.race_no,r.status race_status,r.post_time,r.race_date,
 (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin=r.data_origin) entry_count,
 (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin=r.data_origin AND ${terminalFinishCodeSql} AND NOT EXISTS(SELECT 1 FROM results x WHERE x.race_id=e.race_id AND x.number=e.number AND x.data_origin=e.data_origin)) terminal_entry_count,
 (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin=r.data_origin AND ${terminalFinishCodeSql} AND EXISTS(SELECT 1 FROM results x WHERE x.race_id=e.race_id AND x.number=e.number AND x.data_origin=e.data_origin)) terminal_result_conflict_count,
 (SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin=r.data_origin) result_count,
 (SELECT COUNT(DISTINCT x.number) FROM results x WHERE x.race_id=r.id AND x.data_origin=r.data_origin) distinct_result_count,
 (SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin=r.data_origin AND EXISTS(SELECT 1 FROM entries e WHERE e.race_id=x.race_id AND e.number=x.number AND e.data_origin=x.data_origin)) matched_result_count,
 (SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin=r.data_origin AND x.finish_order=1) winner_count,
 (SELECT COUNT(*) FROM results x JOIN payouts p ON p.race_id=x.race_id AND p.data_origin=x.data_origin AND p.bet_type='win' AND p.selection=CAST(x.number AS TEXT) AND p.payout>0 WHERE x.race_id=r.id AND x.data_origin=r.data_origin AND x.finish_order=1) paid_winner_count,
 (SELECT CASE WHEN json_valid(e.features_json) THEN json_extract(e.features_json,'$.finish_code') END FROM entries e WHERE e.race_id=r.id AND e.data_origin=r.data_origin AND CAST(e.number AS TEXT)=b.selection LIMIT 1) finish_code,
 (SELECT cr.source FROM collection_runs cr WHERE r.data_origin='real' AND r.sport='boat' AND (cr.source='mbrace-boat' OR (cr.source='boatrace-results-worker-v1' AND cr.id='boat-result:'||r.id)) AND cr.sport=r.sport AND cr.target_date=r.race_date AND julianday(cr.started_at)<=julianday('now') ORDER BY julianday(cr.started_at) DESC,cr.id DESC LIMIT 1) result_collection_source,
 (SELECT cr.status FROM collection_runs cr WHERE r.data_origin='real' AND r.sport='boat' AND (cr.source='mbrace-boat' OR (cr.source='boatrace-results-worker-v1' AND cr.id='boat-result:'||r.id)) AND cr.sport=r.sport AND cr.target_date=r.race_date AND julianday(cr.started_at)<=julianday('now') ORDER BY julianday(cr.started_at) DESC,cr.id DESC LIMIT 1) result_collection_status,
 (SELECT cr.started_at FROM collection_runs cr WHERE r.data_origin='real' AND r.sport='boat' AND (cr.source='mbrace-boat' OR (cr.source='boatrace-results-worker-v1' AND cr.id='boat-result:'||r.id)) AND cr.sport=r.sport AND cr.target_date=r.race_date AND julianday(cr.started_at)<=julianday('now') ORDER BY julianday(cr.started_at) DESC,cr.id DESC LIMIT 1) result_collection_last_attempt_at,
 (SELECT COALESCE(cr.finished_at,cr.started_at) FROM collection_runs cr WHERE r.data_origin='real' AND r.sport='boat' AND (cr.source='mbrace-boat' OR (cr.source='boatrace-results-worker-v1' AND cr.id='boat-result:'||r.id)) AND cr.sport=r.sport AND cr.target_date=r.race_date AND cr.status='success' AND julianday(COALESCE(cr.finished_at,cr.started_at))<=julianday('now') ORDER BY julianday(cr.started_at) DESC,cr.id DESC LIMIT 1) result_collection_last_success_at
FROM bets b JOIN races r ON r.id=b.race_id JOIN venues v ON v.id=r.venue_id WHERE (? IS NULL OR b.sport=?) AND (? IS NULL OR b.status=?) AND (? IS NULL OR b.data_origin=?) AND ${nonQuarantinedBet()} ORDER BY b.placed_at DESC`,sport||null,sport||null,status||null,status||null,origin,origin);return c.json(rows.map(b=>({...mapBet(b),venueName:b.venue_name,raceNo:b.race_no,raceDate:b.race_date})));});
app.get('/performance/rank-comparison',async c=>{
 const db=c.env.DB,origin=originFilter(c.req.query('origin'));
 const rows=await all<any>(db,`SELECT b.* FROM bets b JOIN races r ON r.id=b.race_id AND r.data_origin=b.data_origin
   WHERE b.bet_group_id IS NOT NULL AND b.candidate_rank IS NOT NULL AND b.candidate_count IS NOT NULL
   AND (? IS NULL OR b.data_origin=?) AND ${nonQuarantinedBet('b')}
   AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=b.race_id)
   ORDER BY b.bet_group_id,b.candidate_rank`,origin,origin);
 const groups=new Map<string,any[]>(); for(const row of rows){const list=groups.get(row.bet_group_id)??[];list.push(row);groups.set(row.bet_group_id,list);}
 let comparedGroupCount=0,totalStake=0,multiplePayout=0,firstOnlyPayout=0;
 let excludedPendingGroupCount=0,excludedMissingRankOneGroupCount=0,excludedUnknownRankBetCount=0;
 const comparedRaces=new Set<string>();
 for(const group of groups.values()){
   if(group.length<2)continue;
   if(!group.some((b:any)=>b.candidate_rank===1)){excludedMissingRankOneGroupCount++;continue;}
   if(group.some((b:any)=>!['won','lost'].includes(b.status))){excludedPendingGroupCount++;continue;}
   const origins=new Set(group.map((b:any)=>b.data_origin)),races=new Set(group.map((b:any)=>b.race_id));
   if(origins.size!==1||races.size!==1)continue;
   const rankOne=group.find((b:any)=>b.candidate_rank===1);
   // Settlement only marks the race complete after the official result and winner payout are present.
   // A losing rank-1 selection has a known zero payout; a winning one carries the official payout.
   if(rankOne.status==='won'&&rankOne.final_odds===null)continue;
   const stake=group.reduce((sum:number,b:any)=>sum+b.stake,0);
   comparedGroupCount++;comparedRaces.add(rankOne.race_id);totalStake+=stake;
   multiplePayout+=group.reduce((sum:number,b:any)=>sum+(b.payout??0),0);
   firstOnlyPayout+=rankOne.status==='won'?payoutYen(stake,Math.round(rankOne.final_odds*100)):0;
 }
 excludedUnknownRankBetCount=Number((await first<any>(db,`SELECT COUNT(*) count FROM bets b JOIN races r ON r.id=b.race_id AND r.data_origin=b.data_origin
   WHERE (b.bet_group_id IS NULL OR b.candidate_rank IS NULL) AND (? IS NULL OR b.data_origin=?) AND ${nonQuarantinedBet('b')}
   AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=b.race_id)`,origin,origin))?.count??0);
 const measure=(stake:number,payout:number)=>({stake,payout,profit:payout-stake,roi:stake?payout/stake:null});
 return c.json({comparedGroupCount,comparedRaceCount:comparedRaces.size,totalStake,excludedPendingGroupCount,excludedMissingRankOneGroupCount,excludedUnknownRankBetCount,multiple:measure(totalStake,multiplePayout),firstOnly:measure(totalStake,firstOnlyPayout),
   note:'同じ比較対象レース・同じ総賭け金で比較。rank 1を含む複数選択グループの全券が確定したレースだけを対象とし、単独購入はrank 1の実際の結果・公式払戻で再計算。rank 1のみへ総額を配分する仮想払戻は1円未満切り捨て。旧記録の順位不明・未確定・取消は除外。利益や将来成績を保証しない。'});
});
app.get('/performance/overview',async c=>{
 const sport=c.req.query('sport'),origin=originFilter(c.req.query('origin')),purchaseHistory=c.req.query('scope')==='purchase-history';
 if(sport&&!validSport(sport))return jsonError(c,'invalid sport');
 const db=c.env.DB,initial=Number(await setting(db,'initial_bankroll','100000'));
 const bets=await all<any>(db,purchaseHistory?`SELECT 'normal:'||b.id id,b.race_id,b.sport,b.stake,b.placed_at,b.status,b.payout,b.profit,b.settled_at,b.data_origin
   FROM bets b WHERE (? IS NULL OR b.sport=?) AND (? IS NULL OR b.data_origin=?) AND ${nonQuarantinedBet()}
   UNION ALL
   SELECT 'experimental:'||b.id id,b.race_id,'boat' sport,b.stake,b.placed_at,b.status,b.payout,b.profit,b.settled_at,b.data_origin
   FROM experimental_paper_bets b WHERE (? IS NULL OR ?='boat') AND (? IS NULL OR ?='real') AND b.data_origin='real'
     AND NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q WHERE q.bet_id=b.id)
   ORDER BY placed_at,id`:`SELECT * FROM bets b WHERE (? IS NULL OR b.sport=?) AND (? IS NULL OR b.data_origin=?) AND ${nonQuarantinedBet()} ORDER BY b.placed_at,b.id`,
   ...(purchaseHistory?[sport||null,sport||null,origin,origin,sport||null,sport||null,origin,origin]:[sport||null,sport||null,origin,origin]));
 let bankroll=initial,normalBankroll=initial,settled=0,scored=0,hits=0,stake=0,payout=0;
 let curveBankroll=purchaseHistory?0:initial;
 const equity=[{at:bets[0]?.placed_at??now(),bankroll:curveBankroll}];
 const settledBets=bets.filter((b:any)=>b.status==='won'||b.status==='lost'||b.status==='void')
   .sort((a:any,b:any)=>Date.parse(String(a.settled_at??a.placed_at))-Date.parse(String(b.settled_at??b.placed_at))||String(a.id).localeCompare(String(b.id)));
 for(const b of settledBets){
   bankroll+=b.profit??0;settled++;
   if(!purchaseHistory||String(b.id).startsWith('normal:'))normalBankroll+=purchaseHistory?(b.profit??0):0;
   curveBankroll+=b.profit??0;
   if(b.status==='won'||b.status==='lost'){
     scored++;stake+=b.stake;payout+=b.payout??0;
     if(b.status==='won')hits++;
   }
   equity.push({at:b.settled_at??b.placed_at,bankroll:curveBankroll});
 }
 let peak=initial,dd=0,ddPct=0;
 for(const e of equity){const financialValue=purchaseHistory?initial+e.bankroll:e.bankroll;peak=Math.max(peak,financialValue);dd=Math.max(dd,peak-financialValue);if(peak>0)ddPct=Math.max(ddPct,(peak-financialValue)/peak);}
 return c.json({initialBankroll:initial,bankroll:purchaseHistory?normalBankroll:bankroll,totalProfit:purchaseHistory?curveBankroll:bankroll-initial,roi:stake?payout/stake:null,betCount:bets.length,settledCount:settled,hitRate:scored?hits/scored:null,maxDrawdown:dd,maxDrawdownPct:ddPct,equityCurve:equity,quarantined:await quarantineSummary(db,sport||null,origin)});
});
app.post('/ingest/experimental-trifecta/model',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 if(Number(c.req.header('Content-Length')??0)>128_000)return jsonError(c,'experimental model metadata exceeds the request size limit',413);
 const body=await c.req.json().catch(()=>null),manifest=body?.manifest;
 if(!isRecord(manifest)||typeof body?.metadataJson!=='string'||manifest.schema!=='edgelab-experimental-trifecta-artifact-v1'
    ||typeof manifest.modelId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(manifest.modelId)
    ||manifest.trainingMode!=='experimental'||manifest.experimentalOnly!==true
    ||manifest.boatFeatureSchemaVersion!=='boat-prerace-v2-no-weather-experimental-v1'
    ||!isRecord(manifest.files)||!isRecord(manifest.files[`${manifest.modelId}.pkl`])||!isRecord(manifest.files[`${manifest.modelId}.json`])) return jsonError(c,'invalid experimental artifact manifest');
 const modelId=manifest.modelId,pkl=manifest.files[`${modelId}.pkl`],metadataFile=manifest.files[`${modelId}.json`];
 const manifestSha=await sha256Json(manifest),metadataSha=await sha256Text(body.metadataJson);
 let metadata:any;try{metadata=JSON.parse(body.metadataJson)}catch{return jsonError(c,'experimental model metadata is invalid JSON');}
 if(body.manifestSha256!==manifestSha||!isSha256(pkl.sha256)||!isSha256(metadataFile.sha256)
    ||metadataFile.sha256!==metadataSha||metadata.id!==modelId||metadata.status!=='candidate'
    ||metadata.trainingMode!=='experimental'||metadata.experimentalOnly!==true
    ||metadata.sport!=='boat'||metadata.betType!=='trifecta'
    ||metadata.boatFeatureSchemaVersion!=='boat-prerace-v2-no-weather-experimental-v1'
    ||metadata.ticketModelSchemaVersion!=='ticket-selection-v1'
    ||metadata.ticketPredictionSemantics!=='exact-selection-probability-v1'
    ||metadata.ticketBetType!=='trifecta'||metadata.ticketArtifactSha256!==pkl.sha256
    ||!isSha256(manifest.trainingRaceIdSetSha256)
    ||!isRecord(metadata.metrics)||metadata.metrics.evaluationQualified!==false
    ||metadata.metrics.independentValidationPerformed!==false||metadata.metrics.promotionEligible!==false||metadata.metrics.profitabilityProven!==false
    ||metadata.metrics.pointInTimeEvidenceComplete!==true
    ||!Array.isArray(metadata.featureColumns)||metadata.featureColumns.some((x:any)=>['lane_wind_x','lane_wind_y','lane_wave_height'].includes(x))
    ||!isRecord(metadata.trainingEvidence)||metadata.trainingEvidence.raceIdSetSha256!==manifest.trainingRaceIdSetSha256
    ||['sourceArrivalVerifiedRaceCount','verifiedT60CutoffRaceCount','sixFreshExhibitionRaceCount','complete120T60OddsRaceCount','consistentPayoutRaceCount']
      .some((key:string)=>!Number.isInteger(metadata.trainingEvidence[key])||metadata.trainingEvidence[key]<1)
    ||!metadata.trainedAt||!Number.isFinite(Date.parse(metadata.trainedAt))) return jsonError(c,'experimental model metadata, evidence, or artifact hashes are invalid');
 const db=c.env.DB,existing=await first<any>(db,'SELECT manifest_sha256,metadata_sha256 FROM experimental_models WHERE id=?',modelId);
 if(existing){if(existing.manifest_sha256===manifestSha&&existing.metadata_sha256===metadataSha)return c.json({modelId,status:'candidate',idempotent:true});return jsonError(c,'experimental model IDs are immutable',409);}
 if(!await reserveWorkerWrites(db,1)){const budget=await readWriteBudget(db);return c.json({error:'daily D1 write budget unavailable or exhausted',code:budget.state==='missing'||budget.state==='invalid'?'d1_write_budget_unavailable':'d1_write_budget_exhausted',budget},429);}
 await run(db,`INSERT INTO experimental_models(id,status,manifest_schema,sport,bet_type,training_mode,schema_version,artifact_sha256,manifest_sha256,metadata_sha256,trained_at,artifact_manifest_json,manifest_json,registered_at)
   VALUES(?,'candidate','edgelab-experimental-trifecta-artifact-v1','boat','trifecta','experimental','boat-prerace-v2-no-weather-experimental-v1',?,?,?,?,?,?,?)`,
   modelId,pkl.sha256,manifestSha,metadataSha,metadata.trainedAt,JSON.stringify(manifest),body.metadataJson,now());
 return c.json({modelId,status:'candidate',idempotent:false});
});
app.get('/ingest/experimental-trifecta/forecast-model',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 // Match experimentalPaperDecision's selection exactly: latest registered
 // candidate/experimental row wins, with no fallback if its artifact is bad.
 const model=await first<any>(c.env.DB,"SELECT id,status,artifact_sha256 FROM experimental_models WHERE status IN ('candidate','experimental') ORDER BY registered_at DESC,id DESC LIMIT 1");
 return c.json({model:model?{modelId:model.id,artifactSha256:model.artifact_sha256}:null},200,{'Cache-Control':'private, no-store'});
});
function experimentalForecastStorageError(error:string,status=400){return {status,payload:{error}};}
async function persistExperimentalForecast(db:Db,body:any,decisionAt=Date.now()):Promise<{status:number;payload:any}>{
 if(!isRecord(body)||body.schema!=='edgelab-experimental-trifecta-forecast-v1'||body.trainingMode!=='experimental'||body.experimentalOnly!==true
    ||body.ticketModelSchemaVersion!=='ticket-selection-v1'||body.ticketPredictionSemantics!=='exact-selection-probability-v1'
    ||body.boatFeatureSchemaVersion!=='boat-prerace-v2-no-weather-experimental-v1'||!isSha256(body.artifactSha256)
    ||!Array.isArray(body.races)||body.races.length!==1) return experimentalForecastStorageError('experimental forecast envelope must contain exactly one race');
 const model=await first<any>(db,'SELECT * FROM experimental_models WHERE id=?',body.modelId);
 if(!model||model.artifact_sha256!==body.artifactSha256)return experimentalForecastStorageError('experimental model or artifact SHA is not registered',409);
 const accepted:any[]=[];
 for(const forecast of body.races){
   if(!isRecord(forecast)||typeof forecast.raceId!=='string'||typeof forecast.predictedAt!=='string'||!Number.isFinite(Date.parse(forecast.predictedAt))
      ||Date.parse(forecast.predictedAt)>decisionAt||!Array.isArray(forecast.predictions)||forecast.predictions.length!==120) return experimentalForecastStorageError('experimental forecast timestamp or row count is invalid');
   if(Date.parse(model.trained_at)>=Date.parse(forecast.predictedAt))return experimentalForecastStorageError('experimental forecast predates model training');
   const race=await first<any>(db,'SELECT * FROM races WHERE id=?',forecast.raceId);
   if(!race||race.sport!=='boat'||race.status!=='scheduled'||race.data_origin!=='real'||race.race_date!==jstRaceDate(new Date(decisionAt)))return experimentalForecastStorageError('experimental forecast race is not an eligible real race');
   const cutoffMs=Date.parse(race.betting_cutoff_at),observedMs=Date.parse(race.betting_cutoff_observed_at),forecastMs=Date.parse(forecast.predictedAt),targetMs=cutoffMs-PRIMARY_PAPER_OFFSET_MS;
   if(race.betting_cutoff_source!==TRUSTED_CUTOFF_SOURCE||!Number.isFinite(cutoffMs)||!Number.isFinite(observedMs)||observedMs>decisionAt+5_000
      ||decisionAt-observedMs>BOATRACE_CUTOFF_MAX_AGE_MS||decisionAt>targetMs+PRIMARY_PAPER_TOLERANCE_MS
      ||forecastMs>targetMs||forecastMs<targetMs-5*60_000)
      return experimentalForecastStorageError('experimental forecast is outside a verified pre-cutoff prediction window');
   // Resolve the latest archive available at the model's actual prediction
   // time. A newer capture must not invalidate a valid point-in-time snapshot.
   const archiveRow=await first<any>(db,'SELECT id,captured_at,archive_json FROM boatrace_prerace_capture_archives WHERE race_id=? AND data_origin=\'real\' AND julianday(captured_at)<=julianday(?) ORDER BY julianday(captured_at) DESC LIMIT 1',race.id,forecast.predictedAt);
   if(!archiveRow||Date.parse(archiveRow.captured_at)>forecastMs||forecastMs-Date.parse(archiveRow.captured_at)>5*60_000)return experimentalForecastStorageError('official prerace archive is not fresh as of prediction time');
   let archive:any;try{archive=JSON.parse(archiveRow.archive_json)}catch{return experimentalForecastStorageError('official prerace archive is invalid');}
   const lanes=await all<any>(db,'SELECT number,features_json FROM entries WHERE race_id=? AND data_origin=\'real\' ORDER BY number',race.id),numbers=lanes.map(x=>Number(x.number));
   if(numbers.length!==6||numbers.some((x,i)=>x!==i+1)||!experimentalArchiveEvidenceValid(archive,race,lanes)
      ||archive.trifectaOdds.capturedAt!==archiveRow.captured_at||Date.parse(archive.beforeinfo.capturedAt)>forecastMs
      ||Date.parse(archive.raceList.capturedAt)>forecastMs||Date.parse(archive.trifectaOdds.capturedAt)>forecastMs)return experimentalForecastStorageError('official archive identity, six-lane, or complete odds provenance is invalid');
   const predictions=forecast.predictions;
   if(predictions.some((row:any)=>!isRecord(row)||!Number.isFinite(row.probability)||row.probability<0||row.probability>1||!Number.isFinite(row.prob_std)||row.prob_std<0)
      ||!isCompleteTicketDistribution('trifecta',numbers,predictions.map((row:any)=>row.selection),predictions.map((row:any)=>Number(row.probability))))return experimentalForecastStorageError('experimental forecast is not a complete normalized exact-order distribution');
   accepted.push({race,forecast,predictions});
 }
 if(!db.batch)return experimentalForecastStorageError('atomic experimental forecast storage is unavailable',503);
 const statements:Statement[]=[];
 for(const item of accepted){
   const {race,forecast,predictions}=item;
   for(const chunk of splitRowsForD1<any>(predictions,9)){
     const values:any[]=[];
     for(const row of chunk)values.push(crypto.randomUUID(),race.id,model.id,row.selection,Number(row.probability),Number(row.prob_std),forecast.predictedAt,'ticket-selection-v1',model.artifact_sha256);
     statements.push(db.prepare(`INSERT INTO experimental_ticket_predictions(id,race_id,model_id,selection,probability,prob_std,predicted_at,feature_schema_version,artifact_sha256,data_origin)
       VALUES ${chunk.map(()=>"(?,?,?,?,?,?,?,?,?,'real')").join(',')} ON CONFLICT(race_id,model_id,selection,predicted_at) DO NOTHING`).bind(...values));
   }
 }
 if(!await reserveWorkerWrites(db,accepted.length*120)){const budget=await readWriteBudget(db);return {status:429,payload:{error:'daily D1 write budget unavailable or exhausted',code:budget.state==='missing'||budget.state==='invalid'?'d1_write_budget_unavailable':'d1_write_budget_exhausted',budget}};}
 await db.batch(statements);
 return {status:200,payload:{experimentKey:'boat-trifecta-small-sample-v1',stored:accepted.map(x=>({raceId:x.race.id,modelId:model.id,predictedAt:x.forecast.predictedAt,predictionCount:120})),decision:'worker T-60 timing gate'}};
}
app.post('/ingest/experimental-trifecta/forecast',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 if(c.env.ENABLE_NATIVE_EXPERIMENTAL_FORECAST==='true')return jsonError(c,'worker native forecast generation is enabled',409);
 if(Number(c.req.header('Content-Length')??0)>512_000)return jsonError(c,'experimental forecast exceeds the request size limit',413);
 const body=await c.req.json().catch(()=>null);
 const result=await persistExperimentalForecast(c.env.DB,body);
 return c.json(result.payload,result.status as any);
});
app.get('/performance/experimental',async c=>{
 const db=c.env.DB,experimentKey='boat-trifecta-small-sample-v1';
 const model=await first<any>(db,'SELECT id,status,artifact_sha256,schema_version,trained_at FROM experimental_models ORDER BY registered_at DESC,id DESC LIMIT 1');
 const balance=await first<any>(db,'SELECT initial_balance,available_balance FROM experimental_bankroll WHERE experiment_key=?',experimentKey);
 const metric=await first<any>(db,`SELECT COUNT(DISTINCT race_id) races,COUNT(*) bets,COALESCE(SUM(stake),0) stake,
   COALESCE(SUM(CASE WHEN status IN ('won','lost') THEN stake ELSE 0 END),0) settled_stake,
   COALESCE(SUM(CASE WHEN status='won' THEN payout ELSE 0 END),0) payout,
   COALESCE(SUM(CASE WHEN status IN ('won','lost') THEN profit ELSE 0 END),0) profit
   FROM experimental_paper_bets b
   WHERE NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q WHERE q.bet_id=b.id)`);
 const comparisonRows=await all<{race_id:string;stake:number;status:string;payout:number|null;reconciled:number}>(db,`SELECT b.race_id,b.stake,b.status,b.payout,
   EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q WHERE q.bet_id=b.id) reconciled
   FROM experimental_paper_bets b JOIN experimental_paper_decisions d ON d.id=b.decision_id
   WHERE d.experiment_key=? AND b.data_origin='real' ORDER BY b.race_id,b.id`,experimentKey);
 const comparison=buildExperimentalStakeComparison(comparisonRows.map(row=>({raceId:row.race_id,stake:Number(row.stake),status:row.status,payout:row.payout==null?null:Number(row.payout),reconciled:Boolean(row.reconciled)})));
 const rows=await all<any>(db,`SELECT d.race_id,r.race_date,r.race_no,v.name venue_name,
   CASE WHEN d.outcome='placed' AND EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q JOIN experimental_paper_bets qb ON qb.id=q.bet_id WHERE qb.decision_id=d.id)
     AND NOT EXISTS(SELECT 1 FROM experimental_paper_bets vb WHERE vb.decision_id=d.id AND NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations vq WHERE vq.bet_id=vb.id)) THEN 'void' ELSE d.outcome END outcome,
   CASE WHEN d.outcome='placed' AND EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q JOIN experimental_paper_bets qb ON qb.id=q.bet_id WHERE qb.decision_id=d.id)
     AND NOT EXISTS(SELECT 1 FROM experimental_paper_bets vb WHERE vb.decision_id=d.id AND NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations vq WHERE vq.bet_id=vb.id)) THEN 'invalid_stake_unit' ELSE d.reason END reason,
   CASE WHEN d.outcome='placed' THEN COALESCE((SELECT SUM(vb.stake) FROM experimental_paper_bets vb WHERE vb.decision_id=d.id AND NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations vq WHERE vq.bet_id=vb.id)),0)
     ELSE d.total_stake END stake,d.model_id,d.decision_at decided_at,
   (SELECT probability FROM experimental_paper_bets b WHERE b.decision_id=d.id AND NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q WHERE q.bet_id=b.id) ORDER BY b.stake DESC,b.selection LIMIT 1) probability,
   (SELECT odds_at_bet FROM experimental_paper_bets b WHERE b.decision_id=d.id AND NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q WHERE q.bet_id=b.id) ORDER BY b.stake DESC,b.selection LIMIT 1) odds,
   (SELECT prob_std FROM experimental_paper_bets b WHERE b.decision_id=d.id AND NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q WHERE q.bet_id=b.id) ORDER BY b.stake DESC,b.selection LIMIT 1) uncertainty,
   (SELECT expected_roi FROM experimental_paper_bets b WHERE b.decision_id=d.id AND NOT EXISTS(SELECT 1 FROM experimental_paper_bet_reconciliations q WHERE q.bet_id=b.id) ORDER BY b.stake DESC,b.selection LIMIT 1) expected_roi
   FROM experimental_paper_decisions d JOIN races r ON r.id=d.race_id JOIN venues v ON v.id=r.venue_id
   ORDER BY d.decision_at DESC,d.id DESC LIMIT 100`);
 const coverageDate=jstRaceDate(new Date());
 const coverage=await all<any>(db,`SELECT p.race_id,MAX(p.predicted_at) predicted_at FROM (
   SELECT ep.race_id,ep.predicted_at FROM experimental_ticket_predictions ep JOIN races r ON r.id=ep.race_id
   WHERE ep.model_id=? AND ep.artifact_sha256=? AND ep.data_origin='real' AND r.data_origin='real' AND r.race_date=?
     AND r.betting_cutoff_source=? AND julianday(ep.predicted_at)<=julianday(r.betting_cutoff_at,'-1 minute')
     AND julianday(ep.predicted_at)>=julianday(r.betting_cutoff_at,'-6 minutes')
   GROUP BY ep.race_id,ep.predicted_at HAVING COUNT(DISTINCT ep.selection)=120
 ) p GROUP BY p.race_id ORDER BY p.race_id LIMIT 180`,model?.id??'',model?.artifact_sha256??'',coverageDate,TRUSTED_CUTOFF_SOURCE);
 const n=metric??{races:0,bets:0,stake:0,payout:0,profit:0};
 return c.json({experimentKey,state:model?'ready':'unavailable',model:model?{id:model.id,status:model.status,artifactSha256:model.artifact_sha256,schemaVersion:model.schema_version,trainedAt:model.trained_at}:null,
   forecastCoverage:{date:coverageDate,storedRaceCount:coverage.length,races:coverage.map((x:any)=>({raceId:x.race_id,predictedAt:x.predicted_at,predictionCount:120}))},
   bankroll:{initial:Number(balance?.initial_balance??100000),available:Number(balance?.available_balance??100000)},
   metrics:{races:Number(n.races),bets:Number(n.bets),stake:Number(n.stake),payout:Number(n.payout),profit:Number(n.profit),roi:Number(n.settled_stake)>0?Number(n.payout)/Number(n.settled_stake):null},
   comparison,
   decisions:rows.map((x:any)=>({raceId:x.race_id,raceDate:x.race_date,raceNo:Number(x.race_no),venueName:x.venue_name??null,outcome:x.outcome,reason:x.reason??null,stake:Number(x.stake),modelId:x.model_id,decidedAt:x.decided_at,probability:x.probability==null?null:Number(x.probability),odds:x.odds==null?null:Number(x.odds),uncertainty:x.uncertainty==null?null:Number(x.uncertainty),expectedRoi:x.expected_roi==null?null:Number(x.expected_roi)})),
   sizing:{method:'fractional-kelly-portfolio',minimumTicketStake:100,stakeUnit:100,perRaceCombinedCap:1000,dailyCap:null,balanceGuard:'nonnegative-virtual-balance'}});
});
app.get('/performance/historical-trifecta-experiment',async c=>{
 c.header('Cache-Control','private, no-store');
 return c.json(await historicalTrifectaExperimentPerformance(c.env.DB));
});
app.get('/performance/breakdown',async c=>{const db=c.env.DB,origin=originFilter(c.req.query('origin'));
 const O=`(? IS NULL OR b.data_origin=?) AND ${nonQuarantinedBet('b')}`;
 const bySport=await all<any>(db,`SELECT sport,COUNT(*) bets,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,SUM(COALESCE(profit,0)) profit,CASE WHEN SUM(stake)>0 THEN 1.0*SUM(COALESCE(payout,0))/SUM(stake) END roi,1.0*SUM(CASE WHEN status='won' THEN 1 ELSE 0 END)/COUNT(*) hitRate FROM bets b WHERE ${O} AND status IN ('won','lost') GROUP BY sport`,origin,origin);
 const byMonth=await all<any>(db,`SELECT substr(placed_at,1,7) month,sport,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,SUM(COALESCE(profit,0)) profit FROM bets b WHERE ${O} AND status IN ('won','lost') GROUP BY month,sport ORDER BY month`,origin,origin);
 const byEdge=await all<any>(db,`SELECT CASE
   WHEN expected_roi IS NULL THEN '不明'
   WHEN expected_roi >= 0.20 THEN '20%以上'
   WHEN expected_roi >= 0.05 THEN '5〜20%'
   WHEN expected_roi >= 0 THEN '0〜5%'
   ELSE '< 0%'
  END bucket,COUNT(*) bets,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,CASE WHEN SUM(stake)>0 THEN 1.0*SUM(COALESCE(payout,0))/SUM(stake) END roi
  FROM bets b WHERE ${O} AND status IN ('won','lost') GROUP BY bucket ORDER BY CASE bucket WHEN '20%以上' THEN 1 WHEN '5〜20%' THEN 2 WHEN '0〜5%' THEN 3 WHEN '< 0%' THEN 4 ELSE 5 END`,origin,origin);
 const byModel=await all<any>(db,`SELECT COALESCE(model_id,'unknown') modelId,COUNT(*) bets,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,CASE WHEN SUM(stake)>0 THEN 1.0*SUM(COALESCE(payout,0))/SUM(stake) END roi FROM bets b WHERE ${O} AND status IN ('won','lost') GROUP BY model_id`,origin,origin);
 const calibration=await all<any>(db,`SELECT r.sport,CAST(p.probability*10 AS INT) bin,AVG(p.probability) predicted,AVG(CASE WHEN res.finish_order=1 THEN 1.0 ELSE 0.0 END) actual,COUNT(*) count FROM predictions p JOIN races r ON r.id=p.race_id AND p.data_origin=r.data_origin JOIN models m ON m.id=p.model_id AND m.sport=r.sport AND m.bet_type='win' AND (r.sport<>'boat' OR CASE WHEN json_valid(m.metrics_json) THEN (json_type(m.metrics_json,'$.boatArtifactSha256')='text' AND json_extract(m.metrics_json,'$.boatVenueSchemaVersion')='boat-venue-v2' AND length(json_extract(m.metrics_json,'$.correctedTrainingDataSha256'))=64 AND json_extract(m.metrics_json,'$.correctedTrainingDataSha256') NOT GLOB '*[^a-f0-9]*' AND length(json_extract(m.metrics_json,'$.boatArtifactSha256'))=64 AND json_extract(m.metrics_json,'$.boatArtifactSha256') NOT GLOB '*[^a-f0-9]*') ELSE 0 END) JOIN results res ON res.race_id=p.race_id AND res.number=p.number AND res.data_origin=r.data_origin WHERE NOT EXISTS(SELECT 1 FROM data_repair_audit_marks q WHERE q.record_type='prediction' AND q.record_id=p.id) AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races qr WHERE qr.race_id=r.id) AND r.status='finished' AND r.post_time IS NOT NULL AND julianday(p.predicted_at)<=julianday(r.post_time) AND (? IS NULL OR r.data_origin=?) AND p.predicted_at=(SELECT p2.predicted_at FROM predictions p2 WHERE p2.race_id=p.race_id AND p2.model_id=p.model_id AND p2.number=p.number AND p2.data_origin=r.data_origin AND julianday(p2.predicted_at)<=julianday(r.post_time) ORDER BY julianday(p2.predicted_at) DESC LIMIT 1) GROUP BY r.sport,bin ORDER BY r.sport,bin`,origin,origin);
 const oddsDrift=await first<any>(db,`SELECT COUNT(*) bets,AVG(odds_at_bet) avgOddsAtBet,AVG(final_odds) avgFinalOdds,COALESCE(SUM(ev_lost),0) evLostCount FROM bets b WHERE status IN ('won','lost') AND ${O}`,origin,origin);
 return c.json({bySport,byMonth,byEdge,byModel,calibration,oddsDrift,quarantined:await quarantineSummary(db,null,origin)});
});
function isRecord(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function isSha256(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function finite(...values: unknown[]): boolean { return values.every(v => typeof v === 'number' && Number.isFinite(v)); }
function canonicalJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
async function sha256Json(value: unknown): Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
async function sha256Text(value: string): Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
function hasSafeBoatRuntime(model: any) {
  if (model.sport !== 'boat') return true;
  try { const metrics=JSON.parse(model.metrics_json || '{}'); return metrics.boatVenueSchemaVersion === SAFE_BOAT_SCHEMA && isSha256(metrics.correctedTrainingDataSha256) && isSha256(metrics.boatArtifactSha256); }
  catch { return false; }
}
async function initialBaselineValidationError(model: any, metrics: Record<string, any>, body: any, nowMs: number) {
  if (model.sport !== 'boat' || model.bet_type !== 'win') return 'initial-baseline approval is only supported for boat win models';
  if (model.status !== 'candidate') return 'only a candidate model can receive initial-baseline approval';
  if (body?.confirmed !== true) return 'explicit initial-baseline confirmation is required';
  if (!isSha256(body?.validationFingerprint)) return 'validation fingerprint must be a SHA-256 digest';
  if (metrics.initialBaselineEligible !== true) return typeof metrics.initialBaselineReason === 'string' ? metrics.initialBaselineReason : 'initial-baseline validation is not eligible';
  const v = metrics.initialBaselineValidation;
  if (!isRecord(v) || v.policyVersion !== 'initial-baseline-v1' || v.fingerprint !== body.validationFingerprint) return 'initial-baseline validation fingerprint does not match';
  const fingerprintPayload={...v}; delete fingerprintPayload.fingerprint; delete fingerprintPayload.validatedAt;
  delete fingerprintPayload.initialBaselineEligible; delete fingerprintPayload.initialBaselineReason;
  if (await sha256Json(fingerprintPayload)!==v.fingerprint) return 'initial-baseline validation contents do not match their fingerprint';
  if (v.status!=='evaluated' || v.initialBaselineEligible!==true || v.candidateModelId !== model.id || v.sport !== model.sport || v.betType !== model.bet_type || v.dataOrigin !== 'real') return 'initial-baseline validation identity or eligibility does not match this real boat model';
  if (v.validatedAt == null || !Number.isFinite(Date.parse(v.validatedAt)) || Date.parse(v.validatedAt) > nowMs + 5 * 60_000 || nowMs - Date.parse(v.validatedAt) > 24 * 60 * 60_000) return 'initial-baseline validation is stale or has an invalid timestamp';
  const a=v.artifact, cohort=v.cohort, temporal=v.temporal, checks=v.checks, paired=v.pairedComparison;
  if (!isRecord(a) || a.version !== model.version || !isSha256(a.jsonSha256) || !isSha256(a.pickleSha256) || metrics.boatVenueSchemaVersion!==SAFE_BOAT_SCHEMA || !isSha256(metrics.correctedTrainingDataSha256) || v.boatVenueSchemaVersion!==SAFE_BOAT_SCHEMA || !isSha256(v.correctedTrainingDataSha256) || v.correctedTrainingDataSha256!==metrics.correctedTrainingDataSha256 || metrics.boatArtifactSha256!==a.pickleSha256 || !Array.isArray(a.featureColumns) || a.featureColumns.length === 0 || a.featureColumns.some((x:unknown)=>typeof x!=='string'||!x)) return 'validated artifact identity is incomplete';
  if (!isRecord(cohort) || !finite(cohort.raceCount,cohort.dayCount) || cohort.raceCount < 1 || cohort.dayCount < 1 || !isSha256(cohort.raceSetSha256) || !Number.isFinite(Date.parse(cohort.from)) || !Number.isFinite(Date.parse(cohort.to)) || Date.parse(cohort.from)>Date.parse(cohort.to)) return 'validated real cohort counts or dates are invalid';
  if (!isRecord(temporal) || !finite(temporal.trainRaceCount,temporal.validRaceCount,temporal.testRaceCount) || temporal.trainRaceCount<1 || temporal.validRaceCount<1 || temporal.testRaceCount<1 || temporal.disjointRaceIds!==true || temporal.fitAndValidationPrecedeHoldout!==true || temporal.splitMatchesArtifactMetadata!==true) return 'temporal validation evidence is incomplete';
  const dates=[temporal.trainFrom,temporal.trainTo,temporal.validFrom,temporal.validTo,temporal.testFrom,temporal.testTo].map(Date.parse);
  if (dates.some(d=>!Number.isFinite(d)) || !(dates[0]<=dates[1]&&dates[1]<dates[2]&&dates[2]<=dates[3]&&dates[3]<dates[4]&&dates[4]<=dates[5]) || Date.parse(cohort.from)!==dates[4] || Date.parse(cohort.to)!==dates[5]) return 'temporal split dates do not match the held-out cohort';
  const requiredChecks=['safeFeatureSchema','realOnly','completeFullRaceCohorts','probabilitiesFiniteNormalized','storedMetricsReproduced','temporalSplitMatchesArtifact','disjointRaceIds','fitAndValidationPrecedeHoldout','minHeldoutRaceCount','minHeldoutDateCount','pairedLogLossImprovement','pairedBrierImprovement','pairedLogLossDateClusterImprovement','pairedBrierDateClusterImprovement','eceWithinThreshold','noGrossDateSliceReversal','authenticatedRegistrySnapshot','candidateRegisteredAsCandidate','noCompatibleActiveModels'];
  if (!isRecord(checks) || requiredChecks.some(k=>checks[k]!==true)) return 'initial-baseline evidence checks did not all pass';
  const cm=v.candidateMetrics, bm=v.laneBaselineMetrics;
  if (!isRecord(v.candidateRegistryIdentity) || v.candidateRegistryIdentity.id!==model.id || v.candidateRegistryIdentity.version!==model.version || v.candidateRegistryIdentity.status!=='candidate') return 'candidate registry identity is incomplete or stale';
  if (!isRecord(cm) || !isRecord(bm) || !finite(cm.nRaces,cm.logLoss,cm.brier,cm.ece,bm.nRaces,bm.logLoss,bm.brier,bm.ece) || cm.nRaces!==cohort.raceCount || bm.nRaces!==cohort.raceCount) return 'candidate and lane-baseline metrics do not cover the same complete cohort';
  if (!isRecord(paired) || paired.method!=='paired bootstrap by race; separate date-cluster bootstrap' || !finite(paired.raceCount,paired.logLossDelta,paired.brierDelta) || paired.raceCount!==cohort.raceCount || !Array.isArray(paired.logLossCI95) || paired.logLossCI95.length!==2 || !finite(...paired.logLossCI95) || !Array.isArray(paired.brierCI95) || paired.brierCI95.length!==2 || !finite(...paired.brierCI95) || !Array.isArray(paired.dateClusterLogLossCI95) || paired.dateClusterLogLossCI95.length!==2 || !finite(...paired.dateClusterLogLossCI95) || !Array.isArray(paired.dateClusterBrierCI95) || paired.dateClusterBrierCI95.length!==2 || !finite(...paired.dateClusterBrierCI95) || paired.logLossCI95[1]>=0 || paired.brierCI95[1]>=0 || paired.dateClusterLogLossCI95[1]>=0 || paired.dateClusterBrierCI95[1]>=0) return 'paired baseline comparison is incomplete or does not show required improvement';
  if (!Array.isArray(v.dateSlices) || v.dateSlices.length===0 || v.dateSlices.some((x:any)=>!isRecord(x)||!finite(x.raceCount,x.logLoss,x.brier,x.ece,x.deltaLogLossVsLane,x.deltaBrierVsLane)||x.raceCount<1)) return 'date-slice validation evidence is incomplete';
  if (v.sourceAvailability!=='assumed_from_B_prerace_content_not_recorded' || v.historyFeatures!=='not_observed_or_used') return 'source-availability or history-feature limitations are missing';
  if (!isRecord(v.profitability) || !['counterfactual_replay_unproven','counterfactual_replay_positive_evidence_not_profitability_proof'].includes(v.profitability.status)) return 'profitability evidence must remain explicitly unproven or counterfactual';
  const snapshot=v.activeModelSnapshot;
  if (!isRecord(snapshot) || snapshot.source!=='authenticated_registry' || !isSha256(snapshot.snapshotSha256) || !Array.isArray(snapshot.models) || snapshot.models.some((x:any)=>!isRecord(x)||typeof x.id!=='string'||typeof x.version!=='string'||!isSha256(x.metricsSha256)||!['untrained','candidate','active','retired'].includes(x.status)||!['compatible','incompatible','unknown'].includes(x.artifactCompatibility)||x.id===model.id)) return 'authenticated model registry snapshot is invalid';
  if (snapshot.models.some((x:any)=>x.status==='active'&&x.artifactCompatibility!=='incompatible')) return 'an active compatible or unverified model prevents initial-baseline approval';
  if (await sha256Json(snapshot.models)!==snapshot.snapshotSha256) return 'authenticated model registry snapshot digest is invalid';
  return null;
}
async function registrySnapshotMatches(db: Db, model: any, validation: any) {
  const current=await all<any>(db,'SELECT id,version,status,metrics_json FROM models WHERE sport=? AND bet_type=? AND id<>? ORDER BY id,version,status',model.sport,model.bet_type,model.id);
  const order=(a:any,b:any)=>a.id<b.id?-1:a.id>b.id?1:a.version<b.version?-1:a.version>b.version?1:a.status<b.status?-1:a.status>b.status?1:0;
  const expected=(validation.activeModelSnapshot.models as any[]).map(x=>({id:x.id,version:x.version,status:x.status,metricsSha256:x.metricsSha256})).sort(order);
  const actual=await Promise.all(current.sort(order).map(async x=>({id:x.id,version:x.version,status:x.status,metricsSha256:await sha256Text(x.metrics_json??'')})));
  return JSON.stringify(actual)===JSON.stringify(expected);
}
app.get('/models',async c=>{const rows=await all<any>(c.env.DB,'SELECT * FROM models ORDER BY sport,status,id');return c.json(rows.map(mapModel));});
app.post('/models/:id/promote',async c=>{
 const db=c.env.DB,id=c.req.param('id'),m=await first<any>(db,'SELECT * FROM models WHERE id=?',id);if(!m)return jsonError(c,'model not found',404);if(m.status==='untrained')return jsonError(c,'untrained model cannot be promoted');
 let metrics:Record<string,any>;try{metrics=JSON.parse(m.metrics_json||'{}');}catch{return jsonError(c,'model metrics are invalid');}
 const body=await c.req.json().catch(()=>({})) as any, initial=body?.mode==='initial_baseline';
 if(body?.mode!==undefined&&!initial)return jsonError(c,'unsupported promotion mode');
 if(initial){
   const error=await initialBaselineValidationError(m,metrics,body,Date.now());if(error)return jsonError(c,error);
   if(!hasSafeBoatRuntime(m)||metrics.boatVenueSchemaVersion!==SAFE_BOAT_SCHEMA||!isSha256(metrics.correctedTrainingDataSha256))return jsonError(c,'validated safe boat runtime schema is required');
   if(!await registrySnapshotMatches(db,m,metrics.initialBaselineValidation))return jsonError(c,'model registry changed since initial-baseline validation; validate again');
 } else {
   if(metrics.promotionEligible===false)return jsonError(c,typeof metrics.promotionReason==='string'?metrics.promotionReason:'candidate failed same-holdout promotion criteria');
   if(m.sport==='boat'&&metrics.promotionEligible!==true)return jsonError(c,'boat candidates require an eligible same-holdout comparison or explicit initial-baseline approval');
   if(m.bet_type!=='win'&&!ticketValidationEvidence(metrics,m.bet_type))return jsonError(c,'ticket model requires a recent artifact-bound validation and explicit complete-ticket quality gate');
   if(m.bet_type==='win'&&!hasSafeBoatRuntime(m))return jsonError(c,'validated safe boat runtime schema is required before boat win promotion');
 }
 if(!await reserveWorkerWrites(db,2)){const budget=await readWriteBudget(db);return c.json({error:'daily D1 write budget unavailable or exhausted',code:budget.state==='missing'||budget.state==='invalid'?'d1_write_budget_unavailable':'d1_write_budget_exhausted',budget},429);}
 if(db.batch){
   await db.batch([
     db.prepare("UPDATE models SET status='retired' WHERE sport=? AND bet_type=? AND status='active' AND id<>? AND EXISTS(SELECT 1 FROM models WHERE id=? AND status=? AND version=? AND metrics_json IS ?)").bind(m.sport,m.bet_type,id,id,m.status,m.version,m.metrics_json),
     db.prepare("UPDATE models SET status='active' WHERE id=? AND status=? AND version=? AND metrics_json IS ?").bind(id,m.status,m.version,m.metrics_json),
   ]);
 } else {
   const activation=await run(db,"UPDATE models SET status='active' WHERE id=? AND status=? AND version=? AND metrics_json IS ?",id,m.status,m.version,m.metrics_json);
   if(!activation.meta?.changes)return jsonError(c,'model changed during promotion; review again',409);
   await run(db,"UPDATE models SET status='retired' WHERE sport=? AND bet_type=? AND status='active' AND id<>?",m.sport,m.bet_type,id);
 }
 const updated=await first<any>(db,'SELECT * FROM models WHERE id=?',id);if(!updated||updated.status!=='active')return jsonError(c,'model promotion state changed; retry after review',409);
 return c.json(mapModel(updated));
});
// The operator alias is INGEST_TOKEN-scoped because Actions cannot hold the
// web Worker proxy token. It accepts only this approved same-day baseline and
// delegates to the ordinary promotion route, preserving every existing gate.
app.post('/ingest/approved-boat-baseline/promote',async c=>{
  if(!auth(c))return jsonError(c,'unauthorized',401);
  const body=await c.req.json().catch(()=>null) as any;
  const keys=body&&typeof body==='object'&&!Array.isArray(body)?Object.keys(body).sort():[];
  if(keys.length!==3||keys[0]!=='confirmed'||keys[1]!=='date'||keys[2]!=='validationFingerprint'||
     body.confirmed!==true||body.date!==utcDate()||body.validationFingerprint!=='a5596554c3def74853149fdaba5b54557473459ba12ffb717d2d6ad805e0acec')
    return jsonError(c,'explicit current-UTC-day confirmation for the approved initial baseline is required');
  const headers=new Headers({'Authorization':`Bearer ${c.env.INGEST_TOKEN}`,'Content-Type':'application/json'});
  if(c.env.PROXY_TOKEN)headers.set('X-ROI-Proxy',c.env.PROXY_TOKEN);
  const delegated=await app.request('/api/models/boat-win-lgbm-20261010-14b4a90a/promote',{
    method:'POST',headers,body:JSON.stringify({mode:'initial_baseline',confirmed:true,validationFingerprint:body.validationFingerprint}),
  },c.env);
  return new Response(delegated.body,{status:delegated.status,statusText:delegated.statusText,headers:delegated.headers});
});
app.post('/models/:id/rollback',async c=>{const db=c.env.DB,id=c.req.param('id'),m=await first<any>(db,'SELECT * FROM models WHERE id=?',id);if(!m)return jsonError(c,'model not found',404);if(m.status!=='active')return jsonError(c,'model is not active');const old=await first<any>(db,"SELECT * FROM models WHERE sport=? AND bet_type=? AND status='retired' ORDER BY rowid DESC LIMIT 1",m.sport,m.bet_type);if(!old)return jsonError(c,'no retired model to rollback');if(m.bet_type!=='win'){let metrics:any;try{metrics=JSON.parse(old.metrics_json||'{}')}catch{return jsonError(c,'rollback ticket model metadata is invalid')}if(!ticketValidationEvidence(metrics,m.bet_type))return jsonError(c,'rollback target lacks current validated ticket quality evidence')}if(m.bet_type==='win'&&!hasSafeBoatRuntime(old))return jsonError(c,'rollback target lacks validated safe boat runtime schema');if(!await reserveWorkerWrites(db,2)){const budget=await readWriteBudget(db);return c.json({error:'daily D1 write budget unavailable or exhausted',code:budget.state==='missing'||budget.state==='invalid'?'d1_write_budget_unavailable':'d1_write_budget_exhausted',budget},429);}if(db.batch){await db.batch([db.prepare("UPDATE models SET status='retired' WHERE id=? AND status='active'").bind(id),db.prepare("UPDATE models SET status='active' WHERE id=? AND status='retired'").bind(old.id)]);}else{await run(db,"UPDATE models SET status='retired' WHERE id=? AND status='active'",id);await run(db,"UPDATE models SET status='active' WHERE id=? AND status='retired'",old.id);}const updated=await first<any>(db,'SELECT * FROM models WHERE id=?',old.id);if(!updated||updated.status!=='active')return jsonError(c,'rollback state changed; retry after review',409);return c.json(mapModel(updated));});
app.get('/collection/status',async c=>{const db=c.env.DB,runs=await all<any>(db,'SELECT * FROM collection_runs ORDER BY started_at DESC'), tables=['venues','races','entries','odds_snapshots','results','payouts','models','predictions','ticket_predictions','bets','collection_runs','daily_summaries','settings'], tableCounts:Record<string,number>={};for(const t of tables)tableCounts[t]=(await first<any>(db,`SELECT COUNT(*) n FROM ${t}`))?.n??0;
 const classified=runs.map(r=>({...r,...collectionIssues(r)}));
 const keys=[...new Set(runs.map(r=>`${r.source}\n${r.sport}`))];
 const sources=keys.map(key=>{
  const group=classified.filter(r=>`${r.source}\n${r.sport}`===key),latest=group[0];
  const attempts=group.filter(r=>r.status!=='skipped' && !(r.quality.length && !r.error && !r.records));
  const successes=attempts.filter(r=>r.status==='success' || (r.quality.length && !r.error && r.records>0));
  const lastSuccessAt=successes[0]?.started_at??null;
  // A quality skip is still an enabled collector, not a feature-flag shutdown.
  const enabled=latest.source!=='jra' && (latest.status!=='skipped'||latest.quality.length>0);
  return {source:latest.source,sport:latest.sport,enabled,lastRunAt:latest.started_at,lastSuccessAt,successRate:attempts.length?successes.length/attempts.length:null,runs:group.length,records:group.reduce((n,r)=>n+(r.records??0),0),qualityExclusions:group.reduce((n,r)=>n+r.quality.length,0),freshnessMinutes:latest.started_at?Math.max(0,(Date.now()-Date.parse(latest.started_at))/60000):null,note:latest.source==='jra'?'規約上自動取得不可':null};
 });
 const errors=classified.filter(r=>(r.status==='failed'||r.status==='partial') && (r.error||!r.quality.length)).slice(0,50).map(r=>({at:r.started_at,source:r.source,error:r.error??r.reason??r.status}));
 const recentQualityCutoff=Date.now()-60*60_000;
 const qualityExclusions=classified.filter(r=>r.quality.length && Date.parse(r.started_at)>=recentQualityCutoff).slice(0,50).map(r=>({at:r.started_at,source:r.source,count:r.quality.length,reason:r.quality.join(' | ')}));
 return c.json({sources,errors,qualityExclusions,tableCounts,nativeDailyStatus:await readDailyCloudPipelineStatus(db),d1WriteBudget:await readWriteBudget(db),freeTier:{d1RowsApprox:Object.values(tableCounts).reduce((a,b)=>a+b,0),d1RowsNote:'合計は保存中のテーブル行数の概算で、Cloudflareアカウント全体のquota使用量ではありません。'}});
});
for(const route of Object.keys(ingestTables)) app.post(`/ingest/${route}` as any,c=>ingest(c,route));
app.get('/ingest/models',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 const models=await all<any>(c.env.DB,'SELECT id,sport,bet_type,version,algorithm,status,train_from,train_to,valid_from,valid_to,test_from,test_to,n_train,metrics_json,trained_at,notes FROM models ORDER BY sport,status,id');
 return c.json({models});
});
app.get('/ingest/prerace-capture-archives',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 const date=c.req.query('date')??'';
 const cursor=c.req.query('cursor')??'';
 const rawLimit=c.req.query('limit');
 const limit=rawLimit===undefined?25:Number(rawLimit);
 const parsedDate=/^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
 const validDate=!!parsedDate&&new Date(Date.UTC(Number(parsedDate[1]),Number(parsedDate[2])-1,Number(parsedDate[3]))).toISOString().slice(0,10)===date;
 if(!validDate||!Number.isInteger(limit)||limit<1||limit>25)return jsonError(c,'one valid race date and limit between 1 and 25 are required');
 if(cursor&&!/^boat-\d{8}-\d{2}-\d{2}:capture:\d{13}$/.test(cursor))return jsonError(c,'invalid archive cursor');
 const rows=await all<any>(c.env.DB,`SELECT id,race_id,race_date,captured_at,archive_json
   FROM boatrace_prerace_capture_archives WHERE race_date=? AND id>? ORDER BY id ASC LIMIT ?`,date,cursor,limit+1);
 const hasMore=rows.length>limit, page=rows.slice(0,limit);
 const archives=await Promise.all(page.map(async row=>{
   const bytes=new TextEncoder().encode(row.archive_json);
   const digest=await crypto.subtle.digest('SHA-256',bytes);
   const archiveSha256=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
   return {id:row.id,raceId:row.race_id,raceDate:row.race_date,capturedAt:row.captured_at,archiveSha256,archiveJson:row.archive_json};
 }));
 return c.json({schema:'boat-prerace-capture-export-v1',date,limit,archives,nextCursor:hasMore?page.at(-1)?.id??null:null});
});
app.get('/ingest/historical-trifecta-archives',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 const bucket=c.env.TRIFECTA_ARCHIVE;if(!bucket)return c.json({error:'historical archive bucket unavailable',code:'archive_unavailable'},503);
 const date=c.req.query('date')??'',cursor=c.req.query('cursor')||undefined,rawLimit=c.req.query('limit'),limit=rawLimit===undefined?25:Number(rawLimit);
 if(!validHistoricalArchiveDate(date)||!Number.isInteger(limit)||limit<1||limit>25||(cursor&&cursor.length>1024))return jsonError(c,'one valid race date and limit between 1 and 25 are required');
 try {
   const page=await listHistoricalArchiveObjects(bucket,date,cursor,limit),objects=page.objects,hasMore=page.truncated;
   const archives=objects.map(object=>{
     const identity=parseHistoricalArchiveKey(object.key);if(!identity)return null;
     return {key:object.key,raceId:object.customMetadata?.raceId??null,raceDate:identity.raceDate,venueId:identity.venueId,raceNo:identity.raceNo,
       modelId:identity.modelId,phase:identity.completeKey?'t60':'t60-attempt',status:object.customMetadata?.status??'unknown',
       sourceArtifactSha256:object.customMetadata?.sourceArtifactSha256??null,predictedAt:object.customMetadata?.predictedAt||null,
       etag:object.etag,uploadedAt:object.uploaded.toISOString(),size:object.size};
   }).filter(Boolean);
   return c.json({schema:'roi-plus-trifecta-archive-index-v1',date,limit,archives,nextCursor:hasMore?page.cursor??null:null});
 }catch{return c.json({error:'historical archive listing failed',code:'archive_list_failed'},503);}
});
app.get('/ingest/historical-trifecta-archive',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 const bucket=c.env.TRIFECTA_ARCHIVE;if(!bucket)return c.json({error:'historical archive bucket unavailable',code:'archive_unavailable'},503);
 const key=c.req.query('key')??'';
 try {
   const result=await exportHistoricalArchive(bucket,key);if(!result)return jsonError(c,'archive not found',404);
   return new Response(result.object.body,{headers:{'Content-Type':'application/gzip','Cache-Control':'private, no-store',
     'X-Archive-Schema':'roi-plus-trifecta-observation-v1','ETag':result.object.httpEtag}});
 }catch{return c.json({error:'historical archive read failed',code:'archive_read_failed'},503);}
});
app.get('/ingest/historical-trifecta-coverage',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 const bucket=c.env.TRIFECTA_ARCHIVE;if(!bucket)return c.json({error:'historical archive bucket unavailable',code:'archive_unavailable'},503);
 const date=c.req.query('date')??'';if(!validHistoricalArchiveDate(date))return jsonError(c,'valid race date is required');
 try{return c.json(await historicalArchiveCoverage(c.env.DB,bucket,date));}
 catch{return c.json({error:'historical archive coverage failed',code:'archive_coverage_failed'},503);}
});
app.get('/ingest/historical-trifecta-labels',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 const bucket=c.env.TRIFECTA_ARCHIVE;if(!bucket)return c.json({error:'historical archive bucket unavailable',code:'archive_unavailable'},503);
 const date=c.req.query('date')??'',cursor=c.req.query('cursor')??'',rawLimit=c.req.query('limit'),limit=rawLimit===undefined?5:Number(rawLimit);
 if(!validHistoricalArchiveDate(date)||!Number.isInteger(limit)||limit<1||limit>5||(cursor&&!/^[A-Za-z0-9:_-]{1,160}$/.test(cursor)))return jsonError(c,'one valid race date and limit between 1 and 5 are required');
 const candidates=await all<any>(c.env.DB,`SELECT r.id,r.venue_id,r.race_no,r.race_date,r.post_time,r.betting_cutoff_at,cr.reason proof_json
   FROM races r JOIN collection_runs cr ON cr.id='boat-result:'||r.id AND cr.source=? AND cr.status='success'
   WHERE r.sport='boat' AND r.data_origin='real' AND r.race_date=? AND r.id>? AND r.post_time IS NOT NULL
     AND json_valid(cr.reason) AND json_extract(cr.reason,'$.quality')='verified-official-outcome-v2'
     AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
   ORDER BY r.id LIMIT ?`,RESULTS_SOURCE,date,cursor,limit+1);
 const hasMore=candidates.length>limit,page=candidates.slice(0,limit),labels:any[]=[];
 for(const race of page){
   let proof:any;try{proof=JSON.parse(race.proof_json)}catch{continue;}
   const fetchedAt=Date.parse(proof.fetchedAt),now=Date.now();
   if(proof.raceId!==race.id||proof.url!==resultUrl(race)||!/^([a-f0-9]{64})$/.test(String(proof.sha256))
      ||proof.quality!=='verified-official-outcome-v2'||!Number.isFinite(fetchedAt)||fetchedAt<Date.parse(race.post_time)
      ||fetchedAt<Date.parse(race.betting_cutoff_at)||fetchedAt>now||!Array.isArray(proof.results)||proof.results.length!==6||!Array.isArray(proof.payouts))continue;
   const [results,payouts,entries]=await Promise.all([
     all<any>(c.env.DB,"SELECT number,finish_order FROM results WHERE race_id=? AND data_origin='real' ORDER BY finish_order,number",race.id),
     all<any>(c.env.DB,"SELECT selection,payout FROM payouts WHERE race_id=? AND data_origin='real' AND bet_type='trifecta' AND payout>0",race.id),
     all<any>(c.env.DB,"SELECT number FROM entries WHERE race_id=? AND data_origin='real' ORDER BY number",race.id),
   ]);
   if(entries.length!==6||entries.some((row:any,index:number)=>Number(row.number)!==index+1)||results.length!==6
      ||results.some((row:any,index:number)=>Number(row.finish_order)!==index+1)
      ||new Set(results.map((row:any)=>Number(row.number))).size!==6||results.some((row:any)=>!entries.some((entry:any)=>Number(entry.number)===Number(row.number)))
      ||!matchesVerifiedResultPairs(proof.results,results)
      ||payouts.length!==1||proof.payouts.filter((row:any)=>row.betType==='trifecta').length!==1)continue;
   const payout=payouts[0],selection=results.slice(0,3).map((row:any)=>String(row.number)).join('-');
   if(payout.selection!==selection||!Number.isSafeInteger(Number(payout.payout))||Number(payout.payout)<=0
      ||!proof.payouts.some((row:any)=>row.betType==='trifecta'&&row.selection===selection&&Number(row.payout)===Number(payout.payout)))continue;
   const archiveKey=historicalArchiveKey(race.race_date,race.venue_id,Number(race.race_no),'boat-trifecta-historical-base-20261014');
   const archived=await bucket.head(archiveKey);if(!archived||archived.customMetadata?.status!=='complete')continue;
   labels.push({archiveKey,raceId:race.id,raceDate:race.race_date,venueId:race.venue_id,raceNo:Number(race.race_no),
     results:results.map((row:any)=>({number:Number(row.number),finishOrder:Number(row.finish_order)})),
     trifectaPayout:{selection,payoutYen:Number(payout.payout)},availableAt:proof.fetchedAt,
     source:{url:proof.url,sha256:proof.sha256,availableAt:proof.fetchedAt,quality:proof.quality}});
 }
 return c.json({schema:'roi-plus-trifecta-label-export-v1',date,limit,labels,nextCursor:hasMore?page.at(-1)?.id??null:null});
});
app.get('/ingest/experimental-trifecta/training-results',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 const date=c.req.query('date')??'',cursor=c.req.query('cursor')??'',rawLimit=c.req.query('limit'),limit=rawLimit===undefined?5:Number(rawLimit);
 const dateMatch=/^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
 const validDate=!!dateMatch&&new Date(Date.UTC(Number(dateMatch[1]),Number(dateMatch[2])-1,Number(dateMatch[3]))).toISOString().slice(0,10)===date;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 if(!validDate||date!==today||!Number.isInteger(limit)||limit<1||limit>5)return jsonError(c,'current JST date and limit between 1 and 5 are required');
 if(cursor&&!/^boat-\d{8}-\d{2}-\d{2}$/.test(cursor))return jsonError(c,'invalid result-label cursor');
 const db=c.env.DB;
 const candidates=await all<any>(db,`SELECT r.id,r.venue_id,r.race_no,r.race_date,r.post_time,r.betting_cutoff_at,r.betting_cutoff_source,cr.reason proof_json
   FROM races r JOIN collection_runs cr ON cr.id='boat-result:'||r.id AND cr.source=? AND cr.status='success'
   WHERE r.sport='boat' AND r.data_origin='real' AND r.race_date=? AND r.id>? AND r.post_time IS NOT NULL
    AND json_valid(cr.reason) AND json_extract(cr.reason,'$.quality')='verified-official-outcome-v2'
    AND EXISTS(SELECT 1 FROM boatrace_prerace_capture_archives ar WHERE ar.race_id=r.id AND ar.data_origin='real'
      AND julianday(ar.captured_at)<=julianday(r.betting_cutoff_at,'-60 seconds') AND json_valid(ar.archive_json)
      AND json_extract(ar.archive_json,'$.schema')='boat-prerace-capture-v1')
   ORDER BY r.id LIMIT ?`,RESULTS_SOURCE,date,cursor,limit+1);
 const hasMore=candidates.length>limit,page=candidates.slice(0,limit),labels:any[]=[];
 for(const race of page){
   let proof:any;try{proof=JSON.parse(race.proof_json)}catch{continue;}
   const fetchedAt=Date.parse(proof.fetchedAt),now=Date.now();
   if(proof.raceId!==race.id||proof.url!==resultUrl(race)||proof.quality!=='verified-official-outcome-v2'
      ||!isSha256(proof.sha256)||!Number.isFinite(fetchedAt)||fetchedAt<Date.parse(race.post_time)
      ||fetchedAt<Date.parse(race.betting_cutoff_at)||fetchedAt>now||!Array.isArray(proof.results)||proof.results.length!==6
      ||!Array.isArray(proof.payouts))continue;
   const [results,payouts,entries,archiveRow]=await Promise.all([
     all<any>(db,"SELECT number,finish_order FROM results WHERE race_id=? AND data_origin='real' ORDER BY finish_order,number",race.id),
     all<any>(db,"SELECT bet_type,selection,payout FROM payouts WHERE race_id=? AND data_origin='real' AND bet_type='trifecta' AND payout>0",race.id),
     all<any>(db,"SELECT number,features_json FROM entries WHERE race_id=? AND data_origin='real' ORDER BY number",race.id),
     first<any>(db,"SELECT captured_at,archive_json FROM boatrace_prerace_capture_archives WHERE race_id=? AND data_origin='real' AND julianday(captured_at)<=julianday(?) ORDER BY julianday(captured_at) DESC LIMIT 1",race.id,new Date(Date.parse(race.betting_cutoff_at)-60_000).toISOString()),
   ]);
   if(results.length!==6||new Set(results.map((x:any)=>Number(x.number))).size!==6
      ||new Set(results.map((x:any)=>Number(x.finish_order))).size!==6
      ||[1,2,3,4,5,6].some(n=>!results.some((x:any)=>Number(x.finish_order)===n))
      ||new Set(proof.results.map((x:any)=>Number(x.number))).size!==6
      ||new Set(proof.results.map((x:any)=>Number(x.finishOrder))).size!==6
      ||proof.results.some((x:any)=>!results.some((y:any)=>Number(y.number)===Number(x.number)&&Number(y.finish_order)===Number(x.finishOrder)))
      ||payouts.length!==1||proof.payouts.filter((x:any)=>x.betType==='trifecta').length!==1)continue;
   const winningSelection=results.slice(0,3).map((x:any)=>String(x.number)).join('-'),payout=payouts[0];
   if(payout.selection!==winningSelection||!Number.isSafeInteger(Number(payout.payout))||Number(payout.payout)<=0
      ||!proof.payouts.some((x:any)=>x.betType==='trifecta'&&x.selection===payout.selection&&Number(x.payout)===Number(payout.payout)))continue;
   if(!archiveRow||Date.parse(archiveRow.captured_at)>Date.parse(race.betting_cutoff_at)-60_000)continue;
   let archive:any;try{archive=JSON.parse(archiveRow.archive_json)}catch{continue;}
   if(archive.capturedAt!==archiveRow.captured_at||!boatArchiveEvidenceValid(archive,race,entries))continue;
   labels.push({raceId:race.id,raceDate:race.race_date,venueId:race.venue_id,raceNo:Number(race.race_no),
     results:results.map((x:any)=>({number:Number(x.number),finishOrder:Number(x.finish_order)})),
     payouts:[{betType:'trifecta',selection:payout.selection,payout:Number(payout.payout)}],
     source:{url:proof.url,sha256:proof.sha256,fetchedAt:proof.fetchedAt,quality:proof.quality}});
 }
 return c.json({schema:'boat-official-k-result-label-export-v1',date,limit,labels,nextCursor:hasMore?page.at(-1)?.id??null:null});
});
app.post('/admin/collect-boat-results',async c=>{
 if(!auth(c)&&!proxyAuth(c))return jsonError(c,'unauthorized',401);
 if(c.env.ENABLE_BOATRACE_RESULTS_SCRAPE!=='true')return c.json({error:'result collection disabled',code:'results_collection_disabled'},403);
 const body=await c.req.json().catch(()=>null) as {confirmed?:unknown;labelOnly?:unknown}|null;
 if(body?.confirmed!==true)return c.json({error:'explicit confirmation required',code:'confirmation_required'},400);
 if(body.labelOnly!==undefined&&typeof body.labelOnly!=='boolean')return c.json({error:'labelOnly must be boolean',code:'invalid_mode'},400);
 try {
   const result=await collectResults(c.env.DB,new Date(),{mode:'manual',labelOnly:body.labelOnly===true,maxAttempts:body.labelOnly===true?8:undefined,requestBudget:{used:0,max:49}});
   console.info(JSON.stringify({event:body.labelOnly===true?'boat-manual-label-results':'boat-manual-results',status:result.status,targets:result.targets,verified:result.verified,records:result.records,attempted:result.attempted,reason:'reason' in result?result.reason:null,fetchFailures:'fetchFailures' in result?result.fetchFailures:[]}));
   return c.json(result);
 } catch {return c.json({error:'manual result pass failed',code:'manual_results_failed'},503);}
});
app.post('/admin/settle',async c=>{
 if(!auth(c)){
   if(!proxyAuth(c))return jsonError(c,'unauthorized',401);
   const body=await c.req.json().catch(()=>null) as {confirmed?:unknown}|null;
   if(body?.confirmed!==true)return c.json({error:'explicit confirmation required',code:'confirmation_required'},400);
 }
 return c.json({settled:await settleOpen(c.env.DB)});
});
type ScheduledDecisionStages={
  normal?:()=>Promise<any>;
  experimental:()=>Promise<any>;
  historical:()=>Promise<any>;
  pass?:'current'|'upcoming-t60';
  targetMs?:number|null;
  log?:(line:string)=>void;
};
async function runScheduledDecisionStages(stages:ScheduledDecisionStages){
  const log=stages.log??((line:string)=>console.info(line));
  const run=async(stage:'paper-decision-timing'|'experimental-paper-decision'|'historical-trifecta-virtual-experiment',work:(()=>Promise<any>)|undefined,summary:(value:any)=>any=(value:any)=>value)=>{
    if(!work)return {status:'skipped' as const,value:undefined};
    const startedAt=Date.now(),timing={elapsedMs:0,...(Number.isFinite(stages.targetMs)?{startDeltaMs:startedAt-Number(stages.targetMs)}:{})};
    try{
      const value=await work();
      timing.elapsedMs=Math.max(0,Date.now()-startedAt);
      log(JSON.stringify({event:stage,status:'success',...(stages.pass?{pass:stages.pass}:{}),...timing,...summary(value)}));
      return {status:'success' as const,value};
    }catch(error){
      timing.elapsedMs=Math.max(0,Date.now()-startedAt);
      const errorClass=error instanceof Error&&/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)?error.name:'Error';
      log(JSON.stringify({event:stage,status:'failed',...(stages.pass?{pass:stages.pass}:{}),...timing,reason:'decision-stage-failed',errorClass}));
      return {status:'failed' as const,value:undefined};
    }
  };
  const normal=await run('paper-decision-timing',stages.normal,(value:any)=>value===null?{enabled:false}:value.report??{});
  const experimental=await run('experimental-paper-decision',stages.experimental);
  const historical=await run('historical-trifecta-virtual-experiment',stages.historical,(value:any)=>{
    const {archiveObservations,...summary}=value??{};return summary;
  });
  return {normal,experimental,historical};
}
async function runScheduledDecisionPasses(stages:ScheduledDecisionStages,wait:()=>Promise<{status:'none'|'ready'|'expired'|string;targetMs?:number|null}>,log=(line:string)=>console.info(line)){
  const current=await runScheduledDecisionStages({...stages,pass:'current'});
  let target:{status:'none'|'ready'|'expired'|string;targetMs?:number|null};
  try{target=await wait();}catch(error){
    const errorClass=error instanceof Error&&/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)?error.name:'Error';
    log(JSON.stringify({event:'paper-t60-target',status:'failed',reason:'target-discovery-failed',errorClass}));
    return {current,upcoming:null};
  }
  if(target.status!=='ready')return {current,upcoming:null};
  const upcoming=await runScheduledDecisionStages({...stages,pass:'upcoming-t60',targetMs:target.targetMs});
  return {current,upcoming};
}
async function findUpcomingPaperT60Target(db:Db,afterMs:number,throughMs:number){
  const rows=await all<any>(db,`SELECT r.betting_cutoff_at,r.betting_cutoff_source,r.betting_cutoff_observed_at FROM races r
    WHERE r.sport='boat' AND r.data_origin='real' AND r.status='scheduled' AND r.betting_cutoff_source=?
      AND julianday(r.betting_cutoff_at)>julianday(?) AND julianday(r.betting_cutoff_at)<=julianday(?)
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
      AND ((NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.mode='auto')
            AND NOT EXISTS(SELECT 1 FROM paper_decisions d WHERE d.race_id=r.id AND d.phase='primary_t60'))
        OR NOT EXISTS(SELECT 1 FROM experimental_paper_decisions d WHERE d.experiment_key='boat-trifecta-small-sample-v1' AND d.race_id=r.id)
        OR NOT EXISTS(SELECT 1 FROM historical_trifecta_experiment_decisions d WHERE d.race_id=r.id))
    ORDER BY julianday(r.betting_cutoff_at),r.id LIMIT 400`,TRUSTED_CUTOFF_SOURCE,
    isoJstAt(afterMs+PRIMARY_PAPER_OFFSET_MS),isoJstAt(throughMs+PRIMARY_PAPER_OFFSET_MS));
  const targets=rows.map((row:any):number|null=>{
    const target=Date.parse(row.betting_cutoff_at)-PRIMARY_PAPER_OFFSET_MS;
    return primaryPaperTiming(row.betting_cutoff_at,target,row.betting_cutoff_source,row.betting_cutoff_observed_at).eligible?target:null;
  }).filter((value):value is number=>value!==null&&Number.isFinite(value)).sort((a,b)=>a-b);
  return targets[0]??null;
}
const waitForNextPaperT60Target=async(options:{
  now:()=>number;
  findTarget:(afterMs:number,throughMs:number)=>Promise<number|null>;
  refresh:()=>Promise<void>;
  sleep?:(ms:number)=>Promise<void>;
  log?:(line:string)=>void;
})=>{
  const startedAt=options.now();
  const targetMs=await options.findTarget(startedAt-PRIMARY_PAPER_TOLERANCE_MS,startedAt+60_000);
  if(targetMs===null)return {status:'none' as const,targetMs:null,actualMs:options.now()};
  const earlyPointMs=targetMs-8_000;
  const remaining=earlyPointMs-options.now();
  if(remaining>0)await (options.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms))))(remaining);
  // Force fresh I/O after a timer: scheduledTime is not a decision clock and
  // Worker Date.now must be re-read before any timing or odds predicates.
  await options.refresh();
  const actualMs=options.now(),deltaMs=actualMs-targetMs;
  if(Math.abs(deltaMs)>PRIMARY_PAPER_TOLERANCE_MS){
    (options.log??((line:string)=>console.info(line)))(JSON.stringify({event:'paper-t60-target',status:'skipped',reason:'t60-window-expired'}));
    return {status:'expired' as const,targetMs,actualMs};
  }
  return {status:'ready' as const,targetMs,actualMs};
};
export default { fetch: app.fetch, scheduled: async (event: ScheduledController, env: Env, ctx?: ExecutionContext) => {
  if (event.cron === '*/5 * * * *') {
    if(env.ENABLE_NATIVE_DAILY_PIPELINE==='true'){
      if(!env.TRIFECTA_ARCHIVE){
        console.info(JSON.stringify({event:'daily-cloud-pipeline',status:'unconfigured',reason:'archive-binding-unavailable'}));
        return;
      }
      await runDailyCloudPipeline(env.DB,{
        syncProgramFile:(kind,targetDate,scheduledAt)=>syncBoatraceProgramFile(env.DB,env.TRIFECTA_ARCHIVE!,scheduledAt,kind,{targetDate}),
        runLearning:env.FORECAST_LEARNER
          ? (targetDate)=>runNativeDailyLearner(env.FORECAST_LEARNER!,targetDate)
          : undefined,
      });
      return;
    }
    // Keep the legacy forecast fallback disabled while native inference is active;
    // daily collection has its own explicit flag and can be enabled independently.
    if(env.ENABLE_NATIVE_EXPERIMENTAL_FORECAST==='true')return;
    // Separate scheduled invocation keeps GitHub dispatch I/O out of the
    // minute-level T-60, odds, settlement, and shared fetch-budget path.
    await runForecastWatchdog(env.DB, env.FORECAST_GITHUB_TOKEN);
    return;
  }
  if (event.cron !== '* * * * *') return;
  const requestBudget={used:0,max:49};
  const oddsContext=purchaseOddsContext(requestBudget);
  oddsContext.enabled=env.ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE==='true';
  const decisionWork:ScheduledDecisionStages={
    log:line=>console.info(line),
    normal:async()=>{
      const enabled=env.ENABLE_AUTO_BET==='true'||(await setting(env.DB,'auto_bet_enabled','false'))==='true';
      return enabled?autoBetWithReport(env.DB,true,Date.now(),oddsContext):null;
    },
    experimental:async()=>{
      if(env.ENABLE_NATIVE_EXPERIMENTAL_FORECAST==='true'){
        try{
          const generated=await runNativeExperimentalForecast(env.DB,nativeExperimentalModel,nativeRacerHistory as NativeExperimentalHistorySnapshot,{
            storeForecast:body=>persistExperimentalForecast(env.DB,body),
          });
          if(generated.status==='model-mismatch')console.info(JSON.stringify({event:'experimental-forecast-native',source:'worker-native',status:'model-mismatch'}));
        }catch{console.info(JSON.stringify({event:'experimental-forecast-native',source:'worker-native',status:'generation-failed'}));}
      }
      return experimentalPaperDecision(env.DB,Date.now(),oddsContext);
    },
    historical:()=>historicalTrifectaExperimentDecision(env.DB,Date.now(),oddsContext),
  };
  const decisions=await runScheduledDecisionPasses(decisionWork,()=>waitForNextPaperT60Target({
    now:()=>Date.now(),
    findTarget:(afterMs,throughMs)=>findUpcomingPaperT60Target(env.DB,afterMs,throughMs),
    refresh:async()=>{await first(env.DB,'SELECT 1 AS fresh_t60_clock');},
  }),line=>console.info(line));
  const archiveObservations=[decisions.current.historical,decisions.upcoming?.historical]
    .filter((stage:any)=>stage?.status==='success').flatMap((stage:any)=>stage.value?.archiveObservations??[]);
  if(env.ENABLE_HISTORICAL_TRIFECTA_ARCHIVE==='true'&&env.TRIFECTA_ARCHIVE&&archiveObservations.length){
    // The R2 write is deliberately registered only after the T-60 decision
    // path has completed, so storage latency cannot delay or change purchases.
    ctx?.waitUntil(persistHistoricalObservations(env.TRIFECTA_ARCHIVE,env.DB,archiveObservations)
      .then(result=>console.info(JSON.stringify({event:'historical-trifecta-r2-archive',...result})))
      .catch(()=>console.info(JSON.stringify({event:'historical-trifecta-r2-archive',failed:archiveObservations.length,reason:'archive_task_failed'}))));
  }else if(env.ENABLE_HISTORICAL_TRIFECTA_ARCHIVE==='true'&&archiveObservations.length){
    console.info(JSON.stringify({event:'historical-trifecta-r2-archive',failed:archiveObservations.length,reason:'archive_binding_unavailable'}));
  }
  const paperBoundary = Math.floor(event.scheduledTime / 60_000) % 10 === 0;
  // Recover open-purchase outcomes every ten minutes before settlement. The
  // collector prioritizes open normal/experimental/historical tickets and is
  // bounded by its request and write budgets; paper decisions already ran.
  if (env.ENABLE_BOATRACE_RESULTS_SCRAPE === 'true' && paperBoundary) {
    let collection: any = { status:'failed', reason:'ten-minute-pass-failed' };
    let settlement: number | null = null;
    try {
      let archiveTargets={raceIds:[] as string[],scanned:0,truncated:false,fromDate:'',throughDate:''};
      if(env.ENABLE_HISTORICAL_TRIFECTA_ARCHIVE==='true'&&env.TRIFECTA_ARCHIVE){
        try{archiveTargets=await listHistoricalLabelTargetRaceIds(env.TRIFECTA_ARCHIVE,new Date());}catch{archiveTargets={...archiveTargets,raceIds:[]};}
      }
      collection=await collectResults(env.DB,new Date(),{requestBudget,archiveRaceIds:archiveTargets.raceIds});
    } catch (error) {
      // Keep the failure diagnosable without exposing arbitrary D1/upstream text.
      const bindLimit=error instanceof Error&&/too many (?:sql )?variables/i.test(error.message);
      const errorClass=error instanceof Error&&/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)?error.name:'Error';
      collection={status:'failed',reason:bindLimit?'d1-bind-parameter-limit':'results-collection-failed'};
      console.info(JSON.stringify({event:'boat-ten-minute-results-collection',status:'failed',reason:collection.reason,errorClass}));
    }
    try { settlement=(await cron(env.DB,false)).settled; } catch { /* Retry settlement and maintenance next scheduled tick. */ }
    console.info(JSON.stringify({event:'boat-ten-minute-results',status:collection.status,targets:collection.targets,verified:collection.verified,records:collection.records,attempted:collection.attempted,settled:settlement,reason:collection.reason??null,fetchFailures:collection.fetchFailures??[]}));
    return;
  }
  if (paperBoundary) {
    // The minute-level paper decision already ran above. Keep settlement and
    // maintenance on their existing ten-minute cadence without a second buy pass.
    await cron(env.DB, false);
  }
  if (env.ENABLE_BOATRACE_ODDS_SCRAPE === 'true' || env.ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE === 'true') {
    // A collection quota/write failure must not block ten-minute settlement.
    // Capture one compact immutable evidence bundle before bulk 120-row odds
    // snapshots consume the shared optional write/fetch capacity.
    if (env.ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE === 'true') {
      try {
        const archive=await collectBoatraceCaptureArchives(env.DB,new Date(),{requestBudget});
        console.info(JSON.stringify({event:'boatrace-prerace-capture-archive',...archive}));
      } catch {
        console.info(JSON.stringify({event:'boatrace-prerace-capture-archive',status:'failed',reason:'collector_failed'}));
      }
    }
    // Without an approved active trifecta model, the immutable archive is the
    // training source. Avoid spending 120 indexed odds rows per capture for an
    // unavailable live purchase path; win odds retain their existing behavior.
    const liveTrifecta=env.ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE==='true'
      && !!await first<{id:string}>(env.DB,"SELECT id FROM models WHERE sport='boat' AND bet_type='trifecta' AND status='active' LIMIT 1");
    await collectScheduledOdds(env.DB, env.ENABLE_BOATRACE_ODDS_SCRAPE==='true',liveTrifecta,requestBudget,[...oddsContext.cache.keys()]).catch(() => undefined);
  }
  return;
} };
export { app, cron, settleOpen, autoBet, autoBetWithReport, primaryPaperTiming, recordPaperAbstention, experimentalPaperDecision, runScheduledDecisionStages, runScheduledDecisionPasses, waitForNextPaperT60Target, findUpcomingPaperT60Target };
