import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTailRecords, safeDbRows, safeRecentOpenRows, safeResultsSettings } from './diagnose-paper-cron.mjs';

test('parses multiline tail JSON, array messages, cron event and known decision event safely', () => {
  const payload = {
    eventTimestamp: 1791986400000,
    event: { cron: '* * * * *', scheduledTime: 1791986400000 },
    outcome: 'ok',
    logs: [{ level: 'info', message: [JSON.stringify({ event: 'experimental-paper-decision', evaluated: 2,
      placedRaces: 0, placedBets: 0, abstainedByReason: { no_conservative_positive_edge: 2, secret_token_value: 3 } })] }],
    exceptions: [],
  };
  const events = parseTailRecords([JSON.stringify(payload, null, 2)]);
  assert.deepEqual(events, [
    { event: 'scheduled_invocation', timestamp: new Date(1791986400000).toISOString(), cron: '* * * * *', outcome: 'ok' },
    { event: 'experimental-paper-decision', timestamp: new Date(1791986400000).toISOString(), evaluated: 2, placedRaces: 0,
      placedBets: 0, abstainedByReason: { no_conservative_positive_edge: 2 } },
  ]);
});

test('records allowlisted exception type/callsite and never forwards raw exception text', () => {
  const payload = { eventTimestamp: '2026-10-14T07:20:00.000Z', event: { cron: '* * * * *' }, outcome: 'exception',
    logs: [], exceptions: [{ name: 'TypeError', message: 'Cannot read properties of undefined (reading secret_token_value)',
      stack: 'TypeError: secret_token_value\n    at experimentalPaperDecision (index.js:620:1)' }] };
  const result = JSON.stringify(parseTailRecords([JSON.stringify(payload, null, 2)]));
  assert.match(result, /js_missing_property_receiver/);
  assert.match(result, /experimentalPaperDecision/);
  assert.doesNotMatch(result, /secret_token_value|index\.js:620/);
});

test('records CPU and memory exceeded scheduled outcomes without event payload', () => {
  const events = parseTailRecords([
    JSON.stringify({ eventTimestamp: 1791986400, event: { cron: '* * * * *' }, outcome: 'cpuExceeded', logs: [], exceptions: [] }),
    '\n',
    JSON.stringify({ eventTimestamp: 1791986460000, event: { cron: '* * * * *' }, outcome: 'memoryExceeded', logs: [], exceptions: [] }),
  ]);
  assert.deepEqual(events.map(({ outcome }) => outcome), ['cpuExceeded', 'memoryExceeded']);
});

test('captures the five-minute watchdog invocation and only its fixed status fields', () => {
  const payload = { eventTimestamp: 1791986400000, event: { cron: '*/5 * * * *' }, outcome: 'ok',
    logs: [{ level: 'info', message: [JSON.stringify({ event: 'forecast-github-watchdog',
      status: 'http-rejected', statusCode: 403, reason: 'secret response body', token: 'never-forward',
      account_id: 'never-forward' })] }], exceptions: [] };
  assert.deepEqual(parseTailRecords([JSON.stringify(payload)]), [
    { event: 'scheduled_invocation', timestamp: new Date(1791986400000).toISOString(),
      cron: '*/5 * * * *', outcome: 'ok' },
    { event: 'forecast-github-watchdog', timestamp: new Date(1791986400000).toISOString(),
      status: 'http-rejected', statusCode: 403, reason: 'other' },
  ]);
});

test('captures only allowlisted native forecast storage proof fields', () => {
  const payload = { eventTimestamp: '2026-10-16T04:35:00Z', logs: [{ level: 'info', message: [JSON.stringify({
    event: 'experimental-forecast-native', source: 'worker-native', status: 'stored',
    predictionCount: 120, raceId: 'boat-20261016-21-04', predictedAt: '2026-10-16T04:34:00Z',
    token: 'never-forward', account_id: 'never-forward', rawError: 'never-forward',
  })] }] };
  assert.deepEqual(parseTailRecords([JSON.stringify(payload)]), [{
    event: 'experimental-forecast-native', timestamp: '2026-10-16T04:35:00.000Z',
    status: 'stored', source: 'worker-native', predictionCount: 120,
    raceId: 'boat-20261016-21-04', predictedAt: '2026-10-16T04:34:00.000Z',
  }]);
  const invalid = parseTailRecords([JSON.stringify({ logs: [{ level: 'info', message: [JSON.stringify({
    event: 'experimental-forecast-native', source: 'other', status: 'stored',
    predictionCount: 121, raceId: 'private-id', predictedAt: 'bad-time',
  })] }] })]);
  assert.deepEqual(invalid, [{ event: 'experimental-forecast-native', timestamp: null, status: 'stored' }]);
});

test('allows only safe T-60 target fields from diagnostic log events', () => {
  const payload = { eventTimestamp: '2026-10-14T07:20:00Z', logs: [{ level: 'info', message: [JSON.stringify({
    event: 'paper-t60-target', status: 'skipped', reason: 't60-window-expired', pass: 'upcoming-t60',
    cutoffAt: 'sensitive-and-not-allowlisted', account_id: 'not-output',
  })] }] };
  const result = parseTailRecords([JSON.stringify(payload)]);
  assert.deepEqual(result, [{ event: 'paper-t60-target', timestamp: '2026-10-14T07:20:00.000Z',
    status: 'skipped', pass: 'upcoming-t60', reason: 't60-window-expired' }]);
});

test('forwards bounded timing diagnostics and allowlisted drop counters only', () => {
  const payload = { eventTimestamp: '2026-10-14T07:20:00Z', logs: [{ level: 'info', message: [JSON.stringify({
    event: 'experimental-paper-decision', status: 'success', pass: 'upcoming-t60', elapsedMs: 193,
    startDeltaMs: -8, timingDroppedByReason: {
      commit_window_elapsed: 1, pre_batch_window_elapsed: 2, purchase_evidence_stale_before_commit: 3,
      arbitrary_reason: 99,
    }, arbitraryField: 'do-not-forward',
  })] }] };
  const result = parseTailRecords([JSON.stringify(payload)]);
  assert.deepEqual(result, [{ event: 'experimental-paper-decision', timestamp: '2026-10-14T07:20:00.000Z',
    status: 'success', pass: 'upcoming-t60', elapsedMs: 193, startDeltaMs: -8,
    timingDroppedByReason: { commit_window_elapsed: 1, pre_batch_window_elapsed: 2,
      purchase_evidence_stale_before_commit: 3 } }]);
});

test('sanitizes D1 rows and excludes internal identifiers, hashes, and manifest content', () => {
  const rows = safeDbRows(JSON.stringify([{ results: [{
    venue: '丸亀', raceNo: 4, raceDate: '2026-10-14', status: 'scheduled',
    cutoffAt: '2026-10-14T16:42:00+09:00', cutoffSource: 'boatrace-racelist-cutoff-v1',
    cutoffObservedAt: '2026-10-14T16:30:00+09:00', t60TargetAt: '2026-10-14 07:41:00', secondsToCutoff: 60, secondsToT60Target: 0,
    entryCount: 6, predictionCount: 120, predictedAt: '2026-10-14T16:40:00Z',
    hasExperimentalDecision: 0, hasNormalDecision: 1, hasNormalBet: 0, hasHistoricalDecision: 1,
    quarantined: 0, modelReadyGate: 1, productionT60Target: 1,
    race_id: 'internal-race-id', artifact_sha256: 'secret-hash', manifest_json: 'sensitive',
  }] }]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].venue, '丸亀');
  assert.equal(rows[0].productionT60Target, true);
  assert.equal(rows[0].t60TargetAt, '2026-10-14T07:41:00.000Z');
  assert.equal(JSON.stringify(rows).includes('internal-race-id'), false);
  assert.equal(JSON.stringify(rows).includes('secret-hash'), false);
  assert.equal(JSON.stringify(rows).includes('sensitive'), false);
});

test('sanitizes recent open purchase/result evidence without raw IDs or collection JSON', () => {
  const rows = safeRecentOpenRows(JSON.stringify([{ results: [{
    venue: '下関', raceNo: 4, raceDate: '2026-10-14', raceStatus: 'finished',
    cutoffAt: '2026-10-14T19:03:00+09:00', cutoffSource: 'boatrace-racelist-cutoff-v1', ledger: 'primary',
    lastPlacedAt: '2026-10-14T19:02:00+09:00', openTickets: 1, resultsCount: 6, payoutCount: 7, finishCount: 6,
    collectorStartedAt: '2026-10-14T19:10:00+09:00', collectorFinishedAt: '2026-10-14T19:10:03+09:00',
    collectorStatus: 'failed', collectorRecords: 0, collectorQuality: 'unavailable-or-unsupported',
    collectorReason: 'source-state-changed', collectorFetchFailure: 'fetch-timeout',
    race_id: 'private-race-id', error: 'raw error secret', reason_json: '{"payload":"private"}',
  }] }]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ledger, 'primary');
  assert.equal(rows[0].resultsCount, 6);
  assert.equal(rows[0].collectorReason, 'source-state-changed');
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /private-race-id|raw error secret|private/);
});

test('reads only timestamp-shaped values for the two results lock settings', () => {
  const rows = safeResultsSettings(JSON.stringify([{ results: [
    { key: 'boat_results_ten_minute', value: '2026-10-14T19:10' },
    { key: 'boat_results_manual_until', value: 'do-not-output-secret-token' },
  ] }]));
  assert.deepEqual(rows, [
    { key: 'boat_results_ten_minute', present: true, timestamp: '2026-10-14T19:10:00.000Z' },
    { key: 'boat_results_manual_until', present: true, timestamp: null },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /secret-token/);
});
