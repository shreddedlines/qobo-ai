import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError, ThinkingLevel } from '@google/genai';
import { z } from 'zod';

import { createGeminiJsonGenerator, InvalidModelOutputError, type GenerateContentClient, type StreamHandlers } from '../../src/rag/generator.ts';
import { createJsonStringFieldExtractor } from '../../src/rag/json-stream.ts';
import { ANSWER_RESPONSE_SCHEMA } from '../../src/rag/prompts.ts';

type GenerateParams = Parameters<GenerateContentClient['generateContentStream']>[0];

const draftSchema = z.object({
  status: z.enum(['answered', 'insufficient']),
  answer: z.string(),
  citations: z.array(z.string()).default([]),
});

const input = { systemInstruction: 'rules', prompt: 'prompt', responseJsonSchema: ANSWER_RESPONSE_SCHEMA, schema: draftSchema };
const noSleep = { sleep: async () => undefined, random: () => 0 };

/** Splits a document the way a stream would: into pieces that ignore JSON structure. */
function pieces(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
  return parts;
}

const textChunks = (text: string, size = 7) => pieces(text, size).map((part) => ({ text: part }));

function quotaError(retryDelay: string): ApiError {
  return new ApiError({
    status: 429,
    message: JSON.stringify({ error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] } }),
  });
}

/**
 * Each entry is one call: an Error thrown before the stream opens, or the chunks it
 * yields (an Error among them is thrown mid-stream, after the earlier chunks arrived).
 */
function streamingClient(responses: Array<unknown[] | Error>) {
  const calls: GenerateParams[] = [];
  const client = {
    generateContentStream: async (params: GenerateParams) => {
      calls.push(params);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      const chunks = next ?? [];
      return (async function* () {
        for (const chunk of chunks) {
          if (chunk instanceof Error) throw chunk;
          yield chunk;
        }
      })();
    },
  } as unknown as GenerateContentClient;
  return { client, calls };
}

/** Collects what a consumer would show, including the discards a failed attempt causes. */
function collector() {
  const deltas: string[] = [];
  let resets = 0;
  const handlers: StreamHandlers = {
    onDelta: (delta) => void deltas.push(delta),
    onReset: () => {
      resets++;
      deltas.length = 0;
    },
  };
  return {
    handlers,
    deltas,
    get resets() {
      return resets;
    },
    get text() {
      return deltas.join('');
    },
  };
}

describe('incremental answer extraction', () => {
  const answer = 'Starter is ₹499 [S1].\n\nIt is "one-time" per the plans page — 50% off, café style.';
  const document = JSON.stringify({ status: 'answered', answer, citations: ['S1'] });

  it('decodes the field whatever the chunk boundaries are', () => {
    for (const size of [1, 2, 3, 5, 13, document.length]) {
      const extractor = createJsonStringFieldExtractor('answer');
      const out = pieces(document, size)
        .map((part) => extractor.push(part))
        .join('');
      assert.equal(out, answer, `chunk size ${size}`);
      assert.equal(extractor.done, true);
    }
  });

  it('returns the field only — never JSON syntax, other fields or a key that looks like one', () => {
    const tricky = JSON.stringify({
      status: 'answered',
      note: 'the "answer" is not here, and neither is {"answer":"decoy"}',
      answer: 'the real one',
      citations: ['answer', 'S1'],
    });
    const extractor = createJsonStringFieldExtractor('answer');
    const out = pieces(tricky, 4)
      .map((part) => extractor.push(part))
      .join('');
    assert.equal(out, 'the real one');
  });

  it('holds back an incomplete escape rather than leaking a backslash', () => {
    const extractor = createJsonStringFieldExtractor('answer');
    assert.equal(extractor.push('{"answer":"a'), 'a');
    assert.equal(extractor.push('\\'), '', 'a lone backslash is not text');
    assert.equal(extractor.push('n'), '\n');
    assert.equal(extractor.push('\\u00e'), '', 'an unfinished \\u escape waits for its last digit');
    assert.equal(extractor.push('9"}'), 'é');
    assert.equal(extractor.done, true);
  });

  it('never ends a delta on half a character', () => {
    const extractor = createJsonStringFieldExtractor('answer');
    // "🎉" is a surrogate pair: the halves arrive in different chunks.
    assert.equal(extractor.push('{"answer":"\\ud83c'), '');
    assert.equal(extractor.push('\\udf89 done"}'), '🎉 done');
  });

  it('ignores anything after the field is closed', () => {
    const extractor = createJsonStringFieldExtractor('answer');
    extractor.push('{"answer":"done",');
    assert.equal(extractor.done, true);
    assert.equal(extractor.push('"citations":["S1"],"other":"ignored"}'), '');
  });
});

describe('createGeminiJsonGenerator().generateStream', () => {
  const document = JSON.stringify({ status: 'answered', answer: 'Pro is ₹999 [S2].', citations: ['S2'] });

  it('streams the answer as it arrives and resolves the same value generate() would', async () => {
    const { client, calls } = streamingClient([textChunks(document, 6)]);
    const seen = collector();
    const result = await createGeminiJsonGenerator(client, 'gemini-3.7-flash').generateStream(input, seen.handlers);

    assert.deepEqual(result, { value: { status: 'answered', answer: 'Pro is ₹999 [S2].', citations: ['S2'] }, model: 'gemini-3.7-flash' });
    assert.equal(seen.text, 'Pro is ₹999 [S2].', 'the deltas add up to the answer');
    assert.ok(seen.deltas.length > 1, 'the answer arrived in pieces rather than all at once');
    assert.equal(seen.resets, 0);

    const { model, contents, config } = calls[0]!;
    assert.equal(model, 'gemini-3.7-flash');
    assert.deepEqual(contents, [{ role: 'user', parts: [{ text: 'prompt' }] }]);
    assert.equal(config?.systemInstruction, 'rules');
    assert.equal(config?.responseMimeType, 'application/json');
    assert.equal(config?.responseJsonSchema, ANSWER_RESPONSE_SCHEMA);
    assert.equal(config?.thinkingConfig?.thinkingLevel, ThinkingLevel.LOW);
    assert.ok(config?.abortSignal instanceof AbortSignal);
  });

  it('hands over answer text only, never raw chunks', async () => {
    const { client } = streamingClient([textChunks(document, 3)]);
    const seen = collector();
    await createGeminiJsonGenerator(client, 'm').generateStream(input, seen.handlers);

    for (const delta of seen.deltas) {
      for (const leak of ['{', '}', '"', 'status', 'citations', 'answered']) {
        assert.ok(!delta.includes(leak), `delta ${JSON.stringify(delta)} leaked ${leak}`);
      }
    }
  });

  it('accepts a plain callback as well as handlers', async () => {
    const { client } = streamingClient([textChunks(document, 5)]);
    const deltas: string[] = [];
    const result = await createGeminiJsonGenerator(client, 'm').generateStream(input, (delta) => void deltas.push(delta));
    assert.equal(deltas.join(''), 'Pro is ₹999 [S2].');
    assert.equal(result.value.status, 'answered');
  });

  it('rejects an incomplete, malformed or schema-violating stream without retrying', async () => {
    const cases: Array<[string, unknown[]]> = [
      ['cut off mid-document', textChunks(document.slice(0, 24), 6)],
      ['never JSON at all', [{ text: 'Sure! Here you go' }]],
      ['valid JSON, wrong shape', [{ text: '{"status":"maybe","answer":"x"}' }]],
      ['no text at all', [{ candidates: [{ finishReason: 'SAFETY' }] }]],
      ['nothing streamed', []],
    ];

    for (const [name, chunks] of cases) {
      const { client, calls } = streamingClient([chunks]);
      const seen = collector();
      await assert.rejects(
        createGeminiJsonGenerator(client, 'm', { retry: { retries: 2, baseDelayMs: 1, ...noSleep } }).generateStream(input, seen.handlers),
        InvalidModelOutputError,
        name,
      );
      assert.equal(calls.length, 1, `${name}: malformed output is not retried`);
    }
  });

  it('reports the finish reason when the model streams no text', async () => {
    const { client } = streamingClient([[{ candidates: [{ finishReason: 'SAFETY' }] }]]);
    await assert.rejects(createGeminiJsonGenerator(client, 'm').generateStream(input, collector().handlers), (error: Error) => {
      assert.ok(error instanceof InvalidModelOutputError);
      assert.match(error.message, /SAFETY/);
      return true;
    });
  });

  it('keeps the partial answer of a cut-off stream out of the resolved value', async () => {
    const { client } = streamingClient([textChunks(document.slice(0, 40), 6)]);
    const seen = collector();
    await assert.rejects(createGeminiJsonGenerator(client, 'm', { retry: { retries: 0, baseDelayMs: 1, ...noSleep } }).generateStream(input, seen.handlers), InvalidModelOutputError);
    assert.ok(seen.text.length > 0, 'text had already been handed over when the stream died');
  });

  it('retries a mid-stream 429 and tells the consumer to discard the half-written answer', async () => {
    const { client, calls } = streamingClient([[...textChunks('{"status":"answered","answer":"half', 8), quotaError('2s')], textChunks(document, 8)]);
    const seen = collector();
    const sleeps: number[] = [];
    const result = await createGeminiJsonGenerator(client, 'm', {
      retry: { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000, giveUpIfServerDelayExceedsMs: 8_000, sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
    }).generateStream(input, seen.handlers);

    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [2_000]);
    assert.equal(seen.resets, 1, 'the failed attempt is retracted before the next one starts');
    assert.equal(seen.text, 'Pro is ₹999 [S2].', 'only the successful attempt is left');
    assert.equal(result.value.answer, 'Pro is ₹999 [S2].');
  });

  it('switches to the fallback model when the primary fails, before or during the stream', async () => {
    const overloaded = new ApiError({ status: 503, message: '{"error":{"code":503,"status":"UNAVAILABLE"}}' });
    const timedOut = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

    for (const [name, primary, expectedResets] of [
      ['before any text', overloaded as unknown, 0],
      ['mid-stream', [...textChunks('{"status":"answered","answer":"partial', 9), timedOut], 1],
    ] as const) {
      const { client, calls } = streamingClient([primary as unknown[] | Error, textChunks(document, 9)]);
      const seen = collector();
      const fallbacks: unknown[] = [];
      const result = await createGeminiJsonGenerator(client, 'primary', {
        fallbackModel: 'fallback',
        retry: { retries: 2, baseDelayMs: 1, giveUpIfServerDelayExceedsMs: 8_000, ...noSleep },
        onFallback: (error) => fallbacks.push(error),
      }).generateStream(input, seen.handlers);

      assert.deepEqual(
        calls.map((call) => call.model),
        ['primary', 'fallback'],
        `${name}: the failing primary is not retried`,
      );
      assert.equal(result.model, 'fallback', name);
      assert.equal(fallbacks.length, 1, name);
      assert.equal(seen.resets, expectedResets, name);
      assert.equal(seen.text, 'Pro is ₹999 [S2].', `${name}: the consumer is left with the fallback's answer only`);
    }
  });

  it('does not fall back on a request error or on malformed output', async () => {
    const badRequest = new ApiError({ status: 400, message: '{"error":{"code":400,"message":"bad request"}}' });
    for (const [response, expected] of [
      [badRequest, (error: ApiError) => error.status === 400],
      [[{ text: 'not json' }], (error: Error) => error instanceof InvalidModelOutputError],
    ] as const) {
      const { client, calls } = streamingClient([response as unknown[] | Error, textChunks(document)]);
      await assert.rejects(
        createGeminiJsonGenerator(client, 'primary', { fallbackModel: 'fallback', retry: { retries: 2, baseDelayMs: 1, ...noSleep } }).generateStream(input, collector().handlers),
        expected as (error: unknown) => boolean,
      );
      assert.equal(calls.length, 1);
    }
  });

  it('shares the primary cooldown with generate(), so one failure spares every call style', async () => {
    const overloaded = new ApiError({ status: 503, message: '{"error":{"code":503}}' });
    const client = {
      generateContentStream: async (params: GenerateParams) => {
        streamModels.push(params.model);
        const next = streamResponses.shift();
        if (next instanceof Error) throw next;
        return (async function* () {
          yield* (next ?? []) as object[];
        })();
      },
      generateContent: async (params: GenerateParams) => {
        plainModels.push(params.model);
        return { text: document };
      },
    } as unknown as GenerateContentClient;
    const streamModels: string[] = [];
    const plainModels: string[] = [];
    const streamResponses: Array<unknown[] | Error> = [overloaded, textChunks(document)];

    let clock = 0;
    const generator = createGeminiJsonGenerator(client, 'primary', {
      fallbackModel: 'fallback',
      primaryCooldownMs: 120_000,
      now: () => clock,
      retry: { retries: 1, baseDelayMs: 1, ...noSleep },
    });

    assert.equal((await generator.generateStream(input, collector().handlers)).model, 'fallback');
    assert.deepEqual(streamModels, ['primary', 'fallback']);

    clock = 60_000;
    assert.equal((await generator.generate(input)).model, 'fallback', 'generate() honours the cooldown the stream opened');
    assert.deepEqual(plainModels, ['fallback']);

    clock = 121_000;
    assert.equal((await generator.generate(input)).model, 'primary', 'and tries the primary again once it is over');
    assert.deepEqual(plainModels, ['fallback', 'primary']);
  });
});
