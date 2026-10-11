-- Preserve the B-file race time separately from a cutoff verified from an
-- explicitly labelled official schedule field. Existing rows stay unverified.
ALTER TABLE races ADD COLUMN betting_cutoff_at TEXT;
ALTER TABLE races ADD COLUMN betting_cutoff_source TEXT CHECK (
  betting_cutoff_source IS NULL OR betting_cutoff_source = 'boatrace-racelist-cutoff-v1'
);
ALTER TABLE paper_decisions ADD COLUMN cutoff_source TEXT CHECK (
  cutoff_source IS NULL OR cutoff_source = 'boatrace-racelist-cutoff-v1'
);
ALTER TABLE paper_decisions ADD COLUMN input_as_of_at TEXT;
