import json
import io
import os
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from edgelab.trifecta_experimental_pipeline import (PipelineStageFailure, _refresh_same_day_k,
                                                   main, run)
from edgelab.cli import _make_training_rows
from edgelab.features.boat import (TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS,
                                   TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA)


@patch.dict(os.environ, {"EDGELAB_API_URL": "https://example.test", "INGEST_TOKEN": "test-only"})
@patch("edgelab.trifecta_experimental_pipeline.fetch_prerace_capture_archives")
def test_experimental_pipeline_reports_missing_actual_k_without_fabricating_a_model(fetch):
    fetch.return_value = [{"schema": "boat-prerace-capture-export-v1", "date": "2026-10-13",
                           "limit": 25, "archives": [], "nextCursor": None}]
    with TemporaryDirectory() as directory:
        report_path = Path(directory) / "trifecta-experimental-report.json"
        result = run(since="2026-10-13", until="2026-10-13",
                     store_path=str(Path(directory) / "rows.json"), report_path=str(report_path),
                     artifact_dir=str(Path(directory) / "artifacts"))
        persisted = json.loads(report_path.read_text(encoding="utf-8"))
        assert not (Path(directory) / "artifacts").exists()
    assert result["training"]["status"] == "insufficient_pit_evidence"
    assert result["training"]["availableRealKResultRows"] == 0
    assert result["training"]["reason"] == "no_completed_real_K_results"
    assert result["promotion"] == "not_performed"
    assert result["normalRegistrySync"] == "not_performed"
    assert result["virtualPurchase"] == "not_performed"
    assert persisted == result


def test_experimental_pipeline_rejects_reversed_or_unbounded_range_before_network():
    with TemporaryDirectory() as directory:
        for start, end in (("2026-10-14", "2026-10-13"), ("2026-01-01", "2026-02-02")):
            try:
                run(since=start, until=end, store_path=str(Path(directory) / "rows.json"))
            except PipelineStageFailure as exc:
                assert exc.stage == "input_validation"
                assert exc.exception_class == "ValueError"
            else:
                raise AssertionError("invalid range was accepted")


@patch("edgelab.collectors.boatrace.fetch_boatrace_file")
def test_same_day_k_refresh_skips_fetch_when_real_result_is_already_cached(fetch):
    from datetime import date
    rows = {"races": [{"id": "boat-20261013-01-01", "sport": "boat", "race_date": "2026-10-13"}],
            "results": [{"race_id": "boat-20261013-01-01", "finish_order": 1, "data_origin": "real"}]}
    result = _refresh_same_day_k(rows, date(2026, 10, 13))
    assert result == {"status": "already_present", "completedRaces": 1}
    fetch.assert_not_called()


@patch("edgelab.collectors.boatrace.read_source_file_metadata", return_value={"sourceSha256": "a" * 64})
@patch("edgelab.collectors.boatrace.read_lzh", return_value="official source")
@patch("edgelab.collectors.boatrace.fetch_boatrace_file")
def test_same_day_k_refresh_imports_only_outcome_labels_after_source_validation(fetch, read_lzh, metadata):
    from datetime import date
    from tempfile import NamedTemporaryFile
    from edgelab.trifecta_experimental_pipeline import _refresh_same_day_k
    race_id = "boat-20261013-01-01"
    parsed = {"races": [{"id": race_id, "race_date": "2026-10-13"}],
              "entries": [{"race_id": race_id, "number": 1, "available_at": "2026-10-13T00:00:00+09:00"}],
              "results": [{"race_id": race_id, "number": 1, "finish_order": 1, "data_origin": "real"}],
              "payouts": []}
    with NamedTemporaryFile() as file:
        fetch.return_value = file.name
        with patch("edgelab.parsers.boatrace_k.parse_k", return_value=parsed) as parse:
            rows = {"races": [], "entries": [], "results": [], "payouts": []}
            result = _refresh_same_day_k(rows, date(2026, 10, 13))
    fetch.assert_called_once()
    assert fetch.call_args.kwargs["retries"] == 0
    assert fetch.call_args.kwargs["refresh"] is True
    assert result["status"] == "fetched_and_validated"
    assert result["sourceVerified"] is True
    assert not rows["races"] and not rows["entries"]
    assert rows["results"][0]["available_at"].endswith("+00:00")


@patch.dict(os.environ, {"EDGELAB_API_URL": "https://example.test", "INGEST_TOKEN": "test-only"})
@patch("edgelab.trifecta_experimental_pipeline.fetch_prerace_capture_archives",
       side_effect=TypeError("private response or secret text"))
def test_pipeline_failure_report_exposes_only_fixed_stage_and_allowlisted_class(fetch):
    with TemporaryDirectory() as directory:
        report_path = Path(directory) / "report.json"
        output = io.StringIO()
        with redirect_stdout(output):
            status = main(["--since", "2026-10-13", "--until", "2026-10-13",
                           "--store", str(Path(directory) / "rows.json"),
                           "--report", str(report_path)])
        report = json.loads(report_path.read_text(encoding="utf-8"))
    assert status == 2
    assert report["training"] == {"status": "failed", "error": "pipeline_stage_failed",
                                  "failureStage": "archive_export", "exceptionClass": "TypeError"}
    assert "private" not in output.getvalue()
    fetch.assert_called_once()


def test_training_row_builder_supports_weatherless_experimental_schema_with_real_shaped_rows():
    race_id = "boat-20261013-01-01"
    store = {
        "races": [{"id": race_id, "sport": "boat", "data_origin": "real", "race_date": "2026-10-13",
                   "status": "finished", "post_time": "2026-10-13T11:20:00+09:00",
                   "betting_cutoff_at": "2026-10-13T11:00:00+09:00",
                   "betting_cutoff_source": "boatrace-racelist-cutoff-v1",
                   "betting_cutoff_observed_at": "2026-10-13T10:50:00+09:00"}],
        "entries": [{"id": f"{race_id}-{lane}", "race_id": race_id, "number": lane,
                     "available_at": "2026-10-13T10:00:00+09:00",
                     "source_available_at": "2026-10-13T10:00:00+09:00",
                     "source_sha256": "a" * 64, "data_origin": "real",
                     "features_json": json.dumps({"racer_id": f"{10000 + lane}"})}
                    for lane in range(1, 7)],
        "results": [{"race_id": race_id, "number": lane, "finish_order": lane, "data_origin": "real"}
                    for lane in range(1, 7)],
        "prerace_observations": [],
    }
    features = [{"lane": lane, "exhibition_time": 6.0 + lane, "lane_wind_x": 99.0,
                 "lane_wave_height": 99.0} for lane in range(1, 7)]
    with patch("edgelab.features.boat.build_boat_prerace_v2_features", return_value=features):
        rows = _make_training_rows(store, "boat", feature_schema=TRIFECTA_NO_WEATHER_EXPERIMENTAL_SCHEMA,
                                   require_source_arrival=True)
    assert len(rows) == 6
    assert all(row["lane"] == row["number"] for row in rows)
    assert "lane_wind_x" not in rows[0] and "lane_wave_height" not in rows[0]
    assert "lane_wind_x" not in TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS
