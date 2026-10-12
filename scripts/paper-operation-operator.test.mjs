import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_QUERY, TARGET_DATE, parseQuery } from './paper-operation-operator.mjs';

test('status query is bounded to the fixed settings allowlist', () => {
  assert.match(SETTINGS_QUERY, /LIMIT 9/);
  assert.match(SETTINGS_QUERY, /auto_bet_start_date/);
  assert.doesNotMatch(SETTINGS_QUERY, /SELECT\s+\*/i);
  assert.deepEqual(parseQuery('[{"success":true,"results":[{"key":"auto_bet_enabled","value":"false"}]}]'), [{ key: 'auto_bet_enabled', value: 'false' }]);
});

test('operator target date is fixed and has no configuration export', async () => {
  assert.equal(TARGET_DATE, '2026-10-14');
  const operator = await import('./paper-operation-operator.mjs');
  assert.equal('CONFIGURE_SQL' in operator, false);
});

test('bounded D1 JSON parser rejects unexpected response shape and row excess', () => {
  assert.deepEqual(parseQuery('[{"success":true,"results":[{"value":1}]}]', 1), [{ value: 1 }]);
  assert.throws(() => parseQuery('not json'));
  assert.throws(() => parseQuery('[{"success":true,"results":[{},{}]}]', 1));
});
