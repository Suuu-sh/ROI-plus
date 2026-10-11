from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from edgelab import today_operator as operator


def test_operator_is_pinned_to_the_exact_reviewed_candidate() -> None:
    assert operator.DAY == "2026-10-11"
    assert operator.MODEL_ID == "boat-win-lgbm-20261010-14b4a90a"
    assert operator.ARTIFACT_RUN_ID == "38053091327"
    assert len(operator.REQUIRED_CHECKS) == 19


def test_promote_refuses_mismatched_registry_before_any_write(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    pair = (tmp_path / "candidate.pkl", tmp_path / "candidate.json")
    pair[0].write_bytes(b"test")
    pair[1].write_text("{}", encoding="utf-8")
    monkeypatch.setattr(operator, "_today", lambda: None)
    monkeypatch.setattr(operator, "_artifact_pair", lambda _: pair)
    monkeypatch.setattr(operator, "_models", lambda: {operator.MODEL_ID: {
        "id": operator.MODEL_ID, "status": "candidate", "metrics_json": json.dumps({})
    }})
    monkeypatch.setattr(operator, "_request", lambda *args, **kwargs: pytest.fail("promotion must not be sent"))
    with pytest.raises(RuntimeError, match="evidence differs"):
        operator.promote(tmp_path)


def test_forecast_refuses_incomplete_live_race_cohort_before_sync(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    pair = (tmp_path / "candidate.pkl", tmp_path / "candidate.json")
    pair[0].write_bytes(b"test")
    pair[1].write_text("{}", encoding="utf-8")
    monkeypatch.setattr(operator, "_today", lambda: None)
    monkeypatch.setattr(operator, "_artifact_pair", lambda _: pair)
    monkeypatch.setattr(operator, "_models", lambda: {operator.MODEL_ID: {
        "id": operator.MODEL_ID, "status": "active",
        "metrics_json": json.dumps({"boatArtifactSha256": operator.PICKLE_SHA,
                                     "correctedTrainingDataSha256": operator.SOURCE_SHA}),
    }})
    monkeypatch.setattr(operator, "_verify_runtime_artifact", lambda *_: None)

    def source(method: str, path: str, **_: object) -> dict[str, object]:
        query = parse_qs(urlsplit(path).query)
        cutoff = query["cutoff"][0]
        race = {"id": "boat-20261011-01-01", "data_origin": "real", "status": "scheduled",
                "wind_speed": None, "wave_height": None}
        entry = {"id": "entry-1", "race_id": race["id"], "number": 1, "available_at": cutoff,
                 "data_origin": "real"}
        return {"date": operator.DAY, "cutoff": cutoff, "races": [race], "entries": [entry]}

    monkeypatch.setattr(operator, "_request", source)
    monkeypatch.setattr(operator, "load_artifact", lambda _: {})
    monkeypatch.setattr(operator, "sync_rows", lambda *_args, **_kwargs: pytest.fail("incomplete cohort must not sync"))
    with pytest.raises(RuntimeError, match="complete six-lane"):
        operator.forecast(tmp_path)
