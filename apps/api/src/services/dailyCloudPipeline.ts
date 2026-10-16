import { first, run, type Db } from '../repo/db.js';

const STATE_KEY = 'daily_cloud_pipeline_state_v1';
const LEASE_KEY = 'daily_cloud_pipeline_lease_v1';
// Native learner CPU is bounded at five minutes; hold the daily lease beyond
// that to prevent the next five-minute Cron from starting a duplicate call.
const LEASE_MS = 6 * 60_000;
const B_START_MINUTE = 3 * 60;
const B_DEADLINE_MINUTE = 8 * 60;
const K_TODAY_START_MINUTE = 23 * 60 + 30;
const K_DAY_DEADLINE_MINUTE = 23 * 60 + 30;
const SAFE_REASONS = new Set([
  'source-not-published', 'source-forbidden', 'source-fetch-failed', 'source-server-error',
  'source-http-error', 'source-invalid', 'source-already-current', 'source-rate-limited', 'source-redirect-rejected',
  'invalid-schedule', 'archive-size-invalid', 'archive-parse-rejected',
  'source-archive-write-failed', 'database-write-failed',
  'source-sync-in-progress',
  'd1-write-failed', 'd1-write-budget-exhausted',
  'identity-rejected', 'parse-rejected', 'source-sync-failed', 'deadline-missed',
  'learning-service-not-configured', 'learning-not-ready', 'learning-failed', 'learning-service-unavailable', 'learning-already-running',
]);

export type ProgramFileSyncResult = {
  status: 'success' | 'partial' | 'failed' | 'skipped';
  reason?: string;
  kind: 'B' | 'K';
  targetDate: string;
  records: number;
  retryable: boolean;
  sourceSha256?: string;
  fetchedAt?: string;
};

export type DailyStepState = {
  kind: 'B' | 'K';
  targetDate: string;
  state: 'pending' | 'success' | 'failed' | 'missing';
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  reason: string | null;
  deadlineMissed?: boolean;
  records: number;
  sourceSha256?: string;
  fetchedAt?: string;
};

export type DailyLearningState = {
  state: 'unconfigured' | 'pending' | 'success' | 'skipped' | 'failed';
  attempts: number;
  nextAttemptAt: string | null;
  updatedAt: string | null;
  reason: string | null;
  reportStatus?: 'candidate' | 'insufficient_data' | null;
  candidateArtifactCreated?: boolean;
  diagnostic?: { stage: string; errorClass: string } | null;
  diagnosticRevision?: 1 | 2;
  recoveryRetryUsed?: boolean;
};

export type DailyCloudPipelineState = {
  schema: 'daily-cloud-pipeline-v1';
  date: string;
  updatedAt: string;
  bToday: DailyStepState;
  kYesterday: DailyStepState;
  kToday: DailyStepState;
  learning: DailyLearningState;
};

export type DailyLearningResult = { status: 'success' | 'skipped' | 'failed'; reason?: string; retryable?: boolean;
  reportStatus?: 'candidate' | 'insufficient_data'; candidateArtifactCreated?: boolean;
  diagnostic?: { stage: string; errorClass: string } };
export type DailyCloudPipelineOutcome = 'outside-window' | 'busy' | 'idle' | 'source-attempted' | 'learning-attempted';

export interface DailyCloudPipelineOptions {
  now?: () => number;
  syncProgramFile: (kind: 'B' | 'K', targetDate: string, scheduledAt: Date) => Promise<ProgramFileSyncResult>;
  runLearning?: (targetDate: string, scheduledAt: Date) => Promise<DailyLearningResult>;
  log?: (line: string) => void;
}

function jstParts(timestamp: number) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const parts = Object.fromEntries(values.map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00+09:00`);
  value.setUTCDate(value.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

function jstAt(date: string, hour: number, minute = 0): number {
  return Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`);
}

function newStep(kind: 'B' | 'K', targetDate: string): DailyStepState {
  return { kind, targetDate, state: 'pending', attempts: 0, lastAttemptAt: null,
    nextAttemptAt: null, reason: null, records: 0 };
}

function initialState(date: string, prior?: DailyCloudPipelineState): DailyCloudPipelineState {
  const yesterday = addDays(date, -1);
  const carriedK = prior?.kToday?.targetDate === yesterday ? prior.kToday : undefined;
  return {
    schema: 'daily-cloud-pipeline-v1', date, updatedAt: new Date().toISOString(),
    bToday: newStep('B', date), kYesterday: carriedK ?? newStep('K', yesterday),
    kToday: newStep('K', date),
    learning: { state: 'unconfigured', attempts: 0, nextAttemptAt: null,
      updatedAt: null, reason: 'learning-service-not-configured', reportStatus: null, candidateArtifactCreated: false },
  };
}

function parseState(raw: string | undefined, date: string): DailyCloudPipelineState {
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object' && (value as DailyCloudPipelineState).schema === 'daily-cloud-pipeline-v1') {
        const state = value as DailyCloudPipelineState;
        if (state.date === date) {
          // One bounded migration retry for a terminal transient failure written
          // before durable private-learner diagnostics were available.
          if (state.learning?.state === 'failed' && state.learning.reason === 'learning-service-unavailable'
              && state.learning.diagnosticRevision === 1 && state.learning.diagnostic?.stage === 'fit'
              && state.learning.diagnostic?.errorClass === 'OtherError' && state.learning.recoveryRetryUsed !== true) {
            state.learning.state = 'pending'; state.learning.nextAttemptAt = null;
            state.learning.recoveryRetryUsed = true;
          } else if (state.learning?.state === 'failed' && state.learning.reason === 'learning-service-unavailable'
              && state.learning.diagnosticRevision == null && state.learning.recoveryRetryUsed !== true) {
            state.learning.state = 'pending'; state.learning.nextAttemptAt = null;
            state.learning.recoveryRetryUsed = true;
          }
          return state;
        }
        return initialState(date, state);
      }
    } catch { /* invalid state is replaced with a new fail-closed date record */ }
  }
  return initialState(date);
}

function safeReason(reason: string | undefined, fallback: string): string {
  return reason && SAFE_REASONS.has(reason) ? reason : fallback;
}

const SAFE_LEARNER_STAGES = new Set(['request-json', 'experimental-learn', 'normal-learn', 'lease', 'load-cohort', 'feature-build', 'fit', 'persist-candidate', 'persist-report', 'response']);
const SAFE_LEARNER_ERRORS = new Set(['AssertionError', 'AttributeError', 'FileNotFoundError', 'FloatingPointError', 'ImportError', 'IndexError', 'IsADirectoryError', 'KeyError', 'LinAlgError', 'MemoryError', 'ModuleNotFoundError', 'NotADirectoryError', 'NotImplementedError', 'OSError', 'OverflowError', 'PermissionError', 'RuntimeError', 'StopIteration', 'TimeoutError', 'TypeError', 'ValueError', 'ZoneInfoNotFoundError', 'ZeroDivisionError', 'OtherError']);
function isSafeLearnerDiagnostic(value: unknown): value is { stage: string; errorClass: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const diagnostic = value as Record<string, unknown>;
  return Object.keys(diagnostic).sort().join(',') === 'errorClass,stage'
    && typeof diagnostic.stage === 'string' && SAFE_LEARNER_STAGES.has(diagnostic.stage)
    && typeof diagnostic.errorClass === 'string' && SAFE_LEARNER_ERRORS.has(diagnostic.errorClass);
}

function retryDelayMs(attempts: number, reason: string): number {
  if (reason === 'source-sync-in-progress') return 60_000;
  if (reason === 'learning-already-running') return 15 * 60_000;
  // A missing daily source is polled less aggressively than a transient error.
  if (reason === 'source-not-published') return 15 * 60_000;
  if (reason === 'source-forbidden') return Math.min(60, 15 * 2 ** Math.min(attempts - 1, 2)) * 60_000;
  return Math.min(30, 5 * 2 ** Math.min(attempts - 1, 3)) * 60_000;
}

async function claimLease(db: Db, timestamp: number): Promise<string | null> {
  const owner = crypto.randomUUID();
  const value = JSON.stringify({ owner, leaseUntil: timestamp + LEASE_MS });
  const row = await first<{ value: string }>(db, `INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE (CASE WHEN json_valid(settings.value) THEN CAST(COALESCE(json_extract(settings.value,'$.leaseUntil'),0) AS INTEGER) ELSE 0 END) <= ?
    RETURNING value`, LEASE_KEY, value, timestamp);
  return row ? owner : null;
}

async function releaseLease(db: Db, owner: string): Promise<void> {
  await run(db, `UPDATE settings SET value=? WHERE key=? AND json_valid(value)
    AND json_extract(value,'$.owner')=?`, JSON.stringify({ leaseUntil: 0 }), LEASE_KEY, owner);
}

async function readState(db: Db, date: string): Promise<DailyCloudPipelineState> {
  const row = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key=?', STATE_KEY);
  return parseState(row?.value, date);
}

/** Safe status projection for the collection dashboard; never returns raw settings JSON. */
export async function readDailyCloudPipelineStatus(db: Db): Promise<Record<string, unknown> | null> {
  const row = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key=?', STATE_KEY);
  if (!row?.value) return null;
  try {
    const raw: unknown = JSON.parse(row.value);
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as DailyCloudPipelineState;
    if (value.schema !== 'daily-cloud-pipeline-v1' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)
      || !Number.isFinite(Date.parse(value.updatedAt))) return null;
    const step = (item: DailyStepState | undefined) => {
      if (!item || !['pending', 'success', 'failed', 'missing'].includes(item.state)
        || !['B', 'K'].includes(item.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(item.targetDate)) return null;
      return { kind: item.kind, targetDate: item.targetDate, state: item.state,
        attempts: Number.isSafeInteger(item.attempts) && item.attempts >= 0 ? item.attempts : 0,
        lastAttemptAt: typeof item.lastAttemptAt === 'string' && Number.isFinite(Date.parse(item.lastAttemptAt)) ? item.lastAttemptAt : null,
        nextAttemptAt: typeof item.nextAttemptAt === 'string' && Number.isFinite(Date.parse(item.nextAttemptAt)) ? item.nextAttemptAt : null,
        reason: item.reason ? safeReason(item.reason, 'source-sync-failed') : null,
        deadlineMissed: item.deadlineMissed === true,
        records: Number.isSafeInteger(item.records) && item.records >= 0 ? item.records : 0 };
    };
    const learningState = ['unconfigured', 'pending', 'success', 'skipped', 'failed'].includes(value.learning?.state)
      ? value.learning.state : 'unconfigured';
    return { schema: value.schema, date: value.date, updatedAt: value.updatedAt,
      bToday: step(value.bToday), kYesterday: step(value.kYesterday), kToday: step(value.kToday),
      learning: { state: learningState, attempts: Number.isSafeInteger(value.learning?.attempts) && value.learning.attempts >= 0 ? value.learning.attempts : 0,
        updatedAt: typeof value.learning?.updatedAt === 'string' && Number.isFinite(Date.parse(value.learning.updatedAt)) ? value.learning.updatedAt : null,
        reason: value.learning?.reason ? safeReason(value.learning.reason, 'learning-not-ready') : null,
        reportStatus: value.learning?.reportStatus === 'candidate' || value.learning?.reportStatus === 'insufficient_data' ? value.learning.reportStatus : null,
        candidateArtifactCreated: value.learning?.candidateArtifactCreated === true,
        diagnosticRevision: value.learning?.diagnosticRevision === 1 || value.learning?.diagnosticRevision === 2 ? value.learning.diagnosticRevision : null,
        diagnostic: isSafeLearnerDiagnostic(value.learning?.diagnostic) ? value.learning?.diagnostic : null } };
  } catch { return null; }
}

async function writeState(db: Db, state: DailyCloudPipelineState, timestamp: number): Promise<void> {
  state.updatedAt = new Date(timestamp).toISOString();
  await run(db, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    STATE_KEY, JSON.stringify(state));
}

function markDeadline(step: DailyStepState, deadline: number, timestamp: number) {
  if (step.kind === 'B' && step.state === 'pending' && timestamp >= deadline) {
    step.deadlineMissed = true;
    if (step.attempts === 0) {
      // Recover states written by the old deadline handler: no source attempt
      // has happened, so do not make commissioning wait for its stale 1h timer.
      if (!step.reason) step.reason = 'deadline-missed';
      step.nextAttemptAt = new Date(timestamp).toISOString();
    } else if (!step.nextAttemptAt) {
      if (!step.reason) step.reason = 'deadline-missed';
      step.nextAttemptAt = new Date(step.attempts === 0 ? timestamp : timestamp + 60 * 60_000).toISOString();
    }
  } else if (step.state === 'pending' && timestamp >= deadline) {
    step.state = 'missing'; step.reason = 'deadline-missed'; step.nextAttemptAt = null;
  }
}

function sourceDue(step: DailyStepState, start: number, deadline: number, timestamp: number, allowLate = false): boolean {
  return step.state === 'pending' && timestamp >= start && (timestamp < deadline || allowLate)
    && (!step.nextAttemptAt || Date.parse(step.nextAttemptAt) <= timestamp);
}

function updateStep(step: DailyStepState, outcome: ProgramFileSyncResult, timestamp: number) {
  step.attempts++;
  step.lastAttemptAt = new Date(timestamp).toISOString();
  step.records = Number.isSafeInteger(outcome.records) && outcome.records >= 0 ? outcome.records : 0;
  const reason = safeReason(outcome.reason, outcome.status === 'success' ? 'source-already-current' : 'source-sync-failed');
  if (outcome.sourceSha256 && /^[a-f0-9]{64}$/.test(outcome.sourceSha256)) step.sourceSha256 = outcome.sourceSha256;
  if (outcome.fetchedAt && Number.isFinite(Date.parse(outcome.fetchedAt))) step.fetchedAt = outcome.fetchedAt;
  step.reason = outcome.status === 'success' ? null : reason;
  if (outcome.status === 'success') {
    step.state = 'success'; step.nextAttemptAt = null;
    return;
  }
  if (!outcome.retryable) {
    step.state = 'failed'; step.nextAttemptAt = null;
    return;
  }
  step.state = 'pending';
  step.nextAttemptAt = new Date(timestamp + retryDelayMs(step.attempts, reason)).toISOString();
}

function eligibleWork(state: DailyCloudPipelineState, timestamp: number) {
  const date = state.date;
  const bStart = jstAt(date, 3), bDeadline = jstAt(date, 8);
  const kYesterdayStart = jstAt(date, 3), kDeadline = jstAt(date, 23, 30);
  const kTodayStart = jstAt(date, 23, 30), kTodayDeadline = jstAt(addDays(date, 1), 23, 30);
  markDeadline(state.bToday, bDeadline, timestamp);
  markDeadline(state.kYesterday, kDeadline, timestamp);
  markDeadline(state.kToday, kTodayDeadline, timestamp);
  if (sourceDue(state.bToday, bStart, bDeadline, timestamp,
    timestamp < jstAt(date, 23, 30))) return state.bToday;
  // Today's K is given priority at 23:30; the previous day's retry resumes on the next tick.
  if (sourceDue(state.kToday, kTodayStart, kTodayDeadline, timestamp)) return state.kToday;
  if (sourceDue(state.kYesterday, kYesterdayStart, kDeadline, timestamp)) return state.kYesterday;
  return null;
}

/** One bounded daily source/learning operation per invocation; caller schedules this separately from T-60 work. */
export async function runDailyCloudPipeline(db: Db, options: DailyCloudPipelineOptions): Promise<{
  outcome: DailyCloudPipelineOutcome; state: DailyCloudPipelineState;
}> {
  const now = options.now ?? Date.now;
  const timestamp = now();
  const { date, minute } = jstParts(timestamp);
  const log = options.log ?? ((line: string) => console.info(line));
  let state = await readState(db, date);
  if (!Number.isFinite(timestamp)) return { outcome: 'outside-window', state };
  const hasPendingDailyWork = minute >= B_START_MINUTE && minute < K_DAY_DEADLINE_MINUTE;
  if (!hasPendingDailyWork && !(state.kToday.state === 'pending' && minute >= K_TODAY_START_MINUTE)) {
    return { outcome: 'outside-window', state };
  }
  let owner: string | null = null;
  try { owner = await claimLease(db, timestamp); } catch {
    return { outcome: 'busy', state };
  }
  if (!owner) return { outcome: 'busy', state };
  let outcome: DailyCloudPipelineOutcome = 'idle';
  try {
    // Re-read after claiming: state may have advanced since the preflight read.
    state = await readState(db, date);
    if (options.runLearning && state.learning.state === 'unconfigured') {
      state.learning = { state: 'pending', attempts: 0, nextAttemptAt: null, updatedAt: null, reason: null };
    }
    const step = eligibleWork(state, timestamp);
    if (step) {
      try {
        const result = await options.syncProgramFile(step.kind, step.targetDate, new Date(timestamp));
        if (result.kind !== step.kind || result.targetDate !== step.targetDate) {
          updateStep(step, { status: 'failed', reason: 'identity-rejected', retryable: false,
            kind: step.kind, targetDate: step.targetDate, records: 0 }, timestamp);
        } else updateStep(step, result, timestamp);
        outcome = 'source-attempted';
      } catch {
        updateStep(step, { status: 'failed', reason: 'source-sync-failed', retryable: true,
          kind: step.kind, targetDate: step.targetDate, records: 0 }, timestamp);
        outcome = 'source-attempted';
      }
    } else if (options.runLearning && state.kYesterday.state === 'success'
        && state.learning.state === 'pending'
        && (!state.learning.nextAttemptAt || Date.parse(state.learning.nextAttemptAt) <= timestamp)) {
      // Publish pending status before a potentially five-minute service call.
      state.learning.updatedAt = new Date(timestamp).toISOString();
      state.learning.reason = null;
      await writeState(db, state, timestamp);
      try {
        const result = await options.runLearning(state.date, new Date(timestamp));
        const reason = safeReason(result.reason, 'learning-not-ready');
        const attempts = state.learning.attempts + 1;
        const willRetry = result.status === 'failed' && result.retryable === true
          && attempts < (state.learning.recoveryRetryUsed ? 5 : 4);
        state.learning = { state: willRetry ? 'pending' : result.status, attempts,
          nextAttemptAt: willRetry ? new Date(timestamp + retryDelayMs(attempts, reason)).toISOString() : null,
          updatedAt: new Date(timestamp).toISOString(),
          reason: result.status === 'success' ? null : reason,
          reportStatus: result.status === 'success' ? result.reportStatus ?? null : null,
          candidateArtifactCreated: result.status === 'success' && result.candidateArtifactCreated === true,
          diagnostic: isSafeLearnerDiagnostic(result.diagnostic) ? result.diagnostic : null,
          diagnosticRevision: 2,
          recoveryRetryUsed: state.learning.recoveryRetryUsed === true };
      } catch {
        const attempts = state.learning.attempts + 1, willRetry = attempts < 4;
        state.learning = { state: willRetry ? 'pending' : 'failed', attempts,
          nextAttemptAt: willRetry ? new Date(timestamp + retryDelayMs(attempts, 'learning-failed')).toISOString() : null,
          updatedAt: new Date(timestamp).toISOString(), reason: 'learning-failed', reportStatus: null, candidateArtifactCreated: false };
      }
      outcome = 'learning-attempted';
    } else {
      state.learning = options.runLearning ? state.learning
        : { state: 'unconfigured', attempts: 0, nextAttemptAt: null,
          updatedAt: null, reason: 'learning-service-not-configured', reportStatus: null, candidateArtifactCreated: false };
    }
    await writeState(db, state, timestamp);
    log(JSON.stringify({ event: 'daily-cloud-pipeline', status: outcome,
      date: state.date, bToday: state.bToday.state, kYesterday: state.kYesterday.state,
      kToday: state.kToday.state, learning: state.learning.state }));
    return { outcome, state };
  } finally {
    await releaseLease(db, owner).catch(() => undefined);
  }
}
