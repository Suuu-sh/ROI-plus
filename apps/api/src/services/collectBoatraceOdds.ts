import { all, type Db, type Statement } from '../repo/db.js';
import { isStablePool, oddsUrl, parseWinOdds, USER_AGENT } from './boatraceOdds.js';

type RaceTarget = { id: string; venue_id: string; race_no: number; race_date: string };
type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
export type CollectOddsOptions = {
  maxRequests?: number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<FetchResponse>;
};
const jstIso = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
const jstDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function selectOddsTargets(db: Db, now: Date, maxRequests = 30): Promise<RaceTarget[]> {
  const at = now.getTime(), after = jstIso(at), before = jstIso(at + 15 * 60_000), fresh = jstIso(at - 10 * 60_000);
  return all<RaceTarget>(db, `SELECT r.id,r.venue_id,r.race_no,r.race_date FROM races r
    WHERE r.data_origin='real' AND r.sport='boat' AND r.status='scheduled'
      AND r.post_time>=? AND r.post_time<=?
      AND NOT EXISTS (SELECT 1 FROM odds_snapshots o WHERE o.race_id=r.id AND o.bet_type='win' AND o.captured_at>=?)
    ORDER BY r.post_time ASC LIMIT ?`, after, before, fresh, Math.min(30, Math.max(0, Math.floor(maxRequests))));
}

export async function collectOdds(db: Db, now: Date, opts: CollectOddsOptions = {}) {
  const maxRequests = Math.min(30, Math.max(0, Math.floor(opts.maxRequests ?? 30)));
  const targets = await selectOddsTargets(db, now, maxRequests);
  if (!targets.length) return { status: 'skipped' as const, records: 0, targets: 0 };
  const fetcher = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? pause;
  const statements: Statement[] = [];
  const errors: string[] = [];
  let failed = 0, records = 0, attempted = 0;
  for (const race of targets) {
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
  const status = failed === 0 ? 'success' : failed === targets.length ? 'failed' : 'partial';
  const startedAt = jstIso(now.getTime());
  statements.push(db.prepare(`INSERT INTO collection_runs(id,source,sport,target_date,started_at,finished_at,status,records,error)
    VALUES(?, 'boatrace-odds-worker','boat',?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), jstDate(now.getTime()), startedAt, jstIso(Date.now()), status, records, errors.length ? errors.join('; ').slice(0, 2000) : null));
  if (db.batch) await db.batch(statements);
  else for (const statement of statements) await statement.run();
  return { status, records, targets: targets.length, failed };
}
