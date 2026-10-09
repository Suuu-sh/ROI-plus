PRAGMA foreign_keys = ON;

CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL CHECK (sport IN ('horse', 'boat')),
  name TEXT NOT NULL,
  UNIQUE (sport, name)
);

CREATE TABLE races (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL CHECK (sport IN ('horse', 'boat')),
  venue_id TEXT NOT NULL REFERENCES venues(id),
  race_date TEXT NOT NULL CHECK (length(race_date) = 10),
  race_no INTEGER NOT NULL CHECK (race_no > 0),
  name TEXT,
  distance INTEGER,
  surface TEXT,
  track_condition TEXT,
  weather TEXT,
  wind_speed REAL,
  wave_height REAL,
  post_time TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'closed', 'finished', 'cancelled')),
  data_origin TEXT NOT NULL CHECK (data_origin IN ('sample', 'real')),
  updated_at TEXT NOT NULL,
  UNIQUE (sport, venue_id, race_date, race_no)
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  frame INTEGER,
  name TEXT NOT NULL,
  jockey TEXT,
  trainer TEXT,
  weight_carried REAL,
  horse_weight INTEGER,
  racer_class TEXT,
  national_win_rate REAL,
  local_win_rate REAL,
  motor_no TEXT,
  motor_2rate REAL,
  boat_no TEXT,
  boat_2rate REAL,
  exhibition_time REAL,
  start_exhibition REAL,
  features_json TEXT,
  available_at TEXT NOT NULL,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('sample', 'real')),
  UNIQUE (race_id, number)
);

CREATE TABLE odds_snapshots (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  bet_type TEXT NOT NULL CHECK (bet_type IN ('win', 'place', 'quinella', 'exacta', 'trio', 'trifecta')),
  selection TEXT NOT NULL,
  odds REAL,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('sample', 'real')),
  UNIQUE (race_id, bet_type, selection, captured_at)
);

CREATE TABLE results (
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  finish_order INTEGER NOT NULL CHECK (finish_order > 0),
  number INTEGER NOT NULL CHECK (number > 0),
  data_origin TEXT NOT NULL CHECK (data_origin IN ('sample', 'real')),
  PRIMARY KEY (race_id, number),
  UNIQUE (race_id, finish_order)
);

CREATE TABLE payouts (
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  bet_type TEXT NOT NULL CHECK (bet_type IN ('win', 'place', 'quinella', 'exacta', 'trio', 'trifecta')),
  selection TEXT NOT NULL,
  payout INTEGER NOT NULL CHECK (payout >= 0),
  popularity INTEGER,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('sample', 'real')),
  PRIMARY KEY (race_id, bet_type, selection)
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL CHECK (sport IN ('horse', 'boat')),
  bet_type TEXT NOT NULL CHECK (bet_type IN ('win', 'place', 'quinella', 'exacta', 'trio', 'trifecta')),
  version TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('untrained', 'candidate', 'active', 'retired')),
  train_from TEXT,
  train_to TEXT,
  valid_from TEXT,
  valid_to TEXT,
  test_from TEXT,
  test_to TEXT,
  n_train INTEGER,
  metrics_json TEXT,
  trained_at TEXT,
  notes TEXT,
  UNIQUE (sport, bet_type, version)
);

CREATE TABLE predictions (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id),
  number INTEGER NOT NULL CHECK (number > 0),
  probability REAL CHECK (probability IS NULL OR (probability >= 0 AND probability <= 1)),
  prob_std REAL CHECK (prob_std IS NULL OR prob_std >= 0),
  predicted_at TEXT NOT NULL,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('sample', 'real')),
  UNIQUE (race_id, model_id, number, predicted_at)
);

CREATE TABLE bets (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id),
  sport TEXT NOT NULL CHECK (sport IN ('horse', 'boat')),
  bet_type TEXT NOT NULL CHECK (bet_type IN ('win', 'place', 'quinella', 'exacta', 'trio', 'trifecta')),
  selection TEXT NOT NULL,
  stake INTEGER NOT NULL CHECK (stake > 0),
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'auto')),
  predicted_prob REAL,
  odds_at_bet REAL,
  expected_roi REAL,
  edge_label TEXT NOT NULL CHECK (edge_label IN ('HIGH_EDGE', 'POSITIVE_EDGE', 'NEUTRAL', 'NEGATIVE_EDGE', 'INSUFFICIENT_DATA')),
  model_id TEXT REFERENCES models(id),
  placed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'won', 'lost', 'void')),
  payout INTEGER,
  profit INTEGER,
  final_odds REAL,
  settled_at TEXT,
  ev_lost INTEGER NOT NULL DEFAULT 0,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('sample', 'real')),
  UNIQUE (race_id, bet_type, selection, mode, placed_at)
);

CREATE TABLE collection_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  sport TEXT NOT NULL CHECK (sport IN ('horse', 'boat')),
  target_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed', 'skipped')),
  records INTEGER,
  error TEXT,
  reason TEXT,
  UNIQUE (source, sport, target_date, started_at)
);

CREATE TABLE daily_summaries (
  date TEXT NOT NULL,
  sport TEXT NOT NULL CHECK (sport IN ('horse', 'boat')),
  bets INTEGER NOT NULL DEFAULT 0,
  stake INTEGER NOT NULL DEFAULT 0,
  payout INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, sport)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('initial_bankroll', '100000'),
  ('unit_stake', '100'),
  ('auto_bet_enabled', 'false'),
  ('auto_promote_enabled', 'false'),
  ('min_expected_roi', '0.05'),
  ('max_prob_std', '0.05');

CREATE INDEX idx_races_date_sport ON races(race_date, sport);
CREATE INDEX idx_entries_race ON entries(race_id);
CREATE INDEX idx_odds_latest ON odds_snapshots(race_id, bet_type, captured_at DESC);
CREATE INDEX idx_predictions_latest ON predictions(race_id, model_id, predicted_at DESC);
CREATE INDEX idx_bets_status_placed ON bets(status, placed_at);
CREATE UNIQUE INDEX idx_bets_auto_one_per_race ON bets(race_id) WHERE mode = 'auto';
CREATE INDEX idx_collection_runs_source_time ON collection_runs(source, started_at DESC);
