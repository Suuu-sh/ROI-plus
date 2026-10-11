import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import worker from '../src/index.js';
import { collectOdds, selectOddsTargets } from '../src/services/collectBoatraceOdds.js';
import { DAILY_D1_WRITE_BUDGET, DAILY_ESSENTIAL_WRITE_BUDGET, DAILY_ODDS_WRITE_BUDGET, DAILY_OPTIONAL_WRITE_BUDGET, readWriteBudget, reserveWriteBudget, reserveWriteBudgets } from '../src/services/writeBudget.js';
import { D1SqliteAdapter } from './d1-adapter.js';

const root = resolve(import.meta.dirname, '../../..');
const fixture = readFileSync(resolve(root, 'data/fixtures/boatrace/oddstf_24_12_20261009.html'), 'utf8');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const now = new Date(`${today}T03:00:00.000Z`);
const jstDate = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const stamp = (ms: number) => new Date(ms + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
const collectionPage = (url: string) => {
  const parsed=new URL(url);
  return fixture.replaceAll('rno=12',`rno=${parsed.searchParams.get('rno')}`).replaceAll('hd=20261009',`hd=${parsed.searchParams.get('hd')}`);
};
let sqlite: Sqlite.Database, DB: D1SqliteAdapter, nextRaceNo = 1;

beforeEach(() => {
  nextRaceNo = 1;
  sqlite = new Sqlite(':memory:'); DB = new D1SqliteAdapter(sqlite);
  for (const f of readdirSync(resolve(root, 'db/migrations')).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(resolve(root, 'db/migrations', f), 'utf8'));
  sqlite.prepare("INSERT INTO settings(key,value) VALUES('roi_d1_write_budget_utc',?)").run(JSON.stringify({ date: new Date().toISOString().slice(0, 10), reserved: 0, oddsReserved: 0 }));
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('24','boat','Fixture')").run();
  sqlite.prepare("INSERT INTO models(id,sport,bet_type,version,algorithm,status,metrics_json,trained_at) VALUES('safe-win','boat','win','v2','fixture','active',?,?)")
    .run(JSON.stringify({boatVenueSchemaVersion:'boat-venue-v2',correctedTrainingDataSha256:'a'.repeat(64),boatArtifactSha256:'b'.repeat(64)}),stamp(Date.now()-120_000));
});
afterEach(() => sqlite.close());

function race(id: string, post = now.getTime() + 5 * 60_000, date = today) {
  const raceNo=nextRaceNo++;
  sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at)
    VALUES(?,'boat','24',?,?,?,'scheduled','real',?)`).run(id, date, raceNo, stamp(post), stamp(now.getTime()));
  const predictedAt=stamp(Date.now()-60_000);
  for(let number=1;number<=6;number++){
    sqlite.prepare("INSERT INTO entries(id,race_id,number,name,available_at,data_origin) VALUES(?,?,?,? ,?,'real')").run(`${id}-entry-${number}`,id,number,`Lane ${number}`,predictedAt);
    sqlite.prepare("INSERT INTO predictions(id,race_id,model_id,number,probability,prob_std,predicted_at,data_origin) VALUES(?,?, 'safe-win',?, ?,0.01,?,'real')").run(`${id}-prediction-${number}`,id,number,1/6,predictedAt);
  }
}
function finishedOpenBet(id: string) {
  const raceId = `${id}-race`;
  sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at)
    VALUES(?,'boat','24',?,90,'finished','real',?)`).run(raceId, today, stamp(now.getTime()));
  sqlite.prepare(`INSERT INTO entries(id,race_id,number,name,available_at,data_origin) VALUES(?, ?,1,'Lane 1',?,'real')`).run(`${id}-entry`, raceId, stamp(now.getTime()));
  sqlite.prepare(`INSERT INTO results(race_id,finish_order,number,data_origin) VALUES(?,1,1,'real')`).run(raceId);
  sqlite.prepare(`INSERT INTO payouts(race_id,bet_type,selection,payout,data_origin) VALUES(?,'win','1',200,'real')`).run(raceId);
  sqlite.prepare(`INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,predicted_prob,odds_at_bet,expected_roi,edge_label,placed_at,status,data_origin)
    VALUES(?,?,'boat','win','1',100,'manual',0.5,2,0,'NEUTRAL',?,'open','real')`).run(`${id}-bet`, raceId, stamp(now.getTime()));
  return `${id}-bet`;
}

describe('minute odds collection controls', () => {
  it('does not write settings or collection logs when no current-day targets exist', async () => {
    race('yesterday', now.getTime() + 5 * 60_000, '2001-01-01');
    const before = (sqlite.prepare('SELECT total_changes() changes').get() as { changes: number }).changes;
    const fetch = vi.fn();
    expect(await collectOdds(DB, now, { fetch })).toMatchObject({ status: 'skipped', targets: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect((sqlite.prepare('SELECT total_changes() changes').get() as { changes: number }).changes).toBe(before);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM collection_runs').get()).toMatchObject({ n: 0 });
  });

  it('limits target scans to JST today and excludes quarantined races', async () => {
    race('eligible'); race('past-date', now.getTime() + 5 * 60_000, '2001-01-01');
    race('quarantined');
    sqlite.prepare("INSERT INTO data_repair_quarantined_races(race_id,repair_id,reason) VALUES('quarantined','test','fixture')").run();
    expect((await selectOddsTargets(DB, now)).map(x => x.id)).toEqual(['eligible']);
  });

  it('does not fetch, lock, budget, or log without an active safe model prediction',async()=>{
    race('no-model');
    sqlite.prepare("UPDATE models SET status='candidate' WHERE id='safe-win'").run();
    const before=(sqlite.prepare('SELECT total_changes() changes').get() as {changes:number}).changes;
    const fetch=vi.fn();
    expect(await collectOdds(DB,now,{fetch})).toMatchObject({status:'skipped',targets:0});
    expect(fetch).not.toHaveBeenCalled();
    expect((sqlite.prepare('SELECT total_changes() changes').get() as {changes:number}).changes).toBe(before);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key='odds_lock'").get()).toMatchObject({n:0});
    expect(sqlite.prepare('SELECT COUNT(*) n FROM collection_runs').get()).toMatchObject({n:0});
  });

  it('uses a 50-second freshness window', async () => {
    race('fresh-30s'); race('stale-60s');
    sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('fresh-odds','fresh-30s','win','1',2,?,'test','real')").run(stamp(now.getTime() - 30_000));
    sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('stale-odds','stale-60s','win','1',2,?,'test','real')").run(stamp(now.getTime() - 60_000));
    expect((await selectOddsTargets(DB, now)).map(x => x.id)).toEqual(['stale-60s']);
  });

  it('atomically reserves conservative writes in the shared budget and caps odds at 10k', async () => {
    const reserves = await Promise.all([
      reserveWriteBudget(DB, now.toISOString().slice(0, 10), 20, 'odds'),
      reserveWriteBudget(DB, now.toISOString().slice(0, 10), 20, 'odds'),
    ]);
    expect(reserves.filter(Boolean)).toHaveLength(1);
    const stored = JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get() as { value: string }).value);
    expect(stored).toEqual({ date: now.toISOString().slice(0, 10), reserved: 20, oddsReserved: 20, essentialReserved: 0, optionalReserved: 20 });
    sqlite.prepare("UPDATE settings SET value=? WHERE key='roi_d1_write_budget_utc'").run(JSON.stringify({ date: now.toISOString().slice(0, 10), reserved: 9_920, oddsReserved: 9_920 }));
    expect(await reserveWriteBudget(DB, now.toISOString().slice(0, 10), 100, 'odds')).toBe(false);
    expect(await reserveWriteBudget(DB, now.toISOString().slice(0, 10), 1, 'ingest')).toBe(false);
    expect(DAILY_D1_WRITE_BUDGET).toBe(20_000);
    expect(DAILY_ESSENTIAL_WRITE_BUDGET).toBe(16_000);
    expect(DAILY_OPTIONAL_WRITE_BUDGET).toBe(4_000);
    expect(DAILY_ODDS_WRITE_BUDGET).toBe(4_000);
  });

  it('protects the essential bucket from optional work and combines all optional caps', async () => {
    const day = now.toISOString().slice(0, 10);
    expect(await reserveWriteBudget(DB, day, DAILY_OPTIONAL_WRITE_BUDGET, 'optional')).toBe(true);
    expect(await reserveWriteBudget(DB, day, 1, 'odds')).toBe(false);
    expect(await reserveWriteBudget(DB, day, DAILY_ESSENTIAL_WRITE_BUDGET, 'essential')).toBe(true);
    expect(await reserveWriteBudget(DB, day, 1, 'essential')).toBe(false);
    const budget = await readWriteBudget(DB, day);
    expect(budget).toMatchObject({ reserved: DAILY_D1_WRITE_BUDGET, essentialReserved: 16_000, optionalReserved: 4_000, state: 'exhausted' });
  });

  it('does not charge either bucket when a mixed request cannot reserve both', async () => {
    const day = now.toISOString().slice(0, 10);
    await reserveWriteBudget(DB, day, DAILY_OPTIONAL_WRITE_BUDGET, 'optional');
    expect(await reserveWriteBudgets(DB, day, [{ units: 15, category: 'essential' }, { units: 1, category: 'optional' }])).toBe(false);
    expect(await readWriteBudget(DB, day)).toMatchObject({ reserved: 4_000, essentialReserved: 0, optionalReserved: 4_000 });
  });

  it('keeps legacy current-day reservations and closes optional work conservatively', async () => {
    const day = now.toISOString().slice(0, 10);
    sqlite.prepare("UPDATE settings SET value=? WHERE key='roi_d1_write_budget_utc'").run(JSON.stringify({ date: day, reserved: 19_946, oddsReserved: 10_000 }));
    expect(await readWriteBudget(DB, day)).toMatchObject({ reserved: 19_946, remaining: 54, essentialReserved: 15_946, optionalReserved: 4_000, optionalRemaining: 0, state: 'known' });
    expect(await reserveWriteBudget(DB, day, 1, 'optional')).toBe(false);
    expect(await reserveWriteBudget(DB, day, 55, 'essential')).toBe(false);
    expect(await reserveWriteBudget(DB, day, 54, 'essential')).toBe(true);
    const stored = JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get() as { value: string }).value);
    expect(stored).toMatchObject({ reserved: 20_000, essentialReserved: 16_000, optionalReserved: 4_000, oddsReserved: 10_000 });
  });

  it('does not write a lock or budget when the UTC-day budget is exhausted', async () => {
    race('budget-exhausted');
    const utcDay = now.toISOString().slice(0, 10);
    sqlite.prepare("UPDATE settings SET value=? WHERE key='roi_d1_write_budget_utc'").run(JSON.stringify({ date: utcDay, reserved: DAILY_D1_WRITE_BUDGET, oddsReserved: DAILY_ODDS_WRITE_BUDGET }));
    const before = (sqlite.prepare('SELECT total_changes() changes').get() as { changes: number }).changes;
    const fetch = vi.fn();
    expect(await collectOdds(DB, now, { fetch })).toMatchObject({ status: 'skipped', targets: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect((sqlite.prepare('SELECT total_changes() changes').get() as { changes: number }).changes).toBe(before);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key='odds_lock'").get()).toMatchObject({ n: 0 });
  });

  it('rolls the reservation at UTC midnight, independently of the JST target date', async () => {
    const boundary = new Date(`${today}T15:00:00.000Z`);
    const utcDay = boundary.toISOString().slice(0, 10);
    const previousUtcDay = new Date(Date.parse(`${utcDay}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
    race('utc-rollover', boundary.getTime() + 5 * 60_000, jstDate(boundary));
    sqlite.prepare("UPDATE settings SET value=? WHERE key='roi_d1_write_budget_utc'").run(JSON.stringify({ date: previousUtcDay, reserved: DAILY_D1_WRITE_BUDGET, oddsReserved: DAILY_ODDS_WRITE_BUDGET }));
    const fetch = vi.fn(async (url:string) => ({ ok: true, status: 200, text: async () => collectionPage(url) }));
    const result = await collectOdds(DB, boundary, { fetch, sleep: async () => {} });
    expect(result).toMatchObject({ status: 'success', targets: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const budget = JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get() as { value: string }).value);
    expect(budget.date).toBe(utcDay);
    expect(budget.reserved).toBeLessThan(DAILY_D1_WRITE_BUDGET);
  });

  it('fetches only after reservation and releases the lock on normal completion', async () => {
    race('collect-me');
    const fetch = vi.fn(async (url:string) => ({ ok: true, status: 200, text: async () => collectionPage(url) }));
    const result = await collectOdds(DB, now, { fetch, sleep: async () => {} });
    expect(result).toMatchObject({ status: 'success', records: 6, targets: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='odds_lock'").get()).toMatchObject({ value: '' });
    const budget = JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key='roi_d1_write_budget_utc'").get() as { value: string }).value);
    expect(budget.reserved).toBe(51);
  });

  it('does not fetch if budget initialization fails', async () => {
    race('blocked');
    sqlite.exec(`CREATE TRIGGER fail_odds_budget BEFORE UPDATE ON settings WHEN NEW.key='roi_d1_write_budget_utc'
      BEGIN SELECT RAISE(ABORT, 'simulated D1 write quota'); END`);
    const fetch = vi.fn();
    await expect(collectOdds(DB, now, { fetch })).rejects.toThrow('simulated D1 write quota');
    expect(fetch).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key='odds_lock'").get()).toMatchObject({ n: 0 });
  });

  it('does not settle bets on an off-boundary minute event', async () => {
    const betId = finishedOpenBet('off-boundary');
    let minute = Math.floor(Date.now() / 60_000) + 1;
    while (minute % 10 === 0) minute++;
    await worker.scheduled({ cron: '* * * * *', scheduledTime: minute * 60_000 } as ScheduledController, { DB, ENABLE_BOATRACE_ODDS_SCRAPE: 'false', ENABLE_AUTO_BET: 'false' } as never);
    expect(sqlite.prepare('SELECT status FROM bets WHERE id=?').get(betId)).toMatchObject({ status: 'open' });
    expect(sqlite.prepare('SELECT COUNT(*) n FROM collection_runs').get()).toMatchObject({ n: 0 });
  });

  it('runs ten-minute maintenance after a fail-closed odds reservation error', async () => {
    const betId = finishedOpenBet('boundary');
    const actualNow = new Date();
    race('collector-target', actualNow.getTime() + 5 * 60_000, jstDate(actualNow));
    sqlite.exec(`CREATE TRIGGER fail_odds_lock BEFORE UPDATE ON settings WHEN NEW.key='odds_lock'
      BEGIN SELECT RAISE(ABORT, 'simulated D1 write quota'); END`);
    const tenMinuteBoundary = Math.floor(Date.now() / 600_000) * 10;
    await worker.scheduled({ cron: '* * * * *', scheduledTime: tenMinuteBoundary * 60_000 } as ScheduledController, { DB, ENABLE_BOATRACE_ODDS_SCRAPE: 'true', ENABLE_AUTO_BET: 'false' } as never);
    expect(sqlite.prepare('SELECT status,payout FROM bets WHERE id=?').get(betId)).toMatchObject({ status: 'won', payout: 200 });
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='odds_lock'").get()).toMatchObject({ value: '' });
  });
});
