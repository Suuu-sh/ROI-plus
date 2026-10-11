import { estimateOddsWriteUnits, readWriteBudget, reserveWriteBudget, utcDate } from './writeBudget.js';
import { all, type Db, type Statement } from '../repo/db.js';
import { parseTrifectaOdds, trifectaOddsUrl } from './boatraceTrifectaOdds.js';
import { USER_AGENT } from './boatraceOdds.js';

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
const sha256 = async (bytes: ArrayBuffer) => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
};

/** One-request-per-race, opt-in collector. Strict parser failures create no odds rows. */
export async function collectTrifectaOdds(db: Db, now: Date, opts: CollectTrifectaOptions = {}) {
  const maxRequests = Math.min(10, Math.max(0, Math.floor(opts.maxRequests ?? 10)));
  const budget = opts.requestBudget ?? { used: 0, max: 49 };
  const at = now.getTime(), after = jstIso(at), before = jstIso(at + 15 * 60_000), fresh = jstIso(at - 10 * 60_000);
  const targets = await all<RaceTarget>(db, `SELECT r.id,r.venue_id,r.race_no,r.race_date FROM races r
    WHERE r.data_origin='real' AND r.sport='boat' AND r.status='scheduled' AND r.post_time>=? AND r.post_time<=? AND r.race_date=?
      AND NOT EXISTS(SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
      AND (SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin=r.data_origin)=6
      AND NOT EXISTS(SELECT 1 FROM odds_snapshots o WHERE o.race_id=r.id AND o.bet_type='trifecta' AND o.source='boatrace-trifecta-official-v1' AND o.captured_at>=?)
    ORDER BY r.post_time ASC LIMIT ?`, after, before, jstDate(at), fresh, maxRequests);
  if (!targets.length) return { status: 'skipped' as const, records: 0, targets: 0, attempted: 0 };
  const state=await readWriteBudget(db,utcDate(now));
  const remaining=Math.min(state.remaining??0,state.oddsLimit-(state.oddsReserved??state.oddsLimit));
  const admittedCount=Math.min(targets.length,Math.max(0,Math.floor((remaining-32)/(120*5))));
  if(!admittedCount||!await reserveWriteBudget(db,utcDate(now),estimateOddsWriteUnits(admittedCount,120),'odds'))return {status:'skipped' as const,records:0,targets:0,attempted:0,reason:'daily D1 write budget unavailable or exhausted'};
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
        const market=parsed.odds.map(row=>({...row,id:`${race.id}:trifecta:${row.selection}:${capturedAt}`}));
        statements.push(db.prepare(`INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin,source_url,source_sha256,quality_status)
          SELECT json_extract(value,'$.id'),?,'trifecta',json_extract(value,'$.selection'),json_extract(value,'$.odds'),?,'boatrace-trifecta-official-v1','real',?,?,?
          FROM json_each(?) WHERE 1
          ON CONFLICT(race_id,bet_type,selection,captured_at) DO UPDATE SET odds=excluded.odds,source=excluded.source,data_origin='real',source_url=excluded.source_url,source_sha256=excluded.source_sha256,quality_status=excluded.quality_status`)
          .bind(race.id,capturedAt,url,sourceHash,parsed.qualityStatus,JSON.stringify(market)));
        records+=market.length;
      } catch (error) {
        failed++;
        errors.push(`${race.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const status = failed === 0 ? 'success' : failed === admittedTargets.length ? 'failed' : 'partial';
    const startedAt = jstIso(now.getTime());
    statements.push(db.prepare(`INSERT INTO collection_runs(id,source,sport,target_date,started_at,finished_at,status,records,error)
      VALUES(?, 'boatrace-trifecta-odds-worker','boat',?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), jstDate(now.getTime()), startedAt, jstIso(Date.now()), status, records, errors.length ? errors.join('; ').slice(0, 2000) : null));
    if (db.batch) await db.batch(statements);
    else for (const statement of statements) await statement.run();
    return { status, records, targets: admittedTargets.length, failed, attempted };
  } finally {
    await db.prepare("UPDATE settings SET value='' WHERE key='trifecta_odds_lock' AND value=?").bind(after).run().catch(()=>undefined);
  }
}
