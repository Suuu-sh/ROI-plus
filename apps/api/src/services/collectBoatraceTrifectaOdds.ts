import { readWriteBudget, reserveWriteBudget, utcDate } from './writeBudget.js';
import { all, type Db, type Statement } from '../repo/db.js';
import { parseTrifectaOdds, trifectaOddsUrl } from './boatraceTrifectaOdds.js';
import { USER_AGENT } from './boatraceOdds.js';
import { isCompleteTicketDistribution } from '@edgelab/shared';

type RaceTarget = { id: string; venue_id: string; race_no: number; race_date: string };
type FetchResponse = { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> };
export type SharedRequestBudget = { used: number; max: number };
export type CollectTrifectaOptions = {
  maxRequests?: number;
  requestBudget?: SharedRequestBudget;
  sleep?: (ms: number) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<FetchResponse>;
};
const jstIso = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
const jstDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const SHA256 = /^[a-f0-9]{64}$/;
const TICKET_SCHEMA = 'ticket-selection-v1';
const PROBABILITY_SEMANTICS = 'exact-selection-probability-v1';
const sha256 = async (bytes: ArrayBuffer) => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
};

/** One-request-per-race, opt-in collector. Strict parser failures create no odds rows. */
export async function collectTrifectaOdds(db: Db, now: Date, opts: CollectTrifectaOptions = {}) {
  const maxRequests = Math.min(10, Math.max(0, Math.floor(opts.maxRequests ?? 10)));
  const budget = opts.requestBudget ?? { used: 0, max: 49 };
  const at = now.getTime(), after = jstIso(at), before = jstIso(at + 15 * 60_000), recent = jstIso(at - 50_000);
  const races = await all<RaceTarget & {post_time:string}>(db, `SELECT r.id,r.venue_id,r.race_no,r.race_date,r.post_time FROM races r
    WHERE r.data_origin='real' AND r.sport='boat' AND r.status='scheduled' AND r.post_time>=? AND r.post_time<=? AND r.race_date=?
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
      AND (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin=r.data_origin)=6
      AND NOT EXISTS(SELECT 1 FROM odds_snapshots o WHERE o.race_id=r.id AND o.data_origin='real' AND o.bet_type='trifecta' AND o.source='boatrace-trifecta-official-v1' AND o.captured_at>=?)
    ORDER BY r.post_time ASC LIMIT ?`, after, before, jstDate(at), recent, maxRequests);
  const models = await all<{id:string;status:string;bet_type:string;metrics_json:string|null;trained_at:string|null}>(db,
    "SELECT id,status,bet_type,metrics_json,trained_at FROM models WHERE sport='boat' AND bet_type='trifecta' AND status='active'");
  const targets: RaceTarget[] = [];
  for (const race of races) {
    const entries = await all<{number:number}>(db, "SELECT number FROM entries WHERE race_id=? AND data_origin='real' ORDER BY number", race.id);
    const numbers = entries.map(row => Number(row.number));
    if (numbers.length !== 6 || new Set(numbers).size !== 6 || numbers.some(n => !Number.isInteger(n) || n < 1 || n > 6)) continue;
    for (const model of models) {
      let metrics: any;
      try { metrics = JSON.parse(model.metrics_json || '{}'); } catch { continue; }
      const evidence = metrics?.ticketValidation;
      const validatedAt = typeof evidence?.validatedAt === 'string' ? Date.parse(evidence.validatedAt) : NaN;
      if (metrics?.ticketModelSchemaVersion !== TICKET_SCHEMA || metrics?.ticketPredictionSemantics !== PROBABILITY_SEMANTICS
          || metrics?.ticketBetType !== 'trifecta' || typeof metrics?.ticketArtifactSha256 !== 'string' || !SHA256.test(metrics.ticketArtifactSha256)
          || metrics?.promotionEligible !== true || evidence?.status !== 'independently_validated' || evidence?.policyVersion !== TICKET_SCHEMA
          || evidence?.betType !== 'trifecta' || evidence?.artifactSha256 !== metrics.ticketArtifactSha256
          || typeof evidence?.reportSha256 !== 'string' || !SHA256.test(evidence.reportSha256)
          || typeof evidence?.independentReviewId !== 'string' || !evidence.independentReviewId
          || evidence?.dataOrigin !== 'real' || evidence?.completeCombinationCoverage !== true
          || evidence?.probabilitiesNormalized !== true || evidence?.outOfSampleValidated !== true || evidence?.pointInTimeSafe !== true
          || !Number.isFinite(validatedAt) || validatedAt > at || at - validatedAt > 30 * 86400_000) continue;
      const latest = await db.prepare(`SELECT MAX(predicted_at) predicted_at FROM ticket_predictions
        WHERE race_id=? AND model_id=? AND bet_type='trifecta' AND data_origin='real'
          AND julianday(predicted_at)<=julianday(?) AND julianday(predicted_at)<=julianday(?)`).bind(race.id, model.id, after, race.post_time).first<{predicted_at:string|null}>();
      if (!latest?.predicted_at || !model.trained_at || Date.parse(model.trained_at) >= Date.parse(latest.predicted_at)) continue;
      const predictions = await all<{selection:string;probability:number;prob_std:number|null;feature_schema_version:string;artifact_sha256:string}>(db,
        `SELECT selection,probability,prob_std,feature_schema_version,artifact_sha256 FROM ticket_predictions
          WHERE race_id=? AND model_id=? AND bet_type='trifecta' AND data_origin='real' AND predicted_at=?`, race.id, model.id, latest.predicted_at);
      if (predictions.length !== 120 || predictions.some(p => p.feature_schema_version !== TICKET_SCHEMA
          || p.artifact_sha256 !== metrics.ticketArtifactSha256 || p.probability === null || !Number.isFinite(p.probability)
          || p.probability < 0 || p.prob_std === null || !Number.isFinite(p.prob_std) || p.prob_std < 0)
          || !isCompleteTicketDistribution('trifecta', numbers, predictions.map(p => p.selection), predictions.map(p => p.probability))) continue;
      targets.push(race);
      break;
    }
  }
  const admittedTargetsBase = targets.slice(0, maxRequests);
  if (!admittedTargetsBase.length) return { status: 'skipped' as const, records: 0, targets: 0, attempted: 0 };
  const state=await readWriteBudget(db,utcDate(now));
  const remaining=Math.min(state.remaining??0,state.oddsLimit-(state.oddsReserved??state.oddsLimit));
  const admittedCount=Math.min(admittedTargetsBase.length,Math.max(0,Math.floor((remaining-16-32)/(120*5))));
  if(!admittedCount||!await reserveWriteBudget(db,utcDate(now),16,'odds'))return {status:'skipped' as const,records:0,targets:0,attempted:0,reason:'daily D1 write budget unavailable or exhausted'};
  await db.prepare("INSERT INTO settings(key,value) VALUES('trifecta_odds_lock','') ON CONFLICT(key) DO NOTHING").run();
  const lock = await db.prepare("UPDATE settings SET value=? WHERE key='trifecta_odds_lock' AND value<?").bind(after, jstIso(at - 5 * 60_000)).run();
  if (!lock.meta?.changes) return { status: 'skipped' as const, records: 0, targets: 0, attempted: 0 };
  try {
    const admittedTargets=targets.slice(0,admittedCount);
    const fetcher = opts.fetch ?? ((url, init) => fetch(url, init));
    const sleep = opts.sleep ?? pause;
    const statements: Statement[] = [];
    const errors: string[] = [];
    let records = 0, attempted = 0, failed = 0;
    for (const race of admittedTargets) {
      try {
        if (budget.used >= budget.max) throw new Error('shared Worker subrequest budget exhausted');
        if (attempted > 0 || budget.used > 0) await sleep(3000);
        const url = trifectaOddsUrl(race.race_no, race.venue_id, race.race_date);
        budget.used++; attempted++;
        const response = await fetcher(url, { headers: { 'User-Agent': USER_AGENT } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const html = new TextDecoder().decode(bytes);
        const parsed = parseTrifectaOdds(html, { raceDate: race.race_date, venueCode: race.venue_id, raceNo: race.race_no });
        const capturedAt = jstIso(Date.now());
        const sourceHash = await sha256(bytes);
        // One atomic statement per complete market avoids 120 subqueries per
        // race and never exposes a partially written combination set.
        const latest = await all<{captured_at:string;selection:string;odds:number;source_url:string;quality_status:string}>(db,
          `SELECT captured_at,selection,odds,source_url,quality_status FROM odds_snapshots
            WHERE race_id=? AND data_origin='real' AND bet_type='trifecta'
              AND captured_at=(SELECT MAX(captured_at) FROM odds_snapshots WHERE race_id=? AND data_origin='real' AND bet_type='trifecta')`, race.id,race.id);
        const latestMeta=latest[0];
        const unchanged = latest.length === 120 && latestMeta?.source_url === url && latestMeta?.quality_status === parsed.qualityStatus
          && parsed.odds.every(row=>latest.some(previous=>previous.selection===row.selection&&previous.odds===row.odds));
        if (unchanged && Date.now() - Date.parse(latestMeta.captured_at) < 4 * 60_000) continue;
        const market=parsed.odds.map(row=>({...row,id:`${race.id}:trifecta:${row.selection}:${capturedAt}`}));
        statements.push(db.prepare(`INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin,source_url,source_sha256,quality_status)
          SELECT json_extract(value,'$.id'),?,'trifecta',json_extract(value,'$.selection'),json_extract(value,'$.odds'),?,'boatrace-trifecta-official-v1','real',?,?,?
          FROM json_each(?) WHERE 1
          ON CONFLICT(race_id,bet_type,selection,captured_at) DO NOTHING`)
          .bind(race.id,capturedAt,url,sourceHash,parsed.qualityStatus,JSON.stringify(market)));
        records+=market.length;
      } catch (error) {
        failed++;
        errors.push(`${race.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const status = failed === 0 ? 'success' : failed === admittedTargets.length ? 'failed' : 'partial';
    const startedAt = jstIso(now.getTime());
    const error = errors.length ? errors.join('; ').slice(0, 2000) : null;
    if (statements.length && !await reserveWriteBudget(db, utcDate(now), records * 5 + 5, 'odds'))
      return { status: 'skipped' as const, records: 0, targets: admittedTargets.length, failed, attempted, reason: 'daily D1 write budget unavailable or exhausted' };
    const previous = await db.prepare(`SELECT status,records,error FROM collection_runs
      WHERE source='boatrace-trifecta-odds-worker' AND target_date=? ORDER BY started_at DESC,id DESC LIMIT 1`).bind(jstDate(now.getTime())).first<{status:string;records:number;error:string|null}>();
    if (!previous || previous.status !== status || previous.records !== records || previous.error !== error) {
      statements.push(db.prepare(`INSERT INTO collection_runs(id,source,sport,target_date,started_at,finished_at,status,records,error)
        VALUES(?, 'boatrace-trifecta-odds-worker','boat',?,?,?,?,?,?)`)
        .bind(crypto.randomUUID(), jstDate(now.getTime()), startedAt, jstIso(Date.now()), status, records, error));
    }
    if (statements.length) {
      if (db.batch) await db.batch(statements);
      else for (const statement of statements) await statement.run();
    }
    return { status, records, targets: admittedTargets.length, failed, attempted };
  } finally {
    await db.prepare("UPDATE settings SET value='' WHERE key='trifecta_odds_lock' AND value=?").bind(after).run().catch(()=>undefined);
  }
}
