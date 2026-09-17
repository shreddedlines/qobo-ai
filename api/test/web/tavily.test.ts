import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSupabaseGlobalQuota } from '../../src/web/quota.ts';
import { createTavilySearch, sanitizeSearchQuery, WebSearchError } from '../../src/web/tavily.ts';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noSleep = { sleep: async () => undefined, random: () => 0 };

const okBody = {
  query: 'q',
  results: [
    { title: 'Website vs web app', url: 'https://developer.example.org/web-apps', content: 'A web application is interactive…', score: 0.9 },
    { title: 'Qobo Ltd', url: 'https://www.qobo.biz/about', content: 'A different company named Qobo', score: 0.8 },
    { title: 'Duplicate', url: 'https://developer.example.org/web-apps', content: 'Duplicate result', score: 0.7 },
    { title: null, url: 'https://blog.example.com/post', content: 'x'.repeat(5_000), score: null },
    { title: 'Empty', url: 'https://empty.example.com', content: '   ', score: 0.5 },
    { title: 'Bad scheme', url: 'javascript:alert(1)', content: 'nope', score: 0.4 },
  ],
  response_time: '1.2',
};

describe('Tavily web search', () => {
  it('sends a basic search with bearer auth and parses, filters and trims results', async () => {
    const { impl, calls } = fakeFetch([json(200, okBody)]);
    const results = await createTavilySearch({ apiKey: 'tvly-test', fetch: impl, maxResults: 5 }).search('website vs web application');

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.tavily.com/search');
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer tvly-test');
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(body, {
      query: 'website vs web application',
      search_depth: 'basic',
      topic: 'general',
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    });
    assert.ok(calls[0]!.init.signal instanceof AbortSignal);

    assert.deepEqual(
      results.map((r) => r.url),
      ['https://developer.example.org/web-apps', 'https://blog.example.com/post'],
      'drops other "Qobo" sites, duplicates, empty content and non-http URLs',
    );
    assert.equal(results[1]!.title, 'blog.example.com');
    assert.equal(results[1]!.content.length, 1_200);
  });

  it('removes personal data from queries and skips empty queries', async () => {
    assert.equal(sanitizeSearchQuery('SEO tips for priya@example.com call +91 98765 43210 see https://my.site/x'), 'SEO tips for call see');
    const { impl, calls } = fakeFetch([]);
    assert.deepEqual(await createTavilySearch({ apiKey: 'k', fetch: impl }).search('  me@x.com  '), []);
    assert.equal(calls.length, 0);
  });

  it('retries 429 and 5xx, then succeeds', async () => {
    const { impl, calls } = fakeFetch([json(429, { detail: { error: 'rate limited' } }), json(200, okBody)]);
    const results = await createTavilySearch({ apiKey: 'k', fetch: impl, retry: { retries: 1, baseDelayMs: 1, ...noSleep } }).search('q');
    assert.equal(calls.length, 2);
    assert.equal(results.length, 2);

    const server = fakeFetch([json(500, {}), json(503, {})]);
    await assert.rejects(createTavilySearch({ apiKey: 'k', fetch: server.impl, retry: { retries: 1, baseDelayMs: 1, ...noSleep } }).search('q'), (error: WebSearchError) => error.status === 503);
    assert.equal(server.calls.length, 2);
  });

  it('does not retry bad keys or exhausted plans, and reports the reason', async () => {
    for (const [status, message] of [
      [401, 'Unauthorized: missing or invalid API key.'],
      [432, "This request exceeds your plan's set usage limit."],
      [433, 'This request exceeds the pay-as-you-go limit.'],
      [400, 'Invalid topic.'],
    ] as const) {
      const { impl, calls } = fakeFetch([json(status, { detail: { error: message } }), json(200, okBody)]);
      await assert.rejects(
        createTavilySearch({ apiKey: 'k', fetch: impl, retry: { retries: 3, baseDelayMs: 1, ...noSleep } }).search('q'),
        (error: WebSearchError) => error instanceof WebSearchError && error.status === status && error.message.includes(message),
      );
      assert.equal(calls.length, 1, `HTTP ${status} must not be retried`);
    }
  });

  it('wraps network failures (retried) and timeouts (not retried)', async () => {
    const network = fakeFetch([new TypeError('fetch failed'), json(200, okBody)]);
    assert.equal((await createTavilySearch({ apiKey: 'k', fetch: network.impl, retry: { retries: 1, baseDelayMs: 1, ...noSleep } }).search('q')).length, 2);

    const timeout = fakeFetch([new DOMException('The operation timed out.', 'TimeoutError'), json(200, okBody)]);
    await assert.rejects(createTavilySearch({ apiKey: 'k', fetch: timeout.impl, retry: { retries: 1, baseDelayMs: 1, ...noSleep } }).search('q'), WebSearchError);
    assert.equal(timeout.calls.length, 1);
  });

  it('rejects invalid JSON and unexpected response shapes', async () => {
    const invalid = fakeFetch([new Response('<html>oops</html>', { status: 200 })]);
    await assert.rejects(createTavilySearch({ apiKey: 'k', fetch: invalid.impl, retry: { retries: 0, baseDelayMs: 1 } }).search('q'), /invalid JSON/);
    const shape = fakeFetch([json(200, { hits: [] })]);
    await assert.rejects(createTavilySearch({ apiKey: 'k', fetch: shape.impl, retry: { retries: 0, baseDelayMs: 1 } }).search('q'), /unexpected shape/);
  });
});

describe('global web-search quota', () => {
  it('maps consume_global_quota results and surfaces errors', async () => {
    const calls: unknown[] = [];
    const allowed = createSupabaseGlobalQuota({ rpc: async (fn: string, args: unknown) => (calls.push([fn, args]), { data: [{ allowed: true, used: 3, quota_limit: 100 }], error: null }) } as never, 'web_search', 100);
    assert.equal(await allowed.consume(), true);
    assert.deepEqual(calls, [['consume_global_quota', { p_kind: 'web_search', p_limit: 100 }]]);

    const denied = createSupabaseGlobalQuota({ rpc: async () => ({ data: [{ allowed: false, used: 100, quota_limit: 100 }], error: null }) } as never, 'web_search', 100);
    assert.equal(await denied.consume(), false);

    const failing = createSupabaseGlobalQuota({ rpc: async () => ({ data: null, error: { message: 'permission denied' } }) } as never, 'web_search', 100);
    await assert.rejects(failing.consume(), /permission denied/);
  });
});
