import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '@google/genai';

import { googleRetryDelayMs } from '../src/lib/google-api-errors.ts';
import { isTransientError, withRetry } from '../src/lib/retry.ts';

const noSleep = async () => undefined;
const noJitter = () => 0;

function quotaError(retryDelay?: string): ApiError {
  const details: Array<Record<string, unknown>> = [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'embed_content_requests' }] },
  ];
  if (retryDelay) details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
  return new ApiError({
    status: 429,
    message: JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED', details } }),
  });
}

describe('withRetry', () => {
  it('retries transient failures and returns the eventual result', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error('rate limited'), { status: 429 });
        return 'ok';
      },
      { retries: 3, baseDelayMs: 1, sleep: noSleep },
    );
    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
  });

  it('does not retry permanent failures', async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => {
          attempts++;
          throw Object.assign(new Error('bad request'), { status: 400 });
        },
        { retries: 3, baseDelayMs: 1, sleep: noSleep },
      ),
      /bad request/,
    );
    assert.equal(attempts, 1);
  });

  it('gives up after the configured retries', async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => {
          attempts++;
          throw Object.assign(new Error('unavailable'), { status: 503 });
        },
        { retries: 2, baseDelayMs: 1, sleep: noSleep },
      ),
    );
    assert.equal(attempts, 3);
  });

  it('waits at least the server-provided delay, and backs off further once backoff exceeds it', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    await withRetry(
      async () => {
        attempts++;
        if (attempts <= 4) throw quotaError('5s');
        return 'ok';
      },
      {
        retries: 5,
        baseDelayMs: 2_000,
        serverDelayMs: googleRetryDelayMs,
        sleep: async (ms) => void sleeps.push(ms),
        random: noJitter,
      },
    );
    // backoff 2s, 4s, 8s, 16s vs server 5s → max(server, backoff)
    assert.deepEqual(sleeps, [5_000, 5_000, 8_000, 16_000]);
  });

  it('caps every wait at maxDelayMs', async () => {
    const sleeps: number[] = [];
    await assert.rejects(
      withRetry(
        async () => {
          throw quotaError('900s');
        },
        { retries: 1, baseDelayMs: 1_000, maxDelayMs: 60_000, serverDelayMs: googleRetryDelayMs, sleep: async (ms) => void sleeps.push(ms), random: noJitter },
      ),
    );
    assert.deepEqual(sleeps, [60_000]);
  });

  it('reports each retry', async () => {
    const reported: number[] = [];
    let attempts = 0;
    await withRetry(
      async () => {
        if (++attempts < 3) throw quotaError('1s');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 100, serverDelayMs: googleRetryDelayMs, sleep: noSleep, random: noJitter, onRetry: ({ attempt }) => void reported.push(attempt) },
    );
    assert.deepEqual(reported, [1, 2]);
  });

  it('classifies transient errors', () => {
    assert.equal(isTransientError({ status: 500 }), true);
    assert.equal(isTransientError({ status: 408 }), true);
    assert.equal(isTransientError(quotaError('1s')), true);
    assert.equal(isTransientError({ status: 404 }), false);
    assert.equal(isTransientError(new TypeError('fetch failed')), true);
    assert.equal(isTransientError(new Error('other')), false);
  });
});

describe('googleRetryDelayMs', () => {
  it('reads RetryInfo.retryDelay from a Gemini ApiError', () => {
    assert.equal(googleRetryDelayMs(quotaError('37s')), 37_000);
    assert.equal(googleRetryDelayMs(quotaError('1.5s')), 1_500);
    assert.equal(googleRetryDelayMs(quotaError('0.2s')), 200);
  });

  it('falls back to a text match when the message is not pure JSON', () => {
    const error = new Error('got status: 429. {"error":{"details":[{"retryDelay":"12s"}]}} (streamed)');
    assert.equal(googleRetryDelayMs(error), 12_000);
  });

  it('returns undefined when no delay is provided or the value is malformed', () => {
    assert.equal(googleRetryDelayMs(quotaError()), undefined);
    assert.equal(googleRetryDelayMs(quotaError('soon')), undefined);
    assert.equal(googleRetryDelayMs(new Error('plain')), undefined);
    assert.equal(googleRetryDelayMs(null), undefined);
  });
});
