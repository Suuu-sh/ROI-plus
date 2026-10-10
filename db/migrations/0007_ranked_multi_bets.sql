-- Snapshot multi-selection manual/automatic virtual tickets without copying candidate data.
ALTER TABLE bets ADD COLUMN bet_group_id TEXT;
ALTER TABLE bets ADD COLUMN candidate_rank INTEGER CHECK (candidate_rank IS NULL OR candidate_rank > 0);
ALTER TABLE bets ADD COLUMN candidate_count INTEGER CHECK (candidate_count IS NULL OR candidate_count > 0);
ALTER TABLE bets ADD COLUMN odds_captured_at TEXT;
ALTER TABLE bets ADD COLUMN predicted_at_at_bet TEXT;

DROP INDEX IF EXISTS idx_bets_auto_one_per_race;
CREATE UNIQUE INDEX idx_bets_auto_one_per_selection
  ON bets(race_id, bet_type, selection) WHERE mode = 'auto';
CREATE UNIQUE INDEX idx_bets_group_selection
  ON bets(bet_group_id, bet_type, selection) WHERE bet_group_id IS NOT NULL;

INSERT INTO settings(key, value) VALUES ('auto_bet_max_picks', '1')
  ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES ('auto_bet_race_budget', '100')
  ON CONFLICT(key) DO NOTHING;
