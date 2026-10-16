import { describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { D1SqliteAdapter } from './d1-adapter.js';
import { readNativeNormalLearningStatus, runNativeNormalLearningPipeline } from '../src/services/nativeNormalLearningPipeline.js';
import { runNativeNormalDailyLearner } from '../src/services/runNativeDailyLearner.js';

const root = resolve(import.meta.dirname, '../../..');
function createDb() {
  const sqlite = new Sqlite(':memory:');
  for (const file of readdirSync(resolve(root, 'db/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(resolve(root, 'db/migrations', file), 'utf8'));
  }
  return { sqlite, db: new D1SqliteAdapter(sqlite) };
}

function markSourcesReady(sqlite: Sqlite.Database, date: string) {
  const yesterday = new Date(`${date}T12:00:00+09:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const prior = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(yesterday);
  sqlite.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('daily_cloud_pipeline_state_v1', JSON.stringify({
    schema: 'daily-cloud-pipeline-v1', date, updatedAt: '2026-10-16T18:00:00.000Z',
    bToday: { kind: 'B', targetDate: date, state: 'success', attempts: 1, records: 20 },
    kYesterday: { kind: 'K', targetDate: prior, state: 'success', attempts: 1, records: 20 },
    kToday: { kind: 'K', targetDate: date, state: 'pending', attempts: 0, records: 0 },
    learning: { state: 'unconfigured', attempts: 0 },
  }));
}

describe('native normal daily learner', () => {
  it('waits for B today and K yesterday without consuming an attempt', async () => {
    const { sqlite, db } = createDb();
    const result = await runNativeNormalLearningPipeline(db, { now: () => Date.parse('2026-10-16T18:00:00Z'),
      runLearning: async () => { throw new Error('must not call while source gate is closed'); } });
    expect(result.outcome).toBe('waiting-sources');
    expect(result.state).toMatchObject({ state: 'waiting_sources', attempts: 0, reason: 'source-data-not-ready' });
    expect(await readNativeNormalLearningStatus(db, Date.parse('2026-10-16T18:00:00Z')))
      .toMatchObject({ date: '2026-10-17', state: 'waiting_sources', attempts: 0 });
    sqlite.close();
  });

  it('runs once after source readiness and records candidate-only report outcome', async () => {
    const { sqlite, db } = createDb();
    markSourcesReady(sqlite, '2026-10-17');
    let calls = 0;
    const now = Date.parse('2026-10-16T18:00:00Z'); // 03:00 JST Oct 17
    const first = await runNativeNormalLearningPipeline(db, { now: () => now,
      runLearning: async () => { calls++; return { status: 'success', reportStatus: 'candidate', candidateArtifactCreated: true }; } });
    const second = await runNativeNormalLearningPipeline(db, { now: () => now + 5 * 60_000,
      runLearning: async () => { calls++; return { status: 'success', reportStatus: 'candidate', candidateArtifactCreated: true }; } });
    expect(first.outcome).toBe('attempted');
    expect(first.state).toMatchObject({ state: 'success', attempts: 1, reportStatus: 'candidate', candidateArtifactCreated: true });
    expect(second.outcome).toBe('idle');
    expect(calls).toBe(1);
    sqlite.close();
  });

  it('retries retryable service errors only to the four-invocation cap', async () => {
    const { sqlite, db } = createDb();
    markSourcesReady(sqlite, '2026-10-17');
    let now = Date.parse('2026-10-16T18:00:00Z');
    let calls = 0;
    let result;
    for (const delay of [0, 5, 10, 20]) {
      now += delay * 60_000;
      result = await runNativeNormalLearningPipeline(db, { now: () => now,
        runLearning: async () => { calls++; return { status: 'failed', reason: 'learning-service-unavailable', retryable: true }; } });
    }
    const done = await runNativeNormalLearningPipeline(db, { now: () => now + 5 * 60_000,
      runLearning: async () => { calls++; return { status: 'success' }; } });
    expect(result?.state).toMatchObject({ state: 'failed', attempts: 4, nextAttemptAt: null });
    expect(done.outcome).toBe('idle');
    expect(calls).toBe(4);
    sqlite.close();
  });

  it('calls the separate normal endpoint with the fixed confirmed date', async () => {
    let requestUrl = '';
    let requestBody: unknown;
    const response = {
      status: 'insufficient_data', artifactCreated: false, candidatePrefix: 'learning-candidates/2026-10-17/normal-abc/',
      candidateOnly: true, registered: false, promoted: false, inputSelection: 'most-recent-bounded-real-cohort',
      inputCounts: { candidateRaces: 0, archives: 0, labels: 0, truncatedCandidates: 0, requestedWindowDays: 30, selectedFrom: null, selectedTo: null },
    };
    const learner = { fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(url); requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
    } } as unknown as Fetcher;
    const result = await runNativeNormalDailyLearner(learner, '2026-10-17');
    expect(requestUrl).toBe('https://learner/learn/normal');
    expect(requestBody).toEqual({ date: '2026-10-17', confirmed: true });
    expect(result).toMatchObject({ status: 'success', reportStatus: 'insufficient_data', candidateArtifactCreated: false });
  });
});
