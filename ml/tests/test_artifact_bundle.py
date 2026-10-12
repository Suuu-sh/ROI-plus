"""Synthetic-only checks for portable candidate artifact packaging."""
import hashlib
import json
import pickle
import zipfile
from pathlib import Path

import pytest

from edgelab.artifact_bundle import (
    BUNDLE_SCHEMA,
    build_candidate_model_bundle,
    candidate_artifact_provenance,
    verify_candidate_model_bundle,
)


def _candidate_pair(directory, model_id="boat-win-fixture-20261012-a1b2c3d4"):
    # Deliberately not a pickle: bundle verification must check bytes and hashes
    # without deserializing model contents. This pair is test-only fixture data.
    pickle_bytes = b"fixture: synthetic; not a real model pickle"
    (directory / f"{model_id}.pkl").write_bytes(pickle_bytes)
    metadata = {
        "fixture": "synthetic",
        "id": model_id,
        "status": "candidate",
        "sport": "boat",
        "trainedAt": "2026-10-12T00:00:00+00:00",
        "trainFrom": "2026-01-01",
        "trainTo": "2026-08-01",
        "validFrom": "2026-08-02",
        "validTo": "2026-09-01",
        "testFrom": "2026-09-02",
        "testTo": "2026-10-01",
        "nTrainRaces": 500,
        "metrics": {"promotionEligible": False},
        "artifactProvenance": candidate_artifact_provenance(model_id),
    }
    (directory / f"{model_id}.json").write_text(json.dumps(metadata), encoding="utf-8")
    return model_id, pickle_bytes


def test_bundle_records_exact_run_name_and_file_checksums_without_unpickling(tmp_path, monkeypatch):
    monkeypatch.setenv("GITHUB_RUN_ID", "123456789")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")
    monkeypatch.setenv("GITHUB_WORKFLOW", "retrain models")
    monkeypatch.setenv("GITHUB_REPOSITORY", "Suuu-sh/ROI-plus")
    monkeypatch.setenv("GITHUB_SHA", "a" * 40)
    model_id, pickle_bytes = _candidate_pair(tmp_path)

    info = build_candidate_model_bundle(model_id, tmp_path)
    assert info["schema"] == BUNDLE_SCHEMA
    assert info["artifactName"] == f"candidate-model-artifact-{model_id}"
    assert info["artifactRunId"] == "123456789"
    assert info["registryMetrics"]["artifactRunAttempt"] == 2
    assert info["registryMetrics"]["artifactBundleSha256"] == hashlib.sha256(
        (tmp_path / info["bundleFile"]).read_bytes()).hexdigest()

    verified = verify_candidate_model_bundle(tmp_path / info["bundleFile"], expected_model_id=model_id)
    assert verified["provenance"]["artifactRunId"] == "123456789"
    with zipfile.ZipFile(tmp_path / info["bundleFile"]) as archive:
        assert set(archive.namelist()) == {f"{model_id}.pkl", f"{model_id}.json", "manifest.json"}
        assert archive.read(f"{model_id}.pkl") == pickle_bytes
        metadata = json.loads(archive.read(f"{model_id}.json"))
    assert metadata["artifactProvenance"]["artifactName"] == info["artifactName"]
    assert metadata["metrics"]["artifactRunId"] == "123456789"


def test_bundle_verifier_rejects_modified_bundle_before_pickle_loading(tmp_path):
    model_id, _ = _candidate_pair(tmp_path)
    info = build_candidate_model_bundle(model_id, tmp_path)
    bundle = tmp_path / info["bundleFile"]
    bundle.write_bytes(bundle.read_bytes() + b"tamper")
    with pytest.raises(ValueError, match="bundle SHA-256 mismatch"):
        verify_candidate_model_bundle(bundle, expected_model_id=model_id)


def test_bundle_verifier_rejects_member_tampering_even_when_outer_hash_is_recomputed(tmp_path):
    model_id, _ = _candidate_pair(tmp_path)
    info = build_candidate_model_bundle(model_id, tmp_path)
    bundle_path = tmp_path / info["bundleFile"]
    sidecar_path = tmp_path / info["manifestFile"]
    with zipfile.ZipFile(bundle_path) as source:
        contents = {name: source.read(name) for name in source.namelist()}
    contents[f"{model_id}.pkl"] = b"fixture: modified bytes"
    replacement = tmp_path / "replacement.zip"
    with zipfile.ZipFile(replacement, "w", compression=zipfile.ZIP_DEFLATED) as target:
        for name, payload in contents.items():
            target.writestr(name, payload)
    bundle_path.write_bytes(replacement.read_bytes())
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    sidecar["bundleSha256"] = hashlib.sha256(bundle_path.read_bytes()).hexdigest()
    sidecar_path.write_text(json.dumps(sidecar), encoding="utf-8")
    with pytest.raises(ValueError, match="member checksum mismatch"):
        verify_candidate_model_bundle(bundle_path, expected_model_id=model_id)


def test_bundle_provenance_preserves_runtime_json_pickle_identity(tmp_path):
    model_id = "boat-win-runtime-fixture-20261012-a1b2c3d4"
    metrics = {"logLoss": 1.0, "brier": 0.5, "ece": 0.1}
    metadata = {
        "fixture": "synthetic", "id": model_id, "sport": "boat", "betType": "win",
        "status": "candidate", "featureColumns": ["lane"], "trainedAt": "2026-10-12T00:00:00+00:00",
        "metrics": metrics, "artifactProvenance": candidate_artifact_provenance(model_id),
    }
    with (tmp_path / f"{model_id}.pkl").open("wb") as stream:
        pickle.dump({"metadata": metadata, "model": object(), "feature_columns": ["lane"]}, stream)
    (tmp_path / f"{model_id}.json").write_text(json.dumps(metadata), encoding="utf-8")
    build_candidate_model_bundle(model_id, tmp_path)

    from edgelab.cli import _safe_boat_schema_version
    assert _safe_boat_schema_version(model_id, tmp_path) == "boat-base-v1"


def test_bundle_creation_refuses_non_candidate_or_existing_bundle(tmp_path):
    model_id, _ = _candidate_pair(tmp_path)
    metadata_path = tmp_path / f"{model_id}.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["status"] = "active"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    with pytest.raises(ValueError, match="only an exact candidate"):
        build_candidate_model_bundle(model_id, tmp_path)

    metadata["status"] = "candidate"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    info = build_candidate_model_bundle(model_id, tmp_path)
    with pytest.raises(FileExistsError, match="immutable"):
        build_candidate_model_bundle(model_id, tmp_path)
    assert info["registryMetrics"]["artifactBundleManifestFile"].endswith(".manifest.json")


def test_weekly_retrain_archives_verified_candidate_files_for_future_restore():
    workflow = (Path(__file__).resolve().parents[2]
                / ".github/workflows/retrain.yml").read_text(encoding="utf-8")
    assert "candidate-model-artifact-" in workflow
    assert "verify_candidate_model_bundle" in workflow
    assert "actions/upload-artifact@v4" in workflow
    assert "ml/artifacts/${{ steps.candidate-bundle.outputs.model_id }}.pkl" in workflow
    assert "ml/artifacts/${{ steps.candidate-bundle.outputs.model_id }}.json" in workflow
    assert "ml/artifacts/${{ steps.candidate-bundle.outputs.manifest_file }}" in workflow
