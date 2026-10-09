import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import worker from '../src/index.js';
import { collectOdds, selectOddsTargets } from '../src/services/collectBoatraceOdds.js';
import { parseWinOdds } from '../src/services/boatraceOdds.js';
import { D1SqliteAdapter } from './d1-adapter.js';

const root = resolve(import.meta.dirname, '../../..');
const privateOddsFixture = resolve(root, 'data/private_fixtures/boatrace/oddstf_24_12_20261009.html');
const hasPrivateOddsFixture = (() => { try { readFileSync(privateOddsFixture); return true; } catch { return false; } })();
const now = new Date('2026-10-09T01:00:00.000Z');
const stamp = (ms: number) => new Date(ms + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
let sqlite: Sqlite.Database, DB: D1SqliteAdapter;
beforeEach(() => {
  sqlite = new Sqlite(':memory:'); DB = new D1SqliteAdapter(sqlite);
  for (const f of readdirSync(resolve(root, 'db/migrations')).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(resolve(root, 'db/migrations', f), 'utf8'));
  sqlite.prepare("INSERT INTO venues(id,sport,name) VALUES('24','boat','Fixture')").run();
});
afterEach(() => sqlite.close());
function race(id: string, post: number, origin = 'real', status = 'scheduled', no = 1) {
  sqlite.prepare(`INSERT INTO races(id,sport,venue_id,race_date,race_no,post_time,status,data_origin,updated_at)
    VALUES(?,'boat','24','2026-10-09',?,?,?, ?,?)`).run(id, no, stamp(post), status, origin, stamp(now.getTime()));
}

describe('Boatrace win odds collection', () => {
  it('parses fixture win odds and final marker', () => {
    const html = readFileSync(resolve(root, 'data/fixtures/boatrace/oddstf_24_12_20261009.html'), 'utf8');
    expect(parseWinOdds(html)).toEqual({ final: true, odds: [[1, 2.1], [2, 3.2], [3, 4.3], [4, 5.4], [5, 6.5], [6, 7.6]] });
  });

  it.skipIf(!hasPrivateOddsFixture)('parses private official odds regression fixture', () => {
    const html = readFileSync(privateOddsFixture, 'utf8');
    expect(parseWinOdds(html)).toEqual({ final: true, odds: [[1, 1.1], [2, 13.1], [3, 7.6], [4, 6.9], [5, 24.8], [6, 14.2]] });
  });

  it('selects only eligible races and caps at 30', async () => {
    race('inside', now.getTime() + 5 * 60_000);
    race('outside', now.getTime() + 26 * 60_000, 'real', 'scheduled', 2);
    race('sample', now.getTime() + 5 * 60_000, 'sample', 'scheduled', 3);
    race('finished', now.getTime() + 5 * 60_000, 'real', 'finished', 4);
    race('fresh', now.getTime() + 5 * 60_000, 'real', 'scheduled', 5);
    sqlite.prepare("INSERT INTO odds_snapshots(id,race_id,bet_type,selection,odds,captured_at,source,data_origin) VALUES('fresh-o','fresh','win','1',2,?,'test','real')").run(stamp(now.getTime() - 9 * 60_000));
    for (let i = 0; i < 32; i++) race(`extra-${i}`, now.getTime() + 6 * 60_000, 'real', 'scheduled', i + 6);
    const targets = await selectOddsTargets(DB, now, 100);
    expect(targets).toHaveLength(30);
    expect(targets.map(x => x.id)).not.toContain('outside');
    expect(targets.map(x => x.id)).not.toContain('sample');
    expect(targets.map(x => x.id)).not.toContain('finished');
    expect(targets.map(x => x.id)).not.toContain('fresh');
    expect(targets[0].id).toBe('inside');
  });

  it('fetches, stores numeric odds and logs a successful run with injectable sleep', async () => {
    race('fetch-race', now.getTime() + 5 * 60_000);
    race('fetch-race-2', now.getTime() + 6 * 60_000, 'real', 'scheduled', 2);
    const html = readFileSync(resolve(root, 'data/fixtures/boatrace/oddstf_24_12_20261009.html'), 'utf8');
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['User-Agent']).toBeTruthy();
      return { ok: true, status: 200, text: async () => html };
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await collectOdds(DB, now, { fetch, sleep });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(result).toMatchObject({ status: 'success', records: 12, targets: 2 });
    expect(sqlite.prepare("SELECT odds,source,data_origin,captured_at FROM odds_snapshots WHERE race_id='fetch-race' AND bet_type='win' ORDER BY selection").all()).toEqual(
      [[2.1, 'boatrace-odds-tf-final', 'real', stamp(now.getTime())], [3.2, 'boatrace-odds-tf-final', 'real', stamp(now.getTime())], [4.3, 'boatrace-odds-tf-final', 'real', stamp(now.getTime())], [5.4, 'boatrace-odds-tf-final', 'real', stamp(now.getTime())], [6.5, 'boatrace-odds-tf-final', 'real', stamp(now.getTime())], [7.6, 'boatrace-odds-tf-final', 'real', stamp(now.getTime())]].map(([odds, source, data_origin, captured_at]) => ({ odds, source, data_origin, captured_at })));
    expect(sqlite.prepare('SELECT source,status,records,error FROM collection_runs').get()).toMatchObject({ source: 'boatrace-odds-worker', status: 'success', records: 12, error: null });
  });

  it('does nothing when the Worker flag is disabled', async () => {
    race('flag-race', now.getTime() + 5 * 60_000);
    const fetch = vi.fn();
    await worker.scheduled({} as never, { DB, ENABLE_BOATRACE_ODDS_SCRAPE: 'false' } as never);
    expect(fetch).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) n FROM odds_snapshots').get()).toMatchObject({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) n FROM collection_runs').get()).toMatchObject({ n: 0 });
  });
});
