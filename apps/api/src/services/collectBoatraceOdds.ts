import { all, type Db, type Statement } from '../repo/db.js';
import { isStablePool, oddsUrl, parseWinOdds, USER_AGENT } from './boatraceOdds.js';
import { readWriteBudget, reserveWriteBudget, utcDate } from './writeBudget.js';

type RaceTarget = { id: string; venue_id: string; race_no: number; race_date: string };
type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
export type CollectOddsOptions = {
  maxRequests?: number;
  requestBudget?: { used: number; max: number };
  sleep?: (ms: number) => Promise<void>;
  fetch?: (input: string, init?: RequestInit) => Promise<FetchResponse>;
};
// Odds retain their 10k sub-cap inside the shared 20k Worker budget.
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
      AND EXISTS (
        SELECT 1 FROM models m JOIN predictions p ON p.model_id=m.id
        WHERE m.sport='boat' AND m.bet_type='win' AND m.status='active'
          AND CASE WHEN json_valid(m.metrics_json) THEN
            json_type(m.metrics_json,'$.boatArtifactSha256')='text'
            AND json_extract(m.metrics_json,'$.boatVenueSchemaVersion')='boat-venue-v2'
            AND length(json_extract(m.metrics_json,'$.correctedTrainingDataSha256'))=64
            AND json_extract(m.metrics_json,'$.correctedTrainingDataSha256') NOT GLOB '*[^a-f0-9]*'
            AND length(json_extract(m.metrics_json,'$.boatArtifactSha256'))=64
            AND json_extract(m.metrics_json,'$.boatArtifactSha256') NOT GLOB '*[^a-f0-9]*'
          ELSE 0 END
          AND p.race_id=r.id AND p.data_origin='real'
          AND julianday(p.predicted_at)<=julianday(?) AND julianday(p.predicted_at)<=julianday(r.post_time)
          AND p.predicted_at=(SELECT MAX(p2.predicted_at) FROM predictions p2
            WHERE p2.race_id=r.id AND p2.model_id=m.id AND p2.data_origin='real'
              AND julianday(p2.predicted_at)<=julianday(?) AND julianday(p2.predicted_at)<=julianday(r.post_time))
          AND p.probability IS NOT NULL AND p.probability>0 AND p.probability<=1
          AND p.prob_std IS NOT NULL AND p.prob_std>=0
          AND (SELECT COUNT(*) FROM predictions p3 WHERE p3.race_id=r.id AND p3.model_id=m.id
            AND p3.data_origin='real' AND p3.predicted_at=p.predicted_at
            AND p3.probability IS NOT NULL AND p3.probability>0 AND p3.probability<=1
            AND p3.prob_std IS NOT NULL AND p3.prob_std>=0)
            =(SELECT COUNT(*) FROM entries e WHERE e.race_id=r.id AND e.data_origin='real')
          AND NOT EXISTS (SELECT 1 FROM predictions p4 WHERE p4.race_id=r.id AND p4.model_id=m.id
            AND p4.data_origin='real' AND p4.predicted_at=p.predicted_at
            AND NOT EXISTS (SELECT 1 FROM entries e4 WHERE e4.race_id=r.id AND e4.data_origin='real' AND e4.number=p4.number))
      )
      AND NOT EXISTS (SELECT 1 FROM odds_snapshots o WHERE o.race_id=r.id AND o.data_origin='real' AND o.bet_type='win' AND o.captured_at>=?)
    ORDER BY r.post_time ASC LIMIT ?`, jstDate(at), after, before, after, after, fresh, Math.min(30, Math.max(0, Math.floor(maxRequests))));
}

export async function collectOdds(db: Db, now: Date, opts: CollectOddsOptions = {}) {
  const maxRequests = Math.min(30, Math.max(0, Math.floor(opts.maxRequests ?? 30)));
  const targets = await selectOddsTargets(db, now, maxRequests);
  // Empty runs are deliberately read-only: minute scheduling must not write a lock or run record.
  if (!targets.length) return { status: 'skipped' as const, records: 0, targets: 0 };
  // D1's daily quota resets at UTC midnight. Reserve before lock writes so an
  // exhausted budget causes no D1 writes at all; losing a later lock is charged conservatively.
  // Reserve control writes first; actual snapshot units are reserved after
  // comparing fetched markets so unchanged minute polls do not consume a
  // phantom six-row reservation.
  const budget=await readWriteBudget(db,utcDate(now));
  const maxTargets=Math.min(targets.length,Math.max(0,Math.floor(((budget.remaining??0)-16-5)/(6*5))));
  if (!maxTargets || !await reserveWriteBudget(db, utcDate(now), 16, 'odds'))
    return { status: 'skipped' as const, records: 0, targets: 0, reason: 'daily D1 write budget unavailable or exhausted' };
  // Cron の重複実行を避ける。正常終了時に解放し、異常終了時だけ5分で期限切れにする。
  const nowIso = jstIso(now.getTime()), staleIso = jstIso(now.getTime() - 5 * 60_000);
  await db.prepare(`INSERT INTO settings(key,value) VALUES('odds_lock','') ON CONFLICT(key) DO NOTHING`).run();
  const lock = await db.prepare(`UPDATE settings SET value=? WHERE key='odds_lock' AND value<?`).bind(nowIso, staleIso).run();
  if (!lock.meta?.changes) return { status: 'skipped' as const, records: 0, targets: 0 };
  try {
    const admittedTargets = targets.slice(0, maxTargets);
    const fetcher = opts.fetch ?? ((url, init) => fetch(url, init));
    const sleep = opts.sleep ?? pause;
    const requestBudget = opts.requestBudget ?? { used: 0, max: 49 };
    const statements: Statement[] = [];
    const errors: string[] = [];
    const exclusions: string[] = [];
    let failed = 0, excluded = 0, records = 0, attempted = 0;
    for (const race of admittedTargets) {
      try {
        let html = '';
        let requestError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (requestBudget.used >= requestBudget.max) throw new Error('shared subrequest budget exhausted');
          if (attempted > 0 || requestBudget.used > 0) await sleep(3000);
          attempted++; requestBudget.used++;
          try {
            const response = await fetcher(oddsUrl(race.race_no, race.venue_id, race.race_date), { headers: { 'User-Agent': USER_AGENT } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            html = await response.text();
            requestError = undefined;
            break;
          } catch (error) { requestError = error; }
        }
        if (requestError !== undefined) throw requestError;
        const parsed = parseWinOdds(html, { raceDate: race.race_date, venueCode: race.venue_id, raceNo: race.race_no });
        if (!parsed.final && !isStablePool(parsed.odds)) {
          excluded++;
          const values = parsed.odds.filter((row): row is [number, number] => row[1] !== null);
          const overround = values.reduce((sum, [, odds]) => sum + 1 / odds, 0);
          exclusions.push(`${race.id}: odds pool not stable (overround out of range), valid=${values.length}/6, sum=${overround.toFixed(4)}, allowed=1.2..1.5, odds=${parsed.odds.map(([n, value]) => `${n}=${value ?? 'unavailable'}`).join(',')}`);
          continue;
        }
        const capturedAt = jstIso(Date.now());
        const source = parsed.final ? 'boatrace-odds-tf-final' : 'boatrace-odds-tf';
        const market = parsed.odds.filter((row): row is [number, number] => row[1] !== null && Number.isFinite(row[1]));
        const latest = await all<{selection:string;odds:number;source:string;data_origin:string}>(db,
          `SELECT selection,odds,source,data_origin FROM odds_snapshots WHERE race_id=? AND data_origin='real' AND bet_type='win'
            AND captured_at=(SELECT MAX(captured_at) FROM odds_snapshots WHERE race_id=? AND data_origin='real' AND bet_type='win')`, race.id, race.id);
        const unchanged = latest.length === market.length && market.every(([n, odds]) =>
          latest.some(row => row.selection === String(n) && row.odds === odds && row.source === source && row.data_origin === 'real'));
        const latestCapture = await db.prepare(`SELECT MAX(captured_at) captured_at FROM odds_snapshots WHERE race_id=? AND data_origin='real' AND bet_type='win'`).bind(race.id).first<{captured_at:string|null}>();
        const latestCapturedAt = latestCapture?.captured_at ? Date.parse(latestCapture.captured_at) : NaN;
        const needsFreshEvidence = !Number.isFinite(latestCapturedAt) || Date.now() - latestCapturedAt >= 4 * 60_000;
        if (unchanged && !needsFreshEvidence) continue;
        for (const [n, odds] of market) {
          statements.push(db.prepare(`INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin)
            VALUES(?,?,'win',?,?,?,?,'real') ON CONFLICT(race_id,bet_type,selection,captured_at) DO NOTHING`)
            .bind(`${race.id}:win:${n}:${capturedAt}`, race.id, String(n), odds, capturedAt, source));
          records++;
        }
      } catch (error) {
        failed++;
        errors.push(`${race.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const status = failed ? (failed === admittedTargets.length ? 'failed' : 'partial') : excluded === admittedTargets.length ? 'skipped' : excluded ? 'partial' : 'success';
    const startedAt = jstIso(now.getTime());
    const error = errors.length ? errors.join('; ').slice(0, 2000) : null;
    const reason = exclusions.length ? `quality_excluded: ${exclusions.join(' | ')}` : null;
    if (statements.length > 0) {
      const writeUnits = records * 5 + 5;
      if (!await reserveWriteBudget(db, utcDate(now), writeUnits, 'odds')) {
        // Fetching was read-only; fail closed without persisting an unbudgeted snapshot or status.
        return { status: 'skipped' as const, records: 0, targets: admittedTargets.length, failed, excluded, reason: 'daily D1 write budget unavailable or exhausted' };
      }
    }
    const previous = await db.prepare(`SELECT status,records,error,reason FROM collection_runs
      WHERE source='boatrace-odds-worker' AND target_date=? ORDER BY started_at DESC,id DESC LIMIT 1`).bind(jstDate(now.getTime())).first<{status:string;records:number;error:string|null;reason:string|null}>();
    if (!previous || previous.status !== status || previous.records !== records || previous.error !== error || previous.reason !== reason) {
      statements.push(db.prepare(`INSERT INTO collection_runs(id,source,sport,target_date,started_at,finished_at,status,records,error,reason)
        VALUES(?, 'boatrace-odds-worker','boat',?,?,?,?,?,?,?)`)
        .bind(crypto.randomUUID(), jstDate(now.getTime()), startedAt, jstIso(Date.now()), status, records, error, reason));
    }
    if (statements.length) {
      if (db.batch) await db.batch(statements);
      else for (const statement of statements) await statement.run();
    }
    return { status, records, targets: admittedTargets.length, failed, excluded };
  } finally {
    // If cleanup fails, the five-minute lease still prevents a stuck lock forever.
    await db.prepare(`UPDATE settings SET value='' WHERE key='odds_lock' AND value=?`).bind(nowIso).run().catch(() => undefined);
  }
}
