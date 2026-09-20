import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import request from 'supertest';

import type { ChatReply, ChatService } from '../../src/chat/chat-service.ts';
import { replyMetadata } from '../../src/chat/routes.ts';
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

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** Reads the event stream back into frames, ignoring the keep-alive comments. */
function parseFrames(body: string): Frame[] {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return { event: eventLine!.slice('event: '.length), data: JSON.parse(dataLine!.slice('data: '.length)) as Record<string, unknown> };
    });
}

const stream = (body: Record<string, unknown>, bearer: string = token) =>
  request(ctx.app).post('/api/chat/stream').set('Authorization', `Bearer ${bearer}`).send(body);

const deltas = (frames: Frame[]) => frames.filter((frame) => frame.event === 'delta').map((frame) => frame.data.text as string);
const only = (frames: Frame[], event: string) => frames.filter((frame) => frame.event === event);

describe('POST /api/chat/stream', () => {
  it('requires authentication, and does not stream or charge quota without it', async () => {
    const res = await request(ctx.app).post('/api/chat/stream').send({ message: 'hi', clientMessageId: randomUUID() });

    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthorized');
    assert.equal(ctx.chat.requests.length, 0);
    assert.equal(ctx.quota.used.size, 0);
  });

  it('rejects an invalid body as an ordinary 400, before the stream opens', async () => {
    for (const body of [{}, { message: '   ', clientMessageId: randomUUID() }, { message: 'hi', clientMessageId: 'not-a-uuid' }, { message: 'hi', clientMessageId: randomUUID(), replaceMessageId: randomUUID() }]) {
      const res = await stream(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(res.body.error.code, 'bad_request');
      assert.ok(!res.headers['content-type']?.includes('event-stream'));
    }
    assert.equal(ctx.chat.requests.length, 0);
    assert.equal(ctx.quota.used.size, 0);
  });

  it('identifies the response as an unbuffered event stream', async () => {
    ctx.chat.streamChunks = ['QOBO builds websites'];
    const res = await stream({ message: 'What does QOBO do?', clientMessageId: randomUUID() });

    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    assert.match(String(res.headers['cache-control']), /no-cache/);
    assert.match(String(res.headers['cache-control']), /no-transform/);
    assert.equal(res.headers['x-accel-buffering'], 'no');
  });

  it('streams the answer as deltas, then a done frame with the canonical reply', async () => {
    ctx.chat.streamChunks = ['QOBO builds ', 'websites through ', 'WhatsApp.'];
    const clientMessageId = randomUUID();
    const res = await stream({ message: 'What does QOBO do?', clientMessageId });
    const frames = parseFrames(res.text);

    assert.deepEqual(deltas(frames), ['QOBO builds ', 'websites through ', 'WhatsApp.']);
    assert.equal(frames.at(-1)!.event, 'done', 'done is the last frame');
    assert.equal(only(frames, 'done').length, 1);
    assert.equal(only(frames, 'error').length, 0);

    const done = frames.at(-1)!.data as unknown as {
      conversation: { title: string };
      userMessage: { role: string; content: string };
      assistantMessage: { role: string; content: string; intent: string; status: string; sources: unknown[] };
      replayed: boolean;
    };
    assert.equal(done.replayed, false);
    assert.equal(done.conversation.title, 'What does QOBO do?');
    assert.equal(done.userMessage.content, 'What does QOBO do?');
    assert.deepEqual(
      { role: done.assistantMessage.role, content: done.assistantMessage.content, intent: done.assistantMessage.intent, status: done.assistantMessage.status },
      { role: 'assistant', content: 'QOBO builds websites through WhatsApp [1].', intent: 'qobo', status: 'answered' },
    );
    assert.deepEqual(done.assistantMessage.sources, [{ title: 'QOBO Home', url: 'https://qobo.dev/', kind: 'qobo' }]);

    const saved = ctx.exchanges.appended[0]!;
    assert.equal(saved.userId, userId, 'the user comes from the verified token');
    assert.equal(saved.clientMessageId, clientMessageId);
    assert.deepEqual(saved.metadata, replyMetadata(ctx.chat.respondWith as ChatReply));
    assert.equal(ctx.quota.used.get(userId), 1);
  });

  it('never sends internal citation ids to the browser, however they are split', async () => {
    ctx.chat.streamChunks = ['Starter is ₹499 [S', '1]. Pro is ₹999 [W2', '] and both [S1, S3] ship fast.', ' See [S'];
    const res = await stream({ message: 'How much?', clientMessageId: randomUUID() });
    const streamed = deltas(parseFrames(res.text)).join('');

    // The trailing "[S" is an id that never finished arriving: dropped, not shown.
    assert.equal(streamed, 'Starter is ₹499 . Pro is ₹999  and both  ship fast. See ');
    for (const frame of deltas(parseFrames(res.text))) {
      assert.doesNotMatch(frame, /\[[SW]\d/, `delta leaked an internal id: ${JSON.stringify(frame)}`);
    }
  });

  it('leaves text that merely looks like a citation alone', async () => {
    ctx.chat.streamChunks = ['Use [square] brackets [like this], not [S1].'];
    const res = await stream({ message: 'brackets?', clientMessageId: randomUUID() });

    assert.equal(deltas(parseFrames(res.text)).join(''), 'Use [square] brackets [like this], not .');
  });

  it('gives the same canonical answer as the non-streaming endpoint', async () => {
    ctx.chat.streamChunks = ['QOBO builds ', 'websites.'];
    const plain = await request(ctx.app).post('/api/chat').set('Authorization', `Bearer ${token}`).send({ message: 'What does QOBO do?', clientMessageId: randomUUID() });
    const streamed = await stream({ message: 'What does QOBO do?', clientMessageId: randomUUID() });

    const done = parseFrames(streamed.text).at(-1)!.data as Record<string, unknown>;
    const ignoringIdentity = (body: Record<string, unknown>) => ({
      ...body,
      conversation: { ...(body.conversation as Record<string, unknown>), id: '<id>', createdAt: '<at>', updatedAt: '<at>' },
      userMessage: { ...(body.userMessage as Record<string, unknown>), id: '<id>', createdAt: '<at>' },
      assistantMessage: { ...(body.assistantMessage as Record<string, unknown>), id: '<id>', createdAt: '<at>' },
    });

    assert.deepEqual(ignoringIdentity(done), ignoringIdentity(plain.body as Record<string, unknown>));
  });

  it('saves nothing until the answer is complete', async () => {
    let appendedWhileStreaming: number | null = null;
    // The app is built around this service, so it reads the store back through a holder.
    const built: { context?: TestApp } = {};
    const chatService: ChatService = {
      async respond(chatRequest) {
        chatRequest.stream?.onDelta('half an answer');
        appendedWhileStreaming = built.context!.exchanges.appended.length;
        return ctx.chat.respondWith as ChatReply;
      },
    };
    const context = buildTestApp({}, { chatService });
    built.context = context;
    const user = context.verifier.addUser();

    const res = await request(context.app).post('/api/chat/stream').set('Authorization', `Bearer ${user.token}`).send({ message: 'hi', clientMessageId: randomUUID() });

    assert.equal(appendedWhileStreaming, 0, 'no row existed while text was still being streamed');
    assert.equal(context.exchanges.appended.length, 1, 'and exactly one was written when it finished');
    assert.equal(parseFrames(res.text).at(-1)!.event, 'done');
  });

  it('continues a conversation with its recent history', async () => {
    const conversation = ctx.store.seed(userId, 'Plans', '2026-09-01T10:00:00.000Z', 14);
    ctx.chat.streamChunks = ['It is ₹999.'];
    const res = await stream({ message: 'How much is the Pro one?', clientMessageId: randomUUID(), conversationId: conversation.id });

    const done = parseFrames(res.text).at(-1)!.data as unknown as { conversation: { id: string } };
    assert.equal(done.conversation.id, conversation.id);
    const { history } = ctx.chat.requests[0]!;
    assert.equal(history?.length, 10);
    assert.deepEqual(history?.at(-1), { role: 'assistant', content: 'message 13' });
    assert.equal(conversation.messages.length, 16, 'the exchange was appended');
  });

  it('replaces an edited message and its reply in place', async () => {
    const conversation = ctx.store.seed(userId, 'Plans', '2026-09-01T10:00:00.000Z', 4);
    const target = conversation.messages[2]!;
    ctx.chat.streamChunks = ['The Pro plan.'];

    const res = await stream({ message: 'What about Pro?', clientMessageId: randomUUID(), conversationId: conversation.id, replaceMessageId: target.id });
    const done = parseFrames(res.text).at(-1)!.data as unknown as { userMessage: { id: string; content: string } };

    assert.equal(done.userMessage.id, target.id, 'the edited message keeps its id and position');
    assert.equal(done.userMessage.content, 'What about Pro?');
    assert.equal(conversation.messages.length, 4, 'nothing was appended');
    assert.equal(ctx.exchanges.replaced.length, 1);
    assert.equal(ctx.exchanges.appended.length, 0);
    assert.deepEqual(ctx.chat.requests[0]!.history, [
      { role: 'user', content: 'message 0' },
      { role: 'assistant', content: 'message 1' },
    ], 'regenerated against the conversation as it stood before that message');
  });

  it('returns 404 for a conversation or message that is not the caller own, before opening the stream', async () => {
    const other = ctx.verifier.addUser();
    const foreign = ctx.store.seed(other.user.id, 'Private', '2026-09-01T10:00:00.000Z');
    const own = ctx.store.seed(userId, 'Mine', '2026-09-01T10:00:00.000Z');

    for (const body of [
      { message: 'hi', clientMessageId: randomUUID(), conversationId: foreign.id },
      { message: 'hi', clientMessageId: randomUUID(), conversationId: randomUUID() },
      { message: 'hi', clientMessageId: randomUUID(), conversationId: own.id, replaceMessageId: own.messages[1]!.id }, // an assistant reply
    ]) {
      const res = await stream(body);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'not_found');
    }
    assert.equal(ctx.chat.requests.length, 0);
    assert.equal(ctx.quota.used.size, 0);
  });

  it('replays a retried message as a single done frame, without streaming or charging again', async () => {
    ctx.chat.streamChunks = ['QOBO builds websites.'];
    const clientMessageId = randomUUID();
    const first = await stream({ message: 'What is QOBO?', clientMessageId });
    const retry = await stream({ message: 'What is QOBO?', clientMessageId });

    const frames = parseFrames(retry.text);
    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['done'],
      'a saved answer is not re-enacted as tokens',
    );
    const done = frames[0]!.data as unknown as { replayed: boolean; assistantMessage: { id: string } };
    assert.equal(done.replayed, true);
    assert.equal(done.assistantMessage.id, (parseFrames(first.text).at(-1)!.data as unknown as { assistantMessage: { id: string } }).assistantMessage.id);
    assert.equal(ctx.chat.requests.length, 1, 'no second model call');
    assert.equal(ctx.quota.used.get(userId), 1, 'no second charge');
  });

  it('rejects a clientMessageId reused in another conversation', async () => {
    const clientMessageId = randomUUID();
    await stream({ message: 'What is QOBO?', clientMessageId });
    const other = ctx.store.seed(userId, 'Other', '2026-09-01T10:00:00.000Z');

    const res = await stream({ message: 'What is QOBO?', clientMessageId, conversationId: other.id });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'conflict');
  });

  it('enforces the daily cap as an ordinary 429, before the stream opens', async () => {
    ctx.quota.limit = 1;
    await stream({ message: 'first', clientMessageId: randomUUID() });

    const res = await stream({ message: 'second', clientMessageId: randomUUID() });
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'quota_exceeded');
    assert.equal(res.body.error.details.limit, 1);
    assert.ok(res.body.error.details.resetsAt);
    assert.equal(ctx.chat.requests.length, 1);
  });

  it('reports a failure that lands after the stream opened as an error frame, saving nothing', async () => {
    ctx.chat.streamChunks = ['Starting to answ'];
    ctx.chat.respondWith = new AnswerUnavailableError('generation', new Error('503'));

    const res = await stream({ message: 'What does QOBO do?', clientMessageId: randomUUID() });
    const frames = parseFrames(res.text);

    assert.equal(res.status, 200, 'the status line was already sent; the failure travels in the stream');
    assert.deepEqual(deltas(frames), ['Starting to answ']);
    assert.equal(frames.at(-1)!.event, 'error');
    assert.equal(frames.at(-1)!.data.code, 'service_unavailable');
    assert.match(frames.at(-1)!.data.message as string, /temporarily unavailable/);
    assert.equal(only(frames, 'done').length, 0);
    assert.equal(ctx.exchanges.appended.length, 0, 'a failed turn writes nothing');
    assert.equal(ctx.store.conversations.length, 0);
  });

  it('reports a timed-out turn as an error frame on the same 45-second budget', async () => {
    ctx.chat.respondWith = 'hang';
    const res = await stream({ message: 'What does QOBO do?', clientMessageId: randomUUID() });
    const last = parseFrames(res.text).at(-1)!;

    assert.equal(res.status, 200);
    assert.equal(last.event, 'error');
    assert.equal(last.data.code, 'timeout');
    assert.equal(ctx.exchanges.appended.length, 0);
  });

  it('reports a failed save as an error frame', async () => {
    ctx.chat.streamChunks = ['A complete answer.'];
    ctx.exchanges.failWith = new Error('database is down');

    const res = await stream({ message: 'What does QOBO do?', clientMessageId: randomUUID() });
    const frames = parseFrames(res.text);

    assert.deepEqual(deltas(frames), ['A complete answer.']);
    assert.equal(frames.at(-1)!.event, 'error');
    assert.equal(frames.at(-1)!.data.code, 'internal_error');
    assert.equal(only(frames, 'done').length, 0);
  });

  it('tells the browser to discard a draft the pipeline abandoned', async () => {
    // What a retry or the fallback model does: the half-written answer is retracted
    // and the next attempt starts over.
    ctx.chat.streamChunks = ['half an ans', null, 'QOBO builds ', 'websites.'];
    const res = await stream({ message: 'What does QOBO do?', clientMessageId: randomUUID() });
    const frames = parseFrames(res.text);

    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['delta', 'reset', 'delta', 'delta', 'done'],
    );
    assert.deepEqual(deltas(frames).slice(1), ['QOBO builds ', 'websites.']);
    assert.equal((frames.at(-1)!.data as unknown as { assistantMessage: { content: string } }).assistantMessage.content, 'QOBO builds websites through WhatsApp [1].');
  });

  it('sends a fixed reply straight to done, without pretending tokens streamed', async () => {
    for (const reply of [
      { intent: 'off_topic', status: 'redirected', content: 'I can only help with QOBO.' },
      { intent: 'smalltalk', status: 'answered', content: 'Hello!' },
    ] as const) {
      ctx = buildTestApp();
      const user = ctx.verifier.addUser();
      ctx.chat.respondWith = { ...reply, sources: [], metadata: { router: { source: 'model', model: 'm', language: 'en', smalltalkType: 'other' }, latencyMs: 3 } };

      const res = await request(ctx.app).post('/api/chat/stream').set('Authorization', `Bearer ${user.token}`).send({ message: 'hey', clientMessageId: randomUUID() });
      const frames = parseFrames(res.text);

      assert.deepEqual(
        frames.map((frame) => frame.event),
        ['done'],
        reply.intent,
      );
      assert.equal((frames[0]!.data as unknown as { assistantMessage: { content: string } }).assistantMessage.content, reply.content);
    }
  });
});
