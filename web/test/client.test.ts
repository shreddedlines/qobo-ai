import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApiClient } from '../src/api/client.ts';
import { ApiError } from '../src/api/errors.ts';

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

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const conversation = { id: 'c1', title: 'Pricing', createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-18T10:00:00.000Z' };

describe('API client requests', () => {
  it('sends the bearer token and normalizes the base URL', async () => {
    const { client, calls } = harness([json(200, { conversations: [conversation], nextCursor: null })]);
    const result = await client.listConversations();

    assert.equal(calls[0]!.url, 'https://api.example.com/api/conversations');
    assert.equal(calls[0]!.init.method, 'GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer access-token');
    assert.equal(headers.Accept, 'application/json');
    assert.equal(calls[0]!.init.credentials, 'omit');
    assert.deepEqual(result.conversations, [conversation]);
  });

  it('adds pagination parameters only when given', async () => {
    const { client, calls } = harness([json(200, { conversations: [], nextCursor: null }), json(200, { conversations: [], nextCursor: null })]);
    await client.listConversations({ limit: 20, before: '2026-09-18T09:00:00.000Z' });
    assert.equal(calls[0]!.url, 'https://api.example.com/api/conversations?limit=20&before=2026-09-18T09%3A00%3A00.000Z');
    await client.listConversations({});
    assert.equal(calls[1]!.url, 'https://api.example.com/api/conversations');
  });

  it('encodes path parameters and reads a conversation', async () => {
    const { client, calls } = harness([json(200, { conversation, messages: [] })]);
    await client.getConversationMessages('c 1/../x');
    assert.equal(calls[0]!.url, 'https://api.example.com/api/conversations/c%201%2F..%2Fx/messages');
  });

  it('posts a chat message as JSON', async () => {
    const payload = { message: 'What is QOBO?', clientMessageId: '11111111-1111-4111-8111-111111111111', conversationId: null };
    const { client, calls } = harness([json(200, { conversation, userMessage: {}, assistantMessage: {}, replayed: false })]);
    const result = await client.sendMessage(payload);

    assert.equal(calls[0]!.url, 'https://api.example.com/api/chat');
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal((calls[0]!.init.headers as Record<string, string>)['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), payload);
    assert.equal(result.replayed, false);
  });

  it('resolves a 204 delete with no body', async () => {
    const { client, calls } = harness([new Response(null, { status: 204 })]);
    assert.equal(await client.deleteConversation('c1'), undefined);
    assert.equal(calls[0]!.init.method, 'DELETE');
  });

  it('calls the public health endpoint without a token', async () => {
    const { client, calls } = harness([json(200, { status: 'ok', database: 'ok' })], null);
    const result = await client.health({ deep: true });
    assert.equal(calls[0]!.url, 'https://api.example.com/api/health?deep=1');
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, undefined);
    assert.equal(result.database, 'ok');
  });

  it('fails without a network call when signed out', async () => {
    const { client, calls } = harness([json(200, {})], null);
    await assert.rejects(client.listConversations(), (error: ApiError) => error.code === 'unauthorized' && error.status === 401);
    assert.equal(calls.length, 0);
  });
});

describe('API client error handling', () => {
  it('maps the error body, details and request id', async () => {
    const body = { error: { code: 'quota_exceeded', message: "You've reached today's limit of 50 messages.", details: { limit: 50, used: 50, resetsAt: '2026-09-19T00:00:00.000Z' } } };
    const { client } = harness([json(429, body, { 'X-Request-Id': 'req-123' })]);
    await assert.rejects(client.listConversations(), (error: ApiError) => {
      assert.equal(error.code, 'quota_exceeded');
      assert.equal(error.status, 429);
      assert.equal(error.requestId, 'req-123');
      assert.deepEqual(error.details, body.error.details);
      assert.match(error.message, /today's limit/);
      return true;
    });
  });

  it('falls back to the status when the body is unknown or unparseable', async () => {
    const unknownCode = harness([json(418, { error: { code: 'teapot', message: 'nope' } })]);
    await assert.rejects(unknownCode.client.listConversations(), (error: ApiError) => error.code === 'bad_request');

    const html = harness([new Response('<html>502</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })]);
    await assert.rejects(html.client.listConversations(), (error: ApiError) => error.code === 'internal_error' && /HTTP 502/.test(error.message));

    const gateway = harness([new Response('', { status: 504 })]);
    await assert.rejects(gateway.client.listConversations(), (error: ApiError) => error.code === 'timeout');
  });

  it('reports a failed connection as a network error', async () => {
    const { client } = harness([new TypeError('Failed to fetch')]);
    await assert.rejects(client.listConversations(), (error: ApiError) => error.code === 'network' && error.status === 0 && error.cause instanceof TypeError);
  });

  it('reports a request timeout as a timeout', async () => {
    const { client } = harness([new DOMException('The operation timed out.', 'TimeoutError')]);
    await assert.rejects(client.sendMessage({ message: 'hi', clientMessageId: '2' }), (error: ApiError) => error.code === 'timeout');
  });

  it('rethrows a caller-triggered abort untouched (Stop button)', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = harness([new DOMException('This operation was aborted', 'AbortError')]);
    await assert.rejects(
      client.sendMessage({ message: 'hi', clientMessageId: '3' }, { signal: controller.signal }),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
  });

  it('reports an unreadable success body', async () => {
    const { client } = harness([new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } })]);
    await assert.rejects(client.listConversations(), (error: ApiError) => error.code === 'internal_error' && /unreadable/.test(error.message));
  });
});
