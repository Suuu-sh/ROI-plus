"""Submit isolated, one-race experimental forecasts without logging credentials."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable
from urllib.parse import urlsplit


_SAFE_API_ERRORS = {
    "forbidden": "access_forbidden",
    "unauthorized": "unauthorized",
    "official result-worker evidence is server-owned": "server_owned_evidence_denied",
    "experimental forecast envelope must contain exactly one race": "one_race_required",
    "experimental model or artifact SHA is not registered": "model_not_registered_or_sha_mismatch",
    "experimental forecast timestamp or row count is invalid": "invalid_timestamp_or_row_count",
    "experimental forecast predates model training": "forecast_predates_training",
    "experimental forecast race is not an eligible real race": "race_not_eligible",
    "experimental forecast is outside a verified pre-cutoff prediction window": "outside_t60_window",
    "official prerace archive is not fresh as of prediction time": "archive_not_fresh_as_of_prediction",
    "official prerace archive is invalid": "archive_invalid",
    "official archive identity, six-lane, or complete odds provenance is invalid": "archive_evidence_invalid",
    "experimental forecast is not a complete normalized exact-order distribution": "invalid_ticket_distribution",
    "atomic experimental forecast storage is unavailable": "atomic_storage_unavailable",
}
_SAFE_API_CODES = {"d1_write_budget_unavailable", "d1_write_budget_exhausted"}


def _api_diagnostic(body: bytes) -> str | None:
    """Map bounded API error data to fixed diagnostics; never return raw text."""
    if not body or len(body) > 8192:
        return None
    try:
        payload = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    code = payload.get("code")
    if isinstance(code, str) and code in _SAFE_API_CODES:
        return code
    message = payload.get("error")
    return _SAFE_API_ERRORS.get(message.casefold()) if isinstance(message, str) else None


def _http_response_diagnostics(exc: urllib.error.HTTPError, request_url: str) -> dict[str, Any]:
    """Summarize a bounded denial response without exposing its body or headers."""
    try:
        body = exc.read(8193)
    except OSError:
        body = b""
    headers = getattr(exc, "headers", None)
    try:
        content_type = str(headers.get("Content-Type", "")).lower() if headers else ""
        mitigated = str(headers.get("cf-mitigated", "")).strip().lower() == "challenge" if headers else False
        server = str(headers.get("Server", "")).lower() if headers else ""
        api_revision_marker = (headers.get("X-ROI-API-Revision") == "experimental-paper-v1"
                               if headers else False)
    except Exception:
        content_type, mitigated, server, api_revision_marker = "", False, "", False
    is_html = "text/html" in content_type or body.lstrip().lower().startswith((b"<!doctype html", b"<html"))
    if is_html:
        lower_body = body[:8192].lower()
        edge_marker = any(marker in lower_body for marker in (b"cf-chl-", b"cloudflare", b"attention required"))
        edge_challenge = mitigated or (edge_marker and ("cloudflare" in server or not content_type))
        kind = "edge_challenge_html" if edge_challenge else "html_error"
    elif not body:
        edge_challenge, kind = mitigated, "empty_error"
    else:
        try:
            parsed = json.loads(body[:8192].decode("utf-8")) if len(body) <= 8192 else None
        except (ValueError, UnicodeDecodeError):
            parsed = None
        edge_challenge = mitigated
        kind = "json_api_error" if isinstance(parsed, dict) else "non_json_error"
    summary: dict[str, Any] = {"responseKind": kind, "edgeMitigatedChallenge": edge_challenge}
    summary["originApiMarkerPresent"] = api_revision_marker
    expected_suffix = "/api/ingest/experimental-trifecta/forecast"
    try:
        request_parts = urlsplit(request_url)
        response_url = exc.geturl() or request_url
        response_parts = urlsplit(response_url)
        request_identity = (request_parts.scheme.lower(), request_parts.netloc.lower(), request_parts.path)
        response_identity = (response_parts.scheme.lower(), response_parts.netloc.lower(), response_parts.path)
        if request_parts.path == expected_suffix:
            path_kind = "standard_endpoint_path"
        elif request_parts.path.endswith(expected_suffix):
            path_kind = "prefixed_base_path"
        else:
            path_kind = "unexpected_path"
        summary.update({"requestPathKind": path_kind,
                        "responseRedirected": request_identity != response_identity,
                        "responseSameOrigin": (request_parts.scheme.lower(), request_parts.netloc.lower()) ==
                                              (response_parts.scheme.lower(), response_parts.netloc.lower()),
                        "responsePathMatchesRequest": request_parts.path == response_parts.path})
    except (TypeError, ValueError):
        summary.update({"requestPathKind": "unavailable", "responseRedirected": None,
                        "responseSameOrigin": None, "responsePathMatchesRequest": None})
    api_reason = _api_diagnostic(body)
    if api_reason:
        summary["apiReason"] = api_reason
    return summary


def _failure_result(stored: list[str], race_count: int, *, reason: str,
                    category: str | None = None, api_reason: str | None = None) -> dict[str, Any]:
    result = {"status": "partially_stored" if stored else "submission_failed",
              "storedRaceCount": len(stored), "eligibleRaceCount": race_count,
              "failedRaceCount": race_count - len(stored), "reason": reason}
    if category:
        result["failureCategory"] = category
    if api_reason:
        result["apiReason"] = api_reason
    return result


def submit_forecasts(envelope: dict[str, Any], *, base_url: str, token: str,
                     opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """POST each race separately and report partial acceptance accurately.

    The API request cap is one race per invocation. No retries are performed,
    so an uncertain response cannot accidentally duplicate later decisions.
    """
    races = envelope.get("races") if isinstance(envelope, dict) else None
    if (not isinstance(races, list) or not 1 <= len(races) <= 4
            or not base_url or not token):
        return {"status": "invalid_request", "storedRaceCount": 0,
                "eligibleRaceCount": len(races) if isinstance(races, list) else 0,
                "reason": "forecast_envelope_or_credentials_invalid"}
    base = base_url.rstrip("/")
    metadata = {key: value for key, value in envelope.items() if key != "races"}
    stored: list[str] = []
    for race in races:
        if (not isinstance(race, dict) or not isinstance(race.get("raceId"), str)
                or not isinstance(race.get("predictions"), list)
                or len(race["predictions"]) != 120):
            return {"status": "partially_stored" if stored else "submission_failed",
                    "storedRaceCount": len(stored), "eligibleRaceCount": len(races),
                    "failedRaceCount": len(races) - len(stored),
                    "reason": "forecast_race_payload_invalid"}
        body = json.dumps({**metadata, "races": [race]}, ensure_ascii=False,
                          allow_nan=False).encode("utf-8")
        request = urllib.request.Request(base + "/api/ingest/experimental-trifecta/forecast",
            data=body, method="POST", headers={"Authorization": "Bearer " + token,
            "Content-Type": "application/json", "Accept": "application/json",
            "User-Agent": "ROIPlus-Forecast/1.0"})
        try:
            with opener(request, timeout=30) as response:
                response_body = response.read(16_385)
            if not response_body or len(response_body) > 16_384:
                return _failure_result(stored, len(races), reason="invalid_api_response",
                                       category="response_oversized_or_empty")
            result = json.loads(response_body.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            status = exc.code
            category = (f"http_{status}" if status in {400, 401, 403, 404, 409, 413, 429} else
                        "http_5xx" if 500 <= status <= 599 else "http_other")
            result = _failure_result(stored, len(races), reason="api_unavailable_or_rejected",
                                     category=category)
            result.update(_http_response_diagnostics(exc, request.full_url))
            return result
        except (urllib.error.URLError, TimeoutError, OSError):
            return _failure_result(stored, len(races), reason="api_unavailable_or_rejected",
                                   category="transport_error")
        except (ValueError, UnicodeDecodeError):
            return _failure_result(stored, len(races), reason="invalid_api_response",
                                   category="invalid_json")
        accepted = result.get("stored") if isinstance(result, dict) else None
        if (not isinstance(accepted, list) or len(accepted) != 1
                or not isinstance(accepted[0], dict)
                or accepted[0].get("raceId") != race["raceId"]
                or accepted[0].get("modelId") != envelope.get("modelId")
                or accepted[0].get("predictionCount") != 120):
            return {"status": "partially_stored" if stored else "submission_failed",
                    "storedRaceCount": len(stored), "eligibleRaceCount": len(races),
                    "failedRaceCount": len(races) - len(stored),
                    "reason": "invalid_api_response"}
        stored.append(race["raceId"])
    return {"status": "forecast_stored", "storedRaceCount": len(stored),
            "eligibleRaceCount": len(races), "raceIds": stored,
            "decision": "worker T-60 timing gate"}
