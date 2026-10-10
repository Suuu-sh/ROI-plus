import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import worker from '../src/index.js';
import { collectOdds, ODDS_DAILY_WRITE_BUDGET, reserveOddsWriteBudget, selectOddsTargets } from '../src/services/collectBoatraceOdds.js';
import { D1SqliteAdapter } from './d1-adapter.js';

const root = resolve(import.meta.dirname, '../../..');
const fixture = readFileSync(resolve(root, 'data/fixtures/boatrace/oddstf_24_12_20261009.html'), 'utf8');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const now = new Date(`${today}T03:00:00.000Z`);
const jstDate = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const stamp = (ms: number) => new Date(ms + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
let sqlite: Sqlite.Database, DB: D1SqliteAdapter, nextRaceNo = 1;

beforeEach(() => {
  nextRaceNo = 1;
  sqlite = new Sqlite(':memory:'); DB = new D1SqliteAdapter(sqlite);
  for (const f of readdirSync(resolve(root, 'db/migrations')).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(resolve(root, 'db/migrations', f), 'utf8'));
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('24','boat','Fixture')").run();
});
afterEach(() => sqlite.close());

function race(id: string, post = now.getTime() + 5 * 60_000, date = today) {
  sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at)
    VALUES(?,'boat','24',?,?,?,'scheduled','real',?)`).run(id, date, nextRaceNo++, stamp(post), stamp(now.getTime()));
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

  it('uses a 50-second freshness window', async () => {
    race('fresh-30s'); race('stale-60s');
    sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('fresh-odds','fresh-30s','win','1',2,?,'test','real')").run(stamp(now.getTime() - 30_000));
    sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('stale-odds','stale-60s','win','1',2,?,'test','real')").run(stamp(now.getTime() - 60_000));
    expect((await selectOddsTargets(DB, now)).map(x => x.id)).toEqual(['stale-60s']);
  });

  it('atomically reserves bounded estimates and fails closed on concurrent CAS conflict', async () => {
    const reserves = await Promise.all([
      reserveOddsWriteBudget(DB, today, 20),
      reserveOddsWriteBudget(DB, today, 20),
    ]);
    expect(reserves.filter(x => x > 0)).toHaveLength(1);
    expect(reserves.reduce((a, b) => a + b, 0)).toBe(20);
    const stored = JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key='odds_daily_write_budget'").get() as { value: string }).value);
    expect(stored.reserved).toBeLessThanOrEqual(ODDS_DAILY_WRITE_BUDGET);
    sqlite.prepare("UPDATE settings SET value=? WHERE key='odds_daily_write_budget'").run(JSON.stringify({ date: today, reserved: 9_920 }));
    expect(await reserveOddsWriteBudget(DB, today, 30)).toBe(2);
    expect(await reserveOddsWriteBudget(DB, today, 1)).toBe(0);
  });

  it('does not write a lock or budget when the UTC-day budget is exhausted', async () => {
    race('budget-exhausted');
    const utcDay = now.toISOString().slice(0, 10);
    sqlite.prepare("INSERT INTO settings(key,value) VALUES('odds_daily_write_budget',?)").run(JSON.stringify({ date: utcDay, reserved: ODDS_DAILY_WRITE_BUDGET }));
    const before = (sqlite.prepare('SELECT total_changes() changes').get() as { changes: number }).changes;
    const fetch = vi.fn();
    expect(await collectOdds(DB, now, { fetch })).toMatchObject({ status: 'skipped', targets: 0, reason: 'daily odds write budget exhausted' });
    expect(fetch).not.toHaveBeenCalled();
    expect((sqlite.prepare('SELECT total_changes() changes').get() as { changes: number }).changes).toBe(before);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key='odds_lock'").get()).toMatchObject({ n: 0 });
  });

  it('rolls the reservation at UTC midnight, independently of the JST target date', async () => {
    const boundary = new Date(`${today}T15:00:00.000Z`);
    const utcDay = boundary.toISOString().slice(0, 10);
    const previousUtcDay = new Date(Date.parse(`${utcDay}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
    race('utc-rollover', boundary.getTime() + 5 * 60_000, jstDate(boundary));
    sqlite.prepare("INSERT INTO settings(key,value) VALUES('odds_daily_write_budget',?)").run(JSON.stringify({ date: previousUtcDay, reserved: ODDS_DAILY_WRITE_BUDGET }));
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => fixture }));
    const result = await collectOdds(DB, boundary, { fetch, sleep: async () => {} });
    expect(result).toMatchObject({ status: 'success', targets: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const budget = JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key='odds_daily_write_budget'").get() as { value: string }).value);
    expect(budget.date).toBe(utcDay);
  });

  it('fetches only after reservation and releases the lock on normal completion', async () => {
    race('collect-me');
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => fixture }));
    const result = await collectOdds(DB, now, { fetch, sleep: async () => {} });
    expect(result).toMatchObject({ status: 'success', records: 6, targets: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='odds_lock'").get()).toMatchObject({ value: '' });
    const budget = JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key='odds_daily_write_budget'").get() as { value: string }).value);
    expect(budget.reserved).toBe(48);
  });

  it('does not fetch if budget initialization fails', async () => {
    race('blocked');
    sqlite.exec(`CREATE TRIGGER fail_odds_budget BEFORE INSERT ON settings WHEN NEW.key='odds_daily_write_budget'
      BEGIN SELECT RAISE(ABORT, 'simulated D1 write quota'); END`);
    const fetch = vi.fn();
    await expect(collectOdds(DB, now, { fetch })).rejects.toThrow('simulated D1 write quota');
    expect(fetch).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key='odds_lock'").get()).toMatchObject({ n: 0 });
  });

  it('keeps the every-minute event isolated from settlement and auto-bet work', async () => {
    const betRace = 'minute-does-not-settle';
    sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,status,data_origin,updated_at)
      VALUES(?,'boat','24',?,2,'finished','real',?)`).run(betRace, today, stamp(now.getTime()));
    sqlite.prepare(`INSERT INTO bets(id,race_id,sport,bet_type,selection,stake,mode,predicted_prob,odds_at_bet,expected_roi,edge_label,placed_at,status,data_origin)
      VALUES('minute-open-bet',?,'boat','win','1',100,'manual',0.5,2,0,'NEUTRAL',?,'open','real')`).run(betRace, stamp(now.getTime()));
    await worker.scheduled({ cron: '* * * * *' } as ScheduledController, { DB, ENABLE_BOATRACE_ODDS_SCRAPE: 'false', ENABLE_AUTO_BET: 'false' } as never);
    expect(sqlite.prepare("SELECT status FROM bets WHERE id='minute-open-bet'").get()).toMatchObject({ status: 'open' });
    expect(sqlite.prepare('SELECT COUNT(*) n FROM collection_runs').get()).toMatchObject({ n: 0 });
  });
});
