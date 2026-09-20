import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/api/errors.ts';
import type { ChatMessage, ConversationSummary, SendMessageResponse } from '../src/api/types.ts';
import { chatReducer, initialChatState, pendingEntry, timeline, type ChatAction, type ChatState } from '../src/chat/conversation-state.ts';
import { runSend, type SendDeps } from '../src/chat/send.ts';

const conversation: ConversationSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'What does QOBO do?',
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:05.000Z',
};

const userMessage: ChatMessage = { id: 'u1', role: 'user', content: 'What does QOBO do?', intent: null, status: null, sources: [], createdAt: conversation.createdAt };

/** What the API saves: labelled, cited and guarded — not what was streamed. */
const assistantMessage: ChatMessage = {
  id: 'a1',
  role: 'assistant',
  content: '**General information** (from web research, not specific to QOBO)\n\nQOBO builds websites through WhatsApp [1].',
  intent: 'qobo',
  status: 'answered',
  sources: [{ title: 'QOBO Home', url: 'https://qobo.dev/', kind: 'qobo' }],
  createdAt: conversation.updatedAt,
};

const response: SendMessageResponse = { conversation, userMessage, assistantMessage, replayed: false };

const reduce = (state: ChatState, ...actions: ChatAction[]): ChatState => actions.reduce(chatReducer, state);
const start: ChatAction = { type: 'send/start', clientMessageId: 'c1', text: 'What does QOBO do?', startedAt: 1_000 };

function fakeDeps(streamMessage: SendDeps['client']['streamMessage'], ids: string[] = ['generated-id']): { deps: SendDeps; actions: ChatAction[] } {
  const actions: ChatAction[] = [];
  const queue = [...ids];
  return {
    actions,
    deps: {
      client: { streamMessage },
      dispatch: (action) => actions.push(action),
      newId: () => queue.shift() ?? 'exhausted',
      now: () => 1_234,
    },
  };
}

describe('a reply arriving as it is written', () => {
  it('starts with nothing streamed', () => {
    const state = reduce(initialChatState, start);
    assert.equal(state.outgoing?.streamingText, '');
    assert.equal(pendingEntry(state)?.streamingText, '');
  });

  it('accumulates the text in order', () => {
    const state = reduce(initialChatState, start, { type: 'send/delta', text: 'QOBO builds ' }, { type: 'send/delta', text: 'websites ' }, { type: 'send/delta', text: 'through WhatsApp.' });

    assert.equal(state.outgoing?.streamingText, 'QOBO builds websites through WhatsApp.');
    assert.equal(pendingEntry(state)?.streamingText, 'QOBO builds websites through WhatsApp.');
  });

  it('drops everything shown so far on a reset, and keeps accumulating after it', () => {
    const state = reduce(
      initialChatState,
      start,
      { type: 'send/delta', text: 'half an ans' },
      { type: 'send/reset' },
      { type: 'send/delta', text: 'QOBO builds websites.' },
    );

    assert.equal(state.outgoing?.streamingText, 'QOBO builds websites.');
  });

  it('keeps the attempt itself untouched by a reset', () => {
    const streamed = reduce(initialChatState, start, { type: 'send/delta', text: 'half' });
    const afterReset = chatReducer(streamed, { type: 'send/reset' });

    assert.equal(afterReset.outgoing?.clientMessageId, 'c1', 'the message id survives, so a retry still replays');
    assert.equal(afterReset.outgoing?.startedAt, 1_000);
    assert.equal(afterReset.outgoing?.text, 'What does QOBO do?');
  });

  it('replaces the streamed draft with the saved reply, never appends to it', () => {
    const streaming = reduce(initialChatState, start, { type: 'send/delta', text: 'QOBO builds websites through WhatsApp.' });
    const done = chatReducer(streaming, { type: 'send/succeeded', response });

    assert.equal(done.outgoing, null, 'the draft is gone');
    assert.deepEqual(done.messages, [userMessage, assistantMessage]);
    assert.equal(done.messages[1]!.content, assistantMessage.content, 'the label and citation come from the saved reply');
    assert.ok(!done.messages.some((message) => message.content === 'QOBO builds websites through WhatsApp.'), 'the provisional text is not kept anywhere');
    assert.equal(done.lastReplyId, 'a1');
  });

  it('discards the draft when the attempt fails, since nothing was saved', () => {
    const streaming = reduce(initialChatState, start, { type: 'send/delta', text: 'Starting to answ' });
    const error = new ApiError({ status: 200, code: 'service_unavailable', message: 'busy' });
    const failed = chatReducer(streaming, { type: 'send/failed', error });

    assert.equal(failed.outgoing, null);
    assert.deepEqual(failed.messages, []);
    assert.equal(failed.failure?.text, 'What does QOBO do?', 'the question is kept so it can be retried');
    assert.equal(failed.failure?.stopped, false);
  });

  it('discards the draft on Stop, and still records it as stopped', () => {
    const streaming = reduce(initialChatState, start, { type: 'send/delta', text: 'Starting to answ' });
    const stopped = chatReducer(streaming, { type: 'send/stopped' });

    assert.equal(stopped.outgoing, null);
    assert.equal(stopped.failure?.stopped, true);
    assert.equal(stopped.failure?.clientMessageId, 'c1', 'retrying reuses the id, so the saved reply is replayed');
  });

  it('ignores frames that arrive once the attempt is over', () => {
    const settled = reduce(initialChatState, start, { type: 'send/succeeded', response });

    assert.equal(chatReducer(settled, { type: 'send/delta', text: 'late' }), settled);
    assert.equal(chatReducer(settled, { type: 'send/reset' }), settled);
  });

  it('ignores a delta that is not text, rather than showing it', () => {
    const state = reduce(initialChatState, start, { type: 'send/delta', text: 'real text' });

    for (const text of [undefined, null, 42, {}] as unknown[]) {
      assert.equal(chatReducer(state, { type: 'send/delta', text } as ChatAction), state, `${String(text)} is dropped`);
    }
    assert.equal(chatReducer(state, { type: 'send/delta', text: '' }), state, 'an empty delta changes nothing');
  });

  it('shows the reply where the message being edited stands, not at the bottom', () => {
    const earlier: ChatMessage[] = [
      { ...userMessage, id: 'u0', content: 'first question' },
      { ...assistantMessage, id: 'a0', content: 'first answer' },
      { ...userMessage, id: 'u1', content: 'second question' },
      { ...assistantMessage, id: 'a1', content: 'second answer' },
    ];
    const state = reduce(
      { ...initialChatState, conversationId: conversation.id, messages: earlier },
      { type: 'send/start', clientMessageId: 'c2', text: 'edited question', startedAt: 2_000, replacesMessageId: 'u1' },
      { type: 'send/delta', text: 'a new answer being written' },
    );

    const entries = timeline(state);
    assert.deepEqual(
      entries.map((entry) => (entry.kind === 'message' ? entry.message.id : `pending:${entry.pending.streamingText}`)),
      ['u0', 'a0', 'pending:a new answer being written'],
      'the edit streams where it stands, and the reply it is replacing steps aside meanwhile',
    );
  });
});

describe('runSend with a streamed reply', () => {
  it('reports each piece as it arrives, then commits the saved exchange', async () => {
    const { deps, actions } = fakeDeps(async (_request, handlers) => {
      handlers.onDelta('QOBO builds ');
      handlers.onDelta('websites.');
      return response;
    });

    const result = await runSend({ state: initialChatState, text: 'What does QOBO do?', deps });

    assert.deepEqual(actions, [
      { type: 'send/start', clientMessageId: 'generated-id', text: 'What does QOBO do?', startedAt: 1_234 },
      { type: 'send/delta', text: 'QOBO builds ' },
      { type: 'send/delta', text: 'websites.' },
      { type: 'send/succeeded', response },
    ]);
    assert.equal(result, response);

    const state = actions.reduce(chatReducer, initialChatState);
    assert.equal(state.outgoing, null);
    assert.deepEqual(state.messages, [userMessage, assistantMessage]);
  });

  it('passes a reset through as the API retracts a draft', async () => {
    const { deps, actions } = fakeDeps(async (_request, handlers) => {
      handlers.onDelta('half an ans');
      handlers.onReset?.();
      handlers.onDelta('QOBO builds websites.');
      return response;
    });

    await runSend({ state: initialChatState, text: 'What does QOBO do?', deps });

    assert.deepEqual(
      actions.map((action) => action.type),
      ['send/start', 'send/delta', 'send/reset', 'send/delta', 'send/succeeded'],
    );
  });

  it('sends the same request the non-streaming call sent, including an edit', async () => {
    const sent: unknown[] = [];
    const { deps } = fakeDeps(async (request) => {
      sent.push(request);
      return response;
    });
    const state = { ...initialChatState, conversationId: conversation.id };

    await runSend({ state, text: '  What does QOBO do?  ', deps, replaceMessageId: 'u1' });

    assert.deepEqual(sent, [{ message: 'What does QOBO do?', clientMessageId: 'generated-id', conversationId: conversation.id, replaceMessageId: 'u1' }]);
  });

  it('keeps what was streamed out of state when the stream fails midway', async () => {
    const error = new ApiError({ status: 200, code: 'service_unavailable', message: 'busy' });
    const { deps, actions } = fakeDeps(async (_request, handlers) => {
      handlers.onDelta('Starting to answ');
      throw error;
    });

    assert.equal(await runSend({ state: initialChatState, text: 'What does QOBO do?', deps }), null);
    assert.deepEqual(actions.at(-1), { type: 'send/failed', error });

    const state = actions.reduce(chatReducer, initialChatState);
    assert.deepEqual(state.messages, []);
    assert.equal(state.outgoing, null);
  });

  it('records Stop as stopped even after text had started arriving', async () => {
    const controller = new AbortController();
    const { deps, actions } = fakeDeps(async (_request, handlers) => {
      handlers.onDelta('Starting to answ');
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    assert.equal(await runSend({ state: initialChatState, text: 'What does QOBO do?', deps, signal: controller.signal }), null);
    assert.deepEqual(actions.at(-1), { type: 'send/stopped' });
  });

  it('commits a reply that never streamed, such as a replay or a redirect', async () => {
    const replayed = { ...response, replayed: true };
    const { deps, actions } = fakeDeps(async () => replayed);

    await runSend({ state: initialChatState, text: 'What does QOBO do?', deps });

    assert.deepEqual(
      actions.map((action) => action.type),
      ['send/start', 'send/succeeded'],
      'no delta is invented for an answer that already existed',
    );
  });
});
