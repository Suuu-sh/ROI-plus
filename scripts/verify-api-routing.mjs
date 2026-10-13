import { fileURLToPath } from "node:url";

export const API_HEALTH_URL = "https://roi-plus-api.suuu-sh.workers.dev/api/health";
export const API_REVISION_HEADER = "X-ROI-API-Revision";
export const EXPECTED_API_REVISION = "experimental-paper-v1";

export async function verifyApiRouting(request = fetch) {
  let response;
  try {
    response = await request(API_HEALTH_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("API routing verification failed: request_error");
  }

  if (response.status !== 200) {
    throw new Error(`API routing verification failed: http_${response.status}`);
  }
  const revision = response.headers.get(API_REVISION_HEADER);
  if (revision !== EXPECTED_API_REVISION) {
    throw new Error("API routing verification failed: revision_mismatch");
  }

  // Deliberately do not read or print the response body; it contains operational data.
  return { status: response.status, revision };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await verifyApiRouting();
    process.stdout.write(`API routing verified: status=${result.status} revision=${result.revision}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "API routing verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
