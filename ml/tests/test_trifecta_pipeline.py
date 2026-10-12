import unittest
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


if __name__ == "__main__":
    unittest.main()
