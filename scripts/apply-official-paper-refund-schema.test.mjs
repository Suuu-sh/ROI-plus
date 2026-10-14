import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPreserved, refundMigrationAction } from './apply-official-paper-refund-schema.mjs'

const target = '0015_official_paper_refunds.sql'
const local = ['0001_init.sql', '0012_experimental_trifecta_paper.sql', '0013_reconcile_invalid_experimental_stakes.sql', '0014_historical_trifecta_experiment.sql', target]

test('only accepts a ready ledger or 0015 as the sole pending migration', () => {
  assert.equal(refundMigrationAction(local, local.slice(0, -1)), 'apply-target')
  assert.equal(refundMigrationAction(local, local), 'already-applied')
  assert.throws(() => refundMigrationAction(local, local.slice(0, -2)), /only unapplied/)
  assert.throws(() => refundMigrationAction([...local, '0016_unknown.sql'], local.slice(0, -1)), /only unapplied/)
  assert.throws(() => refundMigrationAction(local, [...local, '0016_unknown.sql']), /absent from this checkout/)
})

test('preservation checks accept settlement races and new rows but reject loss or immutable edits', () => {
  const open = { id: 'b1', status: 'open', stake: 100, selection: '1-2-3', payout: null, profit: null, settled_at: null }
  const reconciliation = { bet_id: 'b1', refund_amount: 100, repair_reason: 'invalid_stake_unit' }
  const before = { tables: {
    experimental_paper_bets: [open],
    historical_trifecta_experiment_bets: [],
    experimental_paper_bet_reconciliations: [reconciliation],
  } }
  const after = {
    experimental_paper_bets: [
      { ...open, status: 'void', payout: 100, profit: 0, settled_at: '2026-10-14T00:00:00Z' },
      { id: 'b2', status: 'open', stake: 100, selection: '2-3-4', payout: null, profit: null, settled_at: null },
    ],
    historical_trifecta_experiment_bets: [],
    experimental_paper_bet_reconciliations: [reconciliation],
  }
  assert.doesNotThrow(() => assertPreserved(before, after))
  assert.throws(() => assertPreserved(before, { ...after, experimental_paper_bets: after.experimental_paper_bets.slice(1) }), /lost a pre-existing row/)
  assert.throws(() => assertPreserved(before, { ...after, experimental_paper_bet_reconciliations: [{ ...reconciliation, refund_amount: 200 }] }), /immutable reconciliation/)
  assert.throws(() => assertPreserved(before, { ...after, experimental_paper_bets: [{ ...after.experimental_paper_bets[0], selection: 'changed' }] }), /immutable bet data/)
})
