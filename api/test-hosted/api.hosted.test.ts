/**
 * End-to-end API tests: the real Express app with real token verification,
 * RLS-scoped conversation store and database health check, against the DEV project.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';
import request from 'supertest';

import { createApp } from '../src/app.ts';
import { createSupabaseTokenVerifier } from '../src/auth/token-verifier.ts';
import { loadEnv } from '../src/config/env.ts';
import { createSupabaseConversationStore } from '../src/conversations/store.ts';
import { createAuthClient } from '../src/db/supabase.ts';
import { createSupabaseHealthCheck } from '../src/health/routes.ts';
import { appendExchange, createSignedInUser, deleteCreatedUsers, type TestUser } from './helpers.ts';

// AI provider keys are not exercised here; placeholders satisfy env validation.
const env = loadEnv({ GEMINI_API_KEY: 'unused', TAVILY_API_KEY: 'unused', ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });

const app = createApp({
  env,
  logger: pino({ level: 'silent' }),
  tokenVerifier: createSupabaseTokenVerifier(createAuthClient(env).auth),
  conversationStore: createSupabaseConversationStore(env),
  healthCheck: createSupabaseHealthCheck(env),
});

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
