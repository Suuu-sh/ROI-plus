import { collectionIssues } from './services/collectionIssues.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { all, first, run, type Db, type Statement } from './repo/db.js';
import { candidate, betId, payoutYen, settleValues, validateYenStake } from './services/logic.js';
import { collectOdds } from './services/collectBoatraceOdds.js';
import { collectTrifectaOdds } from './services/collectBoatraceTrifectaOdds.js';
import { canonicalTicketSelection, isCompleteTicketDistribution } from '@edgelab/shared';
import { estimateIngestWriteUnits, estimateWorkerWriteUnits, readWriteBudget, reserveWriteBudget, reserveWriteBudgets, seedUnknownWriteBudget, utcDate, type IngestTable, type WriteCategory } from './services/writeBudget.js';
import type { Sport, DataOrigin, BetType, TicketCandidate } from '@edgelab/shared';

interface Env { DB: Db; INGEST_TOKEN?: string; ENABLE_AUTO_BET?: string; ENABLE_BOATRACE_ODDS_SCRAPE?: string; ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE?: string; PROXY_TOKEN?: string; }
type Ctx = { Bindings: Env };
const SAFE_BOAT_SCHEMA = 'boat-venue-v2';
const TICKET_MODEL_SCHEMA = 'ticket-selection-v1';
const TICKET_PROBABILITY_SEMANTICS = 'exact-selection-probability-v1';
const app = new Hono<Ctx>().basePath('/api');
app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','OPTIONS'], allowHeaders: ['Content-Type','Authorization'] }));
// 本番では閲覧系 API を、Cloudflare Access で保護された画面 Worker（Service Binding）経由に限定する。
// PROXY_TOKEN 未設定（ローカル開発・テスト）では制限しない。ingest は従来どおり INGEST_TOKEN で認証。
app.use('*', async (c, next) => {
  const proxy = c.env.PROXY_TOKEN;
  const path = new URL(c.req.url).pathname;
  if (!proxy || path === '/api/health' || path.startsWith('/api/ingest/') || path === '/api/admin/settle') return next();
  if (c.req.header('X-ROI-Proxy') !== proxy) return c.json({ error: 'forbidden' }, 403);
  return next();
});
// Cache only authenticated, read-only dashboard data. Keep URLs (including the
// complete query string) as keys; mutable ledgers and purchase-sensitive views
// intentionally bypass this cache. Cache API failures must never fail a read.
const READ_CACHE_TTL_SECONDS = 10;
function cacheableReadPath(path: string): boolean {
  return path === '/api/races' || path === '/api/rankings' || path === '/api/models'
    || path === '/api/collection/status' || /^\/api\/races\/[^/]+$/.test(path);
}
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' || !c.env.PROXY_TOKEN || !cacheableReadPath(new URL(c.req.url).pathname)) return next();
  const keyUrl = new URL(c.req.url);
  keyUrl.pathname = `/__roi_read_cache_v1${keyUrl.pathname}`;
  const key = new Request(keyUrl.toString(), { method: 'GET' });
  let cache: Cache | undefined;
  let cached: Response | undefined;
  try {
    cache = (globalThis.caches as CacheStorage & { default?: Cache } | undefined)?.default;
    cached = await cache?.match(key);
  } catch { /* Cache is an optimization only. */ }
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
  }

  // Do not wrap next() in a cache-error handler: application failures must
  // propagate normally and must never cause the route to be executed twice.
  await next();
  const responseHeaders = new Headers(c.res.headers);
  responseHeaders.set('Cache-Control', 'private, no-store');
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: responseHeaders });
  if (c.res.status !== 200 || !c.res.headers.get('content-type')?.includes('application/json')) return;
  const storeHeaders = new Headers(c.res.headers);
  storeHeaders.set('Cache-Control', `public, max-age=${READ_CACHE_TTL_SECONDS}`);
  try {
    await cache?.put(key, new Response(c.res.clone().body, { status: c.res.status, statusText: c.res.statusText, headers: storeHeaders }));
  } catch { /* Ignore cache write errors; return the fresh D1 response. */ }
});
// Persist timestamps with a consistent JST offset; selection queries use
// julianday() so comparisons remain correct when imported ISO offsets differ.
const now = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
const ODDS_MAX_AGE_MS = 10 * 60 * 1000;
const oddsFreshAfter = () => new Date(Date.now() - ODDS_MAX_AGE_MS + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
const reserveWorkerWrites = (db: Db, rows: number) => reserveWriteBudget(db, utcDate(), estimateWorkerWriteUnits(rows), 'essential');
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
function parseList(body: unknown): Record<string, unknown>[] | null {
  const rows = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as any).items) ? (body as any).items : null;
  return rows && rows.every((x: unknown) => x && typeof x === 'object' && !Array.isArray(x)) ? rows as Record<string, unknown>[] : null;
}
const jstRaceDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
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
  models:{table:'models',required:['id','sport','bet_type','version','algorithm','status'],conflict:'id'},
  'collection-runs':{table:'collection_runs',required:['id','source','sport','target_date','started_at','status'],conflict:'id'},
};
const allowedColumns: Record<string,string[]> = {
  venues:'id sport name'.split(' '),
  races:'id sport venue_id race_date race_no name distance surface track_condition weather wind_speed wave_height post_time status data_origin updated_at'.split(' '),
  entries:'id race_id number frame name jockey trainer weight_carried horse_weight racer_class national_win_rate local_win_rate motor_no motor_2rate boat_no boat_2rate exhibition_time start_exhibition features_json available_at data_origin'.split(' '),
  odds_snapshots:'id race_id bet_type selection odds captured_at source data_origin source_url source_sha256 quality_status'.split(' '),
  results:'race_id finish_order number data_origin'.split(' '),
  payouts:'race_id bet_type selection payout popularity data_origin'.split(' '),
  predictions:'id race_id model_id number probability prob_std predicted_at data_origin'.split(' '),
  ticket_predictions:'id race_id model_id bet_type selection probability prob_std predicted_at data_origin feature_schema_version artifact_sha256'.split(' '),
  models:'id sport bet_type version algorithm status train_from train_to valid_from valid_to test_from test_to n_train metrics_json trained_at notes'.split(' '),
  collection_runs:'id source sport target_date started_at finished_at status records error reason'.split(' '),
};
const updateColumns: Record<string,string[]> = {
  venues:['sport','name'],
  races:'sport venue_id race_date race_no name distance surface track_condition weather wind_speed wave_height post_time status data_origin updated_at'.split(' '),
  entries:'frame name jockey trainer weight_carried horse_weight racer_class national_win_rate local_win_rate motor_no motor_2rate boat_no boat_2rate exhibition_time start_exhibition features_json available_at data_origin'.split(' '),
  odds_snapshots:'odds source data_origin source_url source_sha256 quality_status'.split(' '), results:['finish_order','data_origin'], predictions:'probability prob_std data_origin'.split(' '),
  ticket_predictions:'probability prob_std data_origin feature_schema_version artifact_sha256'.split(' '),
  payouts:'payout popularity data_origin'.split(' '),
  models:'sport bet_type version algorithm status train_from train_to valid_from valid_to test_from test_to n_train metrics_json trained_at notes'.split(' '),
  collection_runs:'source sport target_date started_at finished_at status records error reason'.split(' '),
};
async function ingest(c: any, name: string) {
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  const config = ingestTables[name], rows = parseList(await c.req.json().catch(()=>null));
  if (!config || !rows || rows.length > 500 || rows.some(r => config.required.some(k => r[k] === undefined))) return jsonError(c, 'invalid payload (maximum 500 rows)');
  if ((name === 'venues' && rows.length > 50) || (name === 'models' && rows.length > 20)) return jsonError(c, 'small reference/model batches only');
  const table = config.table, allowed = allowedColumns[table], updates = updateColumns[table];
  const db: Db = c.env.DB, statements: Statement[] = [];
  if (['entries','odds_snapshots','results','payouts','predictions','ticket_predictions'].includes(table)) {
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
      raceDate = typeof existing?.race_date === 'string' ? existing.race_date : typeof row.race_date === 'string' ? row.race_date : null;
    } else if (['entries','odds_snapshots','results','payouts','predictions','ticket_predictions'].includes(table)) {
      raceId = typeof row.race_id === 'string' ? row.race_id : null;
      const race = raceId ? await first<any>(db, 'SELECT race_date,data_origin FROM races WHERE id=?', raceId) : null;
      raceDate = typeof race?.race_date === 'string' ? race.race_date : null;
      if (!raceDate) return jsonError(c, 'ingest race must already exist', 409);
      if (row.data_origin !== race.data_origin) return jsonError(c, 'ingest data origin must match the persisted race', 409);
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
    if (openBet) category = 'essential';
    else if (currentRaceData && ['races','entries','results','payouts'].includes(table)) category = 'essential';
    else if (currentRaceData && ['predictions','ticket_predictions'].includes(table)) {
      const modelId = row.model_id;
      const model = typeof modelId === 'string' ? await first<any>(db, 'SELECT status FROM models WHERE id=?', modelId) : null;
      if (model?.status === 'active') category = 'essential';
    }
    rowCategory.set(row, category);
  }
  const changedByCategory: Record<'essential' | 'optional', Partial<Record<IngestTable, number>>> = { essential: {}, optional: {} };
  const sideEffectsByCategory: Record<'essential' | 'optional', number> = { essential: 0, optional: 0 };
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
      const category = rowCategory.get(row) === 'essential' ? 'essential' : 'optional';
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
    Object.values(changedByCategory.optional).reduce((sum, count) => sum + (count ?? 0), 0) + sideEffectsByCategory.essential + sideEffectsByCategory.optional);
  const reservations = (['essential','optional'] as const).flatMap(category => {
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
  const bets = await all<any>(db, `SELECT b.*, r.status AS race_status, r.data_origin AS race_origin FROM bets b JOIN races r ON r.id=b.race_id WHERE b.status='open' AND r.status IN ('finished','cancelled') AND b.data_origin=r.data_origin AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id) AND ${nonQuarantinedBet()}`);
  let settled = 0;
  for (const b of bets) {
    if (b.race_status === 'cancelled') {
      if (!await reserveWorkerWrites(db, 1)) break;
      const result = await run(db, `UPDATE bets SET status='void',payout=0,profit=0,settled_at=? WHERE id=? AND status='open'`, now(), b.id);
      settled += Number(result.meta?.changes ?? 0); continue;
    }
    const integrity = await first<any>(db, `SELECT
      (SELECT COUNT(*) FROM entries e WHERE e.race_id=? AND e.data_origin=?) entry_count,
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
        SELECT 1 FROM results res WHERE res.race_id=p.race_id AND res.data_origin=p.data_origin AND res.finish_order=1 AND p.selection=CAST(res.number AS TEXT))) nonwinner_win_payout_count`,
      b.race_id,b.data_origin,b.race_id,b.data_origin,b.race_id,b.data_origin,b.race_id,b.data_origin,
      b.race_id,b.data_origin,b.race_id,b.data_origin,b.race_id,b.data_origin,b.bet_type,b.race_id,b.data_origin);
    if (!integrity || integrity.entry_count <= 0
        || integrity.result_count !== integrity.entry_count
        || integrity.distinct_result_count !== integrity.entry_count
        || integrity.matched_result_count !== integrity.entry_count
        || integrity.winner_count <= 0
        || (b.bet_type === 'win' && integrity.nonwinner_win_payout_count > 0)
        || (b.bet_type === 'win' ? integrity.paid_winner_count !== integrity.winner_count : integrity.ticket_payout_count <= 0)) continue;
    if (b.bet_type === 'trifecta') {
      const fullOrder = await all<any>(db, 'SELECT number,finish_order FROM results WHERE race_id=? AND data_origin=? ORDER BY finish_order,number', b.race_id, b.data_origin);
      if (integrity.entry_count !== 6 || integrity.winner_count !== 1 || fullOrder.length !== 6
          || fullOrder.some((x: any, i: number) => x.finish_order !== i + 1)) continue;
      const winningSelection = fullOrder.slice(0,3).map((x: any) => String(x.number)).join('-');
      const trifectaPayouts = await all<any>(db, "SELECT selection,payout FROM payouts WHERE race_id=? AND data_origin=? AND bet_type='trifecta' AND payout>0", b.race_id, b.data_origin);
      if (trifectaPayouts.length !== 1 || trifectaPayouts[0].selection !== winningSelection) continue;
    } else if (b.bet_type !== 'win') {
      // Other ticket settlement semantics require their own exact outcome
      // contract; leave historical/manual rows open rather than guessing.
      continue;
    }
    const pay = await first<any>(db, 'SELECT payout FROM payouts WHERE race_id=? AND data_origin=? AND bet_type=? AND selection=? AND payout>0', b.race_id, b.data_origin, b.bet_type, b.selection);
    const values = settleValues(b.stake, pay?.payout ?? null, !!pay);
    const evLost = b.expected_roi > 0 && values.finalOdds !== null && b.predicted_prob * values.finalOdds - 1 <= 0;
    if (!await reserveWorkerWrites(db, evLost ? 2 : 1)) break;
    const result = await run(db, `UPDATE bets SET status=?,payout=?,profit=?,final_odds=?,settled_at=? WHERE id=? AND status='open'`, pay ? 'won' : 'lost', values.payout, values.profit, values.finalOdds, now(), b.id);
    if (Number(result.meta?.changes ?? 0) > 0) {
      if (evLost) await run(db, `UPDATE bets SET ev_lost=1 WHERE id=? AND ev_lost<>1`, b.id);
      settled++;
    }
  }
  return settled;
}
async function autoBet(db: Db, enabled: boolean) {
  if (!enabled) return 0;
  if ((await setting(db, 'auto_bet_paused', 'false')) === 'true') return 0;
  const cfg = Number(await setting(db, 'unit_stake', '100')), minRoi = Number(await setting(db, 'min_expected_roi', '0.05')), maxStd = Number(await setting(db, 'max_prob_std', '0.05'));
  const maxPicks = Math.min(6, Math.max(1, Math.floor(Number(await setting(db, 'auto_bet_max_picks', '1')) || 1)));
  const raceBudget=Number(await setting(db,'auto_bet_race_budget',String(cfg)));
  if (!Number.isSafeInteger(cfg) || cfg <= 0 || !Number.isSafeInteger(raceBudget) || raceBudget <= 0 || raceBudget > 2_147_483_647) return 0;
  const candidates = await all<any>(db, `SELECT r.id race_id,r.sport,r.data_origin,e.number, p.probability,p.prob_std,p.model_id,p.predicted_at,m.status model_status,
    (SELECT o.odds FROM odds_snapshots o WHERE o.race_id=r.id AND o.data_origin=r.data_origin AND o.bet_type='win' AND o.selection=CAST(e.number AS TEXT) AND julianday(o.captured_at)<=julianday(?) AND julianday(o.captured_at)>=julianday(?) AND julianday(o.captured_at)<=julianday(r.post_time) ORDER BY julianday(o.captured_at) DESC LIMIT 1) odds,
    (SELECT o.captured_at FROM odds_snapshots o WHERE o.race_id=r.id AND o.data_origin=r.data_origin AND o.bet_type='win' AND o.selection=CAST(e.number AS TEXT) AND julianday(o.captured_at)<=julianday(?) AND julianday(o.captured_at)>=julianday(?) AND julianday(o.captured_at)<=julianday(r.post_time) ORDER BY julianday(o.captured_at) DESC LIMIT 1) odds_captured_at
    FROM races r JOIN entries e ON e.race_id=r.id JOIN predictions p ON p.race_id=r.id AND p.number=e.number
    JOIN models m ON m.id=p.model_id AND m.status='active' AND m.sport=r.sport AND m.bet_type='win'
      AND (r.sport<>'boat' OR CASE WHEN json_valid(m.metrics_json) THEN (json_type(m.metrics_json,'$.boatArtifactSha256')='text' AND json_extract(m.metrics_json,'$.boatVenueSchemaVersion')='boat-venue-v2' AND length(json_extract(m.metrics_json,'$.correctedTrainingDataSha256'))=64 AND json_extract(m.metrics_json,'$.correctedTrainingDataSha256') NOT GLOB '*[^a-f0-9]*' AND length(json_extract(m.metrics_json,'$.boatArtifactSha256'))=64 AND json_extract(m.metrics_json,'$.boatArtifactSha256') NOT GLOB '*[^a-f0-9]*') ELSE 0 END)
    WHERE r.status='scheduled' AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id) AND e.data_origin=r.data_origin AND p.data_origin=r.data_origin AND p.predicted_at=(SELECT p2.predicted_at FROM predictions p2 WHERE p2.race_id=r.id AND p2.model_id=m.id AND p2.number=e.number AND p2.data_origin=r.data_origin ORDER BY julianday(p2.predicted_at) DESC LIMIT 1)
    AND r.post_time IS NOT NULL AND julianday(r.post_time)>julianday(?)
    AND julianday(p.predicted_at)<=julianday(?) AND julianday(p.predicted_at)<=julianday(r.post_time)
    AND NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.mode='auto')`, now(), oddsFreshAfter(), now(), oddsFreshAfter(), now(), now());
  const grouped = new Map<string, any[]>();
  for (const row of candidates) { const list=grouped.get(row.race_id)??[]; list.push(row); grouped.set(row.race_id,list); }
  const ticketRaces=await all<any>(db,`SELECT r.*,v.name venue_name FROM races r JOIN venues v ON v.id=r.venue_id WHERE r.sport='boat' AND r.data_origin='real' AND r.status='scheduled' AND julianday(r.post_time)>julianday(?) AND NOT EXISTS(SELECT 1 FROM bets b WHERE b.race_id=r.id AND b.mode='auto') AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)`,now());
  for(const race of ticketRaces){for(const t of await ticketCandidatesForRace(db,race,maxStd)){if(!t.buyEligible||t.expectedRoi<minRoi)continue;const list=grouped.get(race.id)??[];list.push({race_id:race.id,sport:race.sport,data_origin:race.data_origin,bet_type:t.betType,selection:t.selection,probability:t.probability,prob_std:t.probStd,model_id:t.modelId,model_status:'active',odds:t.odds,odds_captured_at:t.oddsCapturedAt});grouped.set(race.id,list);}}
  let n=0;
  for (const rows of grouped.values()) {
    const bestTicket=rows.filter(row=>row.bet_type==='trifecta').sort((a,b)=>(candidate(b.probability,b.odds,b.prob_std,'active',maxStd).conservativeRoi??-Infinity)-(candidate(a.probability,a.odds,a.prob_std,'active',maxStd).conservativeRoi??-Infinity))[0];
    const bestWinConservative=Math.max(-Infinity,...rows.filter(row=>!row.bet_type).map(row=>candidate(row.probability,row.odds,row.prob_std,row.model_status,maxStd).conservativeRoi??-Infinity));
    const ticketWins=bestTicket&&(candidate(bestTicket.probability,bestTicket.odds,bestTicket.prob_std,'active',maxStd).conservativeRoi??-Infinity)>bestWinConservative;
    const ranked=(ticketWins?[bestTicket]:rows.filter(row=>!row.bet_type)).map(row=>({...row, edgeData:candidate(row.probability,row.odds,row.prob_std,row.model_status,maxStd)}))
      .filter(row=>row.odds!==null && row.odds!==undefined && row.edgeData.expectedRoi!==null)
      .sort((a,b)=>b.edgeData.expectedRoi-a.edgeData.expectedRoi || Number(a.number)-Number(b.number));
    const selected=ranked.map((row,index)=>({...row,candidateRank:index+1,candidateCount:ranked.length}))
      .filter(row=>row.edgeData.expectedRoi>=minRoi && ['HIGH_EDGE','POSITIVE_EDGE'].includes(row.edgeData.edge)).slice(0,Math.min(maxPicks,6,raceBudget));
    if (!selected.length) continue;
    const groupId=betId(), placedAt=now(), totalStake=raceBudget,baseStake=Math.floor(raceBudget/selected.length),remainder=raceBudget%selected.length;
    const payload=selected.map((row,index)=>({id:betId(),race_id:row.race_id,sport:row.sport,bet_type:row.bet_type??'win',selection:row.selection??String(row.number),stake:baseStake+(index<remainder?1:0),
      predicted_prob:row.probability,odds_at_bet:row.odds,expected_roi:row.edgeData.expectedRoi,edge_label:row.edgeData.edge,
      model_id:row.model_id,placed_at:placedAt,data_origin:row.data_origin,candidate_rank:row.candidateRank,
      candidate_count:row.candidateCount,odds_captured_at:row.odds_captured_at,predicted_at_at_bet:row.predicted_at}));
    if (!await reserveWorkerWrites(db, payload.length * 2)) break;
    const inserted=await run(db,`INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,predicted_prob,odds_at_bet,expected_roi,edge_label,model_id,placed_at,status,data_origin,bet_group_id,candidate_rank,candidate_count,odds_captured_at,predicted_at_at_bet)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.race_id'),json_extract(value,'$.sport'),json_extract(value,'$.bet_type'),json_extract(value,'$.selection'),json_extract(value,'$.stake'),'auto',json_extract(value,'$.predicted_prob'),json_extract(value,'$.odds_at_bet'),json_extract(value,'$.expected_roi'),json_extract(value,'$.edge_label'),json_extract(value,'$.model_id'),json_extract(value,'$.placed_at'),'open',json_extract(value,'$.data_origin'),?,json_extract(value,'$.candidate_rank'),json_extract(value,'$.candidate_count'),json_extract(value,'$.odds_captured_at'),json_extract(value,'$.predicted_at_at_bet')
      FROM json_each(?) WHERE ${availableBankrollSql}>=? AND NOT EXISTS(SELECT 1 FROM bets WHERE race_id=? AND mode='auto')
      ON CONFLICT(race_id,bet_type,selection) WHERE mode='auto' DO NOTHING`,groupId,JSON.stringify(payload),totalStake,rows[0].race_id);
    n+=Number(inserted.meta?.changes??0);
  }
  return n;
}
async function collectScheduledOdds(db: Db, oddsEnabled: boolean, trifectaOddsEnabled: boolean) {
  const requestBudget={used:0,max:49};
  if (trifectaOddsEnabled) {
    // Reserve a small bounded slice for the opt-in parser before legacy win
    // collection; both collectors share the existing per-run 49-fetch cap.
    requestBudget.max=20;
    await collectTrifectaOdds(db,new Date(),{maxRequests:10,requestBudget});
  }
  requestBudget.max=49;
  if (oddsEnabled) await collectOdds(db, new Date(),{requestBudget});
}
async function cron(db: Db, autoEnabled: boolean, oddsEnabled = false, trifectaOddsEnabled = false) {
  await collectScheduledOdds(db, oddsEnabled, trifectaOddsEnabled);
  const settled=await settleOpen(db), bought=await autoBet(db,autoEnabled);
  const cutoff=new Date(Date.now()-30*86400000).toISOString();
  const oldRows=await first<any>(db, `SELECT COUNT(*) count FROM odds_snapshots WHERE captured_at<? AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.race_id=odds_snapshots.race_id AND b.selection=odds_snapshots.selection AND b.odds_at_bet=odds_snapshots.odds AND b.placed_at>=odds_snapshots.captured_at)`, cutoff);
  const cleanupCount=Math.min(10,Number(oldRows?.count??0));
  if(cleanupCount>0&&await reserveOptionalWorkerWrites(db,cleanupCount)) await run(db, `DELETE FROM odds_snapshots WHERE rowid IN (SELECT rowid FROM odds_snapshots WHERE captured_at<? AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.race_id=odds_snapshots.race_id AND b.selection=odds_snapshots.selection AND b.odds_at_bet=odds_snapshots.odds AND b.placed_at>=odds_snapshots.captured_at) LIMIT 10)`, cutoff).catch(()=>{});
  return {settled,bought};
}
app.get('/health', async c=>c.json({ok:true,service:'edgelab-api',d1WriteBudget:await readWriteBudget(c.env.DB)}));
app.get('/ingest/write-budget', async c=>{
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  return c.json(await readWriteBudget(c.env.DB));
});
app.post('/ingest/write-budget/seed', async c=>{
  if (!auth(c)) return jsonError(c, 'unauthorized', 401);
  const body = await c.req.json().catch(()=>null) as any;
  if (!body || body.date !== utcDate() || body.confirmed !== true) return jsonError(c, 'explicit current-UTC-day budget seed confirmation is required');
  const inserted = await seedUnknownWriteBudget(c.env.DB, body.date);
  if (!inserted) return c.json({ error:'budget seed already exists or could not be written', code:'d1_write_budget_seed_conflict', budget:await readWriteBudget(c.env.DB) }, 409);
  return c.json(await readWriteBudget(c.env.DB), 201);
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
   if(typeof body.raceId!=='string'||typeof body.selection!=='string'||!validateYenStake(body.stake))return jsonError(c,'invalid request');
   const race=await first<any>(db,'SELECT * FROM races WHERE id=? AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=races.id)',body.raceId);
   if(!race)return jsonError(c,'race not found',404);
   if(race.status!=='scheduled'||!race.post_time||Date.parse(race.post_time)<=Date.now())return jsonError(c,'race is not scheduled');
   const venue=await first<any>(db,'SELECT name venue_name FROM venues WHERE id=?',race.venue_id);
   const maxStd=Number(await setting(db,'max_prob_std','0.05'));
   const ticket=(await ticketCandidatesForRace(db,{...race,venue_name:venue?.venue_name},maxStd)).find(x=>x.selection===body.selection);
   if(!ticket?.buyEligible)return jsonError(c,'ticket model or audited fresh odds are unavailable');
   const bet={id:betId(),race_id:race.id,sport:race.sport,bet_type:'trifecta',selection:ticket.selection,stake:body.stake,mode:'manual',predicted_prob:ticket.probability,odds_at_bet:ticket.odds,expected_roi:ticket.expectedRoi,edge_label:ticket.edge,model_id:ticket.modelId,placed_at:now(),status:'open',data_origin:'real',odds_captured_at:ticket.oddsCapturedAt};
   if(!await reserveWorkerWrites(db,1))return c.json({error:'daily D1 write budget unavailable or exhausted',budget:await readWriteBudget(db)},429);
   const inserted=await run(db,`INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,predicted_prob,odds_at_bet,expected_roi,edge_label,model_id,placed_at,status,data_origin,odds_captured_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${availableBankrollSql} >= ?`,...Object.values(bet),body.stake);
   if(!inserted.meta?.changes)return jsonError(c,'insufficient bankroll');
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
   if(existing.length!==requested.length||existing.some((b:any,i:number)=>b.race_id!==body.raceId||b.mode!=='manual'||b.selection!==requested[i].selection||b.stake!==requested[i].stake))return jsonError(c,'requestId was already used for a different bet group',409);
   return c.json({groupId,bets:existing.map(mapBet)});
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
 const placedAt=now(), payload=picks.map(row=>({id:betId(),race_id:race.id,sport:race.sport,selection:row.selection,stake:row.stake,
   predicted_prob:row.probability,odds_at_bet:row.odds,expected_roi:row.rankData.expectedRoi,edge_label:row.rankData.edge,model_id:row.model_id,
   placed_at:placedAt,data_origin:race.data_origin,candidate_rank:row.candidateRank,candidate_count:row.candidateCount,
   odds_captured_at:row.odds_captured_at,predicted_at_at_bet:row.predicted_at}));
 if(!await reserveWorkerWrites(db,payload.length*2)){
   const repeated=await all<any>(db,'SELECT * FROM bets WHERE bet_group_id=? ORDER BY selection',groupId);
   const requested=[...selections].sort((a:any,b:any)=>a.selection.localeCompare(b.selection));
   if(repeated.length){
     if(repeated.length===requested.length&&repeated.every((b:any,i:number)=>b.race_id===body.raceId&&b.mode==='manual'&&b.selection===requested[i].selection&&b.stake===requested[i].stake))return c.json({groupId,bets:repeated.map(mapBet)});
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
   if(repeated.length===requested.length&&repeated.every((b:any,i:number)=>b.race_id===body.raceId&&b.mode==='manual'&&b.selection===requested[i].selection&&b.stake===requested[i].stake))return c.json({groupId,bets:repeated.map(mapBet)});
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
async function ticketCandidatesForRace(db: Db, race: any, maxStd: number): Promise<TicketCandidate[]> {
  // Initial support is exact-order trifecta only. Other ticket types stay absent
  // until a compatible model and audited odds source are registered.
  if (await first<any>(db,'SELECT race_id FROM data_repair_quarantined_races WHERE race_id=?',race.id)) return [];
  if (race.sport !== 'boat' || race.data_origin !== 'real' || race.status !== 'scheduled'
      || !race.post_time || Date.parse(race.post_time) <= Date.now()) return [];
  const runners = await all<any>(db, 'SELECT number FROM entries WHERE race_id=? AND data_origin=? ORDER BY number', race.id, race.data_origin);
  const numbers = runners.map((x: any) => Number(x.number));
  if (numbers.length !== 6 || new Set(numbers).size !== 6 || numbers.some((n: number) => !Number.isInteger(n) || n < 1 || n > 6)) return [];
  const models = await all<any>(db, "SELECT * FROM models WHERE sport='boat' AND bet_type='trifecta' AND status='active'");
  const output: TicketCandidate[] = [];
  for (const model of models) {
    if (!validatedTicketModel(model, 'trifecta')) continue;
    const latest = await first<any>(db, `SELECT MAX(predicted_at) predicted_at FROM ticket_predictions WHERE race_id=? AND model_id=? AND bet_type='trifecta' AND data_origin='real' AND julianday(predicted_at)<=julianday(?) AND julianday(predicted_at)<=julianday(?)`, race.id, model.id, now(), race.post_time);
    if (!latest?.predicted_at) continue;
    const predictions = await all<any>(db, `SELECT * FROM ticket_predictions WHERE race_id=? AND model_id=? AND bet_type='trifecta' AND data_origin='real' AND predicted_at=?`, race.id, model.id, latest.predicted_at);
    let metrics: any; try { metrics = JSON.parse(model.metrics_json || '{}'); } catch { continue; }
    if (!model.trained_at || !Number.isFinite(Date.parse(model.trained_at)) || Date.parse(model.trained_at) >= Date.parse(latest.predicted_at)) continue;
    if (predictions.some((p: any) => p.feature_schema_version !== TICKET_MODEL_SCHEMA || p.artifact_sha256 !== metrics.ticketArtifactSha256 || p.prob_std === null || p.prob_std === undefined)) continue;
    if (predictions.some((p: any) => p.probability === null || p.probability === undefined || !Number.isFinite(p.probability))) continue;
    if (!isCompleteTicketDistribution('trifecta', numbers, predictions.map((p: any) => p.selection), predictions.map((p: any) => Number(p.probability)))) continue;
    const latestOdds = await first<any>(db, `SELECT captured_at,source_url,source_sha256 FROM odds_snapshots WHERE race_id=? AND data_origin='real' AND bet_type='trifecta' AND source='boatrace-trifecta-official-v1' AND quality_status='verified-complete-v1' AND source_sha256 IS NOT NULL AND julianday(captured_at)>=julianday(?) AND julianday(captured_at)<=julianday(?) AND julianday(captured_at)<=julianday(?) ORDER BY julianday(captured_at) DESC LIMIT 1`, race.id, oddsFreshAfter(), now(), race.post_time);
    if (!latestOdds || !SHA256.test(latestOdds.source_sha256) || !officialTrifectaUrl(latestOdds.source_url, race)) continue;
    const oddsRows = await all<any>(db, `SELECT selection,odds FROM odds_snapshots WHERE race_id=? AND data_origin='real' AND bet_type='trifecta' AND source='boatrace-trifecta-official-v1' AND quality_status='verified-complete-v1' AND captured_at=? AND source_url=? AND source_sha256=?`, race.id, latestOdds.captured_at, latestOdds.source_url, latestOdds.source_sha256);
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
        modelId: model.id, dataFreshnessMinutes: Math.max(0, (Date.now() - Date.parse(latestOdds.captured_at)) / 60000),
        dataOrigin: 'real', buyEligible: score.edge === 'HIGH_EDGE' || score.edge === 'POSITIVE_EDGE' });
    }
  }
  return output;
}
function resultWaitReason(b:any){
 if(b.data_origin==='sample')return 'sampledata';
 if(b.race_status==='cancelled')return 'cancelled';
 if(b.status!=='open')return null;
 if(b.finish_code==='失格'||b.finish_code==='転覆'||b.finish_code==='妨害'||b.finish_code==='落水'||b.finish_code==='エンスト'||b.finish_code==='不完走')return 'disqualified';
 if(b.finish_code==='欠場'||b.finish_code==='欠')return 'withdrawn';
 const postTime=b.post_time?Date.parse(b.post_time):Number.NaN;
 if(Number.isFinite(postTime)&&postTime>Date.now())return 'notstarted';
 if(!Number.isFinite(postTime)&&(b.race_status==='scheduled'||b.race_status==='closed'))return 'unknown';
 if(!b.entry_count||b.result_count!==b.entry_count||b.distinct_result_count!==b.entry_count||b.matched_result_count!==b.entry_count||!b.winner_count){
   return b.result_collection_status==='failed'||b.result_collection_status==='partial'?'collectionfailed':'officialresultmissing';
 }
 if(b.paid_winner_count!==b.winner_count)return 'payoutmissing';
 return 'settlementpending';
}
function mapBet(b:any){return {id:b.id,raceId:b.race_id,sport:b.sport,betType:b.bet_type,selection:b.selection,stake:b.stake,mode:b.mode,predictedProb:b.predicted_prob,oddsAtBet:b.odds_at_bet,expectedRoi:b.expected_roi,edgeLabel:b.edge_label,modelId:b.model_id,placedAt:b.placed_at,status:b.status,payout:b.payout??null,profit:b.profit??null,finalOdds:b.final_odds??null,settledAt:b.settled_at??null,dataOrigin:b.data_origin,groupId:b.bet_group_id??null,candidateRank:b.candidate_rank??null,candidateCount:b.candidate_count??null,oddsCapturedAt:b.odds_captured_at??null,predictedAtAtBet:b.predicted_at_at_bet??null,resultWaitReason:b.race_status==null?undefined:resultWaitReason(b),resultCollectionSource:b.result_collection_source??null,resultCollectionStatus:b.result_collection_status??null,resultCollectionLastAttemptAt:b.result_collection_last_attempt_at??null,resultCollectionLastSuccessAt:b.result_collection_last_success_at??null};}
async function quarantineSummary(db: Db, sport: string | null, origin: string | null) {
 return await first<any>(db, `SELECT COUNT(*) count,COALESCE(SUM(b.stake),0) stake,COALESCE(SUM(b.payout),0) payout,COALESCE(SUM(b.profit),0) profit FROM bets b WHERE EXISTS(SELECT 1 FROM data_repair_audit_marks q WHERE q.record_type='bet' AND q.record_id=b.id) AND (? IS NULL OR b.sport=?) AND (? IS NULL OR b.data_origin=?)`, sport, sport, origin, origin) ?? {count:0,stake:0,payout:0,profit:0};
}
app.get('/bets/quarantine-summary',async c=>{const sport=c.req.query('sport'),origin=originFilter(c.req.query('origin'));if(sport&&!validSport(sport))return jsonError(c,'invalid sport');return c.json(await quarantineSummary(c.env.DB,sport||null,origin));});
app.get('/bets',async c=>{const sport=c.req.query('sport'),status=c.req.query('status'),origin=originFilter(c.req.query('origin'));if(sport&&!validSport(sport))return jsonError(c,'invalid sport');const rows=await all<any>(c.env.DB,`SELECT b.*,v.name venue_name,r.race_no,r.status race_status,r.post_time,r.race_date,
 (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin=r.data_origin) entry_count,
 (SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin=r.data_origin) result_count,
 (SELECT COUNT(DISTINCT x.number) FROM results x WHERE x.race_id=r.id AND x.data_origin=r.data_origin) distinct_result_count,
 (SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin=r.data_origin AND EXISTS(SELECT 1 FROM entries e WHERE e.race_id=x.race_id AND e.number=x.number AND e.data_origin=x.data_origin)) matched_result_count,
 (SELECT COUNT(*) FROM results x WHERE x.race_id=r.id AND x.data_origin=r.data_origin AND x.finish_order=1) winner_count,
 (SELECT COUNT(*) FROM results x JOIN payouts p ON p.race_id=x.race_id AND p.data_origin=x.data_origin AND p.bet_type='win' AND p.selection=CAST(x.number AS TEXT) AND p.payout>0 WHERE x.race_id=r.id AND x.data_origin=r.data_origin AND x.finish_order=1) paid_winner_count,
 (SELECT CASE WHEN json_valid(e.features_json) THEN json_extract(e.features_json,'$.finish_code') END FROM entries e WHERE e.race_id=r.id AND e.data_origin=r.data_origin AND CAST(e.number AS TEXT)=b.selection LIMIT 1) finish_code,
 (SELECT cr.source FROM collection_runs cr WHERE r.data_origin='real' AND r.sport='boat' AND cr.source='mbrace-boat' AND cr.sport=r.sport AND cr.target_date=r.race_date AND julianday(cr.started_at)<=julianday('now') ORDER BY julianday(cr.started_at) DESC,cr.id DESC LIMIT 1) result_collection_source,
 (SELECT cr.status FROM collection_runs cr WHERE r.data_origin='real' AND r.sport='boat' AND cr.source='mbrace-boat' AND cr.sport=r.sport AND cr.target_date=r.race_date AND julianday(cr.started_at)<=julianday('now') ORDER BY julianday(cr.started_at) DESC,cr.id DESC LIMIT 1) result_collection_status,
 (SELECT cr.started_at FROM collection_runs cr WHERE r.data_origin='real' AND r.sport='boat' AND cr.source='mbrace-boat' AND cr.sport=r.sport AND cr.target_date=r.race_date AND julianday(cr.started_at)<=julianday('now') ORDER BY julianday(cr.started_at) DESC,cr.id DESC LIMIT 1) result_collection_last_attempt_at,
 (SELECT COALESCE(cr.finished_at,cr.started_at) FROM collection_runs cr WHERE r.data_origin='real' AND r.sport='boat' AND cr.source='mbrace-boat' AND cr.sport=r.sport AND cr.target_date=r.race_date AND cr.status='success' AND julianday(COALESCE(cr.finished_at,cr.started_at))<=julianday('now') ORDER BY julianday(cr.started_at) DESC,cr.id DESC LIMIT 1) result_collection_last_success_at
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
app.get('/performance/overview',async c=>{const sport=c.req.query('sport'),origin=originFilter(c.req.query('origin'));if(sport&&!validSport(sport))return jsonError(c,'invalid sport');const db=c.env.DB, initial=Number(await setting(db,'initial_bankroll','100000')), bets=await all<any>(db,`SELECT * FROM bets b WHERE (? IS NULL OR b.sport=?) AND (? IS NULL OR b.data_origin=?) AND ${nonQuarantinedBet()} ORDER BY b.placed_at,b.id`,sport||null,sport||null,origin,origin);let bankroll=initial;const equity=[{at:bets[0]?.placed_at??now(),bankroll}];let settled=0,hits=0,stake=0,payout=0;for(const b of bets){if(b.status==='won'||b.status==='lost'||b.status==='void'){bankroll+=b.profit??0;settled++;stake+=b.stake;payout+=b.payout??0;if(b.status==='won')hits++;equity.push({at:b.settled_at??b.placed_at,bankroll});}}let peak=initial,dd=0,ddPct=0;for(const e of equity){peak=Math.max(peak,e.bankroll);dd=Math.max(dd,peak-e.bankroll);if(peak>0)ddPct=Math.max(ddPct,(peak-e.bankroll)/peak);}return c.json({initialBankroll:initial,bankroll,totalProfit:bankroll-initial,roi:stake?payout/stake:null,betCount:bets.length,settledCount:settled,hitRate:settled?hits/settled:null,maxDrawdown:dd,maxDrawdownPct:ddPct,equityCurve:equity,quarantined:await quarantineSummary(db,sport||null,origin)});});
app.get('/performance/breakdown',async c=>{const db=c.env.DB,origin=originFilter(c.req.query('origin'));
 const O=`(? IS NULL OR b.data_origin=?) AND ${nonQuarantinedBet('b')}`;
 const bySport=await all<any>(db,`SELECT sport,COUNT(*) bets,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,SUM(COALESCE(profit,0)) profit,CASE WHEN SUM(stake)>0 THEN 1.0*SUM(COALESCE(payout,0))/SUM(stake) END roi,CASE WHEN SUM(CASE WHEN status IN ('won','lost') THEN 1 ELSE 0 END)>0 THEN 1.0*SUM(CASE WHEN status='won' THEN 1 ELSE 0 END)/SUM(CASE WHEN status IN ('won','lost') THEN 1 ELSE 0 END) END hitRate FROM bets b WHERE ${O} GROUP BY sport`,origin,origin);
 const byMonth=await all<any>(db,`SELECT substr(placed_at,1,7) month,sport,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,SUM(COALESCE(profit,0)) profit FROM bets b WHERE ${O} GROUP BY month,sport ORDER BY month`,origin,origin);
 const byEdge=await all<any>(db,`SELECT CASE
   WHEN expected_roi IS NULL THEN '不明'
   WHEN expected_roi >= 0.20 THEN '20%以上'
   WHEN expected_roi >= 0.05 THEN '5〜20%'
   WHEN expected_roi >= 0 THEN '0〜5%'
   ELSE '< 0%'
  END bucket,COUNT(*) bets,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,CASE WHEN SUM(stake)>0 THEN 1.0*SUM(COALESCE(payout,0))/SUM(stake) END roi
  FROM bets b WHERE ${O} GROUP BY bucket ORDER BY CASE bucket WHEN '20%以上' THEN 1 WHEN '5〜20%' THEN 2 WHEN '0〜5%' THEN 3 WHEN '< 0%' THEN 4 ELSE 5 END`,origin,origin);
 const byModel=await all<any>(db,`SELECT COALESCE(model_id,'unknown') modelId,COUNT(*) bets,SUM(stake) stake,SUM(COALESCE(payout,0)) payout,CASE WHEN SUM(stake)>0 THEN 1.0*SUM(COALESCE(payout,0))/SUM(stake) END roi FROM bets b WHERE ${O} GROUP BY model_id`,origin,origin);
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
 const qualityExclusions=classified.filter(r=>r.quality.length).slice(0,50).map(r=>({at:r.started_at,source:r.source,count:r.quality.length,reason:r.quality.join(' | ')}));
 return c.json({sources,errors,qualityExclusions,tableCounts,d1WriteBudget:await readWriteBudget(db),freeTier:{d1RowsApprox:Object.values(tableCounts).reduce((a,b)=>a+b,0),d1RowsNote:'合計は保存中のテーブル行数の概算で、Cloudflareアカウント全体のquota使用量ではありません。'}});
});
for(const route of Object.keys(ingestTables)) app.post(`/ingest/${route}` as any,c=>ingest(c,route));
app.get('/ingest/models',async c=>{
 if(!auth(c))return jsonError(c,'unauthorized',401);
 const models=await all<any>(c.env.DB,'SELECT id,sport,bet_type,version,algorithm,status,train_from,train_to,valid_from,valid_to,test_from,test_to,n_train,metrics_json,trained_at,notes FROM models ORDER BY sport,status,id');
 return c.json({models});
});
app.post('/admin/settle',async c=>{if(!auth(c))return jsonError(c,'unauthorized',401);return c.json({settled:await settleOpen(c.env.DB)});});
export default { fetch: app.fetch, scheduled: async (event: ScheduledController, env: Env) => {
  if (event.cron !== '* * * * *') return;
  if (env.ENABLE_BOATRACE_ODDS_SCRAPE === 'true' || env.ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE === 'true') {
    // A collection quota/write failure must not block ten-minute settlement.
    await collectScheduledOdds(env.DB, env.ENABLE_BOATRACE_ODDS_SCRAPE==='true', env.ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE==='true').catch(() => undefined);
  }
  if (Math.floor(event.scheduledTime / 60_000) % 10 !== 0) return;
  await cron(env.DB, env.ENABLE_AUTO_BET==='true' || (await setting(env.DB,'auto_bet_enabled','false'))==='true');
} };
export { app, cron, settleOpen, autoBet };
