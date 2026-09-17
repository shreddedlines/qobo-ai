import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '@google/genai';

import { embedThenReplace } from '../../scripts/ingest/lib/build.ts';
import type { KbChunk } from '../../scripts/ingest/lib/chunk.ts';
import { createSlidingWindowLimiter } from '../../src/lib/rate-limiter.ts';
import { createGeminiEmbedder, EMBEDDING_DIM, type EmbedContentClient } from '../../src/rag/embeddings.ts';
import { createVirtualClock } from '../helpers/virtual-clock.ts';

const chunks: KbChunk[] = Array.from({ length: 119 }, (_, i) => ({
  url: `https://qobo.dev/page-${i % 25}`,
  title: 'Page',
  pageType: 'service',
  section: null,
  chunkIndex: i,
  content: `chunk ${i}`,
  topics: [],
  tokenEstimate: 10,
}));

function quotaError(): ApiError {
  return new ApiError({
    status: 429,
    message: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }] } }),
  });
}

function embedResponse(count: number) {
  return { embeddings: Array.from({ length: count }, () => ({ values: Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === 0 ? 1 : 0)) })) };
}

describe('embedThenReplace', () => {
  it('embeds all 119 chunks under a 90/min limit, retrying a 429, then replaces once', async () => {
    const clock = createVirtualClock();
    const requestLog: Array<{ at: number; units: number }> = [];
    let calls = 0;
    const client = {
      embedContent: async (params: { contents: unknown[] }) => {
        calls++;
        requestLog.push({ at: clock.now(), units: params.contents.length });
        if (calls === 3) throw quotaError(); // third batch is throttled once
        return embedResponse(params.contents.length);
      },
    } as unknown as EmbedContentClient;

    const embedder = createGeminiEmbedder(client, 'gemini-embedding-2', {
      batchSize: 20,
      rateLimiter: createSlidingWindowLimiter({ limit: 90, windowMs: 60_000, now: clock.now, sleep: clock.sleep }),
      retry: { retries: 3, baseDelayMs: 1_000, sleep: clock.sleep, random: () => 0 },
    });

    const replaced: number[][][] = [];
    const vectors = await embedThenReplace(chunks, embedder, async (v) => void replaced.push(v));

    assert.equal(vectors.length, 119);
    assert.equal(replaced.length, 1);
    assert.equal(replaced[0]!.length, 119);
    assert.ok(clock.sleeps.includes(30_000), 'the 429 retry waited for the server-provided retryDelay');

    // Every attempt (including the throttled one) counts against the quota.
    for (const { at } of requestLog) {
      const inWindow = requestLog.filter((entry) => entry.at > at - 60_000 && entry.at <= at).reduce((sum, entry) => sum + entry.units, 0);
      assert.ok(inWindow <= 90, `sent ${inWindow} embedding requests in the minute ending at ${at}ms`);
    }
  });

  it('does not touch the database when embeddings keep failing', async () => {
    const clock = createVirtualClock();
    let calls = 0;
    const client = {
      embedContent: async (params: { contents: unknown[] }) => {
        calls++;
        if (calls >= 6) throw quotaError(); // last batch never succeeds
        return embedResponse(params.contents.length);
      },
    } as unknown as EmbedContentClient;
    const embedder = createGeminiEmbedder(client, 'm', { batchSize: 20, retry: { retries: 2, baseDelayMs: 10, sleep: clock.sleep, random: () => 0 } });

    let replaceCalls = 0;
    await assert.rejects(
      embedThenReplace(chunks, embedder, async () => {
        replaceCalls++;
      }),
      (error: ApiError) => error.status === 429,
    );
    assert.equal(replaceCalls, 0);
    assert.equal(calls, 5 + 3, 'five good batches, then the failing batch tried 1 + 2 retries');
  });

  it('does not retry permanent API errors', async () => {
    let calls = 0;
    const client = {
      embedContent: async () => {
        calls++;
        throw new ApiError({ status: 400, message: '{"error":{"code":400,"message":"API key not valid"}}' });
      },
    } as unknown as EmbedContentClient;
    const embedder = createGeminiEmbedder(client, 'm', { retry: { retries: 5, baseDelayMs: 1, sleep: async () => undefined } });
    let replaceCalls = 0;
    await assert.rejects(embedThenReplace(chunks.slice(0, 3), embedder, async () => void replaceCalls++), /API key not valid/);
    assert.equal(calls, 1);
    assert.equal(replaceCalls, 0);
  });
});
