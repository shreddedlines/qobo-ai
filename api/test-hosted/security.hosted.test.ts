/**
 * Security tests against a real, hosted Supabase DEV project.
 *
 * Creates throwaway users, verifies what the browser-reachable Data API allows,
 * then deletes the users (cascading their data). Never point this at production.
 *
 *   cp .env.test.example .env.test   # dev project values + ALLOW_DESTRUCTIVE_TESTS=true
 *   npm run test:hosted
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { createClient } from '@supabase/supabase-js';

import {
  appendExchange,
  clientOptions,
  createSignedInUser,
  deleteCreatedUsers,
  publishableKey,
  service,
  url,
  type TestUser,
} from './helpers.ts';

let alice: TestUser;
let bob: TestUser;
let aliceConversation: string;
let bobConversation: string;

before(async () => {
  alice = await createSignedInUser();
  bob = await createSignedInUser();
  aliceConversation = await appendExchange(alice.id);
  bobConversation = await appendExchange(bob.id);
});

after(deleteCreatedUsers);

describe('auth configuration', () => {
  it('signs access tokens with an asymmetric key (local getClaims verification)', () => {
    const header = JSON.parse(Buffer.from(alice.accessToken.split('.')[0]!, 'base64url').toString('utf8')) as { alg: string };
    assert.notEqual(header.alg, 'HS256', 'Enable asymmetric JWT signing keys in Supabase → Project Settings → JWT Keys');
  });

  it('verifies tokens with getClaims', async () => {
    const { data, error } = await service.auth.getClaims(alice.accessToken);
    assert.equal(error, null);
    assert.equal(data?.claims.sub, alice.id);
    assert.equal(data?.claims.role, 'authenticated');
  });
});

describe('anonymous Data API access', () => {
  const anon = createClient(url!, publishableKey!, clientOptions);

  it('cannot read conversations or messages', async () => {
    for (const table of ['conversations', 'messages']) {
      const { data, error } = await anon.from(table).select('id');
      assert.ok(error !== null || (data ?? []).length === 0, `${table} must not be readable anonymously`);
    }
  });

  it('cannot call backend functions', async () => {
    const { error } = await anon.rpc('consume_user_quota', { p_user_id: alice.id, p_kind: 'message', p_limit: 1000 });
    assert.notEqual(error, null);
  });
});

describe('authenticated Data API access (browser-equivalent)', () => {
  it('reads only its own conversations and messages', async () => {
    const conversations = await alice.client.from('conversations').select('id, user_id');
    assert.equal(conversations.error, null);
    assert.ok(conversations.data!.length >= 1);
    assert.ok(conversations.data!.every((row) => row.user_id === alice.id));

    const messages = await alice.client.from('messages').select('user_id');
    assert.equal(messages.error, null);
    assert.ok(messages.data!.every((row) => row.user_id === alice.id));
  });

  it("cannot see another user's conversation by id", async () => {
    const { data } = await alice.client.from('conversations').select('id').eq('id', bobConversation);
    assert.deepEqual(data, []);
  });

  it('cannot insert conversations or forge messages', async () => {
    const conversation = await alice.client.from('conversations').insert({ user_id: alice.id, title: 'forged' });
    assert.notEqual(conversation.error, null);

    const message = await alice.client
      .from('messages')
      .insert({ conversation_id: aliceConversation, user_id: alice.id, role: 'assistant', content: 'Lifetime plan ₹99' });
    assert.notEqual(message.error, null);
  });

  it('cannot update messages', async () => {
    const { data, error } = await alice.client.from('messages').update({ content: 'edited' }).eq('user_id', alice.id).select('id');
    assert.ok(error !== null || (data ?? []).length === 0);
  });

  it('cannot call backend functions', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      [
        'append_exchange',
        {
          p_user_id: alice.id,
          p_conversation_id: aliceConversation,
          p_client_message_id: randomUUID(),
          p_title: 'x',
          p_user_content: 'x',
          p_assistant_content: 'x',
          p_intent: 'qobo',
        },
      ],
      ['consume_user_quota', { p_user_id: alice.id, p_kind: 'message', p_limit: 1000 }],
      ['get_kb_meta', {}],
    ];
    for (const [fn, args] of calls) {
      const { error } = await alice.client.rpc(fn, args);
      assert.notEqual(error, null, `${fn} must not be callable by authenticated users`);
    }
  });

  it('cannot reach the private schema', async () => {
    const { error } = await alice.client.schema('private').from('kb_chunks').select('id');
    assert.notEqual(error, null);
  });

  it("cannot delete another user's conversation", async () => {
    const { data } = await alice.client.from('conversations').delete().eq('id', bobConversation).select('id');
    assert.deepEqual(data ?? [], []);
    const stillThere = await service.from('conversations').select('id').eq('id', bobConversation);
    assert.equal(stillThere.data?.length, 1);
  });

  it('deletes its own conversation with messages cascading', async () => {
    const conversationId = await appendExchange(alice.id);
    const { data, error } = await alice.client.from('conversations').delete().eq('id', conversationId).select('id');
    assert.equal(error, null);
    assert.equal(data?.length, 1);
    const messages = await service.from('messages').select('id').eq('conversation_id', conversationId);
    assert.deepEqual(messages.data, []);
  });
});

describe('service role (backend)', () => {
  it('passes a JSON array as a pgvector argument to match_kb_chunks', async () => {
    const embedding = new Array<number>(768).fill(0);
    embedding[0] = 1;
    const { error } = await service.rpc('match_kb_chunks', { p_query_embedding: embedding, p_match_count: 1, p_min_similarity: 0 });
    assert.equal(error, null);
  });
});
