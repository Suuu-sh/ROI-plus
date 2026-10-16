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
                        raise RuntimeError("local_worker_invalid_rejection_failed")
                    if good_status != 200 or good_body.get("status") != "insufficient_data":
                        raise RuntimeError("local_worker_empty_response_failed")
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
import numpy as np
from edgelab.models.numpy_logistic import NumpyLogisticRegression
from workers import WorkerEntrypoint, Response

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        x = np.asarray([[-2., 0.], [-1., 1.], [-1., 0.], [0., 1.], [0., -1.],
                        [1., 0.], [1., -1.], [2., 0.], [2., 1.], [-2., -1.]])
        y = np.asarray([0, 0, 0, 0, 1, 1, 1, 1, 1, 0])
        model = NumpyLogisticRegression(C=0.25, fit_intercept=False,
                                        max_iter=1000, tol=1e-8).fit(x, y)
        result = {"status": "fit_ok", "converged": bool(model.converged_),
                  "finite": bool(np.isfinite(model.coef_).all()),
                  "gradientInfinityNorm": float(model.gradient_norm_)}
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
                    if (status != 200 or body.get("status") != "fit_ok"
                            or body.get("converged") is not True or body.get("finite") is not True):
                        raise RuntimeError("local_numpy_fit_smoke_failed")
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
        return error.code, __import__("json").loads(error.read())


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
                reason = str(error) if str(error) in {
                    "local_worker_smoke_failed", "local_numpy_fit_smoke_failed",
                    "local_worker_invalid_rejection_failed", "local_worker_empty_response_failed",
                    "local_worker_process_exited", "local_worker_not_ready"
                } else "local_worker_smoke_failed"
                print(f"local workerd smoke test failed; stage={reason}", file=sys.stderr)
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
