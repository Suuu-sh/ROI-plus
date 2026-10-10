import type { Db } from '../repo/db.js';

export const DAILY_D1_WRITE_BUDGET = 20_000;
export const DAILY_ODDS_WRITE_BUDGET = 10_000;
export const D1_WRITE_BUDGET_KEY = 'roi_d1_write_budget_utc';

export type WriteBudget = { date: string; reserved: number; oddsReserved: number };
export type WriteBudgetStatus = {
  date: string;
  limit: number;
  oddsLimit: number;
  reserved: number | null;
  oddsReserved: number | null;
  remaining: number | null;
  state: 'known' | 'exhausted' | 'missing' | 'invalid';
};
export type WriteCategory = 'odds' | 'ingest' | 'worker';
export type IngestTable = 'venues' | 'races' | 'entries' | 'odds_snapshots' | 'results' | 'payouts' | 'predictions' | 'models' | 'collection_runs';

const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
function parse(value: string): WriteBudget | null {
  try {
    const parsed = JSON.parse(value) as Partial<WriteBudget>;
    if (!validDate(parsed.date) || !Number.isSafeInteger(parsed.reserved) ||
      (parsed.reserved as number) < 0 || (parsed.reserved as number) > DAILY_D1_WRITE_BUDGET ||
      !Number.isSafeInteger(parsed.oddsReserved) || (parsed.oddsReserved as number) < 0 ||
      (parsed.oddsReserved as number) > DAILY_ODDS_WRITE_BUDGET || (parsed.oddsReserved as number) > (parsed.reserved as number)) return null;
    return { date: parsed.date, reserved: parsed.reserved as number, oddsReserved: parsed.oddsReserved as number };
  } catch { return null; }
}

export const utcDate = (date = new Date()) => date.toISOString().slice(0, 10);

export async function readWriteBudget(db: Db, date = utcDate()): Promise<WriteBudgetStatus> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key=?`).bind(D1_WRITE_BUDGET_KEY).first<{ value: string }>();
  const common = { date, limit: DAILY_D1_WRITE_BUDGET, oddsLimit: DAILY_ODDS_WRITE_BUDGET };
  if (!row) return { ...common, reserved: null, oddsReserved: null, remaining: null, state: 'missing' };
  const value = parse(row.value);
  if (!value || value.date > date) return { ...common, reserved: null, oddsReserved: null, remaining: null, state: 'invalid' };
  const reserved = value.date === date ? value.reserved : 0;
  const oddsReserved = value.date === date ? value.oddsReserved : 0;
  return { ...common, reserved, oddsReserved, remaining: DAILY_D1_WRITE_BUDGET - reserved, state: reserved >= DAILY_D1_WRITE_BUDGET ? 'exhausted' : 'known' };
}

/**
 * Reserve a conservative number of D1 write units before starting work.
 * Missing/corrupt state and CAS contention fail closed. Daily rollover is an
 * atomic compare-and-swap; no worker silently seeds an unknown day's quota.
 */
export async function reserveWriteBudget(db: Db, date: string, units: number, category: WriteCategory): Promise<boolean> {
  if (!validDate(date) || !Number.isSafeInteger(units) || units <= 0 || units > DAILY_D1_WRITE_BUDGET) return false;
  const row = await db.prepare(`SELECT value FROM settings WHERE key=?`).bind(D1_WRITE_BUDGET_KEY).first<{ value: string }>();
  if (!row) return false;
  const prior = parse(row.value);
  if (!prior || prior.date > date) return false;
  const reserved = prior.date === date ? prior.reserved : 0;
  const oddsReserved = prior.date === date ? prior.oddsReserved : 0;
  if (reserved + units > DAILY_D1_WRITE_BUDGET) return false;
  const nextOdds = oddsReserved + (category === 'odds' ? units : 0);
  if (nextOdds > DAILY_ODDS_WRITE_BUDGET) return false;
  const next = JSON.stringify({ date, reserved: reserved + units, oddsReserved: nextOdds });
  const result = await db.prepare(`UPDATE settings SET value=? WHERE key=? AND value=?`)
    .bind(next, D1_WRITE_BUDGET_KEY, row.value).run();
  return result.meta?.changes === 1;
}

/** Explicit operator seeding. Reserve the full current UTC day when previous usage is unknown. */
export async function seedUnknownWriteBudget(db: Db, date: string): Promise<boolean> {
  if (!validDate(date)) return false;
  const value = JSON.stringify({ date, reserved: DAILY_D1_WRITE_BUDGET, oddsReserved: DAILY_ODDS_WRITE_BUDGET });
  const result = await db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING`)
    .bind(D1_WRITE_BUDGET_KEY, value).run();
  return result.meta?.changes === 1;
}

// Rough SQLite row + affected-index amplification, derived from 0001_init.sql.
// Use a higher allowance for hot indexed tables, but keep the factor bounded
// enough that a full 500-row entries/predictions chunk can still fit a day.
const INGEST_WRITE_FACTOR: Record<IngestTable, number> = {
  venues: 3, races: 5, entries: 4, odds_snapshots: 5, results: 3,
  payouts: 2, predictions: 4, models: 3, 'collection_runs': 5,
};
// +8 includes the atomic ledger CAS plus fixed statement/index margin; odds
// +32 includes lock acquire/release and one collection-run row per batch.
export const estimateIngestWriteUnits = (changedByTable: Partial<Record<IngestTable, number>>, sideEffectRows = 0) =>
  Math.max(1, Object.entries(changedByTable).reduce((sum, [table, count]) => sum + (count ?? 0) * INGEST_WRITE_FACTOR[table as IngestTable], sideEffectRows * 4) + 8);
export const estimateOddsWriteUnits = (targetCount: number, maxRowsPerRace = 6) =>
  Math.max(1, targetCount * maxRowsPerRace * INGEST_WRITE_FACTOR.odds_snapshots + 32);
export const estimateWorkerWriteUnits = (mutatedRows: number) => Math.max(1, mutatedRows * 6 + 8);
