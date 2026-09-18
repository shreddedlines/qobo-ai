import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import request from 'supertest';

import { HISTORY_MESSAGES, MAX_MESSAGE_CHARS, replyMetadata, titleFromMessage } from '../../src/chat/routes.ts';
import { nextUtcMidnight } from '../../src/chat/user-quota.ts';
import { DatabaseError } from '../../src/db/supabase.ts';
import { withTimeout, TimeoutError } from '../../src/lib/timeout.ts';
import { AnswerUnavailableError } from '../../src/rag/qobo-answer.ts';
import { buildTestApp, type TestApp } from '../helpers/fakes.ts';

let ctx: TestApp;
let token: string;
let userId: string;

beforeEach(() => {
  ctx = buildTestApp({ CHAT_REQUEST_TIMEOUT_MS: '1000' });
  const user = ctx.verifier.addUser();
  token = user.token;
  userId = user.user.id;
});

const send = (body: Record<string, unknown>, bearer: string = token) => request(ctx.app).post('/api/chat').set('Authorization', `Bearer ${bearer}`).send(body);

describe('POST /api/chat', () => {
  it('requires authentication', async () => {
    const res = await request(ctx.app).post('/api/chat').send({ message: 'hi', clientMessageId: randomUUID() });
    assert.equal(res.status, 401);
    assert.equal(ctx.chat.requests.length, 0);
  });

  it('validates the request body', async () => {
    for (const body of [
      {},
      { message: 'hi' },
      { message: '   ', clientMessageId: randomUUID() },
      { message: 'x'.repeat(MAX_MESSAGE_CHARS + 1), clientMessageId: randomUUID() },
      { message: 'hi', clientMessageId: 'not-a-uuid' },
      { message: 'hi', clientMessageId: randomUUID(), conversationId: 'abc' },
      { message: 42, clientMessageId: randomUUID() },
    ]) {
      const res = await send(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(res.body.error.code, 'bad_request');
    }
    assert.equal(ctx.chat.requests.length, 0);
    assert.equal(ctx.quota.used.size, 0);
  });

  it('starts a conversation, saves both messages and returns them', async () => {
    const clientMessageId = randomUUID();
    const res = await send({ message: '  How does QOBO build   websites on WhatsApp?  ', clientMessageId });

    assert.equal(res.status, 200);
    assert.equal(res.body.replayed, false);
    assert.equal(res.body.conversation.title, 'How does QOBO build websites on WhatsApp?');
    assert.deepEqual(
      { role: res.body.userMessage.role, content: res.body.userMessage.content, status: res.body.userMessage.status },
      { role: 'user', content: 'How does QOBO build   websites on WhatsApp?', status: null },
    );
    assert.deepEqual(
      { role: res.body.assistantMessage.role, intent: res.body.assistantMessage.intent, status: res.body.assistantMessage.status, sources: res.body.assistantMessage.sources },
      { role: 'assistant', intent: 'qobo', status: 'answered', sources: [{ title: 'QOBO Home', url: 'https://qobo.dev/', kind: 'qobo' }] },
    );

    assert.deepEqual(ctx.chat.requests, [{ message: 'How does QOBO build   websites on WhatsApp?', history: [] }]);
    const saved = ctx.exchanges.appended[0]!;
    assert.equal(saved.userId, userId, 'user id comes from the verified token');
    assert.equal(saved.conversationId, null);
    assert.equal(saved.clientMessageId, clientMessageId);
    assert.deepEqual(saved.metadata, replyMetadata(ctx.chat.respondWith as never));
    assert.equal(ctx.quota.used.get(userId), 1);

    const list = await request(ctx.app).get('/api/conversations').set('Authorization', `Bearer ${token}`);
    assert.deepEqual(
      list.body.conversations.map((c: { id: string }) => c.id),
      [res.body.conversation.id],
    );
  });

  it('continues a conversation with its recent history', async () => {
    const conversation = ctx.store.seed(userId, 'Plans', '2026-09-01T10:00:00.000Z', 14);
    const res = await send({ message: 'How much is the Pro one?', clientMessageId: randomUUID(), conversationId: conversation.id });

    assert.equal(res.status, 200);
    assert.equal(res.body.conversation.id, conversation.id);
    const { history } = ctx.chat.requests[0]!;
    assert.equal(history?.length, HISTORY_MESSAGES);
    assert.deepEqual(history?.[0], { role: 'user', content: 'message 4' });
    assert.deepEqual(history?.at(-1), { role: 'assistant', content: 'message 13' });
    assert.equal(conversation.messages.length, 16);
  });

  it("returns 404 for someone else's conversation without spending quota or calling the model", async () => {
    const other = ctx.verifier.addUser();
    const foreign = ctx.store.seed(other.user.id, 'Private', '2026-09-01T10:00:00.000Z');
    for (const conversationId of [foreign.id, randomUUID()]) {
      const res = await send({ message: 'hi', clientMessageId: randomUUID(), conversationId });
      assert.equal(res.status, 404);
    }
    assert.equal(ctx.chat.requests.length, 0);
    assert.equal(ctx.quota.used.size, 0);
    assert.equal(foreign.messages.length, 2);
  });

  it('replays a retried message instead of answering or charging again', async () => {
    const clientMessageId = randomUUID();
    const first = await send({ message: 'What is QOBO?', clientMessageId });
    const retry = await send({ message: 'What is QOBO?', clientMessageId });

    assert.equal(retry.status, 200);
    assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.assistantMessage.id, first.body.assistantMessage.id);
    assert.equal(ctx.chat.requests.length, 1);
    assert.equal(ctx.quota.used.get(userId), 1);

    const conflict = await send({ message: 'What is QOBO?', clientMessageId, conversationId: ctx.store.seed(userId, 'Other', '2026-09-01T10:00:00.000Z').id });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'conflict');
  });

  it('enforces the per-user daily message cap', async () => {
    ctx.quota.limit = 2;
    assert.equal((await send({ message: 'one', clientMessageId: randomUUID() })).status, 200);
    assert.equal((await send({ message: 'two', clientMessageId: randomUUID() })).status, 200);

    const capped = await send({ message: 'three', clientMessageId: randomUUID() });
    assert.equal(capped.status, 429);
    assert.equal(capped.body.error.code, 'quota_exceeded');
    assert.deepEqual(capped.body.error.details, { limit: 2, used: 2, resetsAt: nextUtcMidnight() });
    assert.equal(ctx.chat.requests.length, 2, 'the model is not called once the cap is reached');

    const otherUser = ctx.verifier.addUser();
    assert.equal((await send({ message: 'separate quota', clientMessageId: randomUUID() }, otherUser.token)).status, 200);
  });

  it('returns 503 and saves nothing when the assistant is unavailable', async () => {
    ctx.chat.respondWith = new AnswerUnavailableError('generation', new Error('503 high demand'));
    const clientMessageId = randomUUID();
    const res = await send({ message: 'Pricing?', clientMessageId });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(res.headers['retry-after'], '10');
    assert.equal(ctx.exchanges.appended.length, 0);

    // The client can retry with the same id once the service recovers.
    ctx.chat.respondWith = buildTestApp().chat.respondWith;
    assert.equal((await send({ message: 'Pricing?', clientMessageId })).status, 200);
  });

  it('times out slow turns with 504 and saves nothing', async () => {
    ctx.chat.respondWith = 'hang';
    const startedAt = Date.now();
    const res = await send({ message: 'slow', clientMessageId: randomUUID() });
    assert.equal(res.status, 504);
    assert.equal(res.body.error.code, 'timeout');
    assert.ok(Date.now() - startedAt < 3_000);
    assert.equal(ctx.exchanges.appended.length, 0);
  });

  it('returns 404 when the conversation is deleted while the reply is generated', async () => {
    const conversation = ctx.store.seed(userId, 'Soon deleted', '2026-09-01T10:00:00.000Z');
    const originalRespond = ctx.chat.respond.bind(ctx.chat);
    ctx.chat.respond = async (req) => {
      ctx.store.conversations.splice(ctx.store.conversations.indexOf(conversation), 1);
      return originalRespond(req);
    };
    const res = await send({ message: 'hi', clientMessageId: randomUUID(), conversationId: conversation.id });
    assert.equal(res.status, 404);
  });

  it('hides unexpected failures behind a generic 500', async () => {
    ctx.exchanges.failWith = new DatabaseError('append exchange', new Error('connection reset: secret-host:5432'));
    const res = await send({ message: 'hi', clientMessageId: randomUUID() });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } });
  });

  it('applies the stricter per-IP chat rate limit', async () => {
    const limited = buildTestApp({ CHAT_RATE_LIMIT_PER_MINUTE: '2' });
    const { token: t } = limited.verifier.addUser();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await request(limited.app).post('/api/chat').set('Authorization', `Bearer ${t}`).send({ message: `m${i}`, clientMessageId: randomUUID() })).status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
    assert.equal(limited.chat.requests.length, 2);
  });
});

/** What the fake chat service answers with unless a test overrides it. */
const FAKE_REPLY = 'QOBO builds websites through WhatsApp [1].';

describe('POST /api/chat with replaceMessageId (editing a message)', () => {
  /** A saved conversation with two exchanges, which is what an edit starts from. */
  async function seedTwoExchanges() {
    const first = await send({ message: 'What do your plans include?', clientMessageId: randomUUID() });
    const conversationId = first.body.conversation.id as string;
    const second = await send({ message: 'Do you offer SEO?', clientMessageId: randomUUID(), conversationId });
    return { conversationId, first: first.body, second: second.body };
  }

  const messagesOf = (conversationId: string) => ctx.store.conversations.find((conversation) => conversation.id === conversationId)!.messages;

  it('replaces the message and its reply in place, adding nothing', async () => {
    const { conversationId, first } = await seedTwoExchanges();
    const before = messagesOf(conversationId).length;

    ctx.chat.respondWith = {
      intent: 'qobo',
      status: 'answered',
      content: 'A regenerated answer about plans and SEO.',
      sources: [],
      metadata: { router: { source: 'model', model: 'router-model', language: 'en', smalltalkType: 'other' }, latencyMs: 7 },
    };
    const res = await send({
      message: 'What do your plans include, and is SEO extra?',
      clientMessageId: randomUUID(),
      conversationId,
      replaceMessageId: first.userMessage.id,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.conversation.id, conversationId, 'the same conversation');
    assert.equal(res.body.userMessage.content, 'What do your plans include, and is SEO extra?');

    const messages = messagesOf(conversationId);
    assert.equal(messages.length, before, 'replaced, not appended');
    assert.equal(messages[0]?.content, 'What do your plans include, and is SEO extra?', 'the edit sits in the original position');
    assert.equal(messages[0]?.id, first.userMessage.id, 'the message row itself was changed');
    assert.equal(messages[1]?.role, 'assistant');
    assert.equal(messages[1]?.content, 'A regenerated answer about plans and SEO.', 'the reply is the newly generated one');
    assert.notEqual(messages[1]?.content, first.assistantMessage.content, 'the old reply is gone');
    assert.equal(messages[2]?.content, 'Do you offer SEO?', 'the later exchange is untouched');
  });

  it('regenerates with the history that preceded the edited message', async () => {
    const { conversationId, second } = await seedTwoExchanges();
    ctx.chat.requests.length = 0;

    await send({ message: 'edited follow-up', clientMessageId: randomUUID(), conversationId, replaceMessageId: second.userMessage.id });

    const [regeneration] = ctx.chat.requests;
    assert.equal(regeneration?.message, 'edited follow-up');
    assert.deepEqual(
      (regeneration?.history ?? []).map((turn) => turn.content),
      ['What do your plans include?', FAKE_REPLY],
      'the edited turn and anything after it are not context for it',
    );
  });

  it('refuses to edit an assistant reply', async () => {
    const { conversationId, first } = await seedTwoExchanges();
    ctx.chat.requests.length = 0;

    const res = await send({ message: 'rewritten reply', clientMessageId: randomUUID(), conversationId, replaceMessageId: first.assistantMessage.id });

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
    assert.equal(ctx.chat.requests.length, 0, 'nothing is generated for an impossible edit');
    assert.equal(messagesOf(conversationId)[1]?.content, first.assistantMessage.content, 'the reply is untouched');
  });

  it("refuses to edit someone else's message, without generating or charging", async () => {
    const other = ctx.verifier.addUser();
    const foreign = ctx.store.seed(other.user.id, 'Private', '2026-09-01T10:00:00.000Z');
    ctx.chat.requests.length = 0;
    ctx.quota.used.clear();

    const res = await send({
      message: 'trying to edit a stranger',
      clientMessageId: randomUUID(),
      conversationId: foreign.id,
      replaceMessageId: foreign.messages[0]!.id,
    });

    assert.equal(res.status, 404);
    assert.equal(ctx.chat.requests.length, 0);
    assert.equal(ctx.quota.used.size, 0);
    assert.equal(foreign.messages.length, 2, "the other person's conversation is untouched");
  });

  it('refuses an unknown message id', async () => {
    const { conversationId } = await seedTwoExchanges();
    const res = await send({ message: 'edited', clientMessageId: randomUUID(), conversationId, replaceMessageId: randomUUID() });
    assert.equal(res.status, 404);
  });

  it('requires the conversation the message belongs to', async () => {
    const { first } = await seedTwoExchanges();
    const res = await send({ message: 'edited', clientMessageId: randomUUID(), replaceMessageId: first.userMessage.id });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'bad_request');
  });

  it('leaves the conversation exactly as it was when regeneration fails', async () => {
    const { conversationId, first } = await seedTwoExchanges();
    const before = structuredClone(messagesOf(conversationId));
    ctx.chat.respondWith = new AnswerUnavailableError('generation', new Error('models are busy'));

    const res = await send({
      message: 'an edit that cannot be answered',
      clientMessageId: randomUUID(),
      conversationId,
      replaceMessageId: first.userMessage.id,
    });

    assert.equal(res.status, 503);
    assert.deepEqual(messagesOf(conversationId), before, 'no message was changed or removed');
  });

  it('leaves the conversation as it was when the edit times out', async () => {
    const { conversationId, first } = await seedTwoExchanges();
    const before = structuredClone(messagesOf(conversationId));
    ctx.chat.respondWith = 'hang';

    const res = await send({ message: 'a slow edit', clientMessageId: randomUUID(), conversationId, replaceMessageId: first.userMessage.id });

    assert.equal(res.status, 504);
    assert.deepEqual(messagesOf(conversationId), before);
  });

  it('leaves the conversation as it was when the write itself fails', async () => {
    const { conversationId, first } = await seedTwoExchanges();
    const before = structuredClone(messagesOf(conversationId));
    ctx.exchanges.failWith = new DatabaseError('replace exchange', { message: 'boom' });

    const res = await send({ message: 'an edit that cannot be saved', clientMessageId: randomUUID(), conversationId, replaceMessageId: first.userMessage.id });

    assert.equal(res.status, 500);
    assert.deepEqual(messagesOf(conversationId), before);
  });

  it('replays a retried edit instead of replacing twice or charging again', async () => {
    const { conversationId, first } = await seedTwoExchanges();
    const clientMessageId = randomUUID();
    ctx.quota.used.clear();

    const once = await send({ message: 'edited once', clientMessageId, conversationId, replaceMessageId: first.userMessage.id });
    const twice = await send({ message: 'edited once', clientMessageId, conversationId, replaceMessageId: first.userMessage.id });

    assert.equal(once.body.replayed, false);
    assert.equal(twice.body.replayed, true);
    assert.equal(twice.body.userMessage.id, once.body.userMessage.id);
    assert.equal(ctx.quota.used.get(userId), 1, 'a replayed edit does not spend another message');
    assert.equal(messagesOf(conversationId).length, 4);
  });

  it('spends one message from the daily cap, like any other turn', async () => {
    const { conversationId, first } = await seedTwoExchanges();
    ctx.quota.used.clear();

    await send({ message: 'edited question', clientMessageId: randomUUID(), conversationId, replaceMessageId: first.userMessage.id });

    assert.equal(ctx.quota.used.get(userId), 1);
  });

  it('rejects a malformed replaceMessageId', async () => {
    const { conversationId } = await seedTwoExchanges();
    const res = await send({ message: 'edited', clientMessageId: randomUUID(), conversationId, replaceMessageId: 'not-a-uuid' });
    assert.equal(res.status, 400);
  });
});

describe('chat helpers', () => {
  it('derives short conversation titles', () => {
    assert.equal(titleFromMessage('  What   is QOBO?\n'), 'What is QOBO?');
    const long = titleFromMessage('Can QOBO build an online store for my bakery with UPI payments and delivery tracking in Pune?');
    assert.ok(long.length <= 60 && long.endsWith('…'), long);
    assert.equal(long, 'Can QOBO build an online store for my bakery with UPI…');
    assert.equal(titleFromMessage('x'.repeat(100)), `${'x'.repeat(59)}…`);
  });

  it('computes the next UTC midnight for quota resets', () => {
    assert.equal(nextUtcMidnight(new Date('2026-09-17T23:59:59.000Z')), '2026-09-18T00:00:00.000Z');
    assert.equal(nextUtcMidnight(new Date('2026-12-31T05:00:00.000+05:30')), '2026-12-31T00:00:00.000Z');
  });

  it('withTimeout resolves fast work and rejects slow work', async () => {
    assert.equal(await withTimeout(Promise.resolve('ok'), 50), 'ok');
    await assert.rejects(withTimeout(new Promise(() => undefined), 20), TimeoutError);
    await assert.rejects(
      withTimeout(Promise.reject(new Error('boom')), 50),
      /boom/,
    );
  });
});
