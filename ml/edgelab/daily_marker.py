"""Read the workflow's local daily success marker without network access."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence


_REQUIRED = {
    "daily_collection_success": "true",
    "forecast_ready": "true",
}


def is_complete_daily_marker(path: str | Path) -> bool:
    """Return true only for one unambiguous marker with both readiness flags."""
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return False

    values: dict[str, str] = {}
    for line in lines:
        key, separator, value = line.partition("=")
        if separator and key in _REQUIRED:
            if key in values:
                return False
            values[key] = value
    return values == _REQUIRED


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("marker", type=Path)
    args = parser.parse_args(argv)
    print("true" if is_complete_daily_marker(args.marker) else "false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
