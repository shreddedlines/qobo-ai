import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/api/errors.ts';
import type { ConversationSummary } from '../src/api/types.ts';
import {
  afterDeleteTarget,
  historyReducer,
  initialHistoryState,
  isActiveConversation,
  nextFocusIndex,
  type HistoryAction,
  type HistoryState,
} from '../src/history/history-state.ts';

const conversation = (id: string, updatedAt: string, title = `Chat ${id}`): ConversationSummary => ({
  id,
  title,
  createdAt: '2026-09-18T08:00:00.000Z',
  updatedAt,
});

const first = conversation('a', '2026-09-18T12:00:00.000Z', 'What do your plans include?');
const second = conversation('b', '2026-09-17T12:00:00.000Z');
const third = conversation('c', '2026-09-10T12:00:00.000Z');

const reduce = (state: HistoryState, ...actions: HistoryAction[]): HistoryState => actions.reduce(historyReducer, state);
const ready = reduce(initialHistoryState, { type: 'loaded', conversations: [first, second, third] });

describe('loading the history', () => {
  it('starts out loading', () => {
    assert.equal(initialHistoryState.status, 'loading');
    assert.deepEqual(initialHistoryState.conversations, []);
  });

  it('becomes ready with the loaded conversations', () => {
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.conversations.map((item) => item.id), ['a', 'b', 'c']);
  });

  it('records a load failure and clears it when retried', () => {
    const error = new ApiError({ status: 0, code: 'network', message: 'offline' });
    const failed = reduce(initialHistoryState, { type: 'failed', error });
    assert.equal(failed.status, 'error');
    assert.equal(failed.error, error);

    const retrying = reduce(failed, { type: 'load' });
    assert.equal(retrying.status, 'loading');
    assert.equal(retrying.error, null);
  });

  it('is ready and empty for someone with no conversations yet', () => {
    const empty = reduce(initialHistoryState, { type: 'loaded', conversations: [] });
    assert.equal(empty.status, 'ready');
    assert.deepEqual(empty.conversations, []);
  });
});

describe('upserting a conversation', () => {
  it('adds a new conversation at the front', () => {
    const created = conversation('new', '2026-09-18T13:00:00.000Z', 'Do you offer SEO?');
    const state = reduce(ready, { type: 'upsert', conversation: created });
    assert.deepEqual(state.conversations.map((item) => item.id), ['new', 'a', 'b', 'c']);
  });

  it('moves an existing conversation to the front and updates its title and time', () => {
    const touched = { ...third, title: 'Renamed by a new first message', updatedAt: '2026-09-18T13:30:00.000Z' };
    const state = reduce(ready, { type: 'upsert', conversation: touched });
    assert.deepEqual(state.conversations.map((item) => item.id), ['c', 'a', 'b']);
    assert.equal(state.conversations[0]?.title, 'Renamed by a new first message');
    assert.equal(state.conversations.length, 3, 'no duplicate row for the same conversation');
  });

  it('shows a conversation even if the list had failed to load', () => {
    const failed = reduce(initialHistoryState, { type: 'failed', error: new Error('offline') });
    const state = reduce(failed, { type: 'upsert', conversation: first });
    assert.equal(state.status, 'ready');
    assert.equal(state.error, null);
  });
});

describe('deleting a conversation', () => {
  it('marks the row as deleting while the request runs', () => {
    const state = reduce(ready, { type: 'delete/start', id: 'b' });
    assert.equal(state.deletingId, 'b');
    assert.deepEqual(state.conversations.map((item) => item.id), ['a', 'b', 'c'], 'the row stays until the API confirms');
  });

  it('removes the row and reports what was deleted, for the announcement', () => {
    const state = reduce(ready, { type: 'delete/start', id: 'a' }, { type: 'delete/succeeded', id: 'a' });
    assert.deepEqual(state.conversations.map((item) => item.id), ['b', 'c']);
    assert.equal(state.deletingId, null);
    assert.equal(state.deletedTitle, 'What do your plans include?');
  });

  it('keeps the conversation when the delete fails, and explains why', () => {
    const error = new ApiError({ status: 503, code: 'service_unavailable', message: 'busy' });
    const state = reduce(ready, { type: 'delete/start', id: 'a' }, { type: 'delete/failed', error });
    assert.deepEqual(state.conversations.map((item) => item.id), ['a', 'b', 'c']);
    assert.equal(state.deletingId, null);
    assert.equal(state.deleteError, error);
  });

  it('clears the notices once they have been shown', () => {
    const state = reduce(ready, { type: 'delete/start', id: 'a' }, { type: 'delete/succeeded', id: 'a' }, { type: 'notice/clear' });
    assert.equal(state.deletedTitle, null);
    assert.equal(state.deleteError, null);
  });

  it('leaves a second delete in progress alone', () => {
    const state = reduce(ready, { type: 'delete/start', id: 'b' }, { type: 'delete/succeeded', id: 'a' });
    assert.equal(state.deletingId, 'b');
  });
});

describe('where to go after a delete', () => {
  it('stays put when another conversation was deleted', () => {
    assert.deepEqual(afterDeleteTarget(ready.conversations, 'b', 'a'), { navigate: false, to: '/chat/a' });
  });

  it('opens the next conversation when the open one is deleted', () => {
    assert.deepEqual(afterDeleteTarget(ready.conversations, 'a', 'a'), { navigate: true, to: '/chat/b' });
    assert.deepEqual(afterDeleteTarget(ready.conversations, 'b', 'b'), { navigate: true, to: '/chat/a' });
  });

  it('falls back to a new chat when nothing is left', () => {
    assert.deepEqual(afterDeleteTarget([first], 'a', 'a'), { navigate: true, to: '/chat' });
  });

  it('stays on a new chat when a conversation is deleted from it', () => {
    assert.deepEqual(afterDeleteTarget(ready.conversations, 'a', null), { navigate: false, to: '/chat/' });
  });
});

describe('selection', () => {
  it('marks only the conversation in the address bar as active', () => {
    assert.equal(isActiveConversation('a', 'a'), true);
    assert.equal(isActiveConversation('a', 'b'), false);
    assert.equal(isActiveConversation('a', null), false, 'a new chat has no active conversation');
  });
});

describe('arrow-key movement', () => {
  it('moves down and up, clamping at the ends', () => {
    assert.equal(nextFocusIndex(0, 'ArrowDown', 3), 1);
    assert.equal(nextFocusIndex(2, 'ArrowDown', 3), 2);
    assert.equal(nextFocusIndex(1, 'ArrowUp', 3), 0);
    assert.equal(nextFocusIndex(0, 'ArrowUp', 3), 0);
  });

  it('jumps to the first and last rows', () => {
    assert.equal(nextFocusIndex(2, 'Home', 3), 0);
    assert.equal(nextFocusIndex(0, 'End', 3), 2);
  });

  it('ignores other keys and an empty list, so typing is never swallowed', () => {
    for (const key of ['Enter', 'Tab', 'a', 'Escape', ' ']) {
      assert.equal(nextFocusIndex(0, key, 3), null, key);
    }
    assert.equal(nextFocusIndex(0, 'ArrowDown', 0), null);
  });
});
