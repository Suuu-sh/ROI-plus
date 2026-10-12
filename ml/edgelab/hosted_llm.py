"""Fail-closed adapter for approved Sign in with ChatGPT plan usage.

This module is deliberately not wired into prediction, paper betting, settlement,
or any scheduled workflow. A trusted OAuth/session layer must construct the
session object after verifying identity and the returned scopes.
"""
from __future__ import annotations

import json
import math
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Mapping
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener


CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct"
OPENAI_API_BASE = "https://api.openai.com/v1"
_MAX_ERROR_BODY_BYTES = 16_384
_MAX_SSE_LINE_BYTES = 65_536


class HostedInferenceError(RuntimeError):
    """Safe, structured provider failure with no token or response body text."""

    def __init__(self, code: str, *, status: int | None = None,
                 request_id: str | None = None, response_shape: str | None = None,
                 provider_code: str | None = None,
                 retry_after_seconds: float | None = None):
        self.code = code
        self.status = status
        self.request_id = request_id
        self.response_shape = response_shape
        self.provider_code = provider_code
        self.retry_after_seconds = retry_after_seconds
        super().__init__(f"hosted inference failed: {code}")


@dataclass(frozen=True)
class HostedLLMConfig:
    """Deployment gates; all default closed and never contain user tokens."""

    enabled: bool = False
    hosted_integration_approved: bool = False
    client_id: str = field(default="", repr=False)
    host_id: str = field(default="", repr=False)
    timeout_seconds: float = 30.0
    max_response_bytes: int = 1_000_000
    max_input_characters: int = 20_000
    max_output_characters: int = 50_000

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "HostedLLMConfig":
        """Load only non-secret deployment gates and identifiers.

        OAuth access and refresh tokens are intentionally never read from the
        environment. They must come from a verified, per-user session store.
        """
        env = os.environ if environ is None else environ
        return cls(
            enabled=env.get("EDGELAB_HOSTED_LLM_ENABLED", "").strip().lower() == "true",
            hosted_integration_approved=(
                env.get("EDGELAB_CHATGPT_PLAN_HOSTED_APPROVED", "").strip().lower() == "true"
            ),
            client_id=env.get("EDGELAB_CHATGPT_PLAN_CLIENT_ID", "").strip(),
            host_id=env.get("EDGELAB_CHATGPT_PLAN_HOST_ID", "").strip(),
        )


@dataclass(frozen=True)
class ChatGPTPlanSession:
    """Verified session data supplied by a future Sign in with ChatGPT layer.

    Construct this only after OAuth state/PKCE/nonce and ID-token validation.
    ``granted_scopes`` must come from the successful token exchange, not from
    user input or an unverified access-token decode.
    """

    access_token: str = field(repr=False)
    client_id: str = field(repr=False)
    host_id: str = field(repr=False)
    granted_scopes: frozenset[str] = frozenset()
    expires_at: float = 0.0
    identity_verified: bool = False


@dataclass(frozen=True)
class ModelOption:
    slug: str
    display_name: str


@dataclass(frozen=True)
class InferenceResult:
    text: str
    request_id: str | None


class ChatGPTPlanProvider:
    """Use only the public Responses API after all hosted-use gates pass.

    No API key, Codex credential, localhost OAuth listener, backend API, retry,
    or alternate billing path is supported here.
    """

    def __init__(self, config: HostedLLMConfig, *,
                 opener: Callable[..., Any] | None = None,
                 clock: Callable[[], float] = time.time):
        self.config = config
        self._opener = opener or _open_without_redirects
        self._clock = clock

    def list_models(self, session: ChatGPTPlanSession) -> tuple[ModelOption, ...]:
        self._authorize(session)
        request = Request(
            f"{OPENAI_API_BASE}/models",
            method="GET",
            headers={
                "Authorization": f"Bearer {session.access_token}",
                "Accept": "application/json",
            },
        )
        with self._open(request) as response:
            status = _status(response)
            headers = _headers(response)
            body = _read_bounded(response, self.config.max_response_bytes)
            if status != 200:
                raise _http_error(status, headers, body)
            try:
                payload = json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise HostedInferenceError("invalid_model_catalog", status=status,
                                           request_id=_request_id(headers)) from None
            rows = payload.get("models") if isinstance(payload, dict) else None
            if not isinstance(rows, list):
                raise HostedInferenceError("invalid_model_catalog", status=status,
                                           request_id=_request_id(headers),
                                           response_shape="unexpected_json")
            options: list[ModelOption] = []
            for row in rows:
                if not isinstance(row, dict) or row.get("visibility") != "list":
                    continue
                slug, display_name = row.get("slug"), row.get("display_name")
                if isinstance(slug, str) and slug.strip() and isinstance(display_name, str) and display_name.strip():
                    options.append(ModelOption(slug=slug, display_name=display_name))
            return tuple(options)

    def generate(self, session: ChatGPTPlanSession, *, model: str,
                 prompt: str) -> InferenceResult:
        """Stream one user-authorized Responses request; never retry or fallback."""
        self._authorize(session)
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > self.config.max_input_characters:
            raise HostedInferenceError("invalid_input")
        if not isinstance(model, str) or not model.strip():
            raise HostedInferenceError("model_unavailable")

        # Resolve the model against this account's current list rather than a
        # static model catalog or a catalog from another signed-in account.
        available = self.list_models(session)
        if model not in {item.slug for item in available}:
            raise HostedInferenceError("model_unavailable")

        body = json.dumps({
            "model": model,
            "input": [{"role": "user", "content": prompt}],
            "store": False,
            "stream": True,
        }, separators=(",", ":")).encode("utf-8")
        request = Request(
            f"{OPENAI_API_BASE}/responses",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {session.access_token}",
                "Accept": "text/event-stream",
                "Content-Type": "application/json",
            },
        )
        with self._open(request) as response:
            status = _status(response)
            headers = _headers(response)
            request_id = _request_id(headers)
            if status != 200:
                raise _http_error(status, headers,
                                  _read_bounded(response, min(self.config.max_response_bytes,
                                                               _MAX_ERROR_BODY_BYTES)))
            content_type = _header(headers, "content-type").lower()
            if "text/event-stream" not in content_type:
                raise HostedInferenceError("invalid_stream", status=status,
                                           request_id=request_id,
                                           response_shape="unexpected_content_type")
            text, completed = self._consume_stream(response, request_id)
            if not completed:
                raise HostedInferenceError("stream_incomplete", status=status,
                                           request_id=request_id,
                                           response_shape="event_stream")
            return InferenceResult(text=text, request_id=request_id)

    def _authorize(self, session: ChatGPTPlanSession | None) -> None:
        config = self.config
        if not config.enabled:
            raise HostedInferenceError("hosted_llm_disabled")
        if not config.hosted_integration_approved:
            raise HostedInferenceError("hosted_integration_not_approved")
        timeout_valid = (isinstance(config.timeout_seconds, (int, float))
                         and not isinstance(config.timeout_seconds, bool)
                         and math.isfinite(float(config.timeout_seconds))
                         and config.timeout_seconds > 0)
        limits_valid = all(isinstance(value, int) and not isinstance(value, bool) and value > 0
                           for value in (config.max_response_bytes, config.max_input_characters,
                                         config.max_output_characters))
        if (not isinstance(config.client_id, str) or not config.client_id.strip()
                or not _valid_host_id(config.host_id) or not timeout_valid or not limits_valid):
            raise HostedInferenceError("hosted_configuration_incomplete")
        if session is None:
            raise HostedInferenceError("verified_session_required")
        if not session.identity_verified:
            raise HostedInferenceError("identity_not_verified")
        if session.client_id != config.client_id or session.host_id != config.host_id:
            raise HostedInferenceError("session_binding_mismatch")
        if not isinstance(session.access_token, str) or not session.access_token:
            raise HostedInferenceError("access_token_missing")
        if not _valid_bearer_token(session.access_token):
            raise HostedInferenceError("access_token_invalid")
        if (not isinstance(session.granted_scopes, (set, frozenset, tuple, list))
                or CHATGPT_PLAN_SCOPE not in session.granted_scopes):
            raise HostedInferenceError("chatgpt_plan_usage_not_granted")
        if (not isinstance(session.expires_at, (int, float)) or isinstance(session.expires_at, bool)
                or not math.isfinite(float(session.expires_at)) or session.expires_at <= self._clock()):
            raise HostedInferenceError("session_expired")

    def _open(self, request: Request) -> Any:
        failed = False
        try:
            response = self._opener(request, timeout=self.config.timeout_seconds)
        except HTTPError as error:
            # urllib exposes non-2xx responses as HTTPError file objects.
            return error
        except Exception:
            # Do not keep or expose transport exception text; it may contain headers.
            failed = True
            response = None
        if failed or response is None:
            raise HostedInferenceError("transport_error") from None
        return response

    def _consume_stream(self, response: Any, request_id: str | None) -> tuple[str, bool]:
        output: list[str] = []
        output_size = 0
        bytes_read = 0
        completed = False
        event_name = ""
        data_lines: list[str] = []
        max_bytes = self.config.max_response_bytes

        def consume_data() -> None:
            nonlocal output_size, completed
            if not data_lines:
                return
            raw = "\n".join(data_lines)
            data_lines.clear()
            if raw == "[DONE]":
                return
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                raise HostedInferenceError("invalid_stream_event", status=200,
                                           request_id=request_id,
                                           response_shape="event_stream") from None
            if not isinstance(event, dict):
                raise HostedInferenceError("invalid_stream_event", status=200,
                                           request_id=request_id,
                                           response_shape="event_stream")
            kind = event.get("type") if isinstance(event.get("type"), str) else event_name
            if kind == "response.output_text.delta":
                delta = event.get("delta")
                if not isinstance(delta, str):
                    raise HostedInferenceError("invalid_stream_event", status=200,
                                               request_id=request_id,
                                               response_shape="event_stream")
                output_size += len(delta)
                if output_size > self.config.max_output_characters:
                    raise HostedInferenceError("response_too_large", status=200,
                                               request_id=request_id,
                                               response_shape="event_stream")
                output.append(delta)
            elif kind == "response.failed":
                code = _failed_event_code(event)
                raise HostedInferenceError("response_failed", status=200,
                                           request_id=request_id,
                                           response_shape="stream_error_event",
                                           provider_code=code)
            elif kind == "response.incomplete":
                code = _incomplete_event_code(event)
                raise HostedInferenceError("response_incomplete", status=200,
                                           request_id=request_id,
                                           response_shape="stream_incomplete_event",
                                           provider_code=code)
            elif kind == "response.completed":
                completed = True

        transport_failed = False
        try:
            while True:
                # readline(size) bounds each allocation even if the peer sends
                # one enormous line without a newline. The +1 detects overflow.
                read_limit = min(_MAX_SSE_LINE_BYTES, max_bytes - bytes_read + 1)
                raw_line = response.readline(read_limit)
                if raw_line in (b"", ""):
                    break
                if not isinstance(raw_line, bytes):
                    raise HostedInferenceError("invalid_stream_event", status=200,
                                               request_id=request_id,
                                               response_shape="event_stream")
                line_bytes = raw_line
                bytes_read += len(line_bytes)
                if bytes_read > max_bytes:
                    raise HostedInferenceError("response_too_large", status=200,
                                               request_id=request_id,
                                               response_shape="event_stream")
                if len(line_bytes) == read_limit and not line_bytes.endswith(b"\n"):
                    raise HostedInferenceError("response_too_large", status=200,
                                               request_id=request_id,
                                               response_shape="event_stream")
                try:
                    line = line_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    raise HostedInferenceError("invalid_stream_event", status=200,
                                               request_id=request_id,
                                               response_shape="event_stream") from None
                line = line.rstrip("\r\n")
                if not line:
                    consume_data()
                    if completed:
                        break
                    event_name = ""
                elif line.startswith(":"):
                    continue
                elif line.startswith("event:"):
                    event_name = line[6:].strip()
                elif line.startswith("data:"):
                    value = line[5:]
                    data_lines.append(value[1:] if value.startswith(" ") else value)
            if data_lines:
                consume_data()
        except HostedInferenceError:
            raise
        except Exception:
            # Keep arbitrary stream transport details out of logs and errors.
            transport_failed = True
        if transport_failed:
            raise HostedInferenceError("stream_transport_error", status=200,
                                       request_id=request_id,
                                       response_shape="event_stream") from None
        return "".join(output), completed


def _valid_bearer_token(value: str) -> bool:
    # RFC 6750 b64token characters; rejects CR/LF, spaces, tabs, and controls.
    return re.fullmatch(r"[A-Za-z0-9._~+/-]+={0,}", value) is not None


def _valid_host_id(value: str) -> bool:
    if not isinstance(value, str):
        return False
    if value.startswith("urn:uuid:"):
        candidate = value.removeprefix("urn:uuid:")
        try:
            return str(uuid.UUID(candidate)) == candidate.lower() and candidate == candidate.lower()
        except ValueError:
            return False
    if re.fullmatch(r"urn:ietf:params:oauth:jwk-thumbprint:[A-Za-z0-9_-]+", value):
        return True
    return value.startswith("did:key:") and len(value) > len("did:key:") and not any(ch.isspace() for ch in value)


def _status(response: Any) -> int:
    status = getattr(response, "status", None)
    if status is None:
        status = response.getcode()
    try:
        return int(status)
    except (TypeError, ValueError):
        return 0


def _headers(response: Any) -> Mapping[str, str]:
    value = getattr(response, "headers", {})
    return value if isinstance(value, Mapping) or hasattr(value, "items") else {}


def _header(headers: Mapping[str, str], name: str) -> str:
    target = name.lower()
    for key, value in headers.items():
        if str(key).lower() == target:
            return str(value)
    return ""


def _request_id(headers: Mapping[str, str]) -> str | None:
    value = _header(headers, "x-request-id").strip()
    return value[:128] if value and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value) else None


def _read_bounded(response: Any, max_bytes: int) -> bytes:
    read_failed = False
    try:
        body = response.read(max_bytes + 1)
    except Exception:
        # Response wrappers can expose exception messages with request headers.
        read_failed = True
        body = b""
    if read_failed:
        raise HostedInferenceError("response_read_error", status=_status(response),
                                   request_id=_request_id(_headers(response))) from None
    if len(body) > max_bytes:
        raise HostedInferenceError("response_too_large", status=_status(response),
                                   request_id=_request_id(_headers(response)))
    return body


def _safe_provider_code(value: Any) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", value):
        return None
    return value


def _http_error(status: int, headers: Mapping[str, str], body: bytes) -> HostedInferenceError:
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = None
    shape = "non_json"
    code = None
    if isinstance(payload, dict):
        if isinstance(payload.get("error"), dict):
            shape = "error_object"
            code = _safe_provider_code(payload["error"].get("code"))
        elif "detail" in payload:
            shape = "detail"
        else:
            shape = "json_object"
    elif isinstance(payload, list):
        shape = "json_array"
    provider_code = code or {
        401: "authentication_rejected",
        403: "policy_blocked",
        429: "usage_limit",
        503: "service_unavailable",
    }.get(status, "provider_rejected")
    return HostedInferenceError(
        "provider_rejected", status=status, request_id=_request_id(headers),
        response_shape=shape, provider_code=provider_code,
        retry_after_seconds=_retry_after(headers),
    )


def _retry_after(headers: Mapping[str, str]) -> float | None:
    value = _header(headers, "retry-after").strip()
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = (parsedate_to_datetime(value).timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            return None
    if not math.isfinite(seconds):
        return None
    return max(0.0, min(60.0, seconds))


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        # Never allow an Authorization-bearing request to be replayed elsewhere.
        return None


def _open_without_redirects(request: Request, *, timeout: float):
    return build_opener(_RejectRedirects).open(request, timeout=timeout)


def _failed_event_code(event: Mapping[str, Any]) -> str | None:
    response = event.get("response")
    if isinstance(response, dict) and isinstance(response.get("error"), dict):
        return _safe_provider_code(response["error"].get("code"))
    error = event.get("error")
    return _safe_provider_code(error.get("code")) if isinstance(error, dict) else None


def _incomplete_event_code(event: Mapping[str, Any]) -> str | None:
    response = event.get("response")
    if isinstance(response, dict) and isinstance(response.get("incomplete_details"), dict):
        return _safe_provider_code(response["incomplete_details"].get("reason"))
    return None
