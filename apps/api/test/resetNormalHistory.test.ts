import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from '../src/repo/db.js';
import { normalHistorySnapshot, resetNormalHistory } from '../src/services/resetNormalHistory.js';
import { app } from '../src/index.js';
let sqlite: Sqlite.Database, db: Db;
function adapter(): Db {
  return { prepare(sql) {
    let values: unknown[] = [];
    return { sql, get values() { return values }, bind(...v: unknown[]) { values = v; return this },
      async first<T>() { return sqlite.prepare(sql).get(...values) as T },
      async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[] } },
      async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } } },
    } as any;
  }, async batch(statements) {
    return sqlite.transaction(() => statements.map((s: any) => {
      const stmt = sqlite.prepare(s.sql);
      return stmt.reader ? { results: stmt.all(...s.values) } : { meta: { changes: stmt.run(...s.values).changes } };
    }))();
  } };
}
const root = resolve(import.meta.dirname, '../../..');
beforeEach(() => {
  sqlite = new Sqlite(':memory:'); db = adapter();
  for (const file of readdirSync(resolve(root, 'db/migrations')).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(resolve(root, 'db/migrations', file), 'utf8'));
  sqlite.exec(readFileSync(resolve(root, 'db/seed/sample.sql'), 'utf8'));
  sqlite.exec("INSERT OR REPLACE INTO daily_summaries(date,sport,bets,stake,payout) VALUES('2026-10-14','boat',1,100,0)");
});
afterEach(() => sqlite.close());
describe('normal only backed up reset', () => {
  it('atomically clears only normal bets and derived daily summaries preserving initial setting and protected rows', async () => {
    const before = await normalHistorySnapshot(db);
    expect(JSON.parse(before.tables.bets).length).toBeGreaterThan(0);
    const races = sqlite.prepare('SELECT COUNT(*) AS n FROM races').get();
    const result = await resetNormalHistory(db, before);
    expect(result.deletedBets).toBe(JSON.parse(before.tables.bets).length);
    const after = await normalHistorySnapshot(db);
    expect(after.tables.bets).toBe('[]'); expect(after.tables.daily_summaries).toBe('[]');
    for (const table of ['paper_decisions','experimental_paper_bets','experimental_paper_decisions','experimental_bankroll'] as const) expect(after.tables[table]).toBe(before.tables[table]);
    expect(after.initialBankroll).toBe(before.initialBankroll);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM races').get()).toEqual(races);
  });
  it('refuses stale backup with zero partial deletion', async () => {
    const before = await normalHistorySnapshot(db);
    sqlite.exec('UPDATE bets SET stake=stake+100');
    await expect(resetNormalHistory(db, before)).rejects.toThrow();
    expect(JSON.parse((await normalHistorySnapshot(db)).tables.bets).length).toBe(JSON.parse(before.tables.bets).length);
    expect((await normalHistorySnapshot(db)).tables.daily_summaries).toBe(before.tables.daily_summaries);
  });
  it('refuses concurrent experimental state changes without changing normal state', async () => {
    const before = await normalHistorySnapshot(db);
    sqlite.exec('UPDATE experimental_bankroll SET available_balance=available_balance-100');
    await expect(resetNormalHistory(db, before)).rejects.toThrow();
    expect((await normalHistorySnapshot(db)).tables.bets).toBe(before.tables.bets);
  });
  it('requires ingest authorization and exact destructive confirmation', async () => {
    const env = { DB: db, INGEST_TOKEN: 'fixture-only' };
    expect((await app.request('/api/ingest/normal-history/snapshot', {}, env)).status).toBe(401);
    expect((await app.request('/api/ingest/normal-history/reset', { method:'POST', headers:{Authorization:'Bearer fixture-only','Content-Type':'application/json'}, body:JSON.stringify({snapshot: await normalHistorySnapshot(db)}) }, env)).status).toBe(400);
    const response = await app.request('/api/ingest/normal-history/reset', { method:'POST', headers:{Authorization:'Bearer fixture-only','Content-Type':'application/json'}, body:JSON.stringify({confirmation:'RESET NORMAL PURCHASE HISTORY ONLY',snapshot: await normalHistorySnapshot(db)}) }, env);
    expect(response.status).toBe(200);
  });
});
