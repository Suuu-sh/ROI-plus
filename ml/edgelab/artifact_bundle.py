"""Portable, integrity-checked bundles for immutable model candidates.

Bundles contain a root-level pickle/JSON pair and an internal manifest so
GitHub Actions can archive the same layout that daily restore expects. A
sidecar records the ZIP checksum for transfer verification. No artifact is
activated by creating or checking a bundle.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import zipfile
from pathlib import Path
from typing import Any, Mapping


BUNDLE_SCHEMA = "edgelab-candidate-model-bundle-v1"
_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def candidate_artifact_provenance(model_id: str) -> dict[str, Any]:
    """Return stable, non-secret provenance to embed in both JSON and pickle metadata."""
    if not isinstance(model_id, str) or not _MODEL_ID.fullmatch(model_id) or model_id in {".", ".."}:
        raise ValueError("model ID is not a safe bundle filename")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    run_attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    commit_sha = os.environ.get("GITHUB_SHA", "")
    return {
        "artifactRunId": run_id if re.fullmatch(r"[0-9]+", run_id) else None,
        "artifactRunAttempt": int(run_attempt) if re.fullmatch(r"[0-9]+", run_attempt) else None,
        "artifactName": f"candidate-model-artifact-{model_id}",
        "workflowName": os.environ.get("GITHUB_WORKFLOW") or None,
        "repository": os.environ.get("GITHUB_REPOSITORY") or None,
        "commitSha": commit_sha.lower() if re.fullmatch(r"[a-fA-F0-9]{40}", commit_sha) else None,
    }


def build_candidate_model_bundle(model_id: str, artifact_dir: str | Path = "ml/artifacts") -> dict[str, Any]:
    """Write a candidate ZIP plus manifest; return run/name values for the registry.

    The manifest hashes both files and the ZIP, and the ZIP contains the
    original root-level ``<model_id>.pkl`` and ``<model_id>.json`` names. Existing
    bundles are immutable: repeated creation for an ID fails closed.
    """
    if not isinstance(model_id, str) or not _MODEL_ID.fullmatch(model_id) or model_id in {".", ".."}:
        raise ValueError("model ID is not a safe bundle filename")
    directory = Path(artifact_dir)
    pickle_path = directory / f"{model_id}.pkl"
    metadata_path = directory / f"{model_id}.json"
    artifact_name = f"candidate-model-artifact-{model_id}"
    bundle_path = directory / f"{artifact_name}.zip"
    sidecar_path = directory / f"{artifact_name}.manifest.json"
    if bundle_path.exists() or sidecar_path.exists():
        raise FileExistsError(f"candidate model bundle is immutable and already exists: {artifact_name}")
    try:
        pickle_bytes = pickle_path.read_bytes()
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("candidate model JSON/pickle pair is incomplete or invalid") from exc
    if not isinstance(metadata, dict) or metadata.get("id") != model_id or metadata.get("status") != "candidate":
        raise ValueError("only an exact candidate model JSON/pickle pair can be bundled")

    provenance = candidate_artifact_provenance(model_id)
    if metadata.get("artifactProvenance") != provenance:
        raise ValueError("candidate JSON/pickle pair lacks matching artifact run/name provenance")
    metrics = metadata.get("metrics")
    if not isinstance(metrics, dict):
        metrics = {}
        metadata["metrics"] = metrics
    metrics.update({
        "artifactBundleSchemaVersion": BUNDLE_SCHEMA,
        "artifactName": artifact_name,
        "artifactRunId": provenance["artifactRunId"],
        "artifactRunAttempt": provenance["artifactRunAttempt"],
    })
    encoded_metadata = (json.dumps(metadata, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    # The sidecar JSON and registry now carry the run/name provenance. The
    # pickle remains byte-for-byte unchanged, preserving its registered SHA.
    metadata_path.write_bytes(encoded_metadata)
    file_payloads = {pickle_path.name: pickle_bytes, metadata_path.name: encoded_metadata}
    file_records = {name: {"sha256": _sha256(value), "sizeBytes": len(value)}
                    for name, value in file_payloads.items()}
    metrics.setdefault("modelArtifactSha256", file_records[pickle_path.name]["sha256"])
    # modelArtifactSha256 is descriptive only; it does not replace an existing
    # bet-type-specific registry hash such as boatArtifactSha256 or ticketArtifactSha256.
    if metrics["modelArtifactSha256"] != file_records[pickle_path.name]["sha256"]:
        raise ValueError("model metadata references a different pickle SHA-256")
    # Re-encode after the generic pickle hash has been added.
    encoded_metadata = (json.dumps(metadata, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    metadata_path.write_bytes(encoded_metadata)
    file_payloads[metadata_path.name] = encoded_metadata
    file_records[metadata_path.name] = {"sha256": _sha256(encoded_metadata), "sizeBytes": len(encoded_metadata)}

    manifest = {
        "schema": BUNDLE_SCHEMA,
        "modelId": model_id,
        "modelStatus": "candidate",
        "promotionEligible": bool(metrics.get("promotionEligible") is True),
        "artifactName": artifact_name,
        "provenance": provenance,
        "trainingProvenance": {key: metadata.get(key) for key in
            ("trainedAt", "trainFrom", "trainTo", "validFrom", "validTo", "testFrom", "testTo", "nTrainRaces")},
        "files": file_records,
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, payload in file_payloads.items():
            bundle.writestr(name, payload)
        bundle.writestr("manifest.json", manifest_bytes)
    bundle_bytes = memory.getvalue()
    outer = {**manifest, "bundleFile": bundle_path.name,
             "bundleSha256": _sha256(bundle_bytes), "manifestSha256": _sha256(manifest_bytes)}
    outer_bytes = (json.dumps(outer, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")

    # Exclusive creation keeps an immutable model ID from silently replacing
    # an older portable bundle. If the second write fails, remove only the
    # bundle created in this call so no incomplete pair is left behind.
    created_bundle = False
    try:
        with bundle_path.open("xb") as stream:
            stream.write(bundle_bytes)
        created_bundle = True
        with sidecar_path.open("xb") as stream:
            stream.write(outer_bytes)
    except OSError:
        if created_bundle:
            bundle_path.unlink(missing_ok=True)
        raise

    registry_metrics = {
        "artifactBundleSchemaVersion": BUNDLE_SCHEMA,
        "artifactName": artifact_name,
        "artifactRunId": provenance["artifactRunId"],
        "artifactRunAttempt": provenance["artifactRunAttempt"],
        "artifactWorkflowName": provenance["workflowName"],
        "artifactRepository": provenance["repository"],
        "artifactCommitSha": provenance["commitSha"],
        "artifactBundleFile": bundle_path.name,
        "artifactBundleSha256": outer["bundleSha256"],
        "artifactBundleManifestFile": sidecar_path.name,
        "artifactBundleManifestSha256": _sha256(outer_bytes),
        "modelArtifactSha256": file_records[pickle_path.name]["sha256"],
    }
    return {
        "schema": BUNDLE_SCHEMA,
        "modelId": model_id,
        "artifactName": artifact_name,
        "artifactRunId": provenance["artifactRunId"],
        "artifactRunAttempt": provenance["artifactRunAttempt"],
        "bundleFile": bundle_path.name,
        "bundleSha256": outer["bundleSha256"],
        "manifestFile": sidecar_path.name,
        "manifestSha256": registry_metrics["artifactBundleManifestSha256"],
        "registryMetrics": registry_metrics,
    }


def verify_candidate_model_bundle(bundle_path: str | Path, *, expected_model_id: str | None = None,
                                  manifest_path: str | Path | None = None,
                                  loose_pickle_path: str | Path | None = None,
                                  loose_metadata_path: str | Path | None = None) -> dict[str, Any]:
    """Verify bundle/member hashes and optional restore files without unpickling."""
    bundle_path = Path(bundle_path)
    sidecar = Path(manifest_path) if manifest_path is not None else bundle_path.with_suffix(".manifest.json")
    try:
        bundle_bytes = bundle_path.read_bytes()
        outer_bytes = sidecar.read_bytes()
        outer = json.loads(outer_bytes)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("candidate bundle or manifest is missing or invalid") from exc
    if not isinstance(outer, dict) or outer.get("schema") != BUNDLE_SCHEMA:
        raise ValueError("candidate bundle manifest schema is invalid")
    if not _SHA256.fullmatch(str(outer.get("bundleSha256") or "")) or _sha256(bundle_bytes) != outer.get("bundleSha256"):
        raise ValueError("candidate bundle SHA-256 mismatch")
    model_id = outer.get("modelId")
    if (not isinstance(model_id, str) or not _MODEL_ID.fullmatch(model_id)
            or (expected_model_id is not None and model_id != expected_model_id)
            or outer.get("modelStatus") != "candidate"):
        raise ValueError("candidate bundle identity or status is invalid")
    names = {f"{model_id}.pkl", f"{model_id}.json", "manifest.json"}
    try:
        with zipfile.ZipFile(io.BytesIO(bundle_bytes), "r") as archive:
            info = archive.infolist()
            if len(info) != len(names) or {item.filename for item in info} != names:
                raise ValueError("candidate bundle layout is invalid")
            if any(item.is_dir() for item in info):
                raise ValueError("candidate bundle may not contain directories")
            manifest_bytes = archive.read("manifest.json")
            manifest = json.loads(manifest_bytes)
            outer_core = {key: value for key, value in outer.items()
                          if key not in {"bundleFile", "bundleSha256", "manifestSha256"}}
            if (not isinstance(manifest, dict) or _sha256(manifest_bytes) != outer.get("manifestSha256")
                    or manifest != outer_core
                    or not isinstance(manifest.get("files"), dict)
                    or set(manifest["files"]) != names - {"manifest.json"}):
                raise ValueError("candidate bundle manifest checksum or contents mismatch")
            for name in names - {"manifest.json"}:
                payload = archive.read(name)
                record = manifest["files"][name]
                if (not isinstance(record, dict) or record.get("sha256") != _sha256(payload)
                        or record.get("sizeBytes") != len(payload)):
                    raise ValueError(f"candidate bundle member checksum mismatch: {name}")
            metadata = json.loads(archive.read(f"{model_id}.json"))
    except (OSError, KeyError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
        raise ValueError("candidate bundle is corrupt or incomplete") from exc
    if (loose_pickle_path is None) != (loose_metadata_path is None):
        raise ValueError("both loose restore files must be supplied together")
    if loose_pickle_path is not None and loose_metadata_path is not None:
        for name, path in ((f"{model_id}.pkl", Path(loose_pickle_path)),
                           (f"{model_id}.json", Path(loose_metadata_path))):
            if path.name != name:
                raise ValueError(f"loose candidate artifact filename does not match bundle member: {name}")
            try:
                payload = path.read_bytes()
            except OSError as exc:
                raise ValueError(f"loose candidate artifact is missing or unreadable: {name}") from exc
            record = outer.get("files", {}).get(name)
            if (not isinstance(record, dict) or record.get("sha256") != _sha256(payload)
                    or record.get("sizeBytes") != len(payload)):
                raise ValueError(f"loose candidate artifact does not match verified bundle member: {name}")
    provenance = metadata.get("artifactProvenance") if isinstance(metadata, dict) else None
    outer_provenance = outer.get("provenance")
    if (not isinstance(metadata, dict) or metadata.get("id") != model_id
            or metadata.get("status") != "candidate" or not isinstance(provenance, dict)
            or not isinstance(outer_provenance, dict)
            or outer.get("artifactName") != f"candidate-model-artifact-{model_id}"
            or outer.get("bundleFile") != bundle_path.name
            or provenance.get("artifactName") != outer.get("artifactName")
            or provenance.get("artifactRunId") != outer_provenance.get("artifactRunId")):
        raise ValueError("candidate bundle metadata provenance does not match its manifest")
    return outer
