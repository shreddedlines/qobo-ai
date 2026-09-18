import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/api/errors.ts';
import type { ChatMessage, ConversationSummary, SendMessageResponse } from '../src/api/types.ts';
import {
  chatReducer,
  chatStateFor,
  idForAttempt,
  initialChatState,
  isSending,
  pendingEntry,
  type ChatAction,
  type ChatState,
} from '../src/chat/conversation-state.ts';
import { runSend, type SendDeps } from '../src/chat/send.ts';

const conversation: ConversationSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'What do your plans include?',
  createdAt: '2026-09-18T10:00:00.000Z',
  updatedAt: '2026-09-18T10:00:05.000Z',
};

const userMessage: ChatMessage = {
  id: 'u1',
  role: 'user',
  content: 'What do your plans include?',
  intent: null,
  status: null,
  sources: [],
  createdAt: '2026-09-18T10:00:00.000Z',
};

const assistantMessage: ChatMessage = {
  id: 'a1',
  role: 'assistant',
  content: 'Starter is ₹499 [1].',
  intent: 'qobo',
  status: 'answered',
  sources: [{ title: 'Pricing', url: 'https://qobo.dev/pricing', kind: 'qobo' }],
  createdAt: '2026-09-18T10:00:05.000Z',
};

const response: SendMessageResponse = { conversation, userMessage, assistantMessage, replayed: false };

const reduce = (state: ChatState, ...actions: ChatAction[]): ChatState => actions.reduce(chatReducer, state);

describe('loading a conversation', () => {
  it('starts in a loading state only when there is a conversation to load', () => {
    assert.equal(chatStateFor(conversation.id).loadingHistory, true);
    assert.equal(chatStateFor(null).loadingHistory, false);
  });

  it('replaces the messages and keeps the title', () => {
    const state = reduce(chatStateFor(conversation.id), { type: 'history/loaded', conversation, messages: [userMessage, assistantMessage] });
    assert.deepEqual(state.messages, [userMessage, assistantMessage]);
    assert.equal(state.title, conversation.title);
    assert.equal(state.loadingHistory, false);
  });

  it('records a load failure without losing the conversation id', () => {
    const error = new ApiError({ status: 404, code: 'not_found', message: 'Conversation not found' });
    const state = reduce(chatStateFor(conversation.id), { type: 'history/failed', error });
    assert.equal(state.historyError, error);
    assert.equal(state.loadingHistory, false);
    assert.equal(state.conversationId, conversation.id);
  });
});

describe('optimistic sending', () => {
  const started: ChatAction = { type: 'send/start', clientMessageId: 'c1', text: 'What do your plans include?', startedAt: 1_000 };

  it('shows the user message immediately, before any reply exists', () => {
    const state = reduce(initialChatState, started);
    assert.deepEqual(pendingEntry(state), { kind: 'waiting', clientMessageId: 'c1', text: 'What do your plans include?', startedAt: 1_000 });
    assert.equal(isSending(state), true);
    assert.deepEqual(state.messages, [], 'the optimistic message is not mixed into saved messages');
  });

  it('replaces the optimistic message with the saved pair on success', () => {
    const state = reduce(initialChatState, started, { type: 'send/succeeded', response });
    assert.deepEqual(state.messages, [userMessage, assistantMessage]);
    assert.equal(pendingEntry(state), null);
    assert.equal(isSending(state), false);
    assert.equal(state.conversationId, conversation.id);
  });

  it('does not duplicate messages when the API replays a saved exchange', () => {
    const state = reduce(
      initialChatState,
      started,
      { type: 'send/succeeded', response },
      { type: 'send/start', ...{ clientMessageId: 'c1', text: 'What do your plans include?', startedAt: 2_000 } },
      { type: 'send/succeeded', response: { ...response, replayed: true } },
    );
    assert.deepEqual(state.messages, [userMessage, assistantMessage]);
  });

  it('marks the reply that just arrived, for the screen-reader notice', () => {
    const state = reduce(initialChatState, started, { type: 'send/succeeded', response });
    assert.equal(state.lastReplyId, assistantMessage.id);
  });

  it('does not treat a loaded conversation as a new reply', () => {
    const afterSend = reduce(initialChatState, started, { type: 'send/succeeded', response });
    const afterLoad = reduce(afterSend, { type: 'history/loaded', conversation, messages: [userMessage, assistantMessage] });
    assert.equal(afterLoad.lastReplyId, null, 'opening a saved conversation must not announce a reply');
  });

  it('keeps the message text after a failure so it can be retried', () => {
    const error = new ApiError({ status: 504, code: 'timeout', message: 'too slow' });
    const state = reduce(initialChatState, started, { type: 'send/failed', error });
    assert.deepEqual(pendingEntry(state), { kind: 'failed', clientMessageId: 'c1', text: 'What do your plans include?' });
    assert.equal(state.failure?.error, error);
    assert.equal(isSending(state), false);
  });

  it('records Stop as stopped rather than as a failure', () => {
    const state = reduce(initialChatState, started, { type: 'send/stopped' });
    assert.equal(state.failure?.stopped, true);
    assert.equal(state.failure?.error, null);
    assert.deepEqual(pendingEntry(state), { kind: 'stopped', clientMessageId: 'c1', text: 'What do your plans include?' });
  });

  it('ignores a late failure or stop once nothing is in flight', () => {
    const settled = reduce(initialChatState, started, { type: 'send/succeeded', response });
    assert.equal(chatReducer(settled, { type: 'send/failed', error: new Error('late') }), settled);
    assert.equal(chatReducer(settled, { type: 'send/stopped' }), settled);
  });

  it('clears the failure notice when the next attempt starts, and on dismissal', () => {
    const failed = reduce(initialChatState, started, { type: 'send/failed', error: new Error('x') });
    assert.equal(reduce(failed, started).failure, null);
    assert.equal(reduce(failed, { type: 'failure/dismiss' }).failure, null);
  });
});

describe('client message ids', () => {
  const failed = reduce(initialChatState, { type: 'send/start', clientMessageId: 'c1', text: 'same question', startedAt: 1 }, {
    type: 'send/failed',
    error: new Error('x'),
  });

  it('generates one id per new user message', () => {
    assert.equal(idForAttempt(initialChatState, 'a question', () => 'fresh'), 'fresh');
  });

  it('reuses the id when retrying the same text, so the API replays instead of answering twice', () => {
    assert.equal(idForAttempt(failed, 'same question', () => 'fresh'), 'c1');
  });

  it('never reuses the id for different text, which would replay the wrong answer', () => {
    assert.equal(idForAttempt(failed, 'a different question', () => 'fresh'), 'fresh');
  });
});

function fakeDeps(sendMessage: SendDeps['client']['sendMessage'], ids: string[] = ['generated-id']): { deps: SendDeps; actions: ChatAction[] } {
  const actions: ChatAction[] = [];
  const queue = [...ids];
  return {
    actions,
    deps: {
      client: { sendMessage },
      dispatch: (action) => actions.push(action),
      newId: () => queue.shift() ?? 'exhausted',
      now: () => 1_234,
    },
  };
}

describe('runSend', () => {
  it('sends the trimmed message with the conversation id and the generated client id', async () => {
    const calls: unknown[] = [];
    const { deps, actions } = fakeDeps(async (request) => {
      calls.push(request);
      return response;
    });
    const state = { ...initialChatState, conversationId: conversation.id };

    const result = await runSend({ state, text: '  What do your plans include?  ', deps });

    assert.deepEqual(calls, [{ message: 'What do your plans include?', clientMessageId: 'generated-id', conversationId: conversation.id }]);
    assert.deepEqual(actions, [
      { type: 'send/start', clientMessageId: 'generated-id', text: 'What do your plans include?', startedAt: 1_234 },
      { type: 'send/succeeded', response },
    ]);
    assert.equal(result, response);
  });

  it('refuses an empty message without touching the API', async () => {
    const { deps, actions } = fakeDeps(async () => {
      throw new Error('should not be called');
    });
    assert.equal(await runSend({ state: initialChatState, text: '   \n ', deps }), null);
    assert.deepEqual(actions, []);
  });

  it('reports a failure and keeps the text for a retry', async () => {
    const error = new ApiError({ status: 503, code: 'service_unavailable', message: 'busy' });
    const { deps, actions } = fakeDeps(async () => {
      throw error;
    });

    assert.equal(await runSend({ state: initialChatState, text: 'hello', deps }), null);
    assert.deepEqual(actions.at(-1), { type: 'send/failed', error });
  });

  it('treats an aborted request as stopped, not failed', async () => {
    const controller = new AbortController();
    const { deps, actions } = fakeDeps(async (_request, options) => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError', signal: options?.signal });
    });

    assert.equal(await runSend({ state: initialChatState, text: 'hello', deps, signal: controller.signal }), null);
    assert.deepEqual(actions.at(-1), { type: 'send/stopped' });
  });

  it('retries with the same id, then the state holds no duplicate messages', async () => {
    const { deps, actions } = fakeDeps(async () => {
      throw new ApiError({ status: 0, code: 'network', message: 'offline' });
    }, ['first-id', 'second-id']);

    await runSend({ state: initialChatState, text: 'one question', deps });
    const afterFailure = actions.reduce(chatReducer, initialChatState);
    assert.equal(afterFailure.failure?.clientMessageId, 'first-id');

    const { deps: retryDeps, actions: retryActions } = fakeDeps(async () => response, ['unused-id']);
    await runSend({ state: afterFailure, text: 'one question', deps: retryDeps });
    assert.equal((retryActions[0] as { clientMessageId: string }).clientMessageId, 'first-id');
    assert.deepEqual(retryActions.reduce(chatReducer, afterFailure).messages, [userMessage, assistantMessage]);
  });
});

describe('sending an edited message', () => {
  const editedUser: ChatMessage = { ...userMessage, id: 'u2', content: 'What do your plans include, and is SEO extra?' };
  const editedReply: ChatMessage = { ...assistantMessage, id: 'a2', content: 'SEO is included.' };
  const editedResponse: SendMessageResponse = {
    conversation: { ...conversation, updatedAt: '2026-09-18T10:05:00.000Z' },
    userMessage: editedUser,
    assistantMessage: editedReply,
    replayed: false,
  };

  /** The state after one ordinary exchange, which is what an edit starts from. */
  const afterFirstExchange = reduce(
    initialChatState,
    { type: 'send/start', clientMessageId: 'first-id', text: userMessage.content, startedAt: 1 },
    { type: 'send/succeeded', response },
  );

  it('goes out as a new request, with an id of its own', async () => {
    const sent: unknown[] = [];
    const { deps } = fakeDeps(async (request) => {
      sent.push(request);
      return editedResponse;
    }, ['edited-id']);

    await runSend({ state: afterFirstExchange, text: editedUser.content, deps });

    assert.deepEqual(sent, [
      { message: editedUser.content, clientMessageId: 'edited-id', conversationId: conversation.id },
    ]);
  });

  it('adds the edited message and its reply, leaving the original pair in place', async () => {
    const { deps, actions } = fakeDeps(async () => editedResponse, ['edited-id']);
    await runSend({ state: afterFirstExchange, text: editedUser.content, deps });

    const state = actions.reduce(chatReducer, afterFirstExchange);
    assert.deepEqual(
      state.messages.map((message) => message.id),
      ['u1', 'a1', 'u2', 'a2'],
      'history keeps what was already said; the edit is appended',
    );
    assert.equal(state.messages[0]?.content, userMessage.content, 'the original message is untouched');
    assert.equal(state.conversationId, conversation.id, 'the edit stays in the same conversation');
    assert.equal(state.lastReplyId, 'a2', 'the new reply is the one announced');
  });

  it('does not reuse a failed attempt id once the text has been edited', () => {
    const failed = reduce(
      initialChatState,
      { type: 'send/start', clientMessageId: 'failed-id', text: 'original wording', startedAt: 1 },
      { type: 'send/failed', error: new ApiError({ status: 504, code: 'timeout', message: 'too slow' }) },
    );
    assert.equal(idForAttempt(failed, 'edited wording', () => 'fresh-id'), 'fresh-id');
  });

  it('still replays when an edit left the text unchanged', () => {
    const stopped = reduce(
      initialChatState,
      { type: 'send/start', clientMessageId: 'stopped-id', text: 'unchanged wording', startedAt: 1 },
      { type: 'send/stopped' },
    );
    assert.equal(
      idForAttempt(stopped, 'unchanged wording', () => 'fresh-id'),
      'stopped-id',
      'the same question keeps its id, so the API replays instead of answering twice',
    );
  });
});
