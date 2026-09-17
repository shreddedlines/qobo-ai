import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError, ThinkingLevel } from '@google/genai';

import { checkAnswer, type EvalCase } from '../../scripts/eval/lib/checks.ts';
import { googleRetryDelayMs } from '../../src/lib/google-api-errors.ts';
import { createSlidingWindowLimiter, RateLimitExceededError } from '../../src/lib/rate-limiter.ts';
import { withRetry } from '../../src/lib/retry.ts';
import { createGeminiEmbedder, EMBEDDING_DIM, type EmbedContentClient } from '../../src/rag/embeddings.ts';
import { createGeminiAnswerGenerator, InvalidModelOutputError, type GenerateContentClient } from '../../src/rag/generator.ts';
import { checkKnowledgeBase } from '../../src/rag/kb-compat.ts';
import { ANSWER_RESPONSE_SCHEMA } from '../../src/rag/prompts.ts';
import { createSupabaseKbRetriever, RetrievalError } from '../../src/rag/retriever.ts';
import { createVirtualClock } from '../helpers/virtual-clock.ts';

type GenerateParams = Parameters<GenerateContentClient['generateContent']>[0];

function quotaError(retryDelay: string): ApiError {
  return new ApiError({
    status: 429,
    message: JSON.stringify({ error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] } }),
  });
}

function generatorClient(responses: Array<unknown | Error>) {
  const calls: GenerateParams[] = [];
  const client = {
    generateContent: async (params: GenerateParams) => {
      calls.push(params);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as GenerateContentClient;
  return { client, calls };
}

const noSleep = { sleep: async () => undefined, random: () => 0 };

describe('Gemini answer generator', () => {
  it('requests schema-constrained JSON with the system instruction and low thinking', async () => {
    const { client, calls } = generatorClient([{ text: '{"status":"answered","answer":"Hi [S1]","citations":["S1"]}' }]);
    const draft = await createGeminiAnswerGenerator(client, 'gemini-3.7-flash').generate({ systemInstruction: 'rules', prompt: 'prompt' });
    assert.deepEqual(draft, { status: 'answered', answer: 'Hi [S1]', citations: ['S1'], model: 'gemini-3.7-flash' });

    const { model, contents, config } = calls[0]!;
    assert.equal(model, 'gemini-3.7-flash');
    assert.deepEqual(contents, [{ role: 'user', parts: [{ text: 'prompt' }] }]);
    assert.equal(config?.systemInstruction, 'rules');
    assert.equal(config?.responseMimeType, 'application/json');
    assert.equal(config?.responseJsonSchema, ANSWER_RESPONSE_SCHEMA);
    assert.equal(config?.thinkingConfig?.thinkingLevel, ThinkingLevel.LOW);
    assert.ok(config?.abortSignal instanceof AbortSignal);
  });

  it('retries a short 429 using the server delay', async () => {
    const { client, calls } = generatorClient([quotaError('2s'), { text: '{"status":"insufficient","answer":"","citations":[]}' }]);
    const sleeps: number[] = [];
    const generator = createGeminiAnswerGenerator(client, 'm', {
      retry: { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000, giveUpIfServerDelayExceedsMs: 8_000, sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
    });
    const draft = await generator.generate({ systemInstruction: 's', prompt: 'p' });
    assert.equal(draft.status, 'insufficient');
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [2_000]);
  });

  it('fails fast when the server asks for a delay too long for a chat request', async () => {
    const { client, calls } = generatorClient([quotaError('45s'), { text: '{}' }]);
    const generator = createGeminiAnswerGenerator(client, 'm', { retry: { retries: 2, baseDelayMs: 500, giveUpIfServerDelayExceedsMs: 8_000, ...noSleep } });
    await assert.rejects(generator.generate({ systemInstruction: 's', prompt: 'p' }), (error: ApiError) => error.status === 429);
    assert.equal(calls.length, 1);
  });

  it('switches to the fallback model when the primary is overloaded or times out', async () => {
    const overloaded = new ApiError({ status: 503, message: '{"error":{"code":503,"status":"UNAVAILABLE"}}' });
    const timedOut = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    for (const primaryError of [overloaded, timedOut, quotaError('45s')]) {
      const { client, calls } = generatorClient([primaryError, { text: '{"status":"answered","answer":"Hi [S1]","citations":["S1"]}' }]);
      const fallbacks: unknown[] = [];
      const draft = await createGeminiAnswerGenerator(client, 'gemini-3.7-flash', {
        fallbackModel: 'gemini-3.5-flash-lite',
        retry: { retries: 2, baseDelayMs: 1, giveUpIfServerDelayExceedsMs: 8_000, ...noSleep },
        onFallback: (error) => fallbacks.push(error),
      }).generate({ systemInstruction: 's', prompt: 'p' });

      assert.deepEqual(
        calls.map((c) => c.model),
        ['gemini-3.7-flash', 'gemini-3.5-flash-lite'],
        'the overloaded primary is not retried',
      );
      assert.equal(draft.model, 'gemini-3.5-flash-lite');
      assert.deepEqual(fallbacks, [primaryError]);
    }
  });

  it('skips an unavailable primary during the cooldown, then tries it again', async () => {
    const overloaded = new ApiError({ status: 503, message: '{"error":{"code":503}}' });
    const ok = (answer: string) => ({ text: JSON.stringify({ status: 'answered', answer, citations: [] }) });
    const { client, calls } = generatorClient([overloaded, ok('1'), ok('2'), ok('3')]);
    let clock = 0;
    const generator = createGeminiAnswerGenerator(client, 'primary', {
      fallbackModel: 'fallback',
      primaryCooldownMs: 120_000,
      now: () => clock,
      retry: { retries: 1, baseDelayMs: 1, ...noSleep },
    });
    const input = { systemInstruction: 's', prompt: 'p' };

    assert.equal((await generator.generate(input)).model, 'fallback'); // primary fails → fallback
    clock = 60_000;
    assert.equal((await generator.generate(input)).model, 'fallback'); // within cooldown: primary skipped
    clock = 121_000;
    assert.equal((await generator.generate(input)).model, 'primary'); // cooldown over: primary retried
    assert.deepEqual(
      calls.map((c) => c.model),
      ['primary', 'fallback', 'fallback', 'primary'],
    );
  });

  it('does not fall back on request errors or malformed output', async () => {
    const badRequest = new ApiError({ status: 400, message: '{"error":{"code":400,"message":"Thinking level MINIMAL is not supported"}}' });
    for (const [response, expected] of [
      [badRequest, (error: ApiError) => error.status === 400],
      [{ text: 'not json' }, (error: Error) => error instanceof InvalidModelOutputError],
    ] as const) {
      const { client, calls } = generatorClient([response, { text: '{"status":"answered","answer":"x","citations":[]}' }]);
      await assert.rejects(
        createGeminiAnswerGenerator(client, 'primary', { fallbackModel: 'fallback', retry: { retries: 2, baseDelayMs: 1, ...noSleep } }).generate({ systemInstruction: 's', prompt: 'p' }),
        expected as (error: unknown) => boolean,
      );
      assert.equal(calls.length, 1);
    }
  });

  it('rejects empty, non-JSON and schema-violating output as invalid (without retrying)', async () => {
    for (const response of [{ text: undefined, candidates: [{ finishReason: 'SAFETY' }] }, { text: 'Sure! Here you go' }, { text: '{"status":"maybe","answer":"x"}' }]) {
      const { client, calls } = generatorClient([response]);
      await assert.rejects(createGeminiAnswerGenerator(client, 'm', { retry: { retries: 2, baseDelayMs: 1, ...noSleep } }).generate({ systemInstruction: 's', prompt: 'p' }), InvalidModelOutputError);
      assert.equal(calls.length, 1);
    }
  });
});

describe('Supabase KB retriever', () => {
  const embedClient = {
    embedContent: async () => ({ embeddings: [{ values: Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === 0 ? 1 : 0)) }] }),
  } as unknown as EmbedContentClient;

  it('embeds the question and maps match_kb_chunks rows', async () => {
    const rpcCalls: Array<[string, Record<string, unknown>]> = [];
    const service = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push([fn, args]);
        return { data: [{ id: '7', url: 'https://qobo.dev/plans', title: 'Plans & Pricing', section: null, page_type: 'pricing', content: 'Starter ₹499', topics: null, similarity: '0.81' }], error: null };
      },
    };
    const retriever = createSupabaseKbRetriever({ service: service as never, embedder: createGeminiEmbedder(embedClient, 'gemini-embedding-2'), matchCount: 6, minSimilarity: 0.6 });
    const chunks = await retriever.retrieve('How much?');

    assert.equal(rpcCalls[0]![0], 'match_kb_chunks');
    assert.equal((rpcCalls[0]![1].p_query_embedding as number[]).length, EMBEDDING_DIM);
    assert.equal(rpcCalls[0]![1].p_match_count, 6);
    assert.equal(rpcCalls[0]![1].p_min_similarity, 0.6);
    assert.deepEqual(chunks, [{ id: 7, url: 'https://qobo.dev/plans', title: 'Plans & Pricing', section: null, pageType: 'pricing', content: 'Starter ₹499', topics: [], similarity: 0.81 }]);
  });

  it('wraps database errors', async () => {
    const service = { rpc: async () => ({ data: null, error: { message: 'permission denied' } }) };
    const retriever = createSupabaseKbRetriever({ service: service as never, embedder: createGeminiEmbedder(embedClient, 'm'), matchCount: 6, minSimilarity: 0.6 });
    await assert.rejects(retriever.retrieve('q'), RetrievalError);
  });
});

describe('chat-time embeddings share the rate limiter and fail fast', () => {
  it('rejects instead of queueing a chat request for most of a minute', async () => {
    const clock = createVirtualClock();
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 60_000, maxWaitMs: 5_000, now: clock.now, sleep: clock.sleep });
    await limiter.acquire();
    await limiter.acquire();
    await assert.rejects(limiter.acquire(), (error: RateLimitExceededError) => error instanceof RateLimitExceededError && error.retryAfterMs === 60_000);
    assert.deepEqual(clock.sleeps, []);
  });

  it('still waits when capacity frees up within maxWaitMs', async () => {
    const clock = createVirtualClock();
    const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 3_000, maxWaitMs: 5_000, now: clock.now, sleep: clock.sleep });
    await limiter.acquire();
    await limiter.acquire();
    assert.deepEqual(clock.sleeps, [3_000]);
  });

  it('counts each embedding attempt against the shared limiter', async () => {
    const clock = createVirtualClock();
    const limiter = createSlidingWindowLimiter({ limit: 90, windowMs: 60_000, now: clock.now, sleep: clock.sleep });
    let calls = 0;
    const client = {
      embedContent: async () => {
        calls++;
        if (calls === 1) throw quotaError('1s');
        return { embeddings: [{ values: Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === 0 ? 1 : 0)) }] };
      },
    } as unknown as EmbedContentClient;
    const acquired: number[] = [];
    const countingLimiter = { acquire: async (units?: number) => (acquired.push(units ?? 1), limiter.acquire(units)) };
    const embedder = createGeminiEmbedder(client, 'm', { batchSize: 1, rateLimiter: countingLimiter, retry: { retries: 2, baseDelayMs: 100, sleep: clock.sleep, random: () => 0 } });
    await embedder.embedQuery('question');
    assert.deepEqual(acquired, [1, 1]);
    assert.deepEqual(clock.sleeps, [1_000]);
  });

  it('withRetry gives up on long server delays only when configured', async () => {
    let attempts = 0;
    const fail = async () => {
      attempts++;
      throw quotaError('30s');
    };
    await assert.rejects(withRetry(fail, { retries: 3, baseDelayMs: 1, serverDelayMs: googleRetryDelayMs, giveUpIfServerDelayExceedsMs: 8_000, ...noSleep }));
    assert.equal(attempts, 1);
    attempts = 0;
    await assert.rejects(withRetry(fail, { retries: 1, baseDelayMs: 1, serverDelayMs: googleRetryDelayMs, ...noSleep }));
    assert.equal(attempts, 2);
  });
});

describe('knowledge base compatibility check', () => {
  const rpcReturning = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data, error }) }) as never;

  it('reports ok, empty, mismatch and unavailable', async () => {
    const row = { embedding_model: 'gemini-embedding-2', embedding_dim: 768, chunk_count: 119, snapshot_ref: 'sha256:abc' };
    assert.deepEqual(await checkKnowledgeBase(rpcReturning([row]), 'gemini-embedding-2'), { status: 'ok', chunkCount: 119, snapshotRef: 'sha256:abc' });
    assert.deepEqual(await checkKnowledgeBase(rpcReturning([]), 'gemini-embedding-2'), { status: 'empty' });
    assert.equal((await checkKnowledgeBase(rpcReturning([row]), 'gemini-embedding-001')).status, 'mismatch');
    assert.equal((await checkKnowledgeBase(rpcReturning([{ ...row, embedding_dim: 3072 }]), 'gemini-embedding-2')).status, 'mismatch');
    assert.equal((await checkKnowledgeBase(rpcReturning(null, { message: 'network' }), 'gemini-embedding-2')).status, 'unavailable');
  });
});

describe('eval checks', () => {
  const testCase: EvalCase = {
    id: 'pricing-cost',
    tags: ['pricing'],
    question: 'How much?',
    history: [],
    expect: { status: 'answered', citesAny: ['https://qobo.dev/plans'], containsAll: ['₹499'], containsAny: ['confirm'], notContains: ['₹4,999'] },
  };

  it('passes a compliant answer and explains each failure', () => {
    assert.deepEqual(checkAnswer(testCase, { status: 'answered', content: 'From ₹499; please CONFIRM with our team.', sources: [{ url: 'https://qobo.dev/plans' }] }), []);
    assert.deepEqual(checkAnswer(testCase, { status: 'insufficient', content: 'Bridal prep ₹4,999', sources: [] }), [
      'status is "insufficient", expected "answered"',
      'cites none of https://qobo.dev/plans',
      'missing "₹499"',
      'contains none of "confirm"',
      'must not contain "₹4,999"',
    ]);
  });
});
