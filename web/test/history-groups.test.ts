import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConversationSummary } from '../src/api/types.ts';
import {
  conversationTimeLabel,
  displayTitle,
  groupConversations,
  TITLE_MAX_CHARS,
  UNTITLED_CONVERSATION,
} from '../src/history/conversation-groups.ts';

/** Local-time helper, so grouping is tested in the same timezone the browser uses. */
const at = (year: number, month: number, day: number, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute);

const conversation = (id: string, updatedAt: Date, title = `Chat ${id}`): ConversationSummary => ({
  id,
  title,
  createdAt: updatedAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

const now = at(2026, 9, 18, 14, 30);

describe('groupConversations', () => {
  it('splits conversations into Today, Yesterday and Earlier', () => {
    const groups = groupConversations(
      [
        conversation('a', at(2026, 9, 18, 9, 0)),
        conversation('b', at(2026, 9, 17, 23, 59)),
        conversation('c', at(2026, 9, 11, 8, 0)),
      ],
      now,
    );

    assert.deepEqual(
      groups.map((group) => [group.key, group.label, group.conversations.map((item) => item.id)]),
      [
        ['today', 'Today', ['a']],
        ['yesterday', 'Yesterday', ['b']],
        ['earlier', 'Earlier', ['c']],
      ],
    );
  });

  it('groups by local calendar day, not by elapsed hours', () => {
    // 20 hours earlier, but still the previous calendar day.
    const groups = groupConversations([conversation('late', at(2026, 9, 17, 18, 30))], at(2026, 9, 18, 2, 0));
    assert.deepEqual(
      groups.map((group) => group.key),
      ['yesterday'],
    );

    // Two hours earlier and the same day.
    const sameDay = groupConversations([conversation('early', at(2026, 9, 18, 0, 30))], at(2026, 9, 18, 2, 0));
    assert.deepEqual(
      sameDay.map((group) => group.key),
      ['today'],
    );
  });

  it('keeps each group newest first', () => {
    const groups = groupConversations(
      [
        conversation('older', at(2026, 9, 18, 8, 0)),
        conversation('newest', at(2026, 9, 18, 13, 0)),
        conversation('middle', at(2026, 9, 18, 11, 0)),
      ],
      now,
    );
    assert.deepEqual(groups[0]?.conversations.map((item) => item.id), ['newest', 'middle', 'older']);
  });

  it('leaves out empty groups and returns nothing for an empty list', () => {
    const groups = groupConversations([conversation('a', at(2026, 9, 18))], now);
    assert.deepEqual(
      groups.map((group) => group.key),
      ['today'],
    );
    assert.deepEqual(groupConversations([], now), []);
  });

  it('puts a conversation with an unreadable timestamp under Earlier rather than dropping it', () => {
    const broken: ConversationSummary = { id: 'x', title: 'Broken', createdAt: 'nonsense', updatedAt: 'nonsense' };
    const groups = groupConversations([broken], now);
    assert.deepEqual(groups.map((group) => group.key), ['earlier']);
    assert.equal(groups[0]?.conversations[0]?.id, 'x');
  });

  it('treats a future timestamp as today, so clock skew cannot hide a chat', () => {
    assert.deepEqual(groupConversations([conversation('ahead', at(2026, 9, 19, 1, 0))], now).map((group) => group.key), ['today']);
  });
});

describe('displayTitle', () => {
  it('keeps a short title as it is, with whitespace collapsed', () => {
    assert.equal(displayTitle('What do your plans include?'), 'What do your plans include?');
    assert.equal(displayTitle('  Do you   offer SEO?  '), 'Do you offer SEO?');
  });

  it('cuts a long title at a word boundary', () => {
    const title = 'How does QOBO build a complete online store through WhatsApp for a small business?';
    const shown = displayTitle(title);
    assert.ok(shown.length <= TITLE_MAX_CHARS, shown);
    assert.ok(shown.endsWith('…'), shown);
    assert.ok(!shown.includes('  '));
    assert.ok(title.startsWith(shown.slice(0, -1).trimEnd()), shown);
  });

  it('cuts mid-word when the first word is longer than the limit', () => {
    const shown = displayTitle('Supercalifragilisticexpialidociousandthensomemorelettershere', 20);
    assert.equal(shown, 'Supercalifragilisti…');
    assert.equal(shown.length, 20);
  });

  it('falls back to a neutral label when there is no title', () => {
    for (const value of ['', '   ', null, undefined]) {
      assert.equal(displayTitle(value), UNTITLED_CONVERSATION, String(value));
    }
  });
});

describe('conversationTimeLabel', () => {
  it('shows a clock time for today and a word for yesterday', () => {
    assert.match(conversationTimeLabel(at(2026, 9, 18, 9, 5).toISOString(), now, 'en-GB'), /^0?9:05$/);
    assert.equal(conversationTimeLabel(at(2026, 9, 17, 9, 5).toISOString(), now, 'en-GB'), 'Yesterday');
  });

  it('shows a short date for older chats, adding the year for other years', () => {
    assert.equal(conversationTimeLabel(at(2026, 9, 11).toISOString(), now, 'en-GB'), '11 Sept');
    assert.match(conversationTimeLabel(at(2025, 12, 2).toISOString(), now, 'en-GB'), /2 Dec 2025/);
  });

  it('is empty for an unreadable timestamp', () => {
    assert.equal(conversationTimeLabel('nonsense', now, 'en-GB'), '');
  });
});
