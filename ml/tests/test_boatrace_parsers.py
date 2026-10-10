from __future__ import annotations
import json
from pathlib import Path
import pytest

from edgelab.parsers.boatrace_b import parse_b
from edgelab.parsers.boatrace_k import parse_k

FIXTURES = Path(__file__).resolve().parents[2] / "data" / "fixtures" / "boatrace"
PRIVATE_FIXTURES = Path(__file__).resolve().parents[2] / "data" / "private_fixtures" / "boatrace"


def test_venue_heading_prefers_longest_name_when_names_overlap():
    from edgelab.parsers.boatrace_b import _venue_from_line
    assert _venue_from_line("ボートレース唐津") == "23"
    assert _venue_from_line("ボートレース津") == "09"


def test_fixture_b_program_rows():
    parsed = parse_b((FIXTURES / "b260901.txt").read_bytes())
    race_id = "boat-20260901-24-01"
    race = next(row for row in parsed["races"] if row["id"] == race_id)
    entry = next(row for row in parsed["entries"] if row["race_id"] == race_id and row["number"] == 1)
    assert race["race_date"] == "2026-09-01"
    assert race["venue_id"] == "24"
    assert entry["national_win_rate"] == 5.0
    assert entry["name"] == "架空選手"
    details = json.loads(entry["features_json"])
    assert details["racer_id"] == "1234"
    assert details["age"] is not None
    assert details["branch"]
    assert len(parsed["races"]) == 2


def test_fixture_b_utf8_matches_shift_jis():
    sjis = parse_b((FIXTURES / "b260901.txt").read_bytes())
    utf8 = parse_b((FIXTURES / "b260901.utf8.txt").read_bytes())
    assert utf8 == sjis


def test_fixture_k_results_payout_and_conditions():
    parsed = parse_k((FIXTURES / "k260901.txt").read_bytes())
    race_id = "boat-20260901-24-01"
    winners = [row for row in parsed["results"] if row["race_id"] == race_id and row["finish_order"] == 1]
    assert [row["number"] for row in winners] == [1]
    winner = next(row for row in parsed["entries"] if row["race_id"] == race_id and row["number"] == 1)
    winner_features = json.loads(winner["features_json"])
    assert winner["name"] == "架空選手"
    assert winner_features["racer_id"] == "1234"
    assert winner_features["wind_direction"] == "北西"
    assert winner_features["race_start_timing"] == 0.12
    assert winner_features["entry_course"] == 1
    assert winner["start_exhibition"] is None
    assert next(row for row in parsed["payouts"] if row["race_id"] == race_id and row["bet_type"] == "win")["payout"] == 100
    assert next(row for row in parsed["payouts"] if row["race_id"] == race_id and row["bet_type"] == "trifecta")["payout"] == 1200
    race = next(row for row in parsed["races"] if row["id"] == race_id)
    assert race["wind_speed"] == 2
    assert race["wave_height"] == 1
    assert len(parsed["races"]) == 2


def test_fixture_k_utf8_matches_shift_jis():
    sjis = parse_k((FIXTURES / "k260901.txt").read_bytes())
    utf8 = parse_k((FIXTURES / "k260901.utf8.txt").read_bytes())
    assert utf8 == sjis


@pytest.mark.skipif(not PRIVATE_FIXTURES.exists(), reason="private official fixtures are not installed")
def test_private_official_b_regression():
    parsed = parse_b((PRIVATE_FIXTURES / "b260901.txt").read_bytes())
    race_id = "boat-20260901-24-01"
    entry = next(row for row in parsed["entries"] if row["race_id"] == race_id and row["number"] == 1)
    assert entry["national_win_rate"] == 4.16
    assert json.loads(entry["features_json"])["racer_id"] == "3752"


@pytest.mark.skipif(not PRIVATE_FIXTURES.exists(), reason="private official fixtures are not installed")
def test_private_official_k_regression():
    parsed = parse_k((PRIVATE_FIXTURES / "k260901.txt").read_bytes())
    race_id = "boat-20260901-24-01"
    winners = [row for row in parsed["results"] if row["race_id"] == race_id and row["finish_order"] == 1]
    assert [row["number"] for row in winners] == [3]
    winner = next(row for row in parsed["entries"] if row["race_id"] == race_id and row["number"] == 3)
    features = json.loads(winner["features_json"])
    assert features["racer_id"] == "5086"
    assert features["race_start_timing"] == 0.25
    assert next(row for row in parsed["payouts"] if row["race_id"] == race_id and row["bet_type"] == "trifecta")["payout"] == 4520
