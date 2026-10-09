-- 実データには同着（dead heat）があるため、着順の一意制約を外す。
CREATE TABLE results_new (
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  finish_order INTEGER NOT NULL CHECK (finish_order > 0),
  number INTEGER NOT NULL CHECK (number > 0),
  data_origin TEXT NOT NULL CHECK (data_origin IN ('sample', 'real')),
  PRIMARY KEY (race_id, number)
);
INSERT INTO results_new SELECT race_id, finish_order, number, data_origin FROM results;
DROP TABLE results;
ALTER TABLE results_new RENAME TO results;
CREATE INDEX IF NOT EXISTS idx_results_race_order ON results (race_id, finish_order);
