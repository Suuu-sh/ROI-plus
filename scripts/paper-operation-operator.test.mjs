import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SETTINGS_QUERY, TARGET_DATE, jstRaceDate, targetRaceDates, parseQuery, safeBet } from './paper-operation-operator.mjs';

test('status query is bounded to the fixed settings allowlist', () => {
  assert.match(SETTINGS_QUERY, /LIMIT 9/);
  assert.match(SETTINGS_QUERY, /auto_bet_start_date/);
  assert.doesNotMatch(SETTINGS_QUERY, /SELECT\s+\*/i);
  assert.deepEqual(parseQuery('[{"success":true,"results":[{"key":"auto_bet_enabled","value":"false"}]}]'), [{ key: 'auto_bet_enabled', value: 'false' }]);
});

test('operator dates are calculated from JST and injectable for deterministic tests', async () => {
  assert.equal(jstRaceDate(new Date('2026-10-13T14:59:59.000Z')), '2026-10-13');
  assert.deepEqual(targetRaceDates(new Date('2026-10-13T15:00:00.000Z')),
    { today: '2026-10-14', tomorrow: '2026-10-15' });
  assert.deepEqual(targetRaceDates(new Date('2024-02-28T15:00:00.000Z')),
    { today: '2024-02-29', tomorrow: '2024-03-01' });
  assert.throws(() => jstRaceDate(new Date('invalid')));
  assert.match(TARGET_DATE, /^\d{4}-\d{2}-\d{2}$/);
  const operator = await import('./paper-operation-operator.mjs');
  assert.equal('CONFIGURE_SQL' in operator, false);
});

test('bounded D1 JSON parser rejects unexpected response shape and row excess', () => {
  assert.deepEqual(parseQuery('[{"success":true,"results":[{"value":1}]}]', 1), [{ value: 1 }]);
  assert.throws(() => parseQuery('not json'));
  assert.throws(() => parseQuery('[{"success":true,"results":[{},{}]}]', 1));
});

test('daily sync gets an early post-reset run and retains fallback retries', async () => {
  const workflow = await readFile(new URL('../.github/workflows/daily.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '5 0 \* \* \*'.*09:05 JST/);
  assert.match(workflow, /cron: '30 0 \* \* \*'.*09:30 JST/);
  assert.match(workflow, /cron: '0 2 \* \* \*'.*11:00 JST/);
  assert.match(workflow, /cron: '0 4 \* \* \*'.*13:00 JST/);
});

test('open-bet status projection only returns allowlisted identifiers and fields', () => {
  const safe = safeBet({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', race_id: 'boat-20261013-01-03',
    race_date: '2026-10-13', selection: '1-3-5', status: 'open', private_field: 'discard',
  });
  assert.deepEqual(safe, {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', raceId: 'boat-20261013-01-03',
    raceDate: '2026-10-13', selection: '1-3-5', status: 'open',
  });
  assert.equal(safeBet({ id: 'secret', race_id: 'bad', selection: '1-1-2', status: 'won' }).id, null);
  assert.equal(safeBet({ id: 'secret', race_id: 'bad', selection: '1-1-2', status: 'won' }).status, null);
});
