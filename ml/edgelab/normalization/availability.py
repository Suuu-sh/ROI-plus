"""Point-in-time availability guards shared by feature builders.

Historical outcomes are only eligible when their race date is strictly before
the target race date. Any source observation also needs ``available_at`` at
or before the prediction cutoff. Missing timestamps are not treated as safe.
"""
from __future__ import annotations

from datetime import date, datetime, time, timezone
from typing import Any, Iterable, Mapping


class AvailabilityError(ValueError):
    """Raised when a feature row contains information unavailable at prediction time."""


def parse_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if value is None:
        raise ValueError("date is required")
    return date.fromisoformat(str(value)[:10])


def parse_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        result = value
    elif value is None:
        raise ValueError("available_at is required")
    else:
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if result.tzinfo is None:
        # Project timestamps are ISO strings; interpret naive values as UTC
        # consistently rather than depending on the machine's local timezone.
        result = result.replace(tzinfo=timezone.utc)
    return result.astimezone(timezone.utc)


def available_by(row: Mapping[str, Any], cutoff: Any) -> bool:
    """Whether a row explicitly became available no later than ``cutoff``."""
    try:
        return parse_datetime(row.get("available_at")) <= parse_datetime(cutoff)
    except (TypeError, ValueError):
        return False


def filter_historical(rows: Iterable[Mapping[str, Any]], *, race_date: Any,
                      predicted_at: Any | None = None) -> list[Mapping[str, Any]]:
    """Keep only prior-race rows, optionally enforcing point-in-time availability.

    ``race_date`` comparison is strictly ``<`` by design: same-day outcomes are
    excluded even when their timestamp precedes a later race's prediction.
    """
    target = parse_date(race_date)
    result = []
    for row in rows:
        try:
            prior = parse_date(row.get("race_date")) < target
        except (TypeError, ValueError):
            continue
        if prior and (predicted_at is None or available_by(row, predicted_at)):
            result.append(row)
    return result


def assert_available(rows: Iterable[Mapping[str, Any]], cutoff: Any) -> None:
    """Fail closed if any included source row is missing/after the cutoff."""
    late = [row for row in rows if not available_by(row, cutoff)]
    if late:
        raise AvailabilityError(f"{len(late)} feature row(s) unavailable at prediction cutoff")
