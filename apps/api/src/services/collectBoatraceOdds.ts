import { all, type Db, type Statement } from '../repo/db.js';
import { isStablePool, oddsUrl, parseWinOdds, USER_AGENT } from './boatraceOdds.js';

type RaceTarget = { id: string; venue_id: string; race_no: number; race_date: string };
type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
export type CollectOddsOptions = {
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<FetchResponse>;
};
export const ODDS_DAILY_WRITE_BUDGET = 10_000;
// At most six odds rows per boat race. Reserve 24 row writes per target for
// the odds row plus its indexes, then another 24 for lock/settings/run-log
// control rows and indexes. Unused reservations are intentionally not refunded.
const ESTIMATED_WRITES_PER_TARGET = 24;
const ESTIMATED_CONTROL_WRITES = 24;
const jstIso = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
const jstDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function selectOddsTargets(db: Db, now: Date, maxRequests = 30): Promise<RaceTarget[]> {
  const at = now.getTime(), after = jstIso(at), before = jstIso(at + 15 * 60_000), fresh = jstIso(at - 50_000);
  return all<RaceTarget>(db, `SELECT r.id,r.venue_id,r.race_no,r.race_date FROM races r
    WHERE r.data_origin='real' AND r.sport='boat' AND r.status='scheduled'
      AND r.race_date=?
      AND r.post_time>=? AND r.post_time<=?
      AND NOT EXISTS (SELECT 1 FROM data_repair_quarantined_races q WHERE q.race_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM odds_snapshots o WHERE o.race_id=r.id AND o.bet_type='win' AND o.captured_at>=?)
    ORDER BY r.post_time ASC LIMIT ?`, jstDate(at), after, before, fresh, Math.min(30, Math.max(0, Math.floor(maxRequests))));
}

type OddsBudgetValue = { date: string; reserved: number };
function parseOddsBudget(value: string): OddsBudgetValue | null {
  try {
    const parsed = JSON.parse(value) as Partial<OddsBudgetValue>;
    if (typeof parsed.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ||
      !Number.isSafeInteger(parsed.reserved) || (parsed.reserved as number) < 0 || (parsed.reserved as number) > ODDS_DAILY_WRITE_BUDGET) return null;
    return { date: parsed.date, reserved: parsed.reserved as number };
  } catch { return null; }
}

/** Atomically reserve a conservative per-worker estimate before any fetches. A CAS conflict fails closed. */
export async function reserveOddsWriteBudget(db: Db, date: string, requestedTargets: number): Promise<number> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(requestedTargets) || requestedTargets <= 0) return 0;
  const current = await db.prepare(`SELECT value FROM settings WHERE key='odds_daily_write_budget'`).first<{ value: string }>();
  if (!current) {
    const targets = Math.min(requestedTargets, Math.floor((ODDS_DAILY_WRITE_BUDGET - ESTIMATED_CONTROL_WRITES) / ESTIMATED_WRITES_PER_TARGET));
    if (targets <= 0) return 0;
    const value = JSON.stringify({ date, reserved: ESTIMATED_CONTROL_WRITES + targets * ESTIMATED_WRITES_PER_TARGET });
    const inserted = await db.prepare(`INSERT INTO settings(key,value) VALUES('odds_daily_write_budget',?) ON CONFLICT(key) DO NOTHING`).bind(value).run();
    return inserted.meta?.changes === 1 ? targets : 0;
  }
  const parsed = parseOddsBudget(current.value);
  if (!parsed || parsed.date > date) return 0;
  const reserved = parsed.date === date ? parsed.reserved : 0;
  const available = ODDS_DAILY_WRITE_BUDGET - reserved - ESTIMATED_CONTROL_WRITES;
  const targets = Math.min(requestedTargets, Math.floor(available / ESTIMATED_WRITES_PER_TARGET));
  if (targets <= 0) return 0;
  const value = JSON.stringify({ date, reserved: reserved + ESTIMATED_CONTROL_WRITES + targets * ESTIMATED_WRITES_PER_TARGET });
  const updated = await db.prepare(`UPDATE settings SET value=? WHERE key='odds_daily_write_budget' AND value=?`).bind(value, current.value).run();
  return updated.meta?.changes === 1 ? targets : 0;
}

export async function collectOdds(db: Db, now: Date, opts: CollectOddsOptions = {}) {
  const maxRequests = Math.min(30, Math.max(0, Math.floor(opts.maxRequests ?? 30)));
  const targets = await selectOddsTargets(db, now, maxRequests);
  // Empty runs are deliberately read-only: minute scheduling must not write a lock or run record.
  if (!targets.length) return { status: 'skipped' as const, records: 0, targets: 0 };
  // D1's daily quota resets at UTC midnight. Reserve before lock writes so an
  // exhausted budget causes no D1 writes at all; losing a later lock is charged conservatively.
  const admitted = await reserveOddsWriteBudget(db, now.toISOString().slice(0, 10), targets.length);
  if (!admitted) return { status: 'skipped' as const, records: 0, targets: 0, reason: 'daily odds write budget exhausted' };
  // Cron の重複実行を避ける。正常終了時に解放し、異常終了時だけ5分で期限切れにする。
  const nowIso = jstIso(now.getTime()), staleIso = jstIso(now.getTime() - 5 * 60_000);
  await db.prepare(`INSERT INTO settings(key,value) VALUES('odds_lock','') ON CONFLICT(key) DO NOTHING`).run();
  const lock = await db.prepare(`UPDATE settings SET value=? WHERE key='odds_lock' AND value<?`).bind(nowIso, staleIso).run();
  if (!lock.meta?.changes) return { status: 'skipped' as const, records: 0, targets: 0 };
  try {
    const admittedTargets = targets.slice(0, admitted);
    const fetcher = opts.fetch ?? ((url, init) => fetch(url, init));
    const sleep = opts.sleep ?? pause;
    const statements: Statement[] = [];
    const errors: string[] = [];
    let failed = 0, records = 0, attempted = 0;
    for (const race of admittedTargets) {
      try {
        let html = '';
        let requestError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempted >= 49) throw new Error('subrequest budget exhausted');
          if (attempted > 0) await sleep(3000);
          attempted++;
          try {
            const response = await fetcher(oddsUrl(race.race_no, race.venue_id, race.race_date), { headers: { 'User-Agent': USER_AGENT } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            html = await response.text();
            requestError = undefined;
            break;
          } catch (error) { requestError = error; }
        }
        if (requestError !== undefined) throw requestError;
        const parsed = parseWinOdds(html);
        if (!parsed.final && !isStablePool(parsed.odds)) throw new Error('odds pool not stable (overround out of range)');
        const capturedAt = jstIso(now.getTime());
        const source = parsed.final ? 'boatrace-odds-tf-final' : 'boatrace-odds-tf';
        for (const [n, odds] of parsed.odds) {
          if (odds === null || !Number.isFinite(odds)) continue;
          statements.push(db.prepare(`INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin)
            VALUES(?,?,'win',?,?,?,?,'real') ON CONFLICT(race_id,bet_type,selection,captured_at) DO UPDATE SET odds=excluded.odds,source=excluded.source,data_origin='real'`)
            .bind(`${race.id}:win:${n}:${capturedAt}`, race.id, String(n), odds, capturedAt, source));
          records++;
        }
      } catch (error) {
        failed++;
        errors.push(`${race.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const status = failed === 0 ? 'success' : failed === admittedTargets.length ? 'failed' : 'partial';
    const startedAt = jstIso(now.getTime());
    statements.push(db.prepare(`INSERT INTO collection_runs(id,source,sport,target_date,started_at,finished_at,status,records,error)
      VALUES(?, 'boatrace-odds-worker','boat',?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), jstDate(now.getTime()), startedAt, jstIso(Date.now()), status, records, errors.length ? errors.join('; ').slice(0, 2000) : null));
    if (db.batch) await db.batch(statements);
    else for (const statement of statements) await statement.run();
    return { status, records, targets: admittedTargets.length, failed };
  } finally {
    // If cleanup fails, the five-minute lease still prevents a stuck lock forever.
    await db.prepare(`UPDATE settings SET value='' WHERE key='odds_lock' AND value=?`).bind(nowIso).run().catch(() => undefined);
  }
}
