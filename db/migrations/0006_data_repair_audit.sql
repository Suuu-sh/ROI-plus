-- Explicit quarantine markers for forecasts and ledger rows tied to corrected source data.
-- Original rows remain immutable; consumers must exclude marked records from money/performance paths.
CREATE TABLE data_repair_audit_marks (
  repair_id TEXT NOT NULL,
  race_id TEXT NOT NULL REFERENCES races(id),
  record_type TEXT NOT NULL CHECK (record_type IN ('bet', 'prediction')),
  record_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  marked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repair_id, record_type, record_id)
);
CREATE INDEX idx_data_repair_audit_record ON data_repair_audit_marks(record_type, record_id);
CREATE INDEX idx_data_repair_audit_race ON data_repair_audit_marks(race_id, record_type);
CREATE TABLE data_repair_quarantined_races (
  race_id TEXT PRIMARY KEY REFERENCES races(id),
  repair_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  marked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_data_repair_quarantined_repair ON data_repair_quarantined_races(repair_id);
