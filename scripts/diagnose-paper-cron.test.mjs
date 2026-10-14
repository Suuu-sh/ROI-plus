import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTailRecords } from './diagnose-paper-cron.mjs';

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
