import { collectionIssues } from './services/collectionIssues.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { all, first, run, type Db, type Statement } from './repo/db.js';
import { candidate, betId, payoutYen, settleValues, validateYenStake } from './services/logic.js';
import { collectOdds } from './services/collectBoatraceOdds.js';
import { collectTrifectaOdds } from './services/collectBoatraceTrifectaOdds.js';
import { collectBoatraceCaptureArchives } from './services/collectBoatraceCaptureArchives.js';
import { collectResults } from './services/collectBoatraceResults.js';
import { BOATRACE_CUTOFF_MAX_AGE_MS } from './services/boatraceCutoff.js';
import { canonicalTicketSelection, isCompleteTicketDistribution } from '@edgelab/shared';
import { estimateIngestWriteUnits, estimateWorkerWriteUnits, readWriteBudget, reserveWriteBudget, reserveWriteBudgets, seedUnknownWriteBudget, allowOneDayWriteBudget, ONE_DAY_ALLOWANCE, utcDate, type IngestTable, type WriteCategory } from './services/writeBudget.js';
import type { Sport, DataOrigin, BetType, TicketCandidate } from '@edgelab/shared';

interface Env { DB: Db; INGEST_TOKEN?: string; ENABLE_AUTO_BET?: string; ENABLE_BOATRACE_ODDS_SCRAPE?: string; ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE?: string; ENABLE_BOATRACE_RESULTS_SCRAPE?: string; PROXY_TOKEN?: string; }
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
  json_extract(e.features_json,'$.finish_code') IN ('F','L','K','欠場','欠','失格','転覆','妨害','落水','エンスト','不完走')
  OR json_extract(e.features_json,'$.finish_code') GLOB 'K[0-9]'))`;
const isTerminalFinishCode = (value: unknown): boolean =>
  typeof value === 'string' && (['F','L','K','欠場','欠','失格','転覆','妨害','落水','エンスト','不完走'].includes(value)
    || /^K\d$/.test(value));
const app = new Hono<Ctx>().basePath('/api');
app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','OPTIONS'], allowHeaders: ['Content-Type','Authorization'] }));
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
const isoJstAt = (timestamp: number) => new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
const now = () => isoJstAt(Date.now());
const ODDS_MAX_AGE_MS = 10 * 60 * 1000;
const oddsFreshAfter = (timestamp = Date.now()) => isoJstAt(timestamp - ODDS_MAX_AGE_MS);
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
// Trusted frontend Service Binding adds this secret header; never accept a
// missing/empty token as authenticated and do not weaken ingest beare