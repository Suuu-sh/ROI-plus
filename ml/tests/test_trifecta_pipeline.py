import json
import unittest
from unittest.mock import patch

from edgelab.trifecta_pipeline import fetch_archive_pages, run


class _Response:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return self.payload


class TrifectaPipelineTests(unittest.TestCase):
    @patch("edgelab.trifecta_pipeline.urlopen")
    def test_fetches_cursor_pages_without_exposing_token_in_url(self, open_url):
        cursor = "boat-20261012-01-01:capture:1791770000000"
        open_url.side_effect = [
            _Response({"schema": "boat-prerace-capture-export-v1", "date": "2026-10-12",
                       "limit": 25, "archives": [], "nextCursor": cursor}),
            _Response({"schema": "boat-prerace-capture-export-v1", "date": "2026-10-12",
                       "limit": 25, "archives": [], "nextCursor": None}),
        ]
        pages = fetch_archive_pages("2026-10-12", base_url="https://example.test", token="not-printed")
        self.assertEqual(len(pages), 2)
        self.assertNotIn("not-printed", open_url.call_args_list[0].args[0].full_url)
        self.assertIn("cursor=boat-20261012-01-01%3Acapture%3A", open_url.call_args_list[1].args[0].full_url)

    def test_range_is_bounded_before_network_access(self):
        with self.assertRaisesRegex(ValueError, "at most 32 days"):
            run(since="2026-01-01", until="2026-02-03")


if __name__ == "__main__":
    unittest.main()
