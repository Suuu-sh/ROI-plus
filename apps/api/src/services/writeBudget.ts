import type { Db } from '../repo/db.js';

export type WriteBudgetStatus = {
  date: string;
  enabled: false;
  limit: 0;
  essentialLimit: 0;
  optionalLimit: 0;
  oddsLimit: 0;
  allowance: null;
  reserved: null;
  essentialReserved: null;
  optionalReserved: null;
  oddsReserved: null;
  collectionReserved: null;
  collectionRemaining: null;
  remaining: null;
  essentialRemaining: null;
  optionalRemaining: null;
  state: 'known' | 'exhausted' | 'missing' | 'invalid' | 'disabled';
};
export type WriteCategory = 'odds' | 'optional' | 'essential' | 'collection' | 'ingest' | 'worker';
export type IngestTable = 'venues' | 'races' | 'entries' | 'odds_snapshots' | 'results' | 'payouts' | 'predictions' | 'ticket_predictions' | 'models' | 'collection_runs' | 'boatrace_prerace_observations';

export const utcDate = (date = new Date()) => date.toISOString().slice(0, 10);

/** Reports that the legacy application estimate is not an active quota meter. */
export async function readWriteBudget(_db: Db, date = utcDate()): Promise<WriteBudgetStatus> {
  return { date, enabled: false, limit: 0, essentialLimit: 0, optionalLimit: 0, oddsLimit: 0, allowance: null,
    reserved: null, essentialReserved: null, optionalReserved: null, oddsReserved: null,
    collectionReserved: null, collectionRemaining: null, remaining: null,
    essentialRemaining: null, optionalRemaining: null, state: 'disabled' };
}

/** Compatibility no-op: local estimated reservations no longer gate D1 writes. */
export async function reserveWriteBudget(_db: Db, _date: string, _units: number, _category: WriteCategory): Promise<boolean> {
  return true;
}
export async function reserveWriteBudgets(_db: Db, _date: string, _reservations: Array<{ units: number; category: WriteCategory }>): Promise<boolean> {
  return true;
}

// Conservative per-operation estimate helpers remain for metrics/log context;
// their output is no longer an admission limit or provider-quota estimate.
const INGEST_WRITE_FACTOR: Record<IngestTable, number> = {
  venues: 3, races: 5, entries: 4, odds_snapshots: 5, results: 3,
  payouts: 2, predictions: 4, ticket_predictions: 5, models: 3, 'collection_runs': 5,
  boatrace_prerace_observations: 5,
};
export const estimateIngestWriteUnits = (changedByTable: Partial<Record<IngestTable, number>>, sideEffectRows = 0) =>
  Math.max(1, Object.entries(changedByTable).reduce((sum, [table, count]) => sum + (count ?? 0) * INGEST_WRITE_FACTOR[table as IngestTable], sideEffectRows * 4) + 8);
export const estimateOddsWriteUnits = (targetCount: number, maxRowsPerRace = 6) =>
  Math.max(1, targetCount * maxRowsPerRace * INGEST_WRITE_FACTOR.odds_snapshots + 32);
export const estimateWorkerWriteUnits = (mutatedRows: number) => Math.max(1, mutatedRows * 6 + 8);
