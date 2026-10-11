import type { Db } from '../repo/db.js';

export const DAILY_D1_WRITE_BUDGET = 20_000;
export const DAILY_ESSENTIAL_WRITE_BUDGET = 16_000;
export const DAILY_OPTIONAL_WRITE_BUDGET = 4_000;
// Odds are optional work and share the optional 4k ceiling (not an additional allowance).
export const DAILY_ODDS_WRITE_BUDGET = 4_000;
export const D1_WRITE_BUDGET_KEY = 'roi_d1_write_budget_utc';
export const ONE_DAY_ALLOWANCE = { limit: 30_000, essentialLimit: 24_000, optionalLimit: 6_000, oddsLimit: 6_000 } as const;
const DEFAULT_LIMITS = { limit: DAILY_D1_WRITE_BUDGET, essentialLimit: DAILY_ESSENTIAL_WRITE_BUDGET, optionalLimit: DAILY_OPTIONAL_WRITE_BUDGET, oddsLimit: DAILY_ODDS_WRITE_BUDGET } as const;

type OneDayAllowance = { date: string } & typeof ONE_DAY_ALLOWANCE;

export type WriteBudget = {
  date: string;
  reserved: number;
  oddsReserved: number;
  essentialReserved: number;
  optionalReserved: number;
  allowance?: OneDayAllowance;
};
export type WriteBudgetStatus = {
  date: string;
  limit: number;
  essentialLimit: number;
  optionalLimit: number;
  oddsLimit: number;
  allowance: OneDayAllowance | null;
  reserved: number | null;
  essentialReserved: number | null;
  optionalReserved: number | null;
  oddsReserved: number | null;
  remaining: number | null;
  essentialRemaining: number | null;
  optionalRemaining: number | null;
  state: 'known' | 'exhausted' | 'missing' | 'invalid';
};
export type WriteCategory = 'odds' | 'optional' | 'essential' | 'ingest' | 'worker';
export type IngestTable = 'venues' | 'races' | 'entries' | 'odds_snapshots' | 'results' | 'payouts' | 'predictions' | 'ticket_predictions' | 'models' | 'collection_runs';

const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
function parse(value: string): WriteBudget | null {
  try {
    const parsed = JSON.parse(value) as Partial<WriteBudget>;
    const rawAllowance = (parsed as Partial<WriteBudget>).allowance;
    let allowance: OneDayAllowance | undefined;
    if (rawAllowance !== undefined) {
      if (!rawAllowance || !validDate(rawAllowance.date) || rawAllowance.date !== parsed.date ||
        rawAllowance.limit !== ONE_DAY_ALLOWANCE.limit || rawAllowance.essentialLimit !== ONE_DAY_ALLOWANCE.essentialLimit ||
        rawAllowance.optionalLimit !== ONE_DAY_ALLOWANCE.optionalLimit || rawAllowance.oddsLimit !== ONE_DAY_ALLOWANCE.oddsLimit) return null;
      allowance = { date: rawAllowance.date, ...ONE_DAY_ALLOWANCE };
    }
    const limit = allowance?.limit ?? DAILY_D1_WRITE_BUDGET;
    const essentialLimit = allowance?.essentialLimit ?? DAILY_ESSENTIAL_WRITE_BUDGET;
    const optionalLimit = allowance?.optionalLimit ?? DAILY_OPTIONAL_WRITE_BUDGET;
    if (!validDate(parsed.date) || !Number.isSafeInteger(parsed.reserved) ||
      (parsed.reserved as number) < 0 || (parsed.reserved as number) > limit ||
      !Number.isSafeInteger(parsed.oddsReserved) || (parsed.oddsReserved as number) < 0 ||
      // Pre-split ledgers used the old 10k odds cap. Read them without
      // resetting; the new 4k cap applies to new reservations only.
      (parsed.oddsReserved as number) > 10_000 || (parsed.oddsReserved as number) > (parsed.reserved as number)) return null;
    // Old ledgers predate category counters. Conservatively charge their first
    // optional-cap worth of usage to optional work; never reset/refund `reserved`.
    const hasCategoryCounters = parsed.essentialReserved !== undefined || parsed.optionalReserved !== undefined;
    if (allowance && !hasCategoryCounters) return null;
    let essentialReserved: number, optionalReserved: number;
    if (!hasCategoryCounters) {
      optionalReserved = Math.min(optionalLimit, parsed.reserved as number);
      essentialReserved = (parsed.reserved as number) - optionalReserved;
    } else {
      if (!Number.isSafeInteger(parsed.essentialReserved) || !Number.isSafeInteger(parsed.optionalReserved) ||
        (parsed.essentialReserved as number) < 0 || (parsed.essentialReserved as number) > essentialLimit ||
        (parsed.optionalReserved as number) < 0 || (parsed.optionalReserved as number) > optionalLimit ||
        (parsed.essentialReserved as number) + (parsed.optionalReserved as number) !== parsed.reserved) return null;
      essentialReserved = parsed.essentialReserved as number;
      optionalReserved = parsed.optionalReserved as number;
    }
    return { date: parsed.date, reserved: parsed.reserved as number, oddsReserved: parsed.oddsReserved as number, essentialReserved, optionalReserved, ...(allowance ? { allowance } : {}) };
  } catch { return null; }
}

export const utcDate = (date = new Date()) => date.toISOString().slice(0, 10);

export async function readWriteBudget(db: Db, date = utcDate()): Promise<WriteBudgetStatus> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key=?`).bind(D1_WRITE_BUDGET_KEY).first<{ value: string }>();
  const common = { date, limit: DAILY_D1_WRITE_BUDGET, essentialLimit: DAILY_ESSENTIAL_WRITE_BUDGET, optionalLimit: DAILY_OPTIONAL_WRITE_BUDGET, oddsLimit: DAILY_ODDS_WRITE_BUDGET, allowance: null as OneDayAllowance | null };
  if (!row) return { ...common, reserved: null, essentialReserved: null, optionalReserved: null, oddsReserved: null, remaining: null, essentialRemaining: null, optionalRemaining: null, state: 'missing' };
  const value = parse(row.value);
  if (!value || value.date > date) return { ...common, reserved: null, essentialReserved: null, optionalReserved: null, oddsReserved: null, remaining: null, essentialRemaining: null, optionalRemaining: null, state: 'invalid' };
  const sameDay = value.date === date;
  const allowance = sameDay ? value.allowance ?? null : null;
  const effective = allowance ?? DEFAULT_LIMITS;
  const reserved = sameDay ? value.reserved : 0;
  const essentialReserved = sameDay ? value.essentialReserved : 0;
  const optionalReserved = sameDay ? value.optionalReserved : 0;
  const oddsReserved = sameDay ? value.oddsReserved : 0;
  return { ...common, ...effective, allowance, reserved, essentialReserved, optionalReserved, oddsReserved,
    remaining: effective.limit - reserved,
    essentialRemaining: effective.essentialLimit - essentialReserved,
    optionalRemaining: effective.optionalLimit - optionalReserved,
    state: reserved >= effective.limit ? 'exhausted' : 'known' };
}

/**
 * Reserve conservative write units before starting work. Essential work gets
 * its own 16k protected bucket; odds, cleanup, history, and logs share only
 * 4k. The legacy `ingest`/`worker` categories remain accepted as optional for
 * conservative compatibility. CAS contention and retries are charged, never refunded.
 */
export async function reserveWriteBudget(db: Db, date: string, units: number, category: WriteCategory): Promise<boolean> {
  return reserveWriteBudgets(db, date, [{ units, category }]);
}

/** Reserve multiple priority classes in one CAS so a denied mixed batch does not charge either bucket. */
export async function reserveWriteBudgets(db: Db, date: string, reservations: Array<{ units: number; category: WriteCategory }>): Promise<boolean> {
  if (!validDate(date) || !reservations.length || reservations.some(({units}) => !Number.isSafeInteger(units) || units <= 0 || units > DAILY_D1_WRITE_BUDGET)) return false;
  const row = await db.prepare(`SELECT value FROM settings WHERE key=?`).bind(D1_WRITE_BUDGET_KEY).first<{ value: string }>();
  if (!row) return false;
  const prior = parse(row.value);
  if (!prior || prior.date > date) return false;
  const sameDay = prior.date === date;
  const reserved = sameDay ? prior.reserved : 0;
  const essentialReserved = sameDay ? prior.essentialReserved : 0;
  const optionalReserved = sameDay ? prior.optionalReserved : 0;
  const oddsReserved = sameDay ? prior.oddsReserved : 0;
  const allowance = sameDay ? prior.allowance : undefined;
  const limits = allowance ?? DEFAULT_LIMITS;
  const requestedEssential = reservations.filter(x => x.category === 'essential').reduce((sum,x) => sum+x.units,0);
  const requestedOptional = reservations.filter(x => x.category !== 'essential').reduce((sum,x) => sum+x.units,0);
  const requestedOdds = reservations.filter(x => x.category === 'odds').reduce((sum,x) => sum+x.units,0);
  const requested = requestedEssential + requestedOptional;
  if (reserved + requested > limits.limit
    || essentialReserved + requestedEssential > limits.essentialLimit
    || optionalReserved + requestedOptional > limits.optionalLimit
    || (requestedOdds > 0 && oddsReserved + requestedOdds > limits.oddsLimit)) return false;
  const next = JSON.stringify({ date, reserved: reserved + requested, oddsReserved: oddsReserved + requestedOdds,
    essentialReserved: essentialReserved + requestedEssential, optionalReserved: optionalReserved + requestedOptional, ...(allowance ? { allowance } : {}) });
  const result = await db.prepare(`UPDATE settings SET value=? WHERE key=? AND value=?`)
    .bind(next, D1_WRITE_BUDGET_KEY, row.value).run();
  return result.meta?.changes === 1;
}

/** Add the sole whitelisted one-day allowance to a known current-day ledger, preserving all reservations. */
export async function allowOneDayWriteBudget(db: Db, date: string): Promise<boolean> {
  const allowanceWriteUnits = 2;
  if (!validDate(date)) return false;
  const row = await db.prepare(`SELECT value FROM settings WHERE key=?`).bind(D1_WRITE_BUDGET_KEY).first<{ value: string }>();
  if (!row) return false;
  const prior = parse(row.value);
  if (!prior || prior.date !== date || prior.reserved + allowanceWriteUnits > DAILY_D1_WRITE_BUDGET ||
      prior.essentialReserved + allowanceWriteUnits > DAILY_ESSENTIAL_WRITE_BUDGET) return false;
  if (prior.allowance) return false;
  if (prior.reserved > ONE_DAY_ALLOWANCE.limit || prior.essentialReserved > ONE_DAY_ALLOWANCE.essentialLimit || prior.optionalReserved > ONE_DAY_ALLOWANCE.optionalLimit) return false;
  const next = JSON.stringify({ ...prior, reserved: prior.reserved + allowanceWriteUnits,
    essentialReserved: prior.essentialReserved + allowanceWriteUnits, allowance: { date, ...ONE_DAY_ALLOWANCE } });
  const result = await db.prepare(`UPDATE settings SET value=? WHERE key=? AND value=?`).bind(next, D1_WRITE_BUDGET_KEY, row.value).run();
  return result.meta?.changes === 1;
}

/** Explicit operator seeding reserves today's complete shared allowance. */
export async function seedUnknownWriteBudget(db: Db, date: string): Promise<boolean> {
  if (!validDate(date)) return false;
  const value = JSON.stringify({ date, reserved: DAILY_D1_WRITE_BUDGET, oddsReserved: DAILY_ODDS_WRITE_BUDGET,
    essentialReserved: DAILY_ESSENTIAL_WRITE_BUDGET, optionalReserved: DAILY_OPTIONAL_WRITE_BUDGET });
  const result = await db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING`)
    .bind(D1_WRITE_BUDGET_KEY, value).run();
  return result.meta?.changes === 1;
}

// Rough SQLite row + affected-index amplification, derived from 0001_init.sql.
const INGEST_WRITE_FACTOR: Record<IngestTable, number> = {
  venues: 3, races: 5, entries: 4, odds_snapshots: 5, results: 3,
  payouts: 2, predictions: 4, ticket_predictions: 5, models: 3, 'collection_runs': 5,
};
export const estimateIngestWriteUnits = (changedByTable: Partial<Record<IngestTable, number>>, sideEffectRows = 0) =>
  Math.max(1, Object.entries(changedByTable).reduce((sum, [table, count]) => sum + (count ?? 0) * INGEST_WRITE_FACTOR[table as IngestTable], sideEffectRows * 4) + 8);
export const estimateOddsWriteUnits = (targetCount: number, maxRowsPerRace = 6) =>
  Math.max(1, targetCount * maxRowsPerRace * INGEST_WRITE_FACTOR.odds_snapshots + 32);
export const estimateWorkerWriteUnits = (mutatedRows: number) => Math.max(1, mutatedRows * 6 + 8);
