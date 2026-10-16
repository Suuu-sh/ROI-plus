const LEARNER_URL = 'https://learner/learn';
const NORMAL_LEARNER_URL = 'https://learner/learn/normal';
const MAX_REPORT_BYTES = 64 * 1024;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const validDate = (value: string) => DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export type NativeLearnerReportStatus = 'candidate' | 'insufficient_data';
export type NativeLearnerResult = {
  status: 'success' | 'failed';
  reason?: 'learning-not-ready' | 'learning-service-unavailable' | 'learning-already-running';
  retryable?: boolean;
  reportStatus?: NativeLearnerReportStatus;
  candidateArtifactCreated?: boolean;
};

function validCounts(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const counts = value as Record<string, unknown>;
  const ints = ['candidateRaces', 'archives', 'labels', 'truncatedCandidates', 'requestedWindowDays'];
  if (Object.keys(counts).sort().join(',') !== 'archives,candidateRaces,labels,requestedWindowDays,selectedFrom,selectedTo,truncatedCandidates') return false;
  if (ints.some(key => !Number.isSafeInteger(counts[key]) || Number(counts[key]) < 0)) return false;
  return ['selectedFrom', 'selectedTo'].every(key => counts[key] === null
    || (typeof counts[key] === 'string' && validDate(counts[key] as string)));
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REPORT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function reportResult(report: Record<string, unknown>, date: string): NativeLearnerResult | null {
  if (report.inputSelection !== 'most-recent-bounded-real-cohort' || !validCounts(report.inputCounts)
      || report.candidateOnly !== true || report.registered !== false || report.promoted !== false) return null;
  const validPrefix = (value: unknown) => {
    if (typeof value !== 'string') return false;
    const match = value.match(/^learning-candidates\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/$/);
    return !!match && match[1] === date && SAFE_ID.test(match[2]);
  };
  if (report.status === 'insufficient_data') {
    if (report.artifactCreated !== false || !validPrefix(report.candidatePrefix)) return null;
    return { status: 'success', reportStatus: 'insufficient_data', candidateArtifactCreated: false };
  }
  if (report.status !== 'candidate' || report.artifactCreated !== true || !validPrefix(report.candidatePrefix)) return null;
  return { status: 'success', reportStatus: 'candidate', candidateArtifactCreated: true };
}

/** Calls the private candidate-only learner binding and stores no report text or model identifiers. */
type LearnerMode = 'experimental' | 'normal';
type LearnerLog = (line: string) => void;

function logCall(log: LearnerLog, mode: LearnerMode, stage: string, status: string, reason?: string, httpStatus?: number) {
  log(JSON.stringify({ event: 'private-learner-call', mode, stage, status,
    ...(reason ? { reason } : {}), ...(Number.isSafeInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599
      ? { httpStatus } : {}) }));
}

async function runLearner(learner: Fetcher, targetDate: string, url: string, mode: LearnerMode, log: LearnerLog): Promise<NativeLearnerResult> {
  if (!validDate(targetDate)) {
    logCall(log, mode, 'preflight', 'failed', 'invalid-target-date');
    return { status: 'failed', reason: 'learning-not-ready', retryable: false };
  }
  let response: Response;
  try {
    response = await learner.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ date: targetDate, confirmed: true }), redirect: 'manual',
    });
  } catch {
    logCall(log, mode, 'fetch', 'failed', 'fetch-exception');
    return { status: 'failed', reason: 'learning-service-unavailable', retryable: true };
  }

  if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    logCall(log, mode, 'response', 'rejected', 'redirect-rejected', response.status);
    return { status: 'failed', reason: 'learning-service-unavailable', retryable: true };
  }
  const report = await readBoundedJson(response);
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      logCall(log, mode, 'response', 'retryable-failure', 'http-error', response.status);
      return { status: 'failed', reason: 'learning-service-unavailable', retryable: true };
    }
    if (report?.status === 'skipped' && report.reason === 'daily_lease_active') {
      logCall(log, mode, 'response', 'busy', 'learner-lease-active', response.status);
      return { status: 'failed', reason: 'learning-already-running', retryable: true };
    }
    logCall(log, mode, 'response', 'rejected', 'http-error', response.status);
    return { status: 'failed', reason: 'learning-not-ready', retryable: false };
  }
  if (report?.status === 'skipped' && report.reason === 'daily_lease_active'
      && report.candidateOnly === true) {
    logCall(log, mode, 'response', 'busy', 'learner-lease-active', response.status);
    return { status: 'failed', reason: 'learning-already-running', retryable: true };
  }
  const result = report ? reportResult(report, targetDate) : null;
  logCall(log, mode, result ? 'complete' : 'parse', result ? 'accepted' : 'rejected',
    result ? result.reportStatus : 'invalid-report', response.status);
  return result ?? { status: 'failed', reason: 'learning-not-ready', retryable: false };
}

export function runNativeDailyLearner(learner: Fetcher, targetDate: string, log: LearnerLog = line => console.info(line)): Promise<NativeLearnerResult> {
  return runLearner(learner, targetDate, LEARNER_URL, 'experimental', log);
}

export function runNativeNormalDailyLearner(learner: Fetcher, targetDate: string, log: LearnerLog = line => console.info(line)): Promise<NativeLearnerResult> {
  return runLearner(learner, targetDate, NORMAL_LEARNER_URL, 'normal', log);
}
