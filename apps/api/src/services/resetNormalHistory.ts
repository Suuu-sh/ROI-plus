import { all, type Db } from '../repo/db.js';

const tables = ['bets', 'daily_summaries', 'paper_decisions', 'experimental_paper_bets', 'experimental_paper_decisions', 'experimental_bankroll'] as const;
type Table = typeof tables[number];
export type NormalHistorySnapshot = { version: 1; capturedAt: string; tables: Record<Table, string>; initialBankroll: string; };

/** Schema-aware canonical rows. Only fixed purchase tables, never secret settings. */
export async function snapshotQueries(db: Db) {
  const queries = {} as Record<Table, string>;
  for (const table of tables) {
    const columns = await all<{ name: string }>(db, `PRAGMA table_info(${table})`);
    if (!columns.length || columns.some(c => !/^[a-z_]+$/.test(c.name))) throw new Error('purchase schema unavailable');
    const fields = columns.map(c => `'${c.name}',"${c.name}"`).join(',');
    const order = columns.map(c => `"${c.name}"`).join(',');
    queries[table] = `SELECT COALESCE(json_group_array(json_object(${fields})), '[]') AS rows FROM (SELECT * FROM ${table} ORDER BY ${order})`;
  }
  return queries;
}
const initialQuery = "SELECT COALESCE((SELECT value FROM settings WHERE key='initial_bankroll'),'100000') AS rows";
export async function normalHistorySnapshot(db: Db): Promise<NormalHistorySnapshot> {
  if (!db.batch) throw new Error('atomic database batch required');
  const queries = await snapshotQueries(db);
  const result = await db.batch([...tables.map(t => db.prepare(queries[t])), db.prepare(initialQuery)]) as { results: { rows: string }[] }[];
  const rows = {} as Record<Table, string>;
  tables.forEach((table, i) => { rows[table] = result[i].results[0].rows; });
  return { version: 1, capturedAt: new Date().toISOString(), tables: rows, initialBankroll: result[tables.length].results[0].rows };
}
export function validSnapshot(value: unknown): value is NormalHistorySnapshot {
  const v = value as NormalHistorySnapshot;
  return v?.version === 1 && typeof v.initialBankroll === 'string' && tables.every(t => {
    try { return typeof v.tables?.[t] === 'string' && Array.isArray(JSON.parse(v.tables[t])); } catch { return false; }
  });
}
export async function resetNormalHistory(db: Db, expected: NormalHistorySnapshot) {
  if (!db.batch || !validSnapshot(expected)) throw new Error('valid snapshot and atomic batch required');
  const queries = await snapshotQueries(db);
  // The failing JSON expression aborts the whole transaction before any DELETE.
  // Compare every row, not counts, to refuse writes/settlements since the uploaded backup.
  const predicates = [...tables.map(t => `(${queries[t]}) = ?`), `(${initialQuery}) = ?`];
  await db.batch([
    db.prepare(`SELECT CASE WHEN ${predicates.join(' AND ')} THEN 1 ELSE json('snapshot changed: reset refused') END AS guarded`).bind(...tables.map(t => expected.tables[t]), expected.initialBankroll),
    db.prepare('DELETE FROM bets'),
    db.prepare('DELETE FROM daily_summaries'),
  ]);
  return { deletedBets: JSON.parse(expected.tables.bets).length, deletedDailySummaries: JSON.parse(expected.tables.daily_summaries).length, initialBankroll: Number(expected.initialBankroll) };
}
