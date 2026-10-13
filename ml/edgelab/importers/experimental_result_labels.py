"""Import only authenticated, source-proven official K outcomes for ML labels.

This module never creates or edits races, entries, pre-race observations, or
odds. Label timestamps are the collector's actual result fetch time, not race
time or a reconstructed historical timestamp.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Any, Mapping, Sequence

_SCHEMA = "boat-official-k-result-label-export-v1"
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_RACE_ID = re.compile(r"^boat-(\d{8})-(\d{2})-(\d{2})$")


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def _expected_result_url(race: Mapping[str, Any]) -> str:
    return ("https://www.boatrace.jp/owpc/pc/race/raceresult?"
            f"rno={int(race['race_no'])}&jcd={race['venue_id']}&hd={str(race['race_date']).replace('-', '')}")


def _validate_label(label: Any, requested_date: str, races: Mapping[str, Mapping[str, Any]],
                    now: datetime) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(label, Mapping):
        return None, "label_invalid"
    race_id = label.get("raceId")
    race = races.get(race_id) if isinstance(race_id, str) else None
    match = _RACE_ID.fullmatch(race_id) if isinstance(race_id, str) else None
    if not race or not match or race.get("sport") != "boat" or race.get("data_origin") != "real":
        return None, "real_race_missing"
    try:
        venue, race_no = str(race.get("venue_id")), int(race.get("race_no"))
        if (race.get("race_date") != requested_date or label.get("raceDate") != requested_date
                or label.get("venueId") != venue or type(label.get("raceNo")) is not int
                or label.get("raceNo") != race_no or match.group(1) != requested_date.replace("-", "")
                or match.group(2) != venue or match.group(3) != f"{race_no:02d}"):
            return None, "race_identity_mismatch"
        expected_url = _expected_result_url(race)
    except (KeyError, TypeError, ValueError):
        return None, "race_identity_invalid"

    source = label.get("source")
    if (not isinstance(source, Mapping) or source.get("url") != expected_url
            or source.get("quality") != "verified-official-outcome-v2"
            or not isinstance(source.get("sha256"), str) or not _SHA256.fullmatch(source["sha256"])):
        return None, "result_source_proof_invalid"
    fetched_at = _parse_time(source.get("fetchedAt"))
    post_time = _parse_time(race.get("post_time"))
    if fetched_at is None or post_time is None or fetched_at > now or fetched_at < post_time:
        return None, "result_source_time_invalid"

    results = label.get("results")
    if not isinstance(results, list) or len(results) != 6:
        return None, "complete_numeric_result_missing"
    parsed_results: list[dict[str, int]] = []
    for item in results:
        if (not isinstance(item, Mapping) or type(item.get("number")) is not int
                or type(item.get("finishOrder")) is not int):
            return None, "result_row_invalid"
        parsed_results.append({"number": item["number"], "finish_order": item["finishOrder"]})
    if (sorted(row["number"] for row in parsed_results) != [1, 2, 3, 4, 5, 6]
            or sorted(row["finish_order"] for row in parsed_results) != [1, 2, 3, 4, 5, 6]):
        return None, "complete_numeric_result_missing"
    actual = "-".join(str(row["number"]) for row in sorted(parsed_results, key=lambda row: row["finish_order"])[:3])
    payouts = label.get("payouts")
    if not isinstance(payouts, list) or len(payouts) != 1:
        return None, "exact_trifecta_payout_missing"
    payout = payouts[0]
    if (not isinstance(payout, Mapping) or payout.get("betType") != "trifecta"
            or payout.get("selection") != actual or type(payout.get("payout")) is not int
            or payout["payout"] <= 0):
        return None, "exact_trifecta_payout_mismatch"

    shared = {"available_at": source["fetchedAt"], "source_available_at": source["fetchedAt"],
              "source_sha256": source["sha256"], "source_url": source["url"],
              "source_quality": source["quality"]}
    return {"raceId": race_id, "fetchedAt": source["fetchedAt"], "sourceSha256": source["sha256"],
            "results": [{"race_id": race_id, **row, "data_origin": "real", **shared}
                        for row in parsed_results],
            "payout": {"race_id": race_id, "bet_type": "trifecta", "selection": actual,
                       "payout": payout["payout"], "data_origin": "real", **shared}}, None


def import_experimental_result_labels(store: dict[str, list[dict[str, Any]]],
                                      pages: Sequence[Mapping[str, Any]], requested_date: str, *,
                                      now: datetime | None = None) -> dict[str, Any]:
    """Merge verified result labels only; reject conflicts and never retime features."""
    if date.fromisoformat(requested_date).isoformat() != requested_date:
        raise ValueError("label date must be YYYY-MM-DD")
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    now = now.astimezone(timezone.utc)
    races = {str(row.get("id")): row for row in store.get("races", []) if row.get("id")}
    store.setdefault("results", [])
    store.setdefault("payouts", [])
    imported = excluded = 0
    exclusions: dict[str, int] = {}
    seen: set[str] = set()
    for page in pages:
        if (not isinstance(page, Mapping) or page.get("schema") != _SCHEMA
                or page.get("date") != requested_date or page.get("limit") != 5
                or not isinstance(page.get("labels"), list) or len(page["labels"]) > 5):
            exclusions["page_invalid"] = exclusions.get("page_invalid", 0) + 1
            continue
        for label in page["labels"]:
            parsed, error = _validate_label(label, requested_date, races, now)
            if error or parsed is None:
                category = error or "label_invalid"
                exclusions[category] = exclusions.get(category, 0) + 1
                excluded += 1
                continue
            race_id = parsed["raceId"]
            if race_id in seen:
                exclusions["duplicate_label"] = exclusions.get("duplicate_label", 0) + 1
                excluded += 1
                continue
            seen.add(race_id)
            old_results = [row for row in store["results"] if row.get("race_id") == race_id
                           and row.get("data_origin") == "real"]
            old_by_number = {row.get("number"): row.get("finish_order") for row in old_results}
            new_by_number = {row["number"]: row["finish_order"] for row in parsed["results"]}
            if any(new_by_number.get(number) != finish for number, finish in old_by_number.items()):
                exclusions["existing_result_conflict"] = exclusions.get("existing_result_conflict", 0) + 1
                excluded += 1
                continue
            old_payouts = [row for row in store["payouts"] if row.get("race_id") == race_id
                           and row.get("data_origin") == "real" and row.get("bet_type") == "trifecta"]
            new_payout = parsed["payout"]
            if old_payouts and any((row.get("selection"), row.get("payout")) !=
                                   (new_payout["selection"], new_payout["payout"]) for row in old_payouts):
                exclusions["existing_payout_conflict"] = exclusions.get("existing_payout_conflict", 0) + 1
                excluded += 1
                continue
            # Replace only this race's labels with same-valued, timestamped official proof.
            # The six-entry B features, race timing, archives and odds are untouched.
            result_keys = {(race_id, row["number"]) for row in parsed["results"]}
            store["results"] = [row for row in store["results"]
                                if (row.get("race_id"), row.get("number")) not in result_keys]
            store["results"].extend(parsed["results"])
            store["payouts"] = [row for row in store["payouts"]
                                if not (row.get("race_id") == race_id and row.get("bet_type") == "trifecta"
                                        and row.get("data_origin") == "real")]
            store["payouts"].append(new_payout)
            imported += 1
    return {"schema": _SCHEMA, "requestedDate": requested_date, "importedLabels": imported,
            "excludedLabels": excluded, "exclusions": exclusions,
            "featureRowsModified": 0, "raceRowsModified": 0, "oddsRowsModified": 0}


def verified_experimental_result_race_ids(store: Mapping[str, Any], *, now: datetime | None = None) -> set[str]:
    """Return races whose six results and exact payout retain matching official source proof."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        return set()
    now = now.astimezone(timezone.utc)
    races = {str(row.get("id")): row for row in store.get("races", []) if row.get("id")}
    results: dict[str, list[Mapping[str, Any]]] = {}
    payouts: dict[str, list[Mapping[str, Any]]] = {}
    for row in store.get("results", []):
        results.setdefault(str(row.get("race_id")), []).append(row)
    for row in store.get("payouts", []):
        if row.get("bet_type") == "trifecta":
            payouts.setdefault(str(row.get("race_id")), []).append(row)
    allowed: set[str] = set()
    for race_id, race in races.items():
        rows = results.get(race_id, [])
        if len(rows) != 6 or any(row.get("data_origin") != "real" for row in rows):
            continue
        provenance = {(row.get("source_url"), row.get("source_sha256"), row.get("source_available_at"),
                       row.get("source_quality")) for row in rows}
        if len(provenance) != 1:
            continue
        url, digest, available_at, quality = next(iter(provenance))
        try:
            expected_url = _expected_result_url(race)
        except (KeyError, TypeError, ValueError):
            continue
        fetched = _parse_time(available_at)
        post = _parse_time(race.get("post_time"))
        if (url != expected_url or not isinstance(digest, str) or not _SHA256.fullmatch(digest)
                or quality != "verified-official-outcome-v2" or fetched is None or post is None
                or fetched > now or fetched < post):
            continue
        try:
            numbers = [int(row.get("number")) for row in rows]
            orders = [int(row.get("finish_order")) for row in rows]
        except (TypeError, ValueError):
            continue
        if sorted(numbers) != [1, 2, 3, 4, 5, 6] or sorted(orders) != [1, 2, 3, 4, 5, 6]:
            continue
        actual = "-".join(str(row["number"]) for row in sorted(rows, key=lambda row: int(row["finish_order"]))[:3])
        paid = [row for row in payouts.get(race_id, []) if row.get("data_origin") == "real"
                and row.get("selection") == actual and isinstance(row.get("payout"), (int, float))
                and not isinstance(row.get("payout"), bool) and row.get("payout") > 0
                and row.get("source_url") == url and row.get("source_sha256") == digest
                and row.get("source_available_at") == available_at and row.get("source_quality") == quality]
        if len(paid) == 1:
            allowed.add(race_id)
    return allowed


def experimental_training_store_projection(store: Mapping[str, Any], *, now: datetime | None = None
                                          ) -> dict[str, Any]:
    """Project only source-verified result labels as finished for model/coverage code.

    The normalized cache's scheduled status is intentionally left untouched:
    the official result-label endpoint proves a race is complete, but importing
    a label must not rewrite its source race record. This ephemeral projection
    changes only status on copied race dictionaries for IDs with complete,
    hash/time-verified six-boat results and matching trifecta payout.
    """
    completed_ids = verified_experimental_result_race_ids(store, now=now)
    projected = dict(store)
    projected["races"] = [
        ({**race, "status": "finished", "status_evidence": "verified-official-k-result-label-v1"}
         if str(race.get("id")) in completed_ids else dict(race))
        for race in store.get("races", [])
    ]
    return projected
