-- Experimental small-data trifecta paper ledger is deliberately separate from
-- normal model registry, predictions, bankroll, and performance aggregates.
CREATE TABLE experimental_models (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('candidate','experimental')),
  manifest_schema TEXT NOT NULL CHECK (manifest_schema='edgelab-experimental-trifecta-artifact-v1'),
  sport TEXT NOT NULL CHECK (sport='boat'),
  bet_type TEXT NOT NULL CHECK (bet_type='trifecta'),
  training_mode TEXT NOT NULL CHECK (training_mode='experimental'),
  schema_version TEXT NOT NULL CHECK (schema_version='boat-prerace-v2-no-weather-experimental-v1'),
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256)=64 AND artifact_sha256 NOT GLOB '*[^a-f0-9]*'),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
  metadata_sha256 TEXT NOT NULL CHECK (length(metadata_sha256)=64 AND metadata_sha256 NOT GLOB '*[^a-f0-9]*'),
  trained_at TEXT NOT NULL,
  artifact_manifest_json TEXT NOT NULL CHECK (json_valid(artifact_manifest_json)
    AND json_extract(artifact_manifest_json,'$.schema')='edgelab-experimental-trifecta-artifact-v1'
    AND json_extract(artifact_manifest_json,'$.modelId')=id
    AND json_extract(artifact_manifest_json,'$.trainingMode')='experimental'
    AND json_extract(artifact_manifest_json,'$.experimentalOnly')=1
    AND json_extract(artifact_manifest_json,'$.files."'||id||'.pkl".sha256')=artifact_sha256),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)
    AND json_extract(manifest_json,'$.experimentalOnly')=1
    AND json_extract(manifest_json,'$.trainingMode')='experimental'
    AND json_extract(manifest_json,'$.status') IN ('candidate','experimental')
    AND json_extract(manifest_json,'$.boatFeatureSchemaVersion')='boat-prerace-v2-no-weather-experimental-v1'
    AND json_extract(manifest_json,'$.ticketBetType')='trifecta'
    AND json_extract(manifest_json,'$.ticketArtifactSha256')=artifact_sha256),
  registered_at TEXT NOT NULL
);

CREATE TABLE experimental_ticket_predictions (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE RESTRICT,
  model_id TEXT NOT NULL REFERENCES experimental_models(id) ON DELETE RESTRICT,
  selection TEXT NOT NULL,
  probability REAL NOT NULL CHECK (probability>=0 AND probability<=1),
  prob_std REAL NOT NULL CHECK (prob_std>=0),
  predicted_at TEXT NOT NULL,
  feature_schema_version TEXT NOT NULL CHECK (feature_schema_version='ticket-selection-v1'),
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256)=64 AND artifact_sha256 NOT GLOB '*[^a-f0-9]*'),
  data_origin TEXT NOT NULL CHECK (data_origin='real'),
  UNIQUE(race_id,model_id,selection,predicted_at)
);
CREATE INDEX idx_experimental_ticket_predictions_latest
  ON experimental_ticket_predictions(race_id,model_id,predicted_at DESC);

CREATE TABLE experimental_paper_decisions (
  id TEXT PRIMARY KEY,
  experiment_key TEXT NOT NULL CHECK (experiment_key='boat-trifecta-small-sample-v1'),
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE RESTRICT,
  model_id TEXT NOT NULL REFERENCES experimental_models(id) ON DELETE RESTRICT,
  capture_archive_id TEXT REFERENCES boatrace_prerace_capture_archives(id) ON DELETE RESTRICT,
  decision_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('placed','abstained')),
  reason TEXT,
  total_stake INTEGER NOT NULL DEFAULT 0 CHECK (total_stake BETWEEN 0 AND 1000),
  sizing_method TEXT NOT NULL CHECK (sizing_method='fractional-kelly-portfolio'),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  UNIQUE(experiment_key,race_id)
);

CREATE TABLE experimental_paper_bets (
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
  status TEXT NOT NULL CHECK (status IN ('open','won','lost')),
  payout INTEGER CHECK (payout IS NULL OR payout>=0),
  profit INTEGER,
  settled_at TEXT,
  data_origin TEXT NOT NULL CHECK (data_origin='real'),
  UNIQUE(race_id,selection)
);
CREATE INDEX idx_experimental_paper_bets_status ON experimental_paper_bets(status,placed_at);

CREATE TABLE experimental_bankroll (
  experiment_key TEXT PRIMARY KEY CHECK (experiment_key='boat-trifecta-small-sample-v1'),
  initial_balance INTEGER NOT NULL CHECK (initial_balance=100000),
  available_balance INTEGER NOT NULL CHECK (available_balance>=0),
  updated_at TEXT NOT NULL
);
INSERT INTO experimental_bankroll(experiment_key,initial_balance,available_balance,updated_at)
VALUES('boat-trifecta-small-sample-v1',100000,100000,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TRIGGER trg_experimental_models_no_update BEFORE UPDATE ON experimental_models
BEGIN SELECT RAISE(ABORT, 'experimental model manifests are immutable'); END;
CREATE TRIGGER trg_experimental_models_no_delete BEFORE DELETE ON experimental_models
BEGIN SELECT RAISE(ABORT, 'experimental model manifests are immutable'); END;
