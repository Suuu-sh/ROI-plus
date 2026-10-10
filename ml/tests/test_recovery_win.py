from __future__ import annotations

import json
import pickle

import pytest

from edgelab import recovery_win


def test_recovery_requires_exact_pinned_cache_key_before_registry_access(monkeypatch, tmp_path):
    monkeypatch.setattr(recovery_win, "fetch_model_registry",
                        lambda **kwargs: (_ for _ in ()).throw(AssertionError("must not access registry")))
    with pytest.raises(RuntimeError, match="exact reviewed daily cache key"):
        recovery_win.recover_candidate(cache_key="daily-Linux-latest", run_id="1",
            raw_dir=tmp_path, snapshot_path=tmp_path / "snapshot.json",
            artifact_dir=tmp_path / "artifacts", report_path=tmp_path / "report.json")


def test_recovery_syncs_candidate_only_and_binds_registry_validation(monkeypatch, tmp_path):
    snapshot_path, report_path = tmp_path / "snapshot.json", tmp_path / "report.json"
    artifact_dir = tmp_path / "artifacts"
    registry = [{"id": "old", "sport": "boat", "bet_type": "win", "status": "retired"}]
    synced = []

    def preview(raw_dir, output):
        races = [
            {"id": "before", "race_date": "2026-06-30"},
            {"id": "valid", "race_date": "2026-09-25"},
            {"id": "test-end", "race_date": "2026-10-09"},
            {"id": "after", "race_date": "2026-10-10"},
        ]
        output.write_text(json.dumps({"rows": {
            "races": races,
            "entries": [{"race_id": race["id"]} for race in races],
            "results": [{"race_id": race["id"]} for race in races],
            "payouts": [{"race_id": race["id"]} for race in races],
            "odds_snapshots": [{"race_id": race["id"]} for race in races],
        }, "pairedDays": ["2026-10-09", "2026-10-10"], "unpairedFileCount": 0,
            "sourceFiles": []}))

    def train(rows, *, model_id, version, artifact_dir, **kwargs):
        artifact_dir.mkdir(parents=True, exist_ok=True)
        (artifact_dir / f"{model_id}.pkl").write_bytes(pickle.dumps({"fake": "artifact"}))
        return {"id": model_id, "sport": "boat", "betType": "win", "version": version,
                "algorithm": "test", "status": "candidate", "trainFrom": "2026-07-01",
                "trainTo": "2026-09-10", "validFrom": "2026-09-11", "validTo": "2026-09-25",
                "testFrom": "2026-09-26", "testTo": "2026-10-09", "nTrain": 100,
                "trainedAt": "2026-10-10T00:00:00+00:00", "metrics": {"logLoss": 1.0},
                "boatVenueSchemaVersion": "boat-venue-v2",
                "correctedTrainingDataSha256": kwargs["corrected_training_data_sha256"]}

    def sync(payload, **kwargs):
        assert list(payload) == ["models"]
        assert len(payload["models"]) == 1
        row = payload["models"][0]
        assert row["status"] == "candidate"
        assert row["metrics_json"]
        synced.append(row)
        if registry and any(existing.get("id") == row["id"] for existing in registry):
            registry[:] = [existing for existing in registry if existing.get("id") != row["id"]]
        registry.append(row)
        return {"models": {"sent": 1}}

    monkeypatch.setattr(recovery_win, "preview_boat_cache", preview)
    def training_rows(store, sport):
        assert [r["id"] for r in store["races"]] == ["valid", "test-end"]
        assert {r["race_id"] for r in store["entries"]} == {"valid", "test-end"}
        assert {r["race_id"] for r in store["results"]} == {"valid", "test-end"}
        assert {r["race_id"] for r in store["payouts"]} == {"valid", "test-end"}
        assert {r["race_id"] for r in store["odds_snapshots"]} == {"valid", "test-end"}
        return [{"race_id": "r"}]
    monkeypatch.setattr(recovery_win, "_make_training_rows", training_rows)
    monkeypatch.setattr(recovery_win, "train_model", train)
    monkeypatch.setattr(recovery_win, "fetch_model_registry", lambda **kwargs: list(registry))
    monkeypatch.setattr(recovery_win, "sync_rows", sync)
    def validate(store, *args, **kwargs):
        assert [r["id"] for r in store["races"]] == ["valid", "test-end"]
        return {
        "status": "evaluated", "validatedAt": "2026-10-10T00:01:00+00:00",
        "modelEvidenceEligible": True, "initialBaselineEligible": True,
        "initialBaselineReason": None, "candidateRegistryIdentity": {"status": "candidate"},
        "checks": {"candidateRegisteredAsCandidate": True}, "fingerprint": "f" * 64,
        "activeModelSnapshot": {"models": []}}
    monkeypatch.setattr(recovery_win, "validate_initial_baseline", validate)

    result = recovery_win.recover_candidate(cache_key=recovery_win.BOOTSTRAP_CACHE_KEY, run_id="12345",
        raw_dir=tmp_path, snapshot_path=snapshot_path, artifact_dir=artifact_dir, report_path=report_path)
    assert result["promotionEligible"] is False
    assert len(synced) == 2
    final_metrics = json.loads(synced[-1]["metrics_json"])
    assert final_metrics["promotionEligible"] is False
    assert final_metrics["boatVenueSchemaVersion"] == "boat-venue-v2"
    assert final_metrics["correctedTrainingDataSha256"] == result["sourceSnapshotSha256"]
    saved_report = json.loads(report_path.read_text())
    assert final_metrics["initialBaselineValidation"]["fingerprint"] == saved_report["fingerprint"]
    assert saved_report["promotionEligible"] is False
    assert saved_report["analysisCohort"]["from"] == "2026-07-01"
    assert saved_report["analysisCohort"]["to"] == "2026-10-09"
    assert saved_report["analysisCohort"]["excludedDates"] == ["2026-06-30", "2026-10-10"]
