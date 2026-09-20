import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApiClient } from '../src/api/client.ts';
import { ApiError, isRetryable, isQuotaDetails, toUserFacingError } from '../src/api/errors.ts';
import { createFrameParser } from '../src/api/stream.ts';
import type { SendMessageResponse, StreamHandlers } from '../src/api/types.ts';

const conversation = { id: 'c1', title: 'What does QOBO do?', createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z' };

const savedExchange = {
  conversation,
  userMessage: { id: 'm1', role: 'user', content: 'What does QOBO do?', intent: null, status: null, sources: [], createdAt: conversation.createdAt },
  assistantMessage: {
    id: 'm2',
    role: 'assistant',
    content: 'QOBO builds websites through WhatsApp [1].',
    intent: 'qobo',
    status: 'answered',
    sources: [{ title: 'QOBO Home', url: 'https://qobo.dev/', kind: 'qobo' }],
    createdAt: conversation.createdAt,
  },
  replayed: false,
} as unknown as SendMessageResponse;

const payload = { message: 'What does QOBO do?', clientMessageId: '11111111-1111-4111-8111-111111111111', conversationId: null };

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** An event-stream Response whose body arrives in the given pieces. */
function sse(pieces: string[], { status = 200, headers = {} as Record<string, string> } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Request-Id': 'req-1', ...headers } });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  url: string;
  init: RequestInit;
}

function harness(responses: Array<Response | Error>, token: string | null = 'access-token') {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch call');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;

  const client = createApiClient({ baseUrl: 'https://api.example.com/', getAccessToken: async () => token, fetchImpl, timeoutMs: 5_000 });
  return { client, calls };
}

/** Collects what a consumer would show, including the discards a reset causes. */
function collector() {
  const deltas: string[] = [];
  let resets = 0;
  const handlers: StreamHandlers = {
    onDelta: (text) => void deltas.push(text),
    onReset: () => {
      resets += 1;
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

describe('SSE frame parser', () => {
  it('reads frames however the chunks fall', () => {
    const stream = frame('delta', { text: 'QOBO builds ' }) + frame('delta', { text: 'websites.' }) + frame('done', savedExchange);

    for (const size of [1, 3, 17, 64, stream.length]) {
      const parser = createFrameParser();
      const events: string[] = [];
      for (let at = 0; at < stream.length; at += size) {
        for (const parsed of parser.push(stream.slice(at, at + size))) events.push(parsed.event);
      }
      assert.deepEqual(events, ['delta', 'delta', 'done'], `chunk size ${size}`);
    }
  });

  it('ignores keep-alive comments and unknown events', () => {
    const parser = createFrameParser();
    const frames = parser.push(`: keep-alive\n\n${frame('delta', { text: 'hi' })}: keep-alive\n\n${frame('something-new', { x: 1 })}${frame('done', savedExchange)}`);

    assert.deepEqual(
      frames.map((f) => f.event),
      ['delta', 'done'],
      'an event this version does not know does not break the stream',
    );
  });

  it('holds an incomplete frame until its terminator arrives', () => {
    const parser = createFrameParser();
    assert.deepEqual(parser.push('event: delta\ndata: {"text":"par'), []);
    assert.deepEqual(parser.push('tial"}'), [], 'still no blank line');
    assert.deepEqual(parser.push('\n\n'), [{ event: 'delta', data: { text: 'partial' } }]);
  });

  it('accepts CRLF line endings', () => {
    const parser = createFrameParser();
    assert.deepEqual(parser.push('event: delta\r\ndata: {"text":"hi"}\r\n\r\n'), [{ event: 'delta', data: { text: 'hi' } }]);
  });
});

describe('streamMessage', () => {
  it('posts to the streaming endpoint with the token and asks for an event stream', async () => {
    const { client, calls } = harness([sse([frame('done', savedExchange)])]);
    await client.streamMessage(payload, collector().handlers);

    assert.equal(calls[0]!.url, 'https://api.example.com/api/chat/stream');
    assert.equal(calls[0]!.init.method, 'POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer access-token');
    assert.equal(headers.Accept, 'text/event-stream');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(calls[0]!.init.credentials, 'omit');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), payload);
  });

  it('reports the answer as it arrives and resolves with the saved exchange', async () => {
    const { client } = harness([sse([frame('delta', { text: 'QOBO builds ' }), frame('delta', { text: 'websites.' }), frame('done', savedExchange)])]);
    const seen = collector();

    const result = await client.streamMessage(payload, seen.handlers);

    assert.deepEqual(seen.deltas, ['QOBO builds ', 'websites.']);
    assert.equal(seen.resets, 0);
    assert.deepEqual(result, savedExchange, 'the resolved value is what the non-streaming endpoint returns');
  });

  it('drops what it showed when the reply is written again', async () => {
    const { client } = harness([sse([frame('delta', { text: 'half an ans' }), frame('reset', {}), frame('delta', { text: 'QOBO builds websites.' }), frame('done', savedExchange)])]);
    const seen = collector();

    await client.streamMessage(payload, seen.handlers);

    assert.equal(seen.resets, 1);
    assert.equal(seen.text, 'QOBO builds websites.', 'only what survived the reset is left');
  });

  it('resolves a reply that never streamed, without pretending it did', async () => {
    // A replay, off-topic or small talk: the answer exists already.
    const { client } = harness([sse([frame('done', { ...savedExchange, replayed: true })])]);
    const seen = collector();

    const result = await client.streamMessage(payload, seen.handlers);

    assert.deepEqual(seen.deltas, []);
    assert.equal(result.replayed, true);
  });

  it('turns an error frame into the same ApiError a failed request gives', async () => {
    const { client } = harness([
      sse([frame('delta', { text: 'Starting to answ' }), frame('error', { code: 'service_unavailable', message: 'The assistant is temporarily unavailable. Please try again in a moment.' })]),
    ]);
    const seen = collector();

    await assert.rejects(client.streamMessage(payload, seen.handlers), (error: ApiError) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'service_unavailable');
      assert.equal(error.requestId, 'req-1');
      assert.equal(isRetryable(error), true);
      assert.deepEqual(toUserFacingError(error), { title: 'QOBO is busy right now', detail: 'Wait a few seconds and try again.', canRetry: true });
      return true;
    });
    assert.deepEqual(seen.deltas, ['Starting to answ'], 'what arrived before the failure is still reported');
  });

  it('keeps quota details from an error frame so the limit copy still works', async () => {
    const details = { limit: 50, used: 50, resetsAt: '2026-09-21T00:00:00.000Z' };
    const { client } = harness([sse([frame('error', { code: 'quota_exceeded', message: "You've reached today's limit of 50 messages.", details })])]);

    await assert.rejects(client.streamMessage(payload, collector().handlers), (error: ApiError) => {
      assert.equal(error.code, 'quota_exceeded');
      assert.ok(isQuotaDetails(error.details));
      assert.match(toUserFacingError(error).detail, /all 50 messages/);
      return true;
    });
  });

  it('falls back to internal_error for a code this client does not know', async () => {
    const { client } = harness([sse([frame('error', { code: 'teapot', message: 'unknown to this client' })])]);
    await assert.rejects(client.streamMessage(payload, collector().handlers), (error: ApiError) => error.code === 'internal_error');
  });

  it('maps a failure that lands before the stream opens exactly as sendMessage does', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'unauthorized', 'Missing or malformed Authorization header'],
      [429, 'quota_exceeded', "You've reached today's limit of 50 messages."],
      [404, 'not_found', 'Conversation not found'],
      [400, 'bad_request', 'Invalid chat request'],
    ];

    for (const [status, code, message] of cases) {
      const { client } = harness([json(status, { error: { code, message } })]);
      await assert.rejects(client.streamMessage(payload, collector().handlers), (error: ApiError) => {
        assert.equal(error.status, status, code);
        assert.equal(error.code, code);
        assert.equal(error.message, message);
        return true;
      });
    }
  });

  it('falls back to the status when the pre-stream error body is unreadable', async () => {
    const { client } = harness([new Response('<html>502</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })]);
    await assert.rejects(client.streamMessage(payload, collector().handlers), (error: ApiError) => error.code === 'internal_error' && error.status === 502);
  });

  it('rejects a 200 that is not an event stream', async () => {
    const { client } = harness([json(200, savedExchange)]);
    await assert.rejects(
      client.streamMessage(payload, collector().handlers),
      (error: ApiError) => error.code === 'internal_error' && error.message === 'The API returned an unreadable response',
    );
  });

  it('reports a stream that ends without a verdict as a lost connection', async () => {
    const { client } = harness([sse([frame('delta', { text: 'QOBO builds ' })])]);
    const seen = collector();

    await assert.rejects(client.streamMessage(payload, seen.handlers), (error: ApiError) => {
      assert.equal(error.code, 'network');
      assert.equal(isRetryable(error), true);
      assert.match(error.message, /closed before QOBO finished/);
      return true;
    });
    assert.deepEqual(seen.deltas, ['QOBO builds ']);
  });

  it('reports an unreadable frame rather than passing it on', async () => {
    const { client } = harness([sse(['event: delta\ndata: {not json}\n\n'])]);
    await assert.rejects(
      client.streamMessage(payload, collector().handlers),
      (error: ApiError) => error.code === 'internal_error' && error.message === 'The API returned an unreadable response',
    );
  });

  it('reports a connection that never opened as a network error', async () => {
    const { client } = harness([new TypeError('fetch failed')]);
    await assert.rejects(client.streamMessage(payload, collector().handlers), (error: ApiError) => error.code === 'network' && error.status === 0);
  });

  it('rethrows a caller-triggered abort untouched (Stop button)', async () => {
    const controller = new AbortController();
    const abort = Object.assign(new DOMException('This operation was aborted', 'AbortError'));
    const { client } = harness([abort]);
    controller.abort();

    await assert.rejects(client.streamMessage(payload, collector().handlers, { signal: controller.signal }), (error: unknown) => {
      assert.ok(!(error instanceof ApiError), 'Stop is the person own decision, not a failure to explain');
      assert.equal((error as DOMException).name, 'AbortError');
      return true;
    });
  });

  it('fails without a network call when signed out', async () => {
    const { client, calls } = harness([], null);
    await assert.rejects(client.streamMessage(payload, collector().handlers), (error: ApiError) => error.code === 'unauthorized');
    assert.equal(calls.length, 0);
  });
});
