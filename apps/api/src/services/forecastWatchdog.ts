import { first, run, type Db } from '../repo/db.js';

const LEASE_KEY = 'forecast_github_dispatch_watchdog_v1';
const REPOSITORY = 'Suuu-sh/ROI-plus';
const WORKFLOW = 'trifecta-experimental-forecast.yml';
const BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RUNS_RESPONSE_BYTES = 16 * 1024;
const LEASE_MS = 90_000;
const COOLDOWN_MS = 5 * 60_000;
const ACTIVE_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'pending', 'requested'] as const;
const SAFE_HTTP_STATUSES = new Set([401, 403, 404, 422, 429, 500, 502, 503, 504]);

export type ForecastWatchdogOutcome =
  | 'unconfigured' | 'outside-window' | 'cooldown' | 'active-run'
  | 'dispatched' | 'invalid-response' | 'request-failed' | 'http-rejected' | 'lease-unavailable';

export interface ForecastWatchdogOptions {
  now?: () => number;
  fetcher?: typeof fetch;
  log?: (line: string) => void;
}

function logOutcome(log: (line: string) => void, outcome: ForecastWatchdogOutcome,
                    extra: Record<string, string | number> = {}): ForecastWatchdogOutcome {
  log(JSON.stringify({ event: 'forecast-github-watchdog', status: outcome, ...extra }));
  return outcome;
}

function isForecastHours(timestamp: number): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' })
    .format(new Date(timestamp)));
  return Number.isInteger(hour) && hour >= 8 && hour < 23;
}

async function claimLease(db: Db, timestamp: number): Promise<boolean> {
  const value = JSON.stringify({ leaseUntil: timestamp + LEASE_MS, cooldownUntil: timestamp + COOLDOWN_MS });
  const row = await first<{ value: string }>(db, `
    INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE (CASE WHEN json_valid(settings.value) THEN
      CAST(COALESCE(json_extract(settings.value,'$.leaseUntil'),0) AS INTEGER)
      ELSE 0 END) <= ?
      AND (CASE WHEN json_valid(settings.value) THEN
      CAST(COALESCE(json_extract(settings.value,'$.cooldownUntil'),0) AS INTEGER)
      ELSE 0 END) <= ?
    RETURNING value`, LEASE_KEY, value, timestamp, timestamp);
  return row !== null;
}

async function setCooldown(db: Db, timestamp: number, cooldownMs: number): Promise<void> {
  await run(db, 'UPDATE settings SET value=? WHERE key=?',
    JSON.stringify({ leaseUntil: 0, cooldownUntil: timestamp + cooldownMs }), LEASE_KEY);
}

async function releaseLease(db: Db): Promise<void> {
  await run(db, 'UPDATE settings SET value=? WHERE key=?', JSON.stringify({ leaseUntil: 0, cooldownUntil: 0 }), LEASE_KEY);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RUNS_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function githubHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'User-Agent': 'ROIPlus-Forecast-Watchdog/1.0',
    'X-GitHub-Api-Version': '2026-03-10' };
}

export async function runForecastWatchdog(db: Db, token: string | undefined,
    options: ForecastWatchdogOptions = {}): Promise<ForecastWatchdogOutcome> {
  const log = options.log ?? ((line: string) => console.info(line));
  if (!token) return logOutcome(log, 'unconfigured');
  const now = options.now ?? Date.now;
  const timestamp = now();
  if (!isForecastHours(timestamp)) return logOutcome(log, 'outside-window');

  let claimed = false;
  try {
    claimed = await claimLease(db, timestamp);
  } catch {
    return logOutcome(log, 'lease-unavailable');
  }
  if (!claimed) return logOutcome(log, 'cooldown');

  const fetcher = options.fetcher ?? fetch;
  let dispatchAttempted = false;
  try {
    const runsUrl = `${GITHUB_API}/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs`;
    // Query each live status directly with a single-result response. This
    // avoids burying an old, still-queued run beneath completed history.
    for (const status of ACTIVE_RUN_STATUSES) {
      const url = `${runsUrl}?branch=${BRANCH}&status=${status}&per_page=1`;
      const response = await fetcher(url, { method: 'GET', headers: githubHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' });
      if (response.status !== 200) {
        await response.body?.cancel();
        await setCooldown(db, now(), 60_000);
        const statusCode = SAFE_HTTP_STATUSES.has(response.status) ? response.status : 'other';
        return logOutcome(log, 'http-rejected', { statusCode });
      }
      const payload = await readBoundedJson(response) as { total_count?: unknown; workflow_runs?: unknown } | null;
      const runs = payload?.workflow_runs;
      if (!payload || !Array.isArray(runs) || !Number.isInteger(payload.total_count)
          || (payload.total_count as number) < 0 || runs.length > 1
          || ((payload.total_count as number) === 0 && runs.length !== 0)
          || ((payload.total_count as number) > 0 && (runs.length !== 1
            || !runs[0] || typeof runs[0] !== 'object'
            || (runs[0] as { status?: unknown }).status !== status))) {
        await setCooldown(db, now(), 60_000);
        return logOutcome(log, 'invalid-response');
      }
      if ((payload.total_count as number) > 0) {
        await setCooldown(db, now(), 60_000);
        return logOutcome(log, 'active-run');
      }
    }
    dispatchAttempted = true;
    const dispatch = await fetcher(`${GITHUB_API}/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST', headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: BRANCH, inputs: { market_window_only: 'true' } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error',
    });
    if (dispatch.status !== 200 && dispatch.status !== 204) {
      await dispatch.body?.cancel();
      const status = SAFE_HTTP_STATUSES.has(dispatch.status) ? dispatch.status : 'other';
      return logOutcome(log, 'http-rejected', { statusCode: status });
    }
    await dispatch.body?.cancel();
    // Cooldown was reserved before the external call, so a crash after GitHub
    // accepts the dispatch cannot immediately cause a duplicate dispatch.
    return logOutcome(log, 'dispatched');
  } catch {
    if (!dispatchAttempted) {
      try { await setCooldown(db, now(), 60_000); } catch { /* Lease expires automatically. */ }
    }
    return logOutcome(log, 'request-failed');
  }
}
