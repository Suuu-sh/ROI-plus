import { first, run, type Db } from '../repo/db.js';
import { readDailyCloudPipelineStatus } from './dailyCloudPipeline.js';
import { runNativeNormalDailyLearner } from './runNativeDailyLearner.js';
import type { NativeLearnerResult } from './runNativeDailyLearner.js';

const STATE_PREFIX = 'native_normal_learning_state_v1:';
const LEASE_PREFIX = 'native_normal_learning_lease_v1:';
const LEASE_MS = 6 * 60_000;
const MAX_ATTEMPTS = 4;
const SAFE_REASONS = new Set(['learning-not-ready', 'learning-service-unavailable', 'learning-already-running']);
const SAFE_STAGES = new Set(['request-json', 'experimental-learn', 'normal-learn', 'lease', 'load-cohort', 'feature-build', 'fit', 'persist-candidate', 'persist-report', 'response']);
const SAFE_ERRORS = new Set(['AttributeError', 'ImportError', 'IndexError', 'KeyError', 'MemoryError', 'OverflowError', 'RuntimeError', 'TimeoutError', 'TypeError', 'ValueError', 'OtherError']);

export type NativeNormalLearningState = {
  schema: 'native-normal-learning-v1';
  date: string;
  state: 'unconfigured' | 'waiting_sources' | 'pending' | 'success' | 'failed';
  attempts: number;
  updatedAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  reason: string | null;
  reportStatus: 'candidate' | 'insufficient_data' | null;
  candidateArtifactCreated: boolean;
  diagnostic?: { stage: string; errorClass: string } | null;
  diagnosticRevision?: 1;
  recoveryRetryUsed?: boolean;
};

export type NativeNormalLearningOutcome = 'outside-window' | 'busy' | 'waiting-sources' | 'idle' | 'attempted';

function jstParts(timestamp: number) {
  const values = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp));
  const parts = Object.fromEntries(values.map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function emptyState(date: string, state: NativeNormalLearningState['state'] = 'waiting_sources'): NativeNormalLearningState {
  return { schema: 'native-normal-learning-v1', date, state, attempts: 0, updatedAt: new Date().toISOString(),
    lastAttemptAt: null, nextAttemptAt: null, reason: state === 'unconfigured' ? 'learning-service-not-configured'
      : state === 'waiting_sources' ? 'source-data-not-ready' : null,
    reportStatus: null, candidateArtifactCreated: false };
}

async function readState(db: Db, date: string): Promise<NativeNormalLearningState> {
  const row = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key=?', `${STATE_PREFIX}${date}`);
  try {
    const value: unknown = row?.value ? JSON.parse(row.value) : null;
    if (value && typeof value === 'object') {
      const state = value as NativeNormalLearningState;
      if (state.schema === 'native-normal-learning-v1' && state.date === date
          && ['unconfigured', 'waiting_sources', 'pending', 'success', 'failed'].includes(state.state)) {
        if (state.state === 'failed' && state.reason === 'learning-service-unavailable'
            && state.diagnosticRevision !== 1 && state.recoveryRetryUsed !== true) {
          state.state = 'pending'; state.nextAttemptAt = null; state.recoveryRetryUsed = true;
        }
        return state;
      }
    }
  } catch { /* replace malformed state with a safe empty state */ }
  return emptyState(date);
}

async function writeState(db: Db, state: NativeNormalLearningState, timestamp: number): Promise<void> {
  state.updatedAt = new Date(timestamp).toISOString();
  await run(db, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    `${STATE_PREFIX}${state.date}`, JSON.stringify(state));
}

async function claimLease(db: Db, date: string, timestamp: number): Promise<string | null> {
  const owner = crypto.randomUUID();
  const key = `${LEASE_PREFIX}${date}`;
  const value = JSON.stringify({ owner, leaseUntil: timestamp + LEASE_MS });
  const row = await first<{ value: string }>(db, `INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE (CASE WHEN json_valid(settings.value) THEN CAST(COALESCE(json_extract(settings.value,'$.leaseUntil'),0) AS INTEGER) ELSE 0 END) <= ?
    RETURNING value`, key, value, timestamp);
  return row ? owner : null;
}

async function releaseLease(db: Db, date: string, owner: string): Promise<void> {
  await run(db, `UPDATE settings SET value=? WHERE key=? AND json_valid(value) AND json_extract(value,'$.owner')=?`,
    JSON.stringify({ leaseUntil: 0 }), `${LEASE_PREFIX}${date}`, owner);
}

/** Safe status projection; returns no settings JSON, model IDs, artifact keys, or training details. */
export async function readNativeNormalLearningStatus(db: Db, now = Date.now()): Promise<Record<string, unknown>> {
  const { date } = jstParts(now);
  const row = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key=?', `${STATE_PREFIX}${date}`);
  if (!row?.value) {
    return { date, state: 'waiting_sources', attempts: 0, updatedAt: null,
      lastAttemptAt: null, nextAttemptAt: null, reason: 'not-run-yet', reportStatus: null,
      candidateArtifactCreated: false };
  }
  const state = await readState(db, date);
  return { date, state: state.state, attempts: Number.isSafeInteger(state.attempts) && state.attempts >= 0 ? state.attempts : 0,
    updatedAt: Number.isFinite(Date.parse(state.updatedAt)) ? state.updatedAt : null,
    lastAttemptAt: state.lastAttemptAt && Number.isFinite(Date.parse(state.lastAttemptAt)) ? state.lastAttemptAt : null,
    nextAttemptAt: state.nextAttemptAt && Number.isFinite(Date.parse(state.nextAttemptAt)) ? state.nextAttemptAt : null,
    reason: state.reason && (SAFE_REASONS.has(state.reason) || state.reason === 'source-data-not-ready'
      || state.reason === 'learning-service-not-configured') ? state.reason : null,
    diagnosticRevision: state.diagnosticRevision === 1 ? 1 : null,
    diagnostic: state.diagnostic && SAFE_STAGES.has(state.diagnostic.stage) && SAFE_ERRORS.has(state.diagnostic.errorClass)
      ? { stage: state.diagnostic.stage, errorClass: state.diagnostic.errorClass } : null,
    reportStatus: state.reportStatus === 'candidate' || state.reportStatus === 'insufficient_data' ? state.reportStatus : null,
    candidateArtifactCreated: state.candidateArtifactCreated === true };
}

function retryAt(timestamp: number, attempts: number): string {
  return new Date(timestamp + Math.min(30, 5 * 2 ** Math.max(0, attempts - 1)) * 60_000).toISOString();
}

/** Runs the normal candidate learner separately from the experimental learner and source-sync cron. */
export async function runNativeNormalLearningPipeline(db: Db, options: {
  learner?: Fetcher;
  now?: () => number;
  runLearning?: (targetDate: string) => Promise<NativeLearnerResult>;
  log?: (line: string) => void;
} = {}): Promise<{ outcome: NativeNormalLearningOutcome; state: NativeNormalLearningState }> {
  const log = options.log ?? ((line: string) => console.info(line));
  const emit = (status: string, reason?: string) => log(JSON.stringify({ event: 'native-normal-learning', status, ...(reason ? { reason } : {}) }));
  const timestamp = (options.now ?? Date.now)();
  if (!Number.isFinite(timestamp)) { emit('failed', 'invalid-clock'); return { outcome: 'outside-window', state: emptyState('1970-01-01') }; }
  const { date, minute } = jstParts(timestamp);
  let state = await readState(db, date);
  if (minute < 180 || minute >= 23 * 60 + 30) { emit('outside-window'); return { outcome: 'outside-window', state }; }
  if (state.state === 'success' || state.state === 'failed') {
    emit(state.state);
    return { outcome: 'idle', state };
  }
  if (!options.learner && !options.runLearning) {
    state = { ...state, state: 'unconfigured', reason: 'learning-service-not-configured', nextAttemptAt: null };
    await writeState(db, state, timestamp);
    emit('unconfigured', 'learning-service-not-configured');
    return { outcome: 'idle', state };
  }

  let owner: string | null = null;
  try { owner = await claimLease(db, date, timestamp); } catch { emit('lease-unavailable'); return { outcome: 'busy', state }; }
  if (!owner) { emit('busy'); return { outcome: 'busy', state }; }
  try {
    state = await readState(db, date);
    if (state.state === 'success' || state.state === 'failed') { emit(state.state); return { outcome: 'idle', state }; }
    if (state.nextAttemptAt && Date.parse(state.nextAttemptAt) > timestamp) { emit('backoff'); return { outcome: 'idle', state }; }

    const daily = await readDailyCloudPipelineStatus(db);
    if (!daily || daily.date !== date || (daily.bToday as { state?: string; targetDate?: string } | null)?.state !== 'success'
      || (daily.bToday as { state?: string; targetDate?: string } | null)?.targetDate !== date
      || (daily.kYesterday as { state?: string; targetDate?: string } | null)?.state !== 'success') {
      state = { ...state, state: 'waiting_sources', reason: 'source-data-not-ready', nextAttemptAt: null,
        reportStatus: null, candidateArtifactCreated: false };
      await writeState(db, state, timestamp);
      emit('waiting-sources', 'source-data-not-ready');
      return { outcome: 'waiting-sources', state };
    }

    state = { ...state, state: 'pending', reason: null, nextAttemptAt: null };
    await writeState(db, state, timestamp);
    let result: NativeLearnerResult;
    try {
      result = options.runLearning ? await options.runLearning(date) : await runNativeNormalDailyLearner(options.learner!, date);
    } catch { result = { status: 'failed', reason: 'learning-service-unavailable', retryable: true }; }
    const attempts = state.attempts + 1;
    const reason = result.reason && SAFE_REASONS.has(result.reason) ? result.reason : 'learning-not-ready';
    const retry = result.status === 'failed' && result.retryable === true
      && attempts < (state.recoveryRetryUsed ? MAX_ATTEMPTS + 1 : MAX_ATTEMPTS);
    state = { ...state, state: result.status === 'success' ? 'success' : retry ? 'pending' : 'failed', attempts,
      lastAttemptAt: new Date(timestamp).toISOString(), nextAttemptAt: retry ? retryAt(timestamp, attempts) : null,
      reason: result.status === 'success' ? null : reason,
      diagnostic: result.diagnostic && SAFE_STAGES.has(result.diagnostic.stage) && SAFE_ERRORS.has(result.diagnostic.errorClass)
        ? result.diagnostic : null,
      diagnosticRevision: 1,
      recoveryRetryUsed: state.recoveryRetryUsed === true,
      reportStatus: result.status === 'success' ? result.reportStatus ?? null : null,
      candidateArtifactCreated: result.status === 'success' && result.candidateArtifactCreated === true };
    await writeState(db, state, timestamp);
    emit(state.state === 'success' ? 'completed' : state.state, state.reason ?? state.reportStatus ?? undefined);
    return { outcome: 'attempted', state };
  } finally { await releaseLease(db, date, owner).catch(() => undefined); }
}
