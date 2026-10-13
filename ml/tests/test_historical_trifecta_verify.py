from __future__ import annotations

import json
import gzip
import io
from collections import Counter
from datetime import date, datetime, timezone
from urllib.parse import parse_qs, urlparse

from edgelab.historical_trifecta import iter_date_archives
from edgelab.historical_trifecta_verify import verify_race
from test_historical_trifecta import _archive

RACE_ID = "boat-20261014-03-01"
RACE_DATE = "2026-10-14"
KEY = "historical-trifecta/v1/real/2026-10-14/03/1/boat-trifecta-historical-base-20261014/t-60.json.gz"
NOW = datetime(2026, 10, 15, tzinfo=timezone.utc)


def _coverage(*, status="complete", truncated=False):
    return {"date": RACE_DATE, "expected": 1, "complete": int(status == "complete"),
            "incomplete": int(status == "incomplete"), "missing": int(status == "missing"),
            "failed": int(status == "failed"), "truncated": truncated,
            "targetRace": {"raceId": RACE_ID, "status": status,
                           "archiveKey": KEY if status == "complete" else None,
                           "failureReason": None if status == "complete" else f"{status}_archive"}}


def _archive_json():
    return json.dumps(_archive(), separators=(",", ":")).encode("utf-8")


def _label():
    return {"archiveKey": KEY, "raceId": RACE_ID, "raceDate": RACE_DATE,
            "venueId": "03", "raceNo": 1,
            "results": [{"number": n, "finishOrder": n} for n in range(1, 7)],
            "trifectaPayout": {"selection": "1-2-3", "payoutYen": 1200},
            "availableAt": "2026-10-14T08:00:00Z",
            "source": {"url": "https://www.boatrace.jp/owpc/pc/race/raceresult?rno=1&jcd=03&hd=20261014",
                       "sha256": "b" * 64, "availableAt": "2026-10-14T08:00:00Z",
                       "quality": "verified-official-outcome-v2"}}


def _patch_api(monkeypatch, *, archive=True, label=None, other_race=False, coverage=None):
    import edgelab.historical_trifecta_verify as verifier

    monkeypatch.setattr(verifier, "fetch_date_coverage", lambda *args, **kwargs: coverage or _coverage())

    def archives(day, **kwargs):
        if archive:
            identity = "boat-20261014-03-02" if other_race else RACE_ID
            key = KEY.replace("/1/", "/2/") if other_race else KEY
            yield ({"key": key, "raceId": identity, "raceDate": RACE_DATE}, _archive_json())

    monkeypatch.setattr(verifier, "iter_date_archives", archives)
    monkeypatch.setattr(verifier, "iter_date_labels",
                        lambda *args, **kwargs: iter([label] if label is not None else []))


def test_verifier_reports_one_complete_archive_waiting_for_result_label(monkeypatch):
    _patch_api(monkeypatch, label=None)
    result = verify_race(date_text=RACE_DATE, race_id=RACE_ID, base_url="https://example.invalid",
                         token="not-a-real-token", now=NOW)
    assert result["status"] == "archive_verified_waiting_label"
    assert result["archive"]["immutableKey"] == KEY
    assert result["archive"]["input"]["rows"] == 6
    assert result["archive"]["predictions"]["rows"] == 120
    assert result["archive"]["odds"]["rows"] == 120
    assert result["promotionEligible"] is False


def test_verifier_never_substitutes_another_race(monkeypatch):
    _patch_api(monkeypatch, other_race=True, coverage=_coverage(status="missing"))
    result = verify_race(date_text=RACE_DATE, race_id=RACE_ID, base_url="https://example.invalid",
                         token="not-a-real-token", now=NOW)
    assert result["status"] == "waiting_archive"
    assert result["raceId"] == RACE_ID
    assert "archive" not in result


def test_verified_outcome_uses_shared_training_row_builder_without_fitting(monkeypatch):
    _patch_api(monkeypatch, label=_label())
    result = verify_race(date_text=RACE_DATE, race_id=RACE_ID, base_url="https://example.invalid",
                         token="not-a-real-token", now=NOW)
    assert result["status"] == "verified"
    assert result["trainingInput"]["builder"] == "edgelab.historical_trifecta._training_rows"
    assert result["trainingInput"]["trainingRows"] == 6
    assert result["trainingInput"]["raceGroups"] == 1
    assert result["trainingInput"]["laneNumbers"] == [1, 2, 3, 4, 5, 6]
    assert result["trainingInput"]["oddsRows"] == 120
    assert result["trainingInput"]["payoutRows"] == 1
    assert result["candidateFitPerformed"] is False
    assert result["registryWrite"] == result["predictionSync"] == "not_performed"


def test_incomplete_coverage_remains_waiting_and_truncated_is_not_called_missing(monkeypatch):
    _patch_api(monkeypatch, archive=False, coverage=_coverage(status="incomplete"))
    result = verify_race(date_text=RACE_DATE, race_id=RACE_ID, base_url="https://example.invalid",
                         token="not-a-real-token", now=NOW)
    assert result["status"] == "waiting_archive"
    assert result["reason"] == "incomplete_archive"

    _patch_api(monkeypatch, archive=False, coverage=_coverage(status="unknown", truncated=True))
    result = verify_race(date_text=RACE_DATE, race_id=RACE_ID, base_url="https://example.invalid",
                         token="not-a-real-token", now=NOW)
    assert result["status"] == "waiting_archive"
    assert result["coverage"]["status"] == "unknown"


def test_wrong_label_identity_and_bad_input_are_invalid(monkeypatch):
    wrong = _label()
    wrong["raceId"] = "boat-20261014-03-02"
    _patch_api(monkeypatch, label=wrong)
    result = verify_race(date_text=RACE_DATE, race_id=RACE_ID, base_url="https://example.invalid",
                         token="not-a-real-token", now=NOW)
    assert result["status"] == "invalid"
    assert result["reason"] == "label_archive_identity_mismatch"

    invalid = verify_race(date_text=RACE_DATE, race_id="boat-20261015-03-01",
                          base_url="https://example.invalid", token="not-a-real-token", now=NOW)
    assert invalid["status"] == "invalid"
    assert invalid["reason"] == "race_identity_invalid"


def test_shared_archive_iterator_fetches_only_the_exact_requested_race():
    other_key = KEY.replace("/1/", "/2/")
    payload = {"schema": "roi-plus-trifecta-archive-index-v1", "date": RACE_DATE, "limit": 25,
               "archives": [{"key": other_key, "raceId": "boat-20261014-03-02", "raceDate": RACE_DATE,
                             "status": "complete"},
                            {"key": KEY, "raceId": RACE_ID, "raceDate": RACE_DATE,
                             "status": "complete"}], "nextCursor": None}
    requested_keys = []

    class Response:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, limit=-1):
            return self.body[:limit]

    def opener(request, timeout):
        parsed = urlparse(request.full_url)
        if parsed.path.endswith("historical-trifecta-archives"):
            return Response(json.dumps(payload).encode())
        key = parse_qs(parsed.query)["key"][0]
        requested_keys.append(key)
        return Response(gzip.compress(_archive_json()))

    counters = Counter()
    records = list(iter_date_archives(date.fromisoformat(RACE_DATE), base_url="https://example.invalid",
                                      token="not-a-real-token", coverage=counters, opener=opener,
                                      expected_race_id=RACE_ID))
    assert len(records) == 1
    assert records[0][0]["raceId"] == RACE_ID
    assert requested_keys == [KEY]
    assert counters["other_race_skipped"] == 1
