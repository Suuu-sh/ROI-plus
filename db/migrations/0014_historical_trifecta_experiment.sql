-- Isolated, virtual-only ledger for the historical BASE model experiment.
-- It does not reuse the qualified-candidate or no-weather experimental registry.
CREATE TABLE historical_trifecta_experiment_decisions (
  id TEXT PRIMARY KEY,
  experiment_key TEXT NOT NULL CHECK (experiment_key='boat-trifecta-historical-base-v1'),
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE RESTRICT,
  model_id TEXT NOT NULL CHECK (model_id='boat-trifecta-historical-base-20261014'),
  capture_archive_id TEXT REFERENCES boatrace_prerace_capture_archives(id) ON DELETE RESTRICT,
  decision_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('placed','abstained')),
  reason TEXT,
  total_stake INTEGER NOT NULL DEFAULT 0 CHECK (total_stake BETWEEN 0 AND 1000),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  UNIQUE(experiment_key,race_id)
);
CREATE INDEX idx_historical_trifecta_experiment_decisions_recent
  ON historical_trifecta_experiment_decisions(decision_at DESC);

CREATE TABLE historical_trifecta_experiment_bets (
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
  status TEXT NOT NULL CHECK (status IN ('open','won','lost')),
  payout INTEGER CHECK (payout IS NULL OR payout>=0),
  profit INTEGER,
  settled_at TEXT,
  final_odds REAL,
  data_origin TEXT NOT NULL CHECK (data_origin='real'),
  UNIQUE(decision_id,selection)
);
CREATE INDEX idx_historical_trifecta_experiment_bets_status
  ON historical_trifecta_experiment_bets(status,placed_at);

CREATE TABLE historical_trifecta_experiment_bankroll (
  experiment_key TEXT PRIMARY KEY CHECK (experiment_key='boat-trifecta-historical-base-v1'),
  initial_balance INTEGER NOT NULL CHECK (initial_balance=100000),
  available_balance INTEGER NOT NULL CHECK (available_balance>=0),
  updated_at TEXT NOT NULL
);
INSERT INTO historical_trifecta_experiment_bankroll(experiment_key,initial_balance,available_balance,updated_at)
VALUES('boat-trifecta-historical-base-v1',100000,100000,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
