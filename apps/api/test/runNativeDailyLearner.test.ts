import { describe, expect, it, vi } from 'vitest';
import { runNativeDailyLearner } from '../src/services/runNativeDailyLearner.js';

const day = '2026-10-16';
const report = (overrides: Record<string, unknown> = {}) => ({
  status: 'candidate',
  inputCounts: { candidateRaces: 12, archives: 12, labels: 12, truncatedCandidates: 0,
    requestedWindowDays: 120, selectedFrom: '2026-10-01', selectedTo: day },
  inputSelection: 'most-recent-bounded-real-cohort', candidateOnly: true,
  registered: false, promoted: false, artifactCreated: true,
  candidatePrefix: `learning-candidates/${day}/worker-experimental-20261016T000000Z/`,
  ...overrides,
});
const learnerWith = (response: Response) => {
  const fetch = vi.fn(async () => response);
  return { learner: { fetch } as unknown as Fetcher, fetch };
};

describe('native daily learner service binding', () => {
  it('sends only explicit current-date confirmation and reports a candidate without promotion claims', async () => {
    const { learner, fetch } = learnerWith(new Response(JSON.stringify(report()), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const result = await runNativeDailyLearner(learner, day);
    expect(fetch).toHaveBeenCalledWith('https://learner/learn', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ date: day, confirmed: true }), redirect: 'manual',
    }));
    expect(result).toEqual({ status: 'success', reportStatus: 'candidate', candidateArtifactCreated: true });
    expect(JSON.stringify(result)).not.toMatch(/trained|promoted/i);
  });

  it('accepts a strict insufficient-data report without claiming an artifact', async () => {
    const { learner } = learnerWith(new Response(JSON.stringify(report({
      status: 'insufficient_data', artifactCreated: false,
    })), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await runNativeDailyLearner(learner, day)).toEqual({
      status: 'success', reportStatus: 'insufficient_data', candidateArtifactCreated: false,
    });
  });

  it('fails closed on invalid promotion flags and retries a learner daily lease response', async () => {
    const { learner: invalid } = learnerWith(new Response(JSON.stringify(report({ promoted: true })), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    expect(await runNativeDailyLearner(invalid, day)).toMatchObject({ status: 'failed', retryable: false });
    const { learner: active } = learnerWith(new Response(JSON.stringify({
      status: 'skipped', reason: 'daily_lease_active', candidateOnly: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await runNativeDailyLearner(active, day)).toEqual({
      status: 'failed', reason: 'learning-already-running', retryable: true,
    });
  });

  it('bounds the report body and treats service failures as retryable', async () => {
    const { learner: oversized } = learnerWith(new Response(' '.repeat(65 * 1024), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    expect(await runNativeDailyLearner(oversized, day)).toMatchObject({ status: 'failed', retryable: false });
    const { learner: unavailable } = learnerWith(new Response('{"status":"failed"}', {
      status: 503, headers: { 'content-type': 'application/json' },
    }));
    expect(await runNativeDailyLearner(unavailable, day)).toEqual({
      status: 'failed', reason: 'learning-service-unavailable', retryable: true,
    });
  });

  it('distinguishes fetch exceptions from HTTP failures using only safe stage and status fields', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const throwing = { fetch: vi.fn(async () => { throw new Error('must-not-be-logged'); }) } as unknown as Fetcher;
    await runNativeDailyLearner(throwing, day, line => logs.push(JSON.parse(line)));
    const { learner: unavailable } = learnerWith(new Response('secret response body', { status: 503 }));
    await runNativeDailyLearner(unavailable, day, line => logs.push(JSON.parse(line)));
    expect(logs).toEqual([
      { event: 'private-learner-call', mode: 'experimental', stage: 'fetch', status: 'failed', reason: 'fetch-exception' },
      { event: 'private-learner-call', mode: 'experimental', stage: 'response', status: 'retryable-failure', reason: 'http-error', httpStatus: 503 },
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/must-not-be-logged|secret response body|learner\/learn/);
  });

  it('accepts only fixed internal learner diagnostics from a bounded error response', async () => {
    const body = { status: 'failed', reason: 'learner_internal_error', diagnostic: { stage: 'fit', errorClass: 'ValueError' }, detail: 'must-not-propagate' };
    const { learner } = learnerWith(new Response(JSON.stringify(body), { status: 503, headers: { 'content-type': 'application/json' } }));
    expect(await runNativeDailyLearner(learner, day)).toEqual({ status: 'failed', reason: 'learning-service-unavailable', retryable: true,
      diagnostic: { stage: 'fit', errorClass: 'ValueError' } });
    const { learner: invalid } = learnerWith(new Response(JSON.stringify({ ...body, diagnostic: { stage: 'fit', errorClass: 'ValueError', path: '/private' } }),
      { status: 503, headers: { 'content-type': 'application/json' } }));
    expect(await runNativeDailyLearner(invalid, day)).not.toHaveProperty('diagnostic');
  });
});
