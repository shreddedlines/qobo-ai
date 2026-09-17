export interface RetryAttemptInfo {
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  baseDelayMs: number;
  /** Upper bound for any single wait, including server-requested delays. */
  maxDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  /** Server-requested wait for this error (e.g. a 429 RetryInfo), if any. */
  serverDelayMs?: (error: unknown) => number | undefined;
  onRetry?: (info: RetryAttemptInfo) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Status codes worth retrying: rate limits and transient upstream failures. */
export function isTransientError(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;
  return error instanceof TypeError; // fetch network failures
}

/**
 * Retries with exponential backoff and jitter. When the server says how long to
 * wait, the delay is at least that long; the backoff still grows each attempt so
 * repeated 429s back off further.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    retries,
    baseDelayMs,
    maxDelayMs = 120_000,
    isRetryable = isTransientError,
    serverDelayMs = () => undefined,
    onRetry,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
  } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      const backoff = baseDelayMs * 2 ** attempt;
      const jitter = Math.floor(random() * backoff * 0.25);
      const delayMs = Math.min(maxDelayMs, Math.max(serverDelayMs(error) ?? 0, backoff) + jitter);
      onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
}
