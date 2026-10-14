-- Official refunds are represented explicitly as void without changing any
-- existing paper-bet values. SQLite cannot alter a CHECK constraint in place;
-- rebuild the two bet tables while preserving all columns and indexes.

CREATE TABLE experimental_paper_bets_refund_shadow (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES experimental_paper_decisions(id) ON DELETE RESTRICT,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE RESTRICT,
  model_id TEXT NOT NULL REFERENCES experimental_models(id) ON DELETE RESTRICT,
  selection TEXT NOT NULL,
  stake INTEGER NOT NULL CHECK (stake>0),
  probability REAL NOT NULL CHECK (probability>=0 AND probability<=1),
  prob_std REAL NOT NULL CHECK (prob_std>=0),
  odds_at_bet REAL NOT NULL CHECK (odds_at_bet>0),
  expected_roi REAL NOT NULL,
  placed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','won','lost','void')),
  payout INTEGER CHECK (payout IS NULL OR payout>=0),
  profit INTEGER,
  settled_at TEXT,
  data_origin TEXT NOT NULL CHECK (data_origin='real'),
  UNIQUE(race_id,selection)
);
INSERT INTO experimental_paper_bets_refund_shadow
  SELECT id,decision_id,race_id,model_id,selection,stake,probability,prob_std,
         odds_at_bet,expected_roi,placed_at,status,payout,profit,settled_at,data_origin
  FROM experimental_paper_bets;

CREATE TABLE historical_trifecta_experiment_bets_refund_shadow (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES historical_trifecta_experiment_decisions(id) ON DELETE RESTRICT,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE RESTRICT,
  model_id TEXT NOT NULL CHECK (model_id='boat-trifecta-historical-base-20261014'),
  selection TEXT NOT NULL,
  stake INTEGER NOT NULL CHECK (stake>=100 AND stake%100=0),
  probability REAL NOT NULL CHECK (probability>=0 AND probability<=1),
  prob_std REAL NOT NULL CHECK (prob_std>=0),
  odds_at_bet REAL NOT NULL CHECK (odds_at_bet>1),
  expected_roi REAL NOT NULL,
  placed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','won','lost','void')),
  payout INTEGER CHECK (payout IS NULL OR payout>=0),
  profit INTEGER,
  settled_at TEXT,
  final_odds REAL,
  data_origin TEXT NOT NULL CHECK (data_origin='real'),
  UNIQUE(decision_id,selection)
);
INSERT INTO historical_trifecta_experiment_bets_refund_shadow
  SELECT id,decision_id,race_id,model_id,selection,stake,probability,prob_std,
         odds_at_bet,expected_roi,placed_at,status,payout,profit,settled_at,final_odds,data_origin
  FROM historical_trifecta_experiment_bets;

-- The reconciliation FK uses ON DELETE RESTRICT. Preserve that child table's
-- complete contents in a temporary non-FK table before dropping its parent.
CREATE TABLE experimental_paper_bet_reconciliations_refund_shadow (
  bet_id TEXT PRIMARY KEY,
  experiment_key TEXT NOT NULL,
  original_stake INTEGER NOT NULL,
  refund_amount INTEGER NOT NULL,
  repair_reason TEXT NOT NULL,
  repaired_at TEXT NOT NULL,
  refund_applied_at TEXT
);
INSERT INTO experimental_paper_bet_reconciliations_refund_shadow
  SELECT bet_id,experiment_key,original_stake,refund_amount,repair_reason,repaired_at,refund_applied_at
  FROM experimental_paper_bet_reconciliations;

DROP TRIGGER trg_experimental_paper_bet_reconciliations_no_update;
DROP TRIGGER trg_experimental_paper_bet_reconciliations_no_delete;
DROP TABLE experimental_paper_bet_reconciliations;

DROP TABLE experimental_paper_bets;
ALTER TABLE experimental_paper_bets_refund_shadow RENAME TO experimental_paper_bets;
CREATE INDEX idx_experimental_paper_bets_status
  ON experimental_paper_bets(status,placed_at);

DROP TABLE historical_trifecta_experiment_bets;
ALTER TABLE historical_trifecta_experiment_bets_refund_shadow RENAME TO historical_trifecta_experiment_bets;
CREATE INDEX idx_historical_trifecta_experiment_bets_status
  ON historical_trifecta_experiment_bets(status,placed_at);

CREATE TABLE experimental_paper_bet_reconciliations (
  bet_id TEXT PRIMARY KEY REFERENCES experimental_paper_bets(id) ON DELETE RESTRICT,
  experiment_key TEXT NOT NULL CHECK (experiment_key='boat-trifecta-small-sample-v1'),
  original_stake INTEGER NOT NULL CHECK (original_stake>0),
  refund_amount INTEGER NOT NULL CHECK (refund_amount=original_stake),
  repair_reason TEXT NOT NULL CHECK (repair_reason='invalid_stake_unit'),
  repaired_at TEXT NOT NULL,
  refund_applied_at TEXT
);
INSERT INTO experimental_paper_bet_reconciliations
  SELECT bet_id,experiment_key,original_stake,refund_amount,repair_reason,repaired_at,refund_applied_at
  FROM experimental_paper_bet_reconciliations_refund_shadow;
DROP TABLE experimental_paper_bet_reconciliations_refund_shadow;

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
