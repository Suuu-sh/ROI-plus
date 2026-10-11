-- Freeze only new paper decisions. Existing bets remain unclassified (NULL).
ALTER TABLE bets ADD COLUMN decision_phase TEXT CHECK (
  decision_phase IS NULL OR decision_phase = 'primary_t60'
);

CREATE TABLE paper_decisions (
  race_id TEXT NOT NULL REFERENCES races(id),
  phase TEXT NOT NULL CHECK (phase IN ('primary_t60', 'comparison_t30', 'comparison_t10')),
  cutoff_at TEXT,
  target_at TEXT,
  decided_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('placed', 'abstained', 'observed', 'unavailable')),
  reason TEXT,
  bet_group_id TEXT,
  snapshot_json TEXT,
  PRIMARY KEY (race_id, phase),
  CHECK (
    (phase = 'primary_t60' AND outcome IN ('placed', 'abstained')) OR
    (phase IN ('comparison_t30', 'comparison_t10') AND outcome IN ('observed', 'unavailable'))
  ),
  CHECK (
    (outcome = 'placed' AND reason IS NULL AND bet_group_id IS NOT NULL AND snapshot_json IS NOT NULL) OR
    (outcome = 'abstained' AND reason IS NOT NULL AND bet_group_id IS NULL AND snapshot_json IS NULL) OR
    (outcome = 'observed' AND reason IS NULL AND bet_group_id IS NULL AND snapshot_json IS NOT NULL) OR
    (outcome = 'unavailable' AND reason IS NOT NULL AND bet_group_id IS NULL AND snapshot_json IS NULL)
  )
);

