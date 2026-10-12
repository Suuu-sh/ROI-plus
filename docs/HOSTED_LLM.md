# Hosted LLM readiness

**Status (2026-10-12): disabled and not connected to the application.** The Sign in with ChatGPT interest form was submitted on 2026-10-11. No OpenAI hosted-integration approval, issued client ID, or user grant for ChatGPT plan inference has been verified. The code in `ml/edgelab/hosted_llm.py` is an isolated adapter boundary; no route, UI, cron job, prediction step, or paper-betting path calls it.

## OpenAI access requirements

OpenAI's current documentation separates identity sign-in from permission to use the signed-in person's ChatGPT plan. A valid sign-in without the `chatgpt.tokens.use.direct` scope must not proceed to inference. For a paid or remotely hosted application, OpenAI directs developers to the interest-form process. Submission is not approval. See [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source) and [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

If OpenAI confirms eligibility and this product has a trusted OAuth/session implementation, the adapter accepts only a verified session bound to the configured OAuth client and stable host ID. That auth implementation must validate OAuth state, PKCE, nonce, the ID token, client binding, granted scopes, and token expiry before constructing a `ChatGPTPlanSession`. It must provide the granted scope set from the token exchange. No existing application login or Codex credential can stand in for that grant.

## Adapter behavior

The adapter is intentionally fail-closed. It makes no request unless all of these checks pass:

- `EDGELAB_HOSTED_LLM_ENABLED=true` is set for the deployment.
- `EDGELAB_CHATGPT_PLAN_HOSTED_APPROVED=true` is set only after OpenAI confirms the hosted integration is enabled.
- An issued `EDGELAB_CHATGPT_PLAN_CLIENT_ID` and stable opaque `EDGELAB_CHATGPT_PLAN_HOST_ID` are configured.
- A verified, unexpired per-user session matches that client and host and contains the `chatgpt.tokens.use.direct` scope.

The adapter uses the account's current visible model catalog and the public `https://api.openai.com/v1/responses` endpoint. Requests set `store=false` and `stream=true`. Stream errors, declined access, admission errors, or usage limits stop the request. It does not call ChatGPT `backend-api` endpoints, follow redirects, retry inference, switch to an API key, use paid fallback, or include raw response bodies or tokens in exception text. The API origin is fixed in code.

The access token belongs to a verified per-user OAuth session and is never loaded from an environment variable or repository file. A production session store and OAuth flow are not implemented here. The adapter does not start a localhost callback listener; a future hosted OAuth flow must use an approved public callback and deployment-managed session handling.

## Configuration and checks

The deployment gates default to false. The client ID and host ID are non-secret configuration identifiers; no values are checked into this repository. The approval flag is a guard, not evidence that approval exists. Keep it false until the approval and the issued integration configuration are confirmed. If access is unavailable or revoked, preserve the error status/request ID and stop. Do not retry until a user or operator deliberately reauthorizes the selected account.

Tests inject an in-memory HTTP opener. Run them with `PYTHONPATH=ml python3 -m unittest discover -s ml/tests -p test_hosted_llm.py -v`. They verify closed-by-default behavior, scope and session checks, account-visible model filtering, the public Responses request contract, bounded error metadata, and no retry or fallback. They never make an OpenAI request.

This adapter is not part of statistical probability generation. The existing LightGBM probability engine remains authoritative; no LLM response may create, modify, rank, or validate probabilities, models, bets, settlement results, or paper decisions. Existing operation remains paper-only.
