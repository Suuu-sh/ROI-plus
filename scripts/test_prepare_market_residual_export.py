"""Synthetic-only checks for bounded source export preparation."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('prepare',Path(__file__).with_name('prepare-market-residual-export.py'))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrepareTests(unittest.TestCase):
    def test_rejects_silently_truncated_source_json(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)
            (p/'train-0.json').write_text(json.dumps([dict(race_id='synthetic',snapshot_json='{"x": --- TRUNCATED ---')]))
            with self.assertRaises(json.JSONDecodeError):
                module.prepare(p,'train','2026-10-18T00:00:00Z')
            self.assertFalse((p/'train-decisions.json').exists())

    def test_rejects_duplicate_page_rows(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)
            (p/'train-0.json').write_text(json.dumps([dict(race_id='synthetic')]*2))
            with self.assertRaisesRegex(ValueError,'duplicate'):
                module.prepare(p,'train','2026-10-18T00:00:00Z')

    def test_decoder_supports_parsed_and_original_json(self):
        self.assertEqual(module.decoded('{"x":120}'),dict(x=120))
        self.assertEqual(module.decoded(dict(x=120)),dict(x=120))


if __name__=='__main__':unittest.main()
