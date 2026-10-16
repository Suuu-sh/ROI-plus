import Sqlite from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { D1SqliteAdapter } from './d1-adapter.js';
import { runForecastWatchdog } from '../src/services/forecastWatchdog.js';
import worker from '../src/index.js';

const databases: Sqlite.Database[] = [];
function testDb() {
  const sqlite = new Sqlite(':memory:');
  databases.push(sqlite);
  sqlite.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  return new D1SqliteAdapter(sqlite);
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const atJst = (hour: number, minute = 0) => Date.UTC(2026, 9, 16, hour - 9, minute);
const runs = (workflowRuns: Array<{ status: string }>, totalCount = workflowRuns.length) => new Response(JSON.stringify({
  total_count: totalCount, workflow_runs: workflowRuns,
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('forecast GitHub watchdog', () => {
  it('fails closed when unconfigured or outside JST operating window', async () => {
    const db = testDb();
    const calls: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => { calls.push(String(input)); return runs([]); };
    expect(await runForecastWatchdog(db, undefined, { now: () => atJst(9), fetcher })).toBe('unconfigured');
    expect(await runForecastWatchdog(db, 'test-only', { now: () => atJst(7, 59), fetcher })).toBe('outside-window');
    expect(await runForecastWatchdog(db, 'test-only', { now: () => atJst(23), fetcher })).toBe('outside-window');
    expect(calls).toEqual([]);
  });

  it('does not dispatch when a run is active and retries only after bounded cooldown', async () => {
    const db = testDb();
    const calls: string[] = [];
    const now = atJst(9);
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return url.includes('status=in_progress') ? runs([{ status: 'in_progress' }], 19) : runs([]);
    };
    expect(await runForecastWatchdog(db, 'test-only', { now: () => now, fetcher, log: () => undefined }))
      .toBe('active-run');
    expect(await runForecastWatchdog(db, 'test-only', { now: () => now + 30_000, fetcher, log: () => undefined }))
      .toBe('cooldown');
    expect(calls).toHaveLength(2);
  });

  it('dispatches only the fixed main workflow once per five-minute cooldown', async () => {
    const db = testDb();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const now = atJst(9);
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return init?.method === 'POST' ? new Response(JSON.stringify({ workflow_run_id: 123 }), { status: 200 }) : runs([]);
    };
    expect(await runForecastWatchdog(db, 'test-only', { now: () => now, fetcher, log: () => undefined }))
      .toBe('dispatched');
    expect(await runForecastWatchdog(db, 'test-only', { now: () => now + 4 * 60_000,
      fetcher, log: () => undefined })).toBe('cooldown');
    expect(calls).toHaveLength(6);
    expect(calls.slice(0, 5).map(call => new URL(call.url).searchParams.get('status')))
      .toEqual(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
    expect(calls[0].url).toBe('https://api.github.com/repos/Suuu-sh/ROI-plus/actions/workflows/trifecta-experimental-forecast.yml/runs?branch=main&status=queued&per_page=1');
    expect(calls[5].url).toBe('https://api.github.com/repos/Suuu-sh/ROI-plus/actions/workflows/trifecta-experimental-forecast.yml/dispatches');
    expect(calls[5].init?.body).toBe(JSON.stringify({ ref: 'main', inputs: { market_window_only: 'true' } }));
    expect((calls[0].init?.headers as Record<string, string>)['User-Agent']).toBe('ROIPlus-Forecast-Watchdog/1.0');
    expect(calls.every(call => call.init?.redirect === 'error')).toBe(true);
  });

  it('routes the dedicated cron through watchdog only', async () => {
    const db = testDb();
    const calls: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      return init?.method === 'POST' ? new Response(null, { status: 204 }) : runs([]);
    };
    try {
      await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: atJst(9) } as ScheduledController,
        { DB: db, FORECAST_GITHUB_TOKEN: 'test-only' }, {} as ExecutionContext);
    } finally {
      globalThis.fetch = previousFetch;
    }
    expect(calls).toHaveLength(6);
    expect(calls.every(url => url.includes('/actions/workflows/trifecta-experimental-forecast.yml/'))).toBe(true);
  });

  it('does not dispatch for malformed workflow status and never logs upstream content', async () => {
    const db = testDb();
    const logs: string[] = [];
    const response = new Response(JSON.stringify({ total_count: 1, workflow_runs: [{ status: 'unknown-private' }] }),
      { status: 200 });
    const result = await runForecastWatchdog(db, 'secret-must-not-log', {
      now: () => atJst(9), fetcher: async () => response, log: line => logs.push(line),
    });
    expect(result).toBe('invalid-response');
    expect(logs.join('\n')).not.toContain('secret-must-not-log');
    expect(logs.join('\n')).not.toContain('unknown-private');
  });

  it('maps rejected HTTP responses to fixed status codes only', async () => {
    const db = testDb();
    const logs: string[] = [];
    const result = await runForecastWatchdog(db, 'test-only', {
      now: () => atJst(9), fetcher: async () => new Response('private body', { status: 418 }),
      log: line => logs.push(line),
    });
    expect(result).toBe('http-rejected');
    expect(logs[0]).toContain('"statusCode":"other"');
    expect(logs[0]).not.toContain('private body');
  });

  it('keeps the five-minute cooldown after an uncertain dispatch timeout', async () => {
    const db = testDb();
    let posts = 0;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts++; throw new Error('private timeout text'); }
      return runs([]);
    };
    const now = atJst(9);
    expect(await runForecastWatchdog(db, 'test-only', { now: () => now, fetcher, log: () => undefined }))
      .toBe('request-failed');
    expect(await runForecastWatchdog(db, 'test-only', { now: () => now + 4 * 60_000,
      fetcher, log: () => undefined })).toBe('cooldown');
    expect(posts).toBe(1);
  });
});
