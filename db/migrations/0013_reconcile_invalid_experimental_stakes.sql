-- Preserve invalid experimental paper tickets as audit history while refunding
-- their reserved virtual stake exactly once. Ordinary settlement/reporting
-- derives the ticket as void from this reconciliation ledger.
CREATE TABLE experimental_paper_bet_reconciliations (
  bet_id TEXT PRIMARY KEY REFERENCES experimental_paper_bets(id) ON DELETE RESTRICT,
  experiment_key TEXT NOT NULL CHECK (experiment_key='boat-trifecta-small-sample-v1'),
  original_stake INTEGER NOT NULL CHECK (original_stake>0),
  refund_amount INTEGER NOT NULL CHECK (refund_amount=original_stake),
  repair_reason TEXT NOT NULL CHECK (repair_reason='invalid_stake_unit'),
  repaired_at TEXT NOT NULL,
  refund_applied_at TEXT
);

-- The nullable refund marker makes this sequence retry-safe if a migration
-- runner retries after a partial execution. Migrations execute transactionally.
INSERT INTO experimental_paper_bet_reconciliations
  (bet_id,experiment_key,original_stake,refund_amount,repair_reason,repaired_at)
SELECT b.id,d.experiment_key,b.stake,b.stake,'invalid_stake_unit',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM experimental_paper_bets b
JOIN experimental_paper_decisions d ON d.id=b.decision_id
WHERE d.experiment_key='boat-trifecta-small-sample-v1'
  AND d.outcome='placed'
  AND b.data_origin='real'
  AND b.status='open'
  AND (b.stake<100 OR b.stake%100<>0)
ON CONFLICT(bet_id) DO NOTHING;

UPDATE experimental_bankroll
SET available_balance=available_balance+(
      SELECT COALESCE(SUM(refund_amount),0)
      FROM experimental_paper_bet_reconciliations
      WHERE refund_applied_at IS NULL
    ),
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE experiment_key='boat-trifecta-small-sample-v1'
  AND EXISTS (SELECT 1 FROM experimental_paper_bet_reconciliations WHERE refund_applied_at IS NULL);

UPDATE experimental_paper_bet_reconciliations
SET refund_applied_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE refund_applied_at IS NULL;

CREATE TRIGGER trg_experimental_paper_bets_valid_stake_insert
BEFORE INSERT ON experimental_paper_bets
WHEN NEW.stake<100 OR NEW.stake%100<>0
BEGIN SELECT RAISE(ABORT, 'experimental stake must be at least 100 yen and divisible by 100'); END;

CREATE TRIGGER trg_experimental_paper_bets_valid_stake_update
BEFORE UPDATE OF stake ON experimental_paper_bets
WHEN NEW.stake<100 OR NEW.stake%100<>0
BEGIN SELECT RAISE(ABORT, 'experimental stake must be at least 100 yen and divisible by 100'); END;

CREATE TRIGGER trg_experimental_paper_bet_reconciliations_no_update
BEFORE UPDATE ON experimental_paper_bet_reconciliations
BEGIN SELECT RAISE(ABORT, 'experimental paper bet reconciliations are immutable'); END;

CREATE TRIGGER trg_experimental_paper_bet_reconciliations_no_delete
BEFORE DELETE ON experimental_paper_bet_reconciliations
BEGIN SELECT RAISE(ABORT, 'experimental paper bet reconciliations are immutable'); END;
