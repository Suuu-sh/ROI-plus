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
        suffix = (f"; cloudflare_code={','.join(codes)}" if codes else "")
        suffix += (f"; http_status={','.join(statuses)}" if statuses else "")
        print(f"{label}: failed (exit {result.returncode}; category={category}{suffix}); details suppressed",
              file=sys.stderr)
        raise SystemExit(1)
    return result.stdout


def smoke_test(project: Path, wrangler: Path, env: dict[str, str]) -> None:
    """Start an isolated local workerd with empty D1/R2 bindings and hit /learn."""
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
    base = f"http://127.0.0.1:{port}/learn"

    def post(payload: dict[str, object]) -> tuple[int, dict[str, object]]:
        request = Request(base, data=__import__("json").dumps(payload).encode(),
                          headers={"content-type": "application/json"}, method="POST")
        try:
            with urlopen(request, timeout=2) as response:
                return response.status, __import__("json").loads(response.read())
        except HTTPError as error:
            return error.code, __import__("json").loads(error.read())

    try:
        deadline = time.monotonic() + 45
        today = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 9 * 60 * 60))
        invalid_status = None
        good_status = None
        while time.monotonic() < deadline and process.poll() is None:
            try:
                invalid_status, invalid_body = post({"date": "2000-01-01", "confirmed": True})
                good_status, good_body = post({"date": today, "confirmed": True})
                if (invalid_status == 200 and invalid_body.get("reason") == "request_confirmation_invalid"
                        and good_status == 200 and good_body.get("status") == "insufficient_data"):
                    return
                break
            except (URLError, TimeoutError, ConnectionError):
                time.sleep(0.25)
        raise RuntimeError("local_worker_smoke_failed")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


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
            except Exception:
                print("local workerd smoke test failed; details suppressed", file=sys.stderr)
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
