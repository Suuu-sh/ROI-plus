from __future__ import annotations

import io
import json
import unittest

from edgelab.hosted_llm import (
    CHATGPT_PLAN_SCOPE,
    OPENAI_API_BASE,
    ChatGPTPlanProvider,
    ChatGPTPlanSession,
    HostedInferenceError,
    HostedLLMConfig,
)


TOKEN = "test-access-token-never-a-real-credential"
CLIENT_ID = "test-client"
HOST_ID = "urn:uuid:00000000-0000-4000-8000-000000000001"


def _config(**overrides):
    values = {
        "enabled": True,
        "hosted_integration_approved": True,
        "client_id": CLIENT_ID,
        "host_id": HOST_ID,
    }
    values.update(overrides)
    return HostedLLMConfig(**values)


def _session(**overrides):
    values = {
        "access_token": TOKEN,
        "client_id": CLIENT_ID,
        "host_id": HOST_ID,
        "granted_scopes": frozenset({"openid", CHATGPT_PLAN_SCOPE}),
        "expires_at": 10_000,
        "identity_verified": True,
    }
    values.update(overrides)
    return ChatGPTPlanSession(**values)


class FakeResponse:
    def __init__(self, body: bytes | str, *, status: int = 200, headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self._stream = io.BytesIO(body)
        self.status = status
        self.headers = headers or {}
        self.closed = False

    def read(self, size=-1):
        return self._stream.read(size)

    def __iter__(self):
        return self._stream

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True
        return False


class FakeOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, *, timeout):
        self.requests.append((request, timeout))
        return self.responses.pop(0)


def _catalog(*models):
    return json.dumps({"models": list(models)})


class HostedLLMTests(unittest.TestCase):
    def test_config_defaults_closed_and_does_not_read_credentials_from_environment(self):
        config = HostedLLMConfig.from_env({"OPENAI_API_KEY": "ignored"})

        self.assertFalse(config.enabled)
        self.assertFalse(config.hosted_integration_approved)
        self.assertEqual(config.client_id, "")
        self.assertEqual(config.host_id, "")

    def test_config_requires_exact_true_values_and_reads_only_non_secret_settings(self):
        config = HostedLLMConfig.from_env({
            "EDGELAB_HOSTED_LLM_ENABLED": "yes",
            "EDGELAB_CHATGPT_PLAN_HOSTED_APPROVED": "TRUE",
            "EDGELAB_CHATGPT_PLAN_CLIENT_ID": CLIENT_ID,
            "EDGELAB_CHATGPT_PLAN_HOST_ID": HOST_ID,
            "EDGELAB_CHATGPT_PLAN_ACCESS_TOKEN": TOKEN,
        })

        self.assertFalse(config.enabled)
        self.assertTrue(config.hosted_integration_approved)
        self.assertEqual(config.client_id, CLIENT_ID)
        self.assertFalse(hasattr(config, "access_token"))

    def test_provider_fails_closed_without_hosted_approval_or_enabled_flag(self):
        cases = [
            (_config(enabled=False), "hosted_llm_disabled"),
            (_config(hosted_integration_approved=False), "hosted_integration_not_approved"),
        ]
        for config, expected in cases:
            with self.subTest(expected=expected):
                opener = FakeOpener([])
                provider = ChatGPTPlanProvider(config, opener=opener, clock=lambda: 1)

                with self.assertRaises(HostedInferenceError) as error:
                    provider.list_models(_session())

                self.assertEqual(error.exception.code, expected)
                self.assertEqual(opener.requests, [])

    def test_provider_fails_closed_for_unverified_or_ineligible_sessions_before_network_calls(self):
        cases = [
            (None, "verified_session_required"),
            (_session(identity_verified=False), "identity_not_verified"),
            (_session(granted_scopes=frozenset({"openid"})), "chatgpt_plan_usage_not_granted"),
            (_session(expires_at=1), "session_expired"),
            (_session(client_id="different-client"), "session_binding_mismatch"),
            (_session(host_id="urn:uuid:00000000-0000-4000-8000-000000000002"), "session_binding_mismatch"),
        ]
        for session, expected in cases:
            with self.subTest(expected=expected):
                opener = FakeOpener([])
                provider = ChatGPTPlanProvider(_config(), opener=opener, clock=lambda: 100)

                with self.assertRaises(HostedInferenceError) as error:
                    provider.list_models(session)

                self.assertEqual(error.exception.code, expected)
                self.assertEqual(opener.requests, [])

    def test_configuration_requires_client_and_opaque_host_id_before_network_calls(self):
        for config in (_config(client_id=""), _config(host_id="localhost")):
            with self.subTest(config=config):
                opener = FakeOpener([])
                provider = ChatGPTPlanProvider(config, opener=opener, clock=lambda: 1)

                with self.assertRaises(HostedInferenceError) as error:
                    provider.list_models(_session())

                self.assertEqual(error.exception.code, "hosted_configuration_incomplete")
                self.assertEqual(opener.requests, [])

    def test_model_catalog_only_returns_account_visible_models_and_uses_bearer_token(self):
        opener = FakeOpener([FakeResponse(_catalog(
            {"slug": "model-a", "display_name": "Model A", "visibility": "list"},
            {"slug": "model-hidden", "display_name": "Hidden", "visibility": "private"},
            {"slug": "", "display_name": "Invalid", "visibility": "list"},
        ), headers={"x-request-id": "req-models-123"})])
        provider = ChatGPTPlanProvider(_config(), opener=opener, clock=lambda: 1)

        models = provider.list_models(_session())

        self.assertEqual([(item.slug, item.display_name) for item in models], [("model-a", "Model A")])
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, f"{OPENAI_API_BASE}/models")
        self.assertEqual(request.method, "GET")
        self.assertEqual(request.get_header("Authorization"), f"Bearer {TOKEN}")
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(timeout, 30)

    def test_generation_uses_visible_model_and_public_streaming_responses_contract(self):
        stream = (
            'event: response.output_text.delta\n'
            'data: {"type":"response.output_text.delta","delta":"safe "}\n\n'
            'data: {"type":"response.output_text.delta","delta":"summary"}\n\n'
            'data: {"type":"response.completed","response":{"id":"resp-1"}}\n\n'
        )
        opener = FakeOpener([
            FakeResponse(_catalog({"slug": "model-a", "display_name": "Model A", "visibility": "list"})),
            FakeResponse(stream, headers={"content-type": "text/event-stream", "x-request-id": "req-42"}),
        ])
        provider = ChatGPTPlanProvider(_config(), opener=opener, clock=lambda: 1)

        result = provider.generate(_session(), model="model-a", prompt="Explain the saved paper result.")

        self.assertEqual(result.text, "safe summary")
        self.assertEqual(result.request_id, "req-42")
        self.assertEqual(len(opener.requests), 2)
        request, _ = opener.requests[1]
        self.assertEqual(request.full_url, f"{OPENAI_API_BASE}/responses")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.get_header("Authorization"), f"Bearer {TOKEN}")
        payload = json.loads(request.data)
        self.assertEqual(payload, {
            "model": "model-a",
            "input": [{"role": "user", "content": "Explain the saved paper result."}],
            "store": False,
            "stream": True,
        })

    def test_generation_rejects_unlisted_model_before_responses_request(self):
        opener = FakeOpener([FakeResponse(_catalog(
            {"slug": "model-a", "display_name": "Model A", "visibility": "list"},
        ))])
        provider = ChatGPTPlanProvider(_config(), opener=opener, clock=lambda: 1)

        with self.assertRaises(HostedInferenceError) as error:
            provider.generate(_session(), model="model-not-authorized", prompt="hello")

        self.assertEqual(error.exception.code, "model_unavailable")
        self.assertEqual(len(opener.requests), 1)

    def test_http_errors_preserve_status_request_id_shape_and_code_without_raw_body(self):
        raw_detail = "temporary private admission detail"
        opener = FakeOpener([FakeResponse(
            json.dumps({"detail": raw_detail}), status=403,
            headers={"x-request-id": "req-policy-1", "retry-after": "999"},
        )])
        provider = ChatGPTPlanProvider(_config(), opener=opener, clock=lambda: 1)

        with self.assertRaises(HostedInferenceError) as error:
            provider.list_models(_session())

        self.assertEqual(error.exception.status, 403)
        self.assertEqual(error.exception.request_id, "req-policy-1")
        self.assertEqual(error.exception.response_shape, "detail")
        self.assertEqual(error.exception.provider_code, "policy_blocked")
        self.assertEqual(error.exception.retry_after_seconds, 60)
        self.assertNotIn(raw_detail, str(error.exception))
        self.assertNotIn(TOKEN, str(error.exception))

    def test_provider_error_object_code_is_preserved_safely(self):
        opener = FakeOpener([FakeResponse(
            json.dumps({"error": {"code": "direct_not_enabled", "message": "do not expose"}}),
            status=503, headers={"x-request-id": "req-admission-503"},
        )])
        provider = ChatGPTPlanProvider(_config(), opener=opener, clock=lambda: 1)

        with self.assertRaises(HostedInferenceError) as error:
            provider.list_models(_session())

        self.assertEqual(error.exception.status, 503)
        self.assertEqual(error.exception.request_id, "req-admission-503")
        self.assertEqual(error.exception.response_shape, "error_object")
        self.assertEqual(error.exception.provider_code, "direct_not_enabled")
        self.assertNotIn("do not expose", str(error.exception))

    def test_failed_or_incomplete_streams_never_return_partial_text_or_retry(self):
        failed_stream = (
            'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
            'data: {"type":"response.failed","response":{"error":{"code":"plan_usage_limit"}}}\n\n'
        )
        opener = FakeOpener([
            FakeResponse(_catalog({"slug": "model-a", "display_name": "Model A", "visibility": "list"})),
            FakeResponse(failed_stream, headers={"content-type": "text/event-stream", "x-request-id": "req-fail"}),
        ])
        provider = ChatGPTPlanProvider(_config(), opener=opener, clock=lambda: 1)

        with self.assertRaises(HostedInferenceError) as error:
            provider.generate(_session(), model="model-a", prompt="hello")

        self.assertEqual(error.exception.code, "response_failed")
        self.assertEqual(error.exception.provider_code, "plan_usage_limit")
        self.assertEqual(error.exception.request_id, "req-fail")
        self.assertEqual(len(opener.requests), 2)

        incomplete_opener = FakeOpener([
            FakeResponse(_catalog({"slug": "model-a", "display_name": "Model A", "visibility": "list"})),
            FakeResponse(
                'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
                headers={"content-type": "text/event-stream"},
            ),
        ])
        incomplete_provider = ChatGPTPlanProvider(_config(), opener=incomplete_opener, clock=lambda: 1)
        with self.assertRaises(HostedInferenceError) as incomplete:
            incomplete_provider.generate(_session(), model="model-a", prompt="hello")
        self.assertEqual(incomplete.exception.code, "stream_incomplete")
        self.assertEqual(len(incomplete_opener.requests), 2)


if __name__ == "__main__":
    unittest.main()
