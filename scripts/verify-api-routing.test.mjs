import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  API_REVISION_HEADER,
  EXPECTED_API_REVISION,
  verifyApiRouting,
} from "./verify-api-routing.mjs";

test("read-only routing check accepts the canonical API health identity without reading its body", async () => {
  let requestedUrl;
  const response = {
    status: 200,
    headers: new Headers({ [API_REVISION_HEADER]: EXPECTED_API_REVISION }),
    get body() { throw new Error("response body must not be accessed"); },
  };
  const result = await verifyApiRouting(async (url) => {
    requestedUrl = url;
    return response;
  });

  assert.equal(requestedUrl, "https://roi-plus-api.suuu-sh.workers.dev/api/health");
  assert.deepEqual(result, { status: 200, revision: EXPECTED_API_REVISION });
});

test("read-only routing check fails closed on the wrong API identity", async () => {
  await assert.rejects(
    verifyApiRouting(async () => ({
      status: 200,
      headers: new Headers({ [API_REVISION_HEADER]: "unexpected" }),
    })),
    /revision_mismatch/,
  );
});

test("all scheduled API callers use the documented canonical API Worker, not a configurable secret", async () => {
  const root = new URL("../.github/workflows/", import.meta.url);
  const files = [
    "daily.yml",
    "retrain.yml",
    "recover-win-baseline.yml",
    "validate-initial-baseline.yml",
    "today-boat-forecast-operator.yml",
    "trifecta-candidate-pipeline.yml",
    "trifecta-experimental-pipeline.yml",
  ];
  const contents = await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")));

  for (const content of contents) {
    assert.doesNotMatch(content, /secrets\.EDGELAB_API_URL/);
    assert.match(content, /EDGELAB_API_URL: .*https:\/\/roi-plus-api\.suuu-sh\.workers\.dev/);
  }
  assert.match(contents[3], /inputs\.sync_validation && 'https:\/\/roi-plus-api\.suuu-sh\.workers\.dev' \|\| ''/);
});
