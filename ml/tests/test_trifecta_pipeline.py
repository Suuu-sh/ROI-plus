import unittest
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from edgelab.trifecta_pipeline import fetch_archive_pages, run


class TrifectaPipelineTests(unittest.TestCase):
    @patch("edgelab.trifecta_pipeline.fetch_prerace_capture_archives")
    def test_fetches_archives_through_bounded_sync_reader(self, fetch):
        fetch.return_value = [{"schema": "boat-prerace-capture-export-v1", "date": "2026-10-12",
                               "limit": 25, "archives": [], "nextCursor": None}]
        pages = fetch_archive_pages("2026-10-12", base_url="https://example.test", token="not-printed")
        self.assertEqual(len(pages), 1)
        fetch.assert_called_once_with("2026-10-12", base_url="https://example.test", token="not-printed")

    def test_range_is_bounded_before_network_access(self):
        with self.assertRaisesRegex(ValueError, "at most 32 days"):
            run(since="2026-01-01", until="2026-02-03")

    @patch.dict(os.environ, {"EDGELAB_API_URL": "https://example.test", "INGEST_TOKEN": "test-token"})
    @patch("edgelab.trifecta_pipeline.import_capture_archives")
    @patch("edgelab.trifecta_pipeline.fetch_prerace_capture_archives")
    def test_excluded_archive_summary_keeps_only_allowlisted_reasons_with_empty_store(
            self, fetch, importer):
        fetch.return_value = [{"schema": "boat-prerace-capture-export-v1", "date": "2026-10-13",
                               "limit": 25, "archives": [], "nextCursor": None}]
        importer.return_value = {"importedArchives": 0, "excludedArchives": 1,
                                 "exclusionCounts": {"race_identity_or_real_race_missing": 1,
                                                     "https://private.example/token=do-not-report": 9}}
        with TemporaryDirectory() as directory:
            summary_path = Path(directory) / "trifecta-pipeline-summary.json"
            result = run(since="2026-10-13", until="2026-10-13",
                         store_path=str(Path(directory) / "rows.json"),
                         report_path=str(Path(directory) / "trifecta-report.json"))
            persisted = json.loads(summary_path.read_text(encoding="utf-8"))
        self.assertEqual(result["archiveExclusionCounts"], {
            "race_identity_or_real_race_missing": 1, "other": 9,
        })
        self.assertEqual(result["archiveExclusionCountsByDate"]["2026-10-13"], result["archiveExclusionCounts"])
        self.assertEqual(persisted["archiveExclusionCounts"], result["archiveExclusionCounts"])
        self.assertEqual(result["training"]["status"], "insufficient_pit_evidence")
        self.assertNotIn("private.example", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
