-- Store only observations captured from the live official beforeinfo page.
-- Existing B/K rows are not backfilled or relabelled by this migration.
CREATE TABLE boatrace_prerace_observations (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('exhibition','weather')),
  entry_number INTEGER NOT NULL CHECK (entry_number BETWEEN 0 AND 6),
  source_url TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'),
  source_observed_at TEXT,
  source_observation_label TEXT,
  fetched_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  data_origin TEXT NOT NULL CHECK (data_origin='real'),
  CHECK ((kind='weather' AND entry_number=0) OR (kind='exhibition' AND entry_number BETWEEN 1 AND 6)),
  CHECK (julianday(available_at)=julianday(fetched_at)),
  CHECK (source_observed_at IS NULL OR julianday(source_observed_at)<=julianday(fetched_at)),
  UNIQUE(race_id,kind,entry_number,fetched_at)
);

CREATE INDEX idx_boatrace_prerace_observations_race_time
  ON boatrace_prerace_observations(race_id,kind,entry_number,fetched_at DESC);
