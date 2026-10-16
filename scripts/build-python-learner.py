#!/usr/bin/env python3
"""Build (or explicitly deploy) the private Python learner Worker.

The repository's normal ``ml/`` tree contains unrelated Python tooling and a
requirements.txt that pywrangler intentionally rejects. Build in a temporary
project containing only the learner source, pinned pyproject, and Wrangler
config. Generated worker venvs are moved outside the bundle before Wrangler is
run; they are disposable build output, never repository files.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_UV = "0.12.3"
EXPECTED_PYWRANGLER = "1.17.8"
MAX_BUNDLE_KIB = 64 * 1024


def run(command: list[str], *, cwd: Path, env: dict[str, str], label: str) -> str:
    result = subprocess.run(command, cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        output = result.stdout.lower()
        if re.search(r"(too large|exceeds? (the )?(maximum|limit)|bundle.{0,20}(size|limit)|script.{0,20}(size|limit))", output):
            category = "bundle_or_resource_limit"
        elif re.search(r"(unauthorized|forbidden|authentication|invalid api token)", output):
            category = "authorization"
        elif re.search(r"(invalid binding|binding.{0,20}(missing|not found)|configuration error)", output):
            category = "configuration"
        elif re.search(r"(compatibility date|unsupported runtime|runtime failed to start)", output):
            category = "runtime_compatibility"
        else:
            category = "other"
        codes = sorted(set(re.findall(r"\b(?:100\d{2}|101\d{2})\b", output)))
        statuses = sorted(set(re.findall(r"\bHTTP(?: status)?[ :]+([45]\d\d)\b", output)))
        # Error 10027 includes a numeric account-side limit in some Wrangler
        # responses. Extract only a number + unit, never the surrounding text.
        size_limits = sorted(set(re.findall(
            r"(?:size limit of|exceeded (?:the )?(?:worker )?size limit of|"
            r"(?:worker )?exceeded the limit of|up to)\s*([0-9]+(?:\.[0-9]+)?\s*(?:MiB|MB|KiB|KB))",
            output, flags=re.IGNORECASE)))
        suffix = (f"; cloudflare_code={','.join(codes)}" if codes else "")
        suffix += (f"; http_status={','.join(statuses)}" if statuses else "")
        suffix += (f"; reported_size_limit={','.join(size_limits)}" if size_limits else "")
        print(f"{label}: failed (exit {result.returncode}; category={category}{suffix}); details suppressed",
              file=sys.stderr)
        raise SystemExit(1)
    return result.stdout


def smoke_test(project: Path, wrangler: Path, env: dict[str, str]) -> None:
    """Exercise both routes and a NumPy fit in isolated local workerd processes."""
    config = str(project / "wrangler.toml")
    schema = ("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);"
              "CREATE TABLE races(id TEXT PRIMARY KEY,sport TEXT,venue_id TEXT,race_no INTEGER,"
              "race_date TEXT,post_time TEXT,status TEXT,data_origin TEXT,betting_cutoff_at TEXT,"
              "betting_cutoff_source TEXT,betting_cutoff_observed_at TEXT);"
              "CREATE TABLE collection_runs(id TEXT PRIMARY KEY,source TEXT,status TEXT,reason TEXT);"
              "CREATE TABLE boatrace_prerace_capture_archives(id TEXT PRIMARY KEY,race_id TEXT,"
              "race_date TEXT,captured_at TEXT,archive_json TEXT,data_origin TEXT);")
    state_dir = project / ".local-smoke-state"
    run([str(wrangler), "d1", "execute", "roi-plus", "--local", "--command", schema,
         "--persist-to", str(state_dir), "--config", config], cwd=project, env=env,
        label="local D1 smoke setup")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    process = subprocess.Popen([str(wrangler), "dev", "--local", "--ip", "127.0.0.1",
        "--port", str(port), "--compatibility-date", "2026-10-13",
        "--persist-to", str(state_dir), "--config", config],
        cwd=project, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def post(route: str, payload: dict[str, object]) -> tuple[int, dict[str, object]]:
        request = Request(f"http://127.0.0.1:{port}{route}", data=__import__("json").dumps(payload).encode(),
                          headers={"content-type": "application/json"}, method="POST")
        try:
            with urlopen(request, timeout=2) as response:
                return response.status, __import__("json").loads(response.read())
        except HTTPError as error:
            return error.code, __import__("json").loads(error.read())

    routes_passed = False
    try:
        deadline = time.monotonic() + 45
        today = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 9 * 60 * 60))
        while time.monotonic() < deadline and process.poll() is None:
            try:
                for route in ("/learn", "/learn/normal"):
                    invalid_status, invalid_body = post(route, {"date": "2000-01-01", "confirmed": True})
                    good_status, good_body = post(route, {"date": today, "confirmed": True})
                    if invalid_status != 200 or invalid_body.get("reason") != "request_confirmation_invalid":
                        raise RuntimeError(f"local_worker_invalid_rejection_failed:{invalid_status}")
                    if good_status != 200 or good_body.get("status") != "insufficient_data":
                        raise RuntimeError(f"local_worker_empty_response_failed:{good_status}")
                routes_passed = True
                break
            except (URLError, TimeoutError, ConnectionError):
                time.sleep(0.25)
        if not routes_passed:
            if process.poll() is not None:
                raise RuntimeError("local_worker_process_exited")
            raise RuntimeError("local_worker_not_ready")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if not routes_passed:
        raise RuntimeError("local_worker_smoke_failed")

    # Keep the actual service routes free of test-only endpoints. Swap only the
    # disposable build directory's entrypoint to prove the Pyodide NumPy solver
    # can fit and return diagnostics in workerd.
    fit_smoke = project / "src" / "numpy_fit_smoke.py"
    fit_smoke.write_text('''import json
import tempfile
from pathlib import Path
import numpy as np
from edgelab.features.boat import TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS
from edgelab.models import trifecta
from edgelab.models.trifecta_coverage import _t60_cutoff
from edgelab.importers import experimental_result_labels
from workers import WorkerEntrypoint, Response

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        race_id = "boat-20261015-01-01"
        day = "2026-10-15"
        rows = []
        for lane in range(1, 7):
            row = {column: float(lane) / 10.0 for column in TRIFECTA_NO_WEATHER_EXPERIMENTAL_FEATURE_COLUMNS}
            row.update({"lane": lane, "race_id": race_id, "race_date": day, "number": lane,
                        "finish_order": lane, "data_origin": "real",
                        "available_at": day + "T10:00:00+09:00",
                        "predicted_at": day + "T10:01:00+09:00"})
            rows.append(row)
        evidence = {"raceId": race_id, "completeResult": True, "verifiedT60Cutoff": True,
                    "sixEntryAvailability": True, "sourceArrivalVerified": True,
                    "freshExhibitionLanes": [1, 2, 3, 4, 5, 6],
                    "completeT60Odds": True, "consistentPayout": True, "freshWeather": False}
        trifecta.audit_trifecta_coverage = lambda *args, **kwargs: {"races": [evidence],
                                                                   "finishedRealBoatRaces": 1}
        experimental_result_labels.verified_experimental_result_race_ids = lambda store: {race_id}
        try:
            verified_cutoff, _ = _t60_cutoff({"id": race_id, "race_date": day, "venue_id": "01", "race_no": 1,
                "status": "finished", "data_origin": "real", "post_time": day + "T11:20:00+09:00",
                "betting_cutoff_at": day + "T11:00:00+09:00",
                "betting_cutoff_source": "boatrace-racelist-cutoff-v1",
                "betting_cutoff_observed_at": day + "T10:55:00+09:00"})
            if verified_cutoff is None:
                raise ValueError("synthetic_cutoff_smoke_failed")
            with tempfile.TemporaryDirectory() as directory:
                report = trifecta.train_trifecta_experimental(rows, {}, model_id="workerd-fit-smoke",
                    artifact_dir=Path(directory), estimator_backend="numpy-newton")
                result = {"status": "fit_ok" if report.get("artifactCreated") is True else "fit_failed",
                          "converged": bool(report.get("estimatorFit", {}).get("primary", {}).get("converged")),
                          "finite": bool(np.isfinite(report.get("estimatorFit", {}).get("primary", {}).get("objectiveValue", float("nan")))),
                          "artifactFiles": len(list(Path(directory).iterdir()))}
        except Exception as error:
            known = {"AssertionError", "AttributeError", "FileNotFoundError", "FloatingPointError",
                     "ImportError", "IndexError", "IsADirectoryError", "KeyError", "LinAlgError", "MemoryError", "ModuleNotFoundError",
                     "NotADirectoryError", "NotImplementedError", "OSError", "OverflowError",
                     "PermissionError", "RuntimeError", "TimeoutError", "TypeError", "ValueError",
                     "ZeroDivisionError", "ZoneInfoNotFoundError"}
            error_name = type(error).__name__
            result = {"status": "fit_failed", "errorClass": error_name if error_name in known else "OtherError"}
        return Response(json.dumps(result), status=200,
                        headers={"content-type": "application/json"})
''', encoding="utf-8")
    config_path = project / "wrangler.toml"
    original_config = config_path.read_text(encoding="utf-8")
    config_path.write_text(original_config.replace('main = "src/worker.py"',
                                                   'main = "src/numpy_fit_smoke.py"', 1),
                           encoding="utf-8")
    try:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            fit_port = sock.getsockname()[1]
        fit_process = subprocess.Popen([str(wrangler), "dev", "--local", "--ip", "127.0.0.1",
            "--port", str(fit_port), "--compatibility-date", "2026-10-13",
            "--persist-to", str(state_dir), "--config", str(config_path)],
            cwd=project, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and fit_process.poll() is None:
                try:
                    status, body = post_fit(fit_port)
                    if status != 200:
                        raise RuntimeError(f"local_trainer_http_error:{status}")
                    if body.get("status") != "fit_ok":
                        error_name = body.get("errorClass")
                        known = {"AssertionError", "AttributeError", "FileNotFoundError", "FloatingPointError",
                                 "ImportError", "IndexError", "IsADirectoryError", "KeyError", "LinAlgError", "MemoryError", "ModuleNotFoundError",
                                 "NotADirectoryError", "NotImplementedError", "OSError", "OverflowError",
                                 "PermissionError", "RuntimeError", "TimeoutError", "TypeError", "ValueError",
                    "StopIteration", "ZeroDivisionError", "ZoneInfoNotFoundError", "OtherError"}
                        error_name = error_name if error_name in known else "OtherError"
                        raise RuntimeError(f"local_trainer_fit_smoke_failed:{error_name}")
                    if (status != 200 or body.get("converged") is not True
                            or body.get("finite") is not True or body.get("artifactFiles") != 3):
                        raise RuntimeError("local_trainer_fit_smoke_invalid")
                    break
                except (URLError, TimeoutError, ConnectionError):
                    time.sleep(0.25)
            else:
                raise RuntimeError("local_numpy_fit_smoke_failed")
        finally:
            fit_process.terminate()
            try:
                fit_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                fit_process.kill()
                fit_process.wait(timeout=5)
    finally:
        config_path.write_text(original_config, encoding="utf-8")


def post_fit(port: int) -> tuple[int, dict[str, object]]:
    request = Request(f"http://127.0.0.1:{port}/", data=b"{}",
                      headers={"content-type": "application/json"}, method="POST")
    try:
        with urlopen(request, timeout=5) as response:
            return response.status, __import__("json").loads(response.read())
    except HTTPError as error:
        try:
            body = __import__("json").loads(error.read())
        except Exception:
            body = {"status": "non_json"}
        return error.code, body


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="build and validate without deploying (default)")
    mode.add_argument("--deploy", action="store_true", help="explicitly deploy the private learner Worker")
    mode.add_argument("--smoke-test", action="store_true", help="dry-run then exercise the Worker locally")
    args = parser.parse_args()

    uv = os.environ.get("UV") or shutil.which("uv")
    if not uv:
        parser.error("uv 0.12.3 is required (set UV to its executable path)")
    version_output = subprocess.run([uv, "--version"], text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, check=False).stdout.strip()
    if not version_output.startswith(f"uv {EXPECTED_UV} "):
        parser.error(f"uv {EXPECTED_UV} is required; found an unsupported version")
    env = os.environ.copy()
    env["PATH"] = str(Path(uv).resolve().parent) + os.pathsep + env.get("PATH", "")
    wrangler = ROOT / "node_modules/.bin/wrangler"
    if not wrangler.is_file():
        parser.error("repository-local Wrangler is required; run npm install first")

    with tempfile.TemporaryDirectory(prefix="roi-plus-python-learner-") as temp_name:
        project = Path(temp_name)
        src = project / "src"
        src.mkdir()
        shutil.copy2(ROOT / "ml/src/worker.py", src / "worker.py")
        shutil.copytree(ROOT / "ml/edgelab", src / "edgelab",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copy2(ROOT / "ml/pyproject.toml", project / "pyproject.toml")
        shutil.copy2(ROOT / "ml/wrangler.toml", project / "wrangler.toml")

        # Pin pywrangler independently of whatever may be globally installed.
        run([uv, "tool", "run", "--from", f"workers-py=={EXPECTED_PYWRANGLER}",
             "pywrangler", "sync"], cwd=project, env=env, label="pywrangler sync")

        # pywrangler creates a local test venv in its project tree. It must not
        # be bundled as source; retain it only until this temp project is removed.
        for generated in (project / ".venv-workers", src / ".venv-workers"):
            if generated.exists():
                with tempfile.TemporaryDirectory(prefix="roi-plus-generated-worker-venv-") as outside_name:
                    shutil.move(str(generated), str(Path(outside_name) / generated.name))

        output = run([str(wrangler), "deploy", "--dry-run", "--config", str(project / "wrangler.toml")],
                     cwd=project, env=env, label="learner dry-run")
        bundle = re.search(r"Total \(\d+ modules\).*?([\d.,]+ KiB)", output)
        upload = re.search(r"Total Upload: ([\d.,]+ KiB) / gzip: ([\d.,]+ KiB)", output)
        if not bundle or not upload:
            print("learner dry-run: validation output missing expected summary", file=sys.stderr)
            return 1
        bundle_kib = float(bundle.group(1).split()[0].replace(",", ""))
        upload_kib = float(upload.group(1).split()[0].replace(",", ""))
        if max(bundle_kib, upload_kib) > MAX_BUNDLE_KIB:
            print("learner dry-run: bundle exceeds 64 MiB limit", file=sys.stderr)
            return 1
        print("learner dry-run passed")
        print(f"Bundle: {bundle.group(1)}; upload: {upload.group(1)}; gzip: {upload.group(2)}")
        if args.smoke_test:
            try:
                smoke_test(project, wrangler, env)
            except Exception as error:
                safe_error = str(error)
                trainer_error = (safe_error.split(":", 1)[1] if safe_error.startswith("local_trainer_fit_smoke_failed:") else None)
                if trainer_error not in {"AssertionError", "AttributeError", "FileNotFoundError", "ImportError",
                    "IndexError", "IsADirectoryError", "KeyError", "MemoryError", "ModuleNotFoundError",
                    "NotADirectoryError", "NotImplementedError", "OSError", "OverflowError", "PermissionError",
                    "RuntimeError", "StopIteration", "TimeoutError", "TypeError", "ValueError", "ZeroDivisionError",
                    "ZoneInfoNotFoundError", "OtherError"}:
                    trainer_error = None
                reason = safe_error if safe_error in {
                    "local_worker_smoke_failed", "local_numpy_fit_smoke_failed",
                    "local_worker_invalid_rejection_failed", "local_worker_empty_response_failed",
                    "local_worker_process_exited", "local_worker_not_ready"
                } else "local_worker_smoke_failed"
                if safe_error.startswith("local_worker_invalid_rejection_failed:"):
                    http_status = safe_error.rsplit(":", 1)[1]
                    if not http_status.isdigit(): http_status = "unknown"
                    print(f"local workerd smoke test failed; stage=learner-invalid-request httpStatus={http_status}", file=sys.stderr)
                    return 1
                if safe_error.startswith("local_worker_empty_response_failed:"):
                    http_status = safe_error.rsplit(":", 1)[1]
                    if not http_status.isdigit(): http_status = "unknown"
                    print(f"local workerd smoke test failed; stage=learner-current-date httpStatus={http_status}", file=sys.stderr)
                    return 1
                if safe_error.startswith("local_trainer_http_error:"):
                    http_status = safe_error.rsplit(":", 1)[1]
                    if not http_status.isdigit(): http_status = "unknown"
                    print(f"local workerd smoke test failed; stage=trainer-endpoint httpStatus={http_status}", file=sys.stderr)
                    return 1
                if safe_error == "local_trainer_fit_smoke_invalid":
                    print("local workerd smoke test failed; stage=trainer-fit invalid-result", file=sys.stderr)
                elif trainer_error:
                    print(f"local workerd smoke test failed; stage=trainer-fit errorClass={trainer_error}", file=sys.stderr)
                else:
                    error_name = type(error).__name__
                    safe_class = error_name if error_name in {
                        "AssertionError", "AttributeError", "FileNotFoundError", "FloatingPointError",
                        "ImportError", "IndexError", "IsADirectoryError", "KeyError", "LinAlgError",
                        "MemoryError", "ModuleNotFoundError", "NotADirectoryError", "NotImplementedError",
                        "OSError", "OverflowError", "PermissionError", "RuntimeError", "StopIteration",
                        "TimeoutError", "TypeError", "ValueError", "ZeroDivisionError", "ZoneInfoNotFoundError",
                    } else "OtherError"
                    print(f"local workerd smoke test failed; stage={reason} errorClass={safe_class}", file=sys.stderr)
                return 1
            print("local workerd smoke test passed")
        if args.deploy:
            run([str(wrangler), "deploy", "--config", str(project / "wrangler.toml")],
                cwd=project, env=env, label="learner deploy")
            # Do not echo Wrangler deployment details, which may include account
            # and environment identifiers.
            print("learner deploy succeeded")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
