-- A single immutable JSON row stores each validated prerace capture bundle.
-- This does not write to odds_snapshots, predictions, or paper decisions.
CREATE TABLE boatrace_prerace_capture_archives (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE RESTRICT,
  race_date TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  archive_json TEXT NOT NULL CHECK (
    json_valid(archive_json)
    AND length(archive_json) <= 32768
    AND json_extract(archive_json,'$.schema') = 'boat-prerace-capture-v1'
    AND json_extract(archive_json,'$.race.id') = race_id
    AND json_array_length(archive_json,'$.trifectaOdds.odds') = 120
    AND length(json_extract(archive_json,'$.beforeinfo.sha256')) = 64
    AND json_extract(archive_json,'$.beforeinfo.sha256') NOT GLOB '*[^a-f0-9]*'
    AND length(json_extract(archive_json,'$.trifectaOdds.sha256')) = 64
    AND json_extract(archive_json,'$.trifectaOdds.sha256') NOT GLOB '*[^a-f0-9]*'
    AND julianday(json_extract(archive_json,'$.beforeinfo.cutoffAt')) > julianday(json_extract(archive_json,'$.beforeinfo.capturedAt'))
    AND julianday(json_extract(archive_json,'$.beforeinfo.cutoffAt')) > julianday(json_extract(archive_json,'$.trifectaOdds.capturedAt'))
  ),
  data_origin TEXT NOT NULL CHECK (data_origin='real'),
  UNIQUE(race_id,captured_at)
);

CREATE INDEX idx_boatrace_capture_archives_date_cursor
  ON boatrace_prerace_capture_archives(race_date,id);
CREATE INDEX idx_boatrace_capture_archives_race_time
  ON boatrace_prerace_capture_archives(race_id,captured_at DESC);

CREATE TRIGGER trg_boatrace_capture_archives_no_update
BEFORE UPDATE ON boatrace_prerace_capture_archives
BEGIN
  SELECT RAISE(ABORT, 'prerace capture archives are immutable');
END;

CREATE TRIGGER trg_boatrace_capture_archives_no_delete
BEFORE DELETE ON boatrace_prerace_capture_archives
BEGIN
  SELECT RAISE(ABORT, 'prerace capture archives are immutable');
END;
