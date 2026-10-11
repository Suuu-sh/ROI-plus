-- Keep the legacy number-based `predictions` table unchanged: existing win
-- training, calibration, and replay data continue to use its original key.
CREATE TABLE ticket_predictions (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id),
  bet_type TEXT NOT NULL CHECK (bet_type IN ('place', 'quinella', 'exacta', 'wide', 'trio', 'trifecta')),
  selection TEXT NOT NULL,
  probability REAL CHECK (probability IS NULL OR (probability >= 0 AND probability <= 1)),
  prob_std REAL CHECK (prob_std IS NULL OR prob_std >= 0),
  predicted_at TEXT NOT NULL,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('sample', 'real')),
  feature_schema_version TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^a-f0-9]*'),
  UNIQUE (race_id, model_id, bet_type, selection, predicted_at)
);

CREATE INDEX idx_ticket_predictions_latest
  ON ticket_predictions(race_id, model_id, bet_type, predicted_at DESC);

-- Provenance evidence is optional for historical/win odds. Generic ticket
-- candidate eligibility will require both values and a recognized source.
ALTER TABLE odds_snapshots ADD COLUMN source_url TEXT;
ALTER TABLE odds_snapshots ADD COLUMN source_sha256 TEXT;
ALTER TABLE odds_snapshots ADD COLUMN quality_status TEXT;
