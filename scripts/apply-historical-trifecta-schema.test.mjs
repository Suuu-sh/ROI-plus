import test from 'node:test'
import assert from 'node:assert/strict'
import { migrationAction } from './apply-historical-trifecta-schema.mjs'

const applied = ['0001_init.sql', '0013_some_prior.sql']
const local = [...applied, '0014_historical_trifecta_experiment.sql']

test('allows only exact-ready or the sole 0014 missing state', () => {
  assert.equal(migrationAction(local, local), 'already-applied')
  assert.equal(migrationAction(local, applied), 'apply-target')
})

test('fails closed for old missing migrations, unexpected ledger names, or multiple missing names', () => {
  assert.throws(() => migrationAction(local, ['0001_init.sql']), /Fail closed/)
  assert.throws(() => migrationAction(local, [...local, '0015_unknown.sql']), /absent from this checkout/)
  assert.throws(() => migrationAction(local, ['0001_init.sql', '0013_some_prior.sql', '0014_other.sql']), /absent from this checkout/)
})
