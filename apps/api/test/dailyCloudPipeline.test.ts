import { describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { D1SqliteAdapter } from './d1-adapter.js';
import { readDailyCloudPipelineStatus, runDailyCloudPipeline } from '../src/services/dailyCloudPipeline.js';
import worker, { app } from '../src/index.js';

const root = resolve(import.meta.dirname, '../../..');
function createDb() {
  const sqlite = new Sqlite(':memory:');
  for (const file of readdirSync(resolve(root, 'db/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(resolve(root, 'db/migrations', file), 'utf8'));
  }
  return { sqlite, db: new D1SqliteAdapter(sqlite) };
}

describe('daily Cloudflare source pipeline orchestration', () => {
  it('retries a not-yet-published B file with backoff, then records success idempotently', async () => {
    const { sqlite, db } = createDb();
    let now = Date.parse('2026-10-15T18:00:00Z'); // 03:00 JST on Oct 16
    const calls: Array<[string, string]> = [];
    const sync = async (kind: 'B' | 'K', targetDate: string) => {
      calls.push([kind, targetDate]);
      return calls.length === 1
        ? { status: 'failed' as const, reason: 'source-not-published', retryable: true, kind, targetDate, records: 0 }
        : { status: 'success' as const, retryable: false, kind, targetDate, records: 50,
            sourceSha256: 'a'.repeat(64), fetchedAt: new Date(now).toISOString() };
    };
    const first = await runDailyCloudPipeline(db, { now: () => now, syncProgramFile: sync, log: () => undefined });
    expect(first.outcome).toBe('source-attempted');
    expect(first.state.bToday).toMatchObject({ state: 'pending', attempts: 1, reason: 'source-not-published' });
    now += 5 * 60_000;
    const nextSource = await runDailyCloudPipeline(db, { now: () => now, syncProgramFile: sync, log: () => undefined });
    expect(nextSource.outcome).toBe('source-attempted');
    expect(calls).toHaveLength(2); // One source file per invocation; yesterday K gets its own call.
    now += 10 * 60_000;
    const retry = await runDailyCloudPipeline(db, { now: () => now, syncProgramFile: sync, log: () => undefined });
    expect(retry.outcome).toBe('source-attempted');
    expect(retry.state.bToday).toMatchObject({ state: 'success', attempts: 2, records: 50, sourceSha256: 'a'.repeat(64) });
    expect(calls).toEqual([['B', '2026-10-16'], ['K', '2026-10-15'], ['B', '2026-10-16']]);
    sqlite.close();
  });

  it('carries the current-day K checkpoint forward as yesterday and leaves learning unconfigured', async () => {
    const { sqlite, db } = createDb();
    const now = Date.parse('2026-10-16T14:30:00Z'); // 23:30 JST
    const first = await runDailyCloudPipeline(db, {
      now: () => now,
      syncProgramFile: async (kind, targetDate) => ({ status: 'failed', reason: 'source-not-published',
        retryable: true, kind, targetDate, records: 0 }),
      log: () => undefined,
    });
    expect(first.state.kToday).toMatchObject({ targetDate: '2026-10-16', state: 'pending', attempts: 1 });
    const nextDay = await runDailyCloudPipeline(db, {
      now: () => Date.parse('2026-10-16T18:00:00Z'), // 03:00 JST on Oct 17
      syncProgramFile: async (kind, targetDate) => ({ status: 'success', retryable: false,
        kind, targetDate, records: 20 }),
      log: () => undefined,
    });
    expect(nextDay.state.kYesterday).toMatchObject({ targetDate: '2026-10-16', state: 'pending', attempts: 1 });
    expect(nextDay.state.bToday.targetDate).toBe('2026-10-17');
    expect(nextDay.state.learning).toMatchObject({ state: 'unconfigured', reason: 'learning-service-not-configured' });
    sqlite.close();
  });

  it('marks the B readiness deadline but continues bounded recovery later the same day', async () => {
    const { sqlite, db } = createDb();
    let now = Date.parse('2026-10-15T23:00:00Z'); // 08:00 JST: readiness deadline
    const missed = await runDailyCloudPipeline(db, { now: () => now,
      syncProgramFile: async (kind, targetDate) => ({ status: 'failed', reason: 'source-not-published',
        retryable: true, kind, targetDate, records: 0 }), log: () => undefined });
    expect(missed.state.bToday).toMatchObject({ state: 'pending', deadlineMissed: true, reason: 'source-not-published', attempts: 1 });
    expect(missed.state.bToday.nextAttemptAt).toBe('2026-10-15T23:15:00.000Z');
    now = Date.parse('2026-10-16T00:00:00Z'); // 09:00 JST: commissioning/recovery remains possible
    const recovered = await runDailyCloudPipeline(db, { now: () => now,
      syncProgramFile: async (kind, targetDate) => ({ status: 'success', retryable: false,
        kind, targetDate, records: 48 }), log: () => undefined });
    expect(recovered.state.bToday).toMatchObject({ state: 'success', deadlineMissed: true, attempts: 2, records: 48 });
    const status = await readDailyCloudPipelineStatus(db);
    expect(status).toMatchObject({ bToday: { state: 'success', deadlineMissed: true } });
    expect(JSON.stringify(status)).not.toContain('sourceSha256');
    sqlite.close();
  });

  it('immediately retries legacy B readiness-only state instead of honoring its stale one-hour timer', async () => {
    const { sqlite, db } = createDb();
    const now = Date.parse('2026-10-16T06:25:00Z'); // 15:25 JST
    const staleState = {
      schema: 'daily-cloud-pipeline-v1', date: '2026-10-16', updatedAt: '2026-10-16T06:20:00Z',
      bToday: { kind: 'B', targetDate: '2026-10-16', state: 'pending', attempts: 0,
        lastAttemptAt: null, nextAttemptAt: '2026-10-16T07:25:00.000Z', reason: 'deadline-missed', deadlineMissed: true, records: 0 },
      kYesterday: { kind: 'K', targetDate: '2026-10-15', state: 'pending', attempts: 0,
        lastAttemptAt: null, nextAttemptAt: null, reason: null, records: 0 },
      kToday: { kind: 'K', targetDate: '2026-10-16', state: 'pending', attempts: 0,
        lastAttemptAt: null, nextAttemptAt: null, reason: null, records: 0 },
      learning: { state: 'unconfigured', attempts: 0, nextAttemptAt: null, updatedAt: null, reason: 'learning-service-not-configured' },
    };
    sqlite.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('daily_cloud_pipeline_state_v1', JSON.stringify(staleState));
    const calls: string[] = [];
    const result = await runDailyCloudPipeline(db, { now: () => now,
      syncProgramFile: async (kind, targetDate) => { calls.push(kind + targetDate);
        return { status: 'failed', reason: 'source-fetch-failed', retryable: true, kind, targetDate, records: 0 }; },
      log: () => undefined });
    expect(calls).toEqual(['B2026-10-16']);
    expect(result.state.bToday).toMatchObject({ state: 'pending', attempts: 1, deadlineMissed: true, reason: 'source-fetch-failed' });
    expect(result.state.bToday.nextAttemptAt).toBe('2026-10-16T06:30:00.000Z');
    sqlite.close();
  });

  it('does not let an expired lease owner release a newer invocation lease', async () => {
    const { sqlite, db } = createDb();
    const firstAt = Date.parse('2026-10-16T18:00:00Z');
    let enterFirst!: () => void;
    let continueFirst!: () => void;
    const firstEntered = new Promise<void>(resolve => { enterFirst = resolve; });
    const firstContinue = new Promise<void>(resolve => { continueFirst = resolve; });
    let enterSecond!: () => void;
    let continueSecond!: () => void;
    const secondEntered = new Promise<void>(resolve => { enterSecond = resolve; });
    const secondContinue = new Promise<void>(resolve => { continueSecond = resolve; });
    const oldInvocation = runDailyCloudPipeline(db, { now: () => firstAt,
      syncProgramFile: async (kind, targetDate) => { enterFirst(); await firstContinue;
        return { status: 'success', retryable: false, kind, targetDate, records: 1 }; }, log: () => undefined });
    await firstEntered;
    const newInvocation = runDailyCloudPipeline(db, { now: () => firstAt + 100_000,
      syncProgramFile: async (kind, targetDate) => { enterSecond(); await secondContinue;
        return { status: 'success', retryable: false, kind, targetDate, records: 2 }; }, log: () => undefined });
    await secondEntered;
    continueFirst();
    await oldInvocation;
    const leaseRow = sqlite.prepare("SELECT value FROM settings WHERE key='daily_cloud_pipeline_lease_v1'").get() as { value: string };
    const lease = JSON.parse(leaseRow.value);
    expect(lease.leaseUntil).toBe(firstAt + 100_000 + 90_000);
    continueSecond();
    await newInvocation;
    sqlite.close();
  });

  it('routes the separate five-minute cron through native daily collection only when explicitly enabled', async () => {
    const { sqlite, db } = createDb();
    const now = Date.parse('2026-10-16T19:00:00Z'); // 04:00 JST Oct 17
    vi.setSystemTime(now);
    const fetcher = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const env = { DB: db, ENABLE_NATIVE_DAILY_PIPELINE: 'true', ENABLE_NATIVE_EXPERIMENTAL_FORECAST: 'true',
      TRIFECTA_ARCHIVE: {} as R2Bucket };
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: now } as ScheduledController, env as any);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const status = await app.request('/api/collection/status', {}, env as any);
    expect((await status.json() as any).nativeDailyStatus).toMatchObject({
      date: '2026-10-17', bToday: { state: 'pending', reason: 'source-not-published' },
      learning: { state: 'unconfigured' },
    });
    vi.unstubAllGlobals();
    vi.useRealTimers();
    sqlite.close();
  });
});
