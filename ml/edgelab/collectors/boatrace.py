"""Download official Boatrace B/K archives with polite pacing and disk cache.

The official endpoint is one daily file per type (not one file per venue):
``/od2/{B,K}/YYYYMM/{b,k}YYMMDD.lzh``. A missing file (HTTP 404) is a normal
no-data condition and returns ``None``. Successful downloads are atomically
cached, so repeated runs are idempotent and do not hit the source again.
"""
from __future__ import annotations

import os
import tempfile
import threading
import time
from datetime import date
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_URL = "https://www1.mbrace.or.jp/od2"
USER_AGENT = "EdgeLab/0.1 (official Boatrace downloadable data collector)"
MIN_INTERVAL_SECONDS = 3.0
DEFAULT_RETRIES = 3

_rate_lock = threading.Lock()
_last_request_at = 0.0


def _date(value: str | date) -> date:
    if isinstance(value, date):
        return value
    return date.fromisoformat(value)


def _wait_for_slot() -> None:
    """Enforce a 3-second minimum gap between outgoing requests in this process."""
    global _last_request_at
    with _rate_lock:
        now = time.monotonic()
        delay = MIN_INTERVAL_SECONDS - (now - _last_request_at)
        if delay > 0:
            time.sleep(delay)
        _last_request_at = time.monotonic()


def boatrace_url(kind: str, target_date: str | date) -> str:
    """Build the official daily B or K download URL."""
    day = _date(target_date)
    file_prefix = kind.lower()
    if file_prefix not in {"b", "k"}:
        raise ValueError("kind must be 'B' or 'K'")
    return f"{BASE_URL}/{file_prefix.upper()}/{day:%Y%m}/{file_prefix}{day:%y%m%d}.lzh"


def fetch_boatrace_file(kind: str, target_date: str | date,
                        cache_dir: str | os.PathLike[str] | None = None,
                        retries: int = DEFAULT_RETRIES,
                        timeout: float = 30.0) -> Path | None:
    """Fetch and cache one official B/K LZH archive.

    ``retries=3`` means up to three retries after the initial attempt. Network
    failures and retryable HTTP statuses use exponential backoff (1, 2, 4s by
    default); 404 is returned immediately as ``None`` and is not cached.
    """
    day = _date(target_date)
    prefix = kind.lower()
    url = boatrace_url(prefix, day)
    if cache_dir is None:
        cache_dir = Path(__file__).resolve().parents[3] / "data" / "raw" / "boatrace"
    target = Path(cache_dir) / f"{prefix}{day:%y%m%d}.lzh"
    if target.is_file() and target.stat().st_size > 0:
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/octet-stream"})
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        _wait_for_slot()
        try:
            with urlopen(request, timeout=timeout) as response:
                payload = response.read()
            if not payload:
                raise OSError(f"empty response from {url}")
            fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
            try:
                with os.fdopen(fd, "wb") as temp_file:
                    temp_file.write(payload)
                    temp_file.flush()
                    os.fsync(temp_file.fileno())
                os.replace(temp_name, target)
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)
            return target
        except HTTPError as exc:
            if exc.code == 404:
                return None
            last_error = exc
            if exc.code < 500 and exc.code not in (408, 425, 429):
                raise
        except (URLError, TimeoutError, OSError) as exc:
            last_error = exc
        if attempt < retries:
            time.sleep(min(2 ** attempt, 30))
    assert last_error is not None
    raise RuntimeError(f"failed to download {url} after {retries + 1} attempts") from last_error


def read_lzh(path: str | os.PathLike[str]) -> str:
    """Decompress the first text member and decode the official Shift_JIS file."""
    import lhafile
    archive = lhafile.Lhafile(str(path))
    names = archive.namelist()
    if not names:
        raise ValueError(f"LZH archive has no members: {path}")
    member = next((name for name in names if str(name).lower().endswith((".txt", ".dat"))), names[0])
    raw = archive.read(member)
    if isinstance(raw, str):
        return raw
    try:
        return raw.decode("shift_jis")
    except UnicodeDecodeError:
        return raw.decode("cp932")


# Short alias for CLI callers.
fetch = fetch_boatrace_file
