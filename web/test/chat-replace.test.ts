import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/api/errors.ts';
import type { ChatMessage, ConversationSummary, SendMessageResponse } from '../src/api/types.ts';
import {
  chatReducer,
  initialChatState,
  pendingEntry,
  replaceExchange,
  timeline,
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

const message = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({
  id,
  role,
  content,
  intent: role === 'assistant' ? 'qobo' : null,
  status: role === 'assistant' ? 'answered' : null,
  sources: [],
  createdAt: '2026-09-18T10:00:00.000Z',
});

/** Two saved exchanges, which is what an edit starts from. */
const saved = [
  message('u1', 'user', 'What do your plans include?'),
  message('a1', 'assistant', 'Starter is ₹499.'),
  message('u2', 'user', 'Do you offer SEO?'),
  message('a2', 'assistant', 'Yes, SEO is included.'),
];

const loaded: ChatState = chatReducer(initialChatState, { type: 'history/loaded', conversation, messages: saved });

const editedUser = message('u1', 'user', 'What do your plans include, and is SEO extra?');
const editedReply = message('a1', 'assistant', 'Starter is ₹499 and SEO is included.');
const editedResponse: SendMessageResponse = {
  conversation,
  userMessage: editedUser,
  assistantMessage: editedReply,
  replayed: false,
};

describe('replaceExchange', () => {
  it('puts the edited message where the original was, replacing its reply', () => {
    const result = replaceExchange(saved, 'u1', editedUser, editedReply);
    assert.deepEqual(
      result.map((entry) => [entry.id, entry.content]),
      [
        ['u1', 'What do your plans include, and is SEO extra?'],
        ['a1', 'Starter is ₹499 and SEO is included.'],
        ['u2', 'Do you offer SEO?'],
        ['a2', 'Yes, SEO is included.'],
      ],
    );
  });

  it('adds nothing and removes nothing', () => {
    assert.equal(replaceExchange(saved, 'u1', editedUser, editedReply).length, saved.length);
    assert.equal(replaceExchange(saved, 'u2', message('u2', 'user', 'edited'), message('a2', 'assistant', 'new')).length, saved.length);
  });

  it('replaces a later exchange without touching the earlier one', () => {
    const result = replaceExchange(saved, 'u2', message('u2', 'user', 'edited follow-up'), message('a2', 'assistant', 'a new reply'));
    assert.deepEqual(
      result.map((entry) => entry.content),
      ['What do your plans include?', 'Starter is ₹499.', 'edited follow-up', 'a new reply'],
    );
  });

  it('leaves no copy of the replaced text anywhere', () => {
    const result = replaceExchange(saved, 'u1', editedUser, editedReply);
    assert.ok(!result.some((entry) => entry.content === 'What do your plans include?'), 'the old question is gone');
    assert.ok(!result.some((entry) => entry.content === 'Starter is ₹499.'), 'the old reply is gone');
  });

  it('writes the reply in when the message had none', () => {
    const lonely = [message('u1', 'user', 'a question with no reply')];
    const result = replaceExchange(lonely, 'u1', editedUser, editedReply);
    assert.deepEqual(
      result.map((entry) => entry.role),
      ['user', 'assistant'],
    );
  });

  it('falls back to appending when the target is gone', () => {
    const result = replaceExchange(saved, 'missing', editedUser, editedReply);
    assert.equal(result.length, saved.length, 'the ids already exist, so nothing is duplicated');
  });
});

describe('the reducer on a replacement', () => {
  const start: ChatAction = { type: 'send/start', clientMessageId: 'c1', text: editedUser.content, startedAt: 1_000, replacesMessageId: 'u1' };

  it('replaces in place rather than appending', () => {
    const state = [start, { type: 'send/succeeded' as const, response: editedResponse, replacedMessageId: 'u1' }].reduce(chatReducer, loaded);
    assert.equal(state.messages.length, 4, 'the conversation is the same length');
    assert.equal(state.messages[0]?.content, editedUser.content);
    assert.equal(state.messages[1]?.content, editedReply.content);
    assert.equal(state.conversationId, conversation.id, 'the same conversation');
    assert.equal(state.lastReplyId, 'a1', 'the regenerated reply is the one announced');
  });

  it('still appends when nothing is being replaced', () => {
    const appended = [
      { type: 'send/start' as const, clientMessageId: 'c2', text: 'a brand new question', startedAt: 1 },
      {
        type: 'send/succeeded' as const,
        response: { conversation, userMessage: message('u3', 'user', 'a brand new question'), assistantMessage: message('a3', 'assistant', 'an answer'), replayed: false },
      },
    ].reduce(chatReducer, loaded);
    assert.equal(appended.messages.length, 6);
  });

  it('keeps the conversation untouched while the replacement is still in flight', () => {
    const state = chatReducer(loaded, start);
    assert.deepEqual(
      state.messages.map((entry) => entry.content),
      saved.map((entry) => entry.content),
      'nothing is changed until the API confirms',
    );
    assert.equal(pendingEntry(state)?.replacesMessageId, 'u1');
  });

  it('leaves the original exchange in place when the replacement fails', () => {
    const state = [start, { type: 'send/failed' as const, error: new ApiError({ status: 503, code: 'service_unavailable', message: 'busy' }) }].reduce(
      chatReducer,
      loaded,
    );
    assert.deepEqual(
      state.messages.map((entry) => entry.content),
      saved.map((entry) => entry.content),
      'a failed edit cannot corrupt the conversation',
    );
    assert.equal(state.failure?.text, editedUser.content, 'the edited text is kept for a retry');
  });

  it('leaves the original exchange in place when the replacement is stopped', () => {
    const state = [start, { type: 'send/stopped' as const }].reduce(chatReducer, loaded);
    assert.deepEqual(
      state.messages.map((entry) => entry.content),
      saved.map((entry) => entry.content),
    );
  });
});

describe('what the conversation shows during an edit', () => {
  const start: ChatAction = { type: 'send/start', clientMessageId: 'c1', text: editedUser.content, startedAt: 1_000, replacesMessageId: 'u1' };

  it('shows the edit where the message it replaces stands', () => {
    const entries = timeline(chatReducer(loaded, start));
    assert.deepEqual(
      entries.map((entry) => (entry.kind === 'message' ? entry.message.content : `pending:${entry.pending.text}`)),
      [`pending:${editedUser.content}`, 'Do you offer SEO?', 'Yes, SEO is included.'],
      'the edit stands in position and the reply it replaces steps aside',
    );
  });

  it('never shows the edit at the bottom while it is being generated', () => {
    const entries = timeline(chatReducer(loaded, start));
    assert.equal(entries.at(-1)?.kind, 'message', 'the last entry is still the saved conversation');
  });

  it('keeps an ordinary new message at the bottom', () => {
    const entries = timeline(chatReducer(loaded, { type: 'send/start', clientMessageId: 'c2', text: 'a new question', startedAt: 1 }));
    assert.equal(entries.length, 5);
    assert.deepEqual(entries.at(-1), { kind: 'pending', pending: { kind: 'waiting', clientMessageId: 'c2', text: 'a new question', startedAt: 1 } });
  });

  it('puts a failed edit last, with the original exchange still visible', () => {
    const failed = [start, { type: 'send/failed' as const, error: new Error('nope') }].reduce(chatReducer, loaded);
    const entries = timeline(failed);
    assert.deepEqual(
      entries.map((entry) => (entry.kind === 'message' ? entry.message.content : 'pending')),
      ['What do your plans include?', 'Starter is ₹499.', 'Do you offer SEO?', 'Yes, SEO is included.', 'pending'],
      'the stored exchange is shown as it is, and the retry sits with its controls',
    );
  });

  it('shows the saved conversation unchanged when nothing is pending', () => {
    assert.deepEqual(
      timeline(loaded).map((entry) => (entry.kind === 'message' ? entry.message.id : 'pending')),
      ['u1', 'a1', 'u2', 'a2'],
    );
  });

  it('does not lose the pending entry if the target disappears mid-flight', () => {
    const orphaned: ChatState = { ...chatReducer(loaded, start), messages: [] };
    assert.deepEqual(timeline(orphaned), [{ kind: 'pending', pending: { kind: 'waiting', clientMessageId: 'c1', text: editedUser.content, startedAt: 1_000, replacesMessageId: 'u1' } }]);
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

describe('runSend for an edit', () => {
  it('asks the API to replace the message, in the same conversation', async () => {
    const sent: unknown[] = [];
    const { deps, actions } = fakeDeps(async (request) => {
      sent.push(request);
      return editedResponse;
    });

    await runSend({ state: loaded, text: editedUser.content, deps, replaceMessageId: 'u1' });

    assert.deepEqual(sent, [
      { message: editedUser.content, clientMessageId: 'generated-id', conversationId: conversation.id, replaceMessageId: 'u1' },
    ]);
    assert.equal((actions[0] as { replacesMessageId?: string }).replacesMessageId, 'u1');
    assert.equal((actions[1] as { replacedMessageId?: string }).replacedMessageId, 'u1');
  });

  it('sends no replaceMessageId for an ordinary message', async () => {
    const sent: unknown[] = [];
    const { deps } = fakeDeps(async (request) => {
      sent.push(request);
      return editedResponse;
    });

    await runSend({ state: loaded, text: 'an ordinary question', deps });

    assert.deepEqual(sent, [{ message: 'an ordinary question', clientMessageId: 'generated-id', conversationId: conversation.id }]);
  });

  it('reports a failed edit without changing the conversation', async () => {
    const error = new ApiError({ status: 503, code: 'service_unavailable', message: 'busy' });
    const { deps, actions } = fakeDeps(async () => {
      throw error;
    });

    await runSend({ state: loaded, text: editedUser.content, deps, replaceMessageId: 'u1' });

    const state = actions.reduce(chatReducer, loaded);
    assert.deepEqual(
      state.messages.map((entry) => entry.content),
      saved.map((entry) => entry.content),
    );
    assert.equal(state.failure?.error, error);
  });
});
