/**
 * End-to-end API tests: the real Express app with real token verification,
 * RLS-scoped conversation store, exchange store, daily quota and database health
 * check, against the DEV project.
 *
 * The chat pipeline is faked for most cases (no model cost). One case sends a
 * small-talk message through the real router when Gemini credentials are present.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';
import request from 'supertest';

import { createApp, type AppDeps } from '../src/app.ts';
import { createSupabaseTokenVerifier } from '../src/auth/token-verifier.ts';
import { createSupabaseExchangeStore } from '../src/chat/exchange-store.ts';
import { createSupabaseUserMessageQuota } from '../src/chat/user-quota.ts';
import { loadEnv } from '../src/config/env.ts';
import { createSupabaseConversationStore } from '../src/conversations/store.ts';
import { createAuthClient, createServiceClient } from '../src/db/supabase.ts';
import { createSupabaseHealthCheck } from '../src/health/routes.ts';
import { createChatRuntime } from '../src/rag/setup.ts';
import { FakeChatService } from '../test/helpers/fakes.ts';
import { appendExchange, createSignedInUser, deleteCreatedUsers, type TestUser } from './helpers.ts';

const hasModelCredentials = Boolean(process.env.GEMINI_API_KEY && process.env.TAVILY_API_KEY);

// AI provider keys are optional for most cases; placeholders satisfy env validation.
const env = loadEnv({ GEMINI_API_KEY: 'unused', TAVILY_API_KEY: 'unused', ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const service = createServiceClient(env);
const fakeChat = new FakeChatService();

function buildApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    env,
    logger: pino({ level: 'silent' }),
    tokenVerifier: createSupabaseTokenVerifier(createAuthClient(env).auth),
    conversationStore: createSupabaseConversationStore(env),
    healthCheck: createSupabaseHealthCheck(env),
    chatService: fakeChat,
    exchangeStore: createSupabaseExchangeStore(service),
    userQuota: createSupabaseUserMessageQuota(service, 50),
    ...overrides,
  });
}

const app = buildApp();

let alice: TestUser;
let bob: TestUser;
let aliceConversation: string;
let bobConversation: string;

before(async () => {
  alice = await createSignedInUser();
  bob = await createSignedInUser();
  aliceConversation = await appendExchange(alice.id, null, 'Alice first');
  await appendExchange(alice.id, aliceConversation);
  bobConversation = await appendExchange(bob.id, null, 'Bob private');
});

after(deleteCreatedUsers);

const asUser = (user: TestUser, req: request.Test) => req.set('Authorization', `Bearer ${user.accessToken}`);

describe('hosted API', () => {
  it('passes the deep health check against the database', async () => {
    const res = await request(app).get('/api/health?deep=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.database, 'ok');
  });

  it('rejects a forged token', async () => {
    const [header, payload] = alice.accessToken.split('.');
    const res = await request(app).get('/api/conversations').set('Authorization', `Bearer ${header}.${payload}.Zm9yZ2Vk`);
    assert.equal(res.status, 401);
  });

  it("lists only the caller's conversations", async () => {
    const res = await asUser(alice, request(app).get('/api/conversations'));
    assert.equal(res.status, 200);
    const ids = res.body.conversations.map((c: { id: string }) => c.id);
    assert.ok(ids.includes(aliceConversation));
    assert.ok(!ids.includes(bobConversation));
  });

  it('returns messages in order with sources', async () => {
    const res = await asUser(alice, request(app).get(`/api/conversations/${aliceConversation}/messages`));
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.messages.map((m: { role: string }) => m.role),
      ['user', 'assistant', 'user', 'assistant'],
    );
    assert.deepEqual(res.body.messages[1].sources, [{ title: 'QOBO', url: 'https://qobo.dev/', kind: 'qobo' }]);
  });

  it("returns 404 for another user's conversation and for unknown ids", async () => {
    for (const id of [bobConversation, randomUUID()]) {
      const res = await asUser(alice, request(app).get(`/api/conversations/${id}/messages`));
      assert.equal(res.status, 404);
    }
    const del = await asUser(alice, request(app).delete(`/api/conversations/${bobConversation}`));
    assert.equal(del.status, 404);
  });

  it('deletes an owned conversation', async () => {
    const conversationId = await appendExchange(alice.id, null, 'To delete');
    const del = await asUser(alice, request(app).delete(`/api/conversations/${conversationId}`));
    assert.equal(del.status, 204);
    const after = await asUser(alice, request(app).get(`/api/conversations/${conversationId}/messages`));
    assert.equal(after.status, 404);
  });
});

describe('hosted chat endpoint (fake pipeline, real persistence)', () => {
  it('creates a conversation, continues it and reads it back with statuses', async () => {
    const first = await asUser(alice, request(app).post('/api/chat')).send({ message: 'What does QOBO do?', clientMessageId: randomUUID() });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.replayed, false);
    assert.equal(first.body.conversation.title, 'What does QOBO do?');
    assert.equal(first.body.assistantMessage.status, 'answered');
    const conversationId = first.body.conversation.id as string;

    const second = await asUser(alice, request(app).post('/api/chat')).send({ message: 'And the pricing?', clientMessageId: randomUUID(), conversationId });
    assert.equal(second.status, 200);
    assert.equal(second.body.conversation.id, conversationId);
    assert.deepEqual(fakeChat.requests.at(-1)?.history, [
      { role: 'user', content: 'What does QOBO do?' },
      { role: 'assistant', content: 'QOBO builds websites through WhatsApp [1].' },
    ]);

    const messages = await asUser(alice, request(app).get(`/api/conversations/${conversationId}/messages`));
    assert.deepEqual(
      messages.body.messages.map((m: { role: string; status: string | null; intent: string | null }) => [m.role, m.status, m.intent]),
      [
        ['user', null, null],
        ['assistant', 'answered', 'qobo'],
        ['user', null, null],
        ['assistant', 'answered', 'qobo'],
      ],
    );
  });

  it('replays a retried clientMessageId from the database', async () => {
    const clientMessageId = randomUUID();
    const first = await asUser(alice, request(app).post('/api/chat')).send({ message: 'Retry me', clientMessageId });
    const calls = fakeChat.requests.length;
    const retry = await asUser(alice, request(app).post('/api/chat')).send({ message: 'Retry me', clientMessageId });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.assistantMessage.id, first.body.assistantMessage.id);
    assert.equal(fakeChat.requests.length, calls, 'no second model call');
  });

  it("cannot post into another user's conversation", async () => {
    const res = await asUser(alice, request(app).post('/api/chat')).send({ message: 'Intrude', clientMessageId: randomUUID(), conversationId: bobConversation });
    assert.equal(res.status, 404);
    const bobs = await asUser(bob, request(app).get(`/api/conversations/${bobConversation}/messages`));
    assert.equal(bobs.body.messages.length, 2);
  });

  it('enforces the daily cap in the database, independent of deleted conversations', async () => {
    const capped = buildApp({ userQuota: createSupabaseUserMessageQuota(service, 2) });
    const carol = await createSignedInUser();
    const send = (message: string) => asUser(carol, request(capped).post('/api/chat')).send({ message, clientMessageId: randomUUID() });

    const one = await send('one');
    assert.equal(one.status, 200);
    await asUser(carol, request(capped).delete(`/api/conversations/${one.body.conversation.id}`));
    assert.equal((await send('two')).status, 200);
    const three = await send('three');
    assert.equal(three.status, 429);
    assert.equal(three.body.error.code, 'quota_exceeded');
    assert.equal(three.body.error.details.limit, 2);
  });

  it(
    'runs one real chat turn through the router when model credentials are available',
    { skip: hasModelCredentials ? false : 'GEMINI_API_KEY/TAVILY_API_KEY not set' },
    async () => {
      const real = buildApp({ chatService: createChatRuntime(env).chatService });
      const res = await asUser(alice, request(real).post('/api/chat')).send({ message: 'hello!', clientMessageId: randomUUID() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.assistantMessage.intent, 'smalltalk');
      assert.match(res.body.assistantMessage.content, /QOBO/);

      const { data } = await service.from('messages').select('metadata').eq('id', res.body.assistantMessage.id).single<{ metadata: { status: string; router: { source: string; model: string } } }>();
      assert.equal(data?.metadata.status, 'answered');
      assert.equal(data?.metadata.router.source, 'model');
    },
  );
});
