import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/api/errors.ts';
import type { ConversationSummary } from '../src/api/types.ts';
import { historyReducer, initialHistoryState, type HistoryAction, type HistoryState } from '../src/history/history-state.ts';
import { isUnchanged, MAX_TITLE_CHARS, normalizeTitle, titleProblem } from '../src/history/rename.ts';
import {
  readSidebarCollapsed,
  SIDEBAR_STORAGE_KEY,
  sidebarToggleLabel,
  writeSidebarCollapsed,
} from '../src/history/sidebar-preference.ts';

function fakeStorage(initial: Record<string, string> = {}, options: { throwOnRead?: boolean; throwOnWrite?: boolean } = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key: string) {
      if (options.throwOnRead) throw new Error('storage blocked');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (options.throwOnWrite) throw new Error('storage blocked');
      values.set(key, value);
    },
  };
}

describe('the sidebar collapse preference', () => {
  it('is expanded until someone collapses it', () => {
    assert.equal(readSidebarCollapsed(fakeStorage()), false);
    assert.equal(readSidebarCollapsed(undefined), false);
  });

  it('remembers a collapse and an expand', () => {
    const storage = fakeStorage();
    writeSidebarCollapsed(storage, true);
    assert.equal(storage.values.get(SIDEBAR_STORAGE_KEY), 'collapsed');
    assert.equal(readSidebarCollapsed(storage), true);

    writeSidebarCollapsed(storage, false);
    assert.equal(readSidebarCollapsed(storage), false, 'reopening is remembered too, not just collapsing');
  });

  it('treats an unreadable or nonsense value as expanded', () => {
    assert.equal(readSidebarCollapsed(fakeStorage({ [SIDEBAR_STORAGE_KEY]: 'sideways' })), false);
    assert.equal(readSidebarCollapsed(fakeStorage({}, { throwOnRead: true })), false);
  });

  it('survives a browser that refuses storage, as in a private window', () => {
    assert.doesNotThrow(() => writeSidebarCollapsed(fakeStorage({}, { throwOnWrite: true }), true));
  });

  it('says what the toggle will do, so the state is not left to an icon', () => {
    assert.equal(sidebarToggleLabel(false), 'Hide conversation sidebar');
    assert.equal(sidebarToggleLabel(true), 'Show conversation sidebar');
  });
});

describe('a conversation title', () => {
  it('accepts an ordinary name, trimmed', () => {
    assert.equal(normalizeTitle('  Pricing questions  '), 'Pricing questions');
    assert.equal(titleProblem('Pricing questions'), null);
  });

  it('refuses an empty or whitespace-only name', () => {
    for (const value of ['', '   ', '\n', '\t  \n']) {
      assert.equal(normalizeTitle(value), null, JSON.stringify(value));
      assert.equal(titleProblem(value), 'Enter a name for this chat.', JSON.stringify(value));
    }
  });

  it('refuses a name longer than the column allows', () => {
    const tooLong = 'x'.repeat(MAX_TITLE_CHARS + 1);
    assert.equal(normalizeTitle(tooLong), null);
    assert.match(titleProblem(tooLong) ?? '', /120 characters or fewer/);
    assert.equal(normalizeTitle('x'.repeat(MAX_TITLE_CHARS))?.length, MAX_TITLE_CHARS, 'the limit itself is allowed');
  });

  it('counts a name as unchanged once trimming is taken into account', () => {
    assert.equal(isUnchanged('  Pricing  ', 'Pricing'), true);
    assert.equal(isUnchanged('Pricing plans', 'Pricing'), false);
  });
});

const conversation = (id: string, title: string, updatedAt: string): ConversationSummary => ({
  id,
  title,
  createdAt: '2026-09-18T08:00:00.000Z',
  updatedAt,
});

const first = conversation('a', 'Older chat', '2026-09-17T12:00:00.000Z');
const second = conversation('b', 'Newer chat', '2026-09-18T12:00:00.000Z');
const reduce = (state: HistoryState, ...actions: HistoryAction[]): HistoryState => actions.reduce(historyReducer, state);
const ready = reduce(initialHistoryState, { type: 'loaded', conversations: [second, first] });

describe('renaming in the history state', () => {
  it('marks the row as saving while the request runs', () => {
    const state = reduce(ready, { type: 'rename/start', id: 'a' });
    assert.equal(state.renamingId, 'a');
    assert.equal(state.conversations.find((c) => c.id === 'a')?.title, 'Older chat', 'the old name stays until the API confirms');
  });

  it('shows the new name once it is saved', () => {
    const state = reduce(
      ready,
      { type: 'rename/start', id: 'a' },
      { type: 'rename/succeeded', conversation: { ...first, title: 'Pricing questions' } },
    );
    assert.equal(state.conversations.find((c) => c.id === 'a')?.title, 'Pricing questions');
    assert.equal(state.renamingId, null);
    assert.equal(state.renameError, null);
  });

  it('does not reorder the list: renaming is not activity', () => {
    const state = reduce(
      ready,
      { type: 'rename/start', id: 'a' },
      { type: 'rename/succeeded', conversation: { ...first, title: 'Pricing questions' } },
    );
    assert.deepEqual(
      state.conversations.map((c) => c.id),
      ['b', 'a'],
      'the renamed chat keeps its place',
    );
    assert.equal(state.conversations.find((c) => c.id === 'a')?.updatedAt, first.updatedAt);
  });

  it('keeps the old name and explains itself when saving fails', () => {
    const error = new ApiError({ status: 503, code: 'service_unavailable', message: 'busy' });
    const state = reduce(ready, { type: 'rename/start', id: 'a' }, { type: 'rename/failed', error });
    assert.equal(state.conversations.find((c) => c.id === 'a')?.title, 'Older chat');
    assert.equal(state.renamingId, null);
    assert.equal(state.renameError, error);
  });

  it('leaves every other conversation alone', () => {
    const state = reduce(ready, { type: 'rename/succeeded', conversation: { ...first, title: 'Renamed' } });
    assert.equal(state.conversations.find((c) => c.id === 'b')?.title, 'Newer chat');
  });

  it('ignores a rename for a conversation that is no longer listed', () => {
    const state = reduce(ready, { type: 'rename/succeeded', conversation: conversation('gone', 'Ghost', '2026-09-18T12:00:00.000Z') });
    assert.deepEqual(
      state.conversations.map((c) => c.title),
      ['Newer chat', 'Older chat'],
    );
  });

  it('clears the rename error with the other notices', () => {
    const failed = reduce(ready, { type: 'rename/failed', error: new Error('nope') });
    assert.equal(reduce(failed, { type: 'notice/clear' }).renameError, null);
  });

  it('does not disturb deleting', () => {
    const state = reduce(ready, { type: 'rename/start', id: 'a' }, { type: 'delete/start', id: 'b' });
    assert.equal(state.renamingId, 'a');
    assert.equal(state.deletingId, 'b');
  });
});
