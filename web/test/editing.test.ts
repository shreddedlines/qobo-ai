import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatMessage } from '../src/api/types.ts';
import { activeEdit, canEditMessage, composerKey, editActionLabel, startEditing } from '../src/chat/editing.ts';

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
  content: 'Starter is ₹499.',
  intent: 'qobo',
  status: 'answered',
  sources: [{ title: 'Pricing', url: 'https://qobo.dev/plans', kind: 'qobo' }],
  createdAt: '2026-09-18T10:00:05.000Z',
};

describe('which messages can be edited', () => {
  it('allows the person to edit their own saved message', () => {
    assert.equal(canEditMessage(userMessage), true);
  });

  it('never allows editing a reply from QOBO', () => {
    assert.equal(canEditMessage(assistantMessage), false);
    assert.equal(startEditing(assistantMessage), null, 'the rule holds in logic, not only by hiding a button');
  });

  it('refuses a message with no saved id, such as one still being sent', () => {
    assert.equal(canEditMessage({ ...userMessage, id: '' }), false);
    assert.equal(canEditMessage({ ...userMessage, id: '   ' }), false);
    assert.equal(startEditing({ ...userMessage, id: '' }), null);
  });
});

describe('startEditing', () => {
  it('hands the composer the message id and its exact text', () => {
    assert.deepEqual(startEditing(userMessage), { messageId: 'u1', text: 'What do your plans include?' });
  });

  it('keeps the text verbatim, including line breaks and spacing', () => {
    const multiline = { ...userMessage, content: 'First line\n\n  indented second line  ' };
    assert.equal(startEditing(multiline)?.text, 'First line\n\n  indented second line  ');
  });
});

describe('editActionLabel', () => {
  it('names the message it edits, so several controls are told apart', () => {
    assert.equal(editActionLabel('What do your plans include?'), 'Edit your message: What do your plans include?');
  });

  it('shortens a long message and collapses its whitespace', () => {
    const label = editActionLabel(`How does QOBO   build\na complete online store through WhatsApp for a small business?`);
    assert.ok(label.startsWith('Edit your message: How does QOBO build'), label);
    assert.ok(label.endsWith('…'), label);
    assert.ok(label.length <= 'Edit your message: '.length + 60, label);
  });

  it('still names the control when there is nothing to quote', () => {
    assert.equal(editActionLabel('   '), 'Edit your message');
  });
});

describe('composerKey', () => {
  it('changes per edited message, so the composer takes the new text', () => {
    assert.equal(composerKey(null), 'compose');
    assert.equal(composerKey({ messageId: 'u1', text: 'a' }), 'edit-u1');
    assert.notEqual(composerKey({ messageId: 'u1', text: 'a' }), composerKey({ messageId: 'u2', text: 'a' }));
  });

  it('returns to the plain composer when editing stops', () => {
    assert.equal(composerKey(null), 'compose');
  });
});

describe('activeEdit', () => {
  const messages = [userMessage, assistantMessage];

  it('keeps an edit whose message is on screen', () => {
    const edit = { messageId: 'u1', text: 'reworded' };
    assert.equal(activeEdit(edit, messages), edit);
  });

  it('drops an edit whose message is gone, as when the conversation changes', () => {
    assert.equal(activeEdit({ messageId: 'u1', text: 'reworded' }, []), null);
    assert.equal(activeEdit({ messageId: 'u1', text: 'reworded' }, [assistantMessage]), null);
  });

  it('is null when nothing is being edited', () => {
    assert.equal(activeEdit(null, messages), null);
  });
});
