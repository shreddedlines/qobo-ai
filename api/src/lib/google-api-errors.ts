/**
 * Extracts the server-requested retry delay from a Google API error.
 *
 * The @google/genai SDK throws `ApiError` whose message is the JSON error body:
 *   {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[
 *     {"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}
 * `retryDelay` is a protobuf Duration string ("37s", "1.5s").
 */
export function googleRetryDelayMs(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return undefined;

  try {
    const body = JSON.parse(message) as { error?: { details?: Array<Record<string, unknown>> } };
    for (const detail of body.error?.details ?? []) {
      if (String(detail['@type'] ?? '').endsWith('google.rpc.RetryInfo')) {
        const parsed = parseDuration(detail.retryDelay);
        if (parsed !== undefined) return parsed;
      }
    }
  } catch {
    // Not JSON (e.g. streamed or proxied errors): fall back to a text search below.
  }

  const match = /"retryDelay"\s*:\s*"([\d.]+s)"/.exec(message);
  return match ? parseDuration(match[1]) : undefined;
}

function parseDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match) return undefined;
  return Math.ceil(Number(match[1]) * 1000);
}
