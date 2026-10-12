import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIGURE_SQL, SETTINGS_QUERY, TARGET_DATE, compatibleActiveTrifecta, parseQuery } from './paper-operation-operator.mjs';

test('status query is bounded to the fixed settings allowlist', () => {
  assert.match(SETTINGS_QUERY, /LIMIT 9/);
  assert.match(SETTINGS_QUERY, /auto_bet_start_date/);
  assert.doesNotMatch(SETTINGS_QUERY, /SELECT\s+\*/i);
  assert.deepEqual(parseQuery('[{"success":true,"results":[{"key":"INGEST_TOKEN","value":"secret"}]}]'), [{ key: 'INGEST_TOKEN', value: 'secret' }]);
});

test('configuration SQL only mutates enable, pause, and fixed start date', () => {
  assert.equal(TARGET_DATE, '2026-10-14');
  assert.match(CONFIGURE_SQL, /auto_bet_enabled/);
  assert.match(CONFIGURE_SQL, /auto_bet_paused/);
  assert.match(CONFIGURE_SQL, /auto_bet_start_date.*2026-10-14/);
  assert.doesNotMatch(CONFIGURE_SQL, /unit_stake|min_expected_roi|max_prob_std|budget|promote/i);
});

test('bounded D1 JSON parser rejects unexpected response shape and row excess', () => {
  assert.deepEqual(parseQuery('[{"success":true,"results":[{"value":1}]}]', 1), [{ value: 1 }]);
  assert.throws(() => parseQuery('not json'));
  assert.throws(() => parseQuery('[{"success":true,"results":[{},{}]}]', 1));
});

test('configure gate requires a recent fully validated active trifecta model', () => {
  const sha = 'a'.repeat(64);
  const metrics = { ticketModelSchemaVersion:'ticket-selection-v1', ticketPredictionSemantics:'exact-selection-probability-v1', ticketBetType:'trifecta', ticketArtifactSha256:sha, promotionEligible:true, ticketValidation:{ status:'independently_validated', policyVersion:'ticket-selection-v1', betType:'trifecta', artifactSha256:sha, reportSha256:'b'.repeat(64), independentReviewId:'review-1', dataOrigin:'real', completeCombinationCoverage:true, probabilitiesNormalized:true, outOfSampleValidated:true, pointInTimeSafe:true, validatedAt:'2026-10-13T00:00:00Z' } };
  assert.equal(compatibleActiveTrifecta({status:'candidate',sport:'boat',bet_type:'trifecta',metrics_json:JSON.stringify(metrics)}, Date.parse('2026-10-13T12:00:00Z')), false);
  assert.equal(compatibleActiveTrifecta({status:'active',sport:'boat',bet_type:'trifecta',metrics_json:JSON.stringify(metrics)}, Date.parse('2026-10-13T12:00:00Z')), true);
  assert.equal(compatibleActiveTrifecta({status:'active',sport:'boat',bet_type:'trifecta',metrics_json:JSON.stringify(metrics)}, Date.parse('2026-11-20T00:00:00Z')), false);
});
