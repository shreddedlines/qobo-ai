import type { ChatMessage } from '../api/types.ts';

export interface MessageEdit {
  /** The saved message whose text is being reworked. */
  messageId: string;
  text: string;
}

/**
 * Only a saved message of the person's own can be edited.
 *
 * A reply is QOBO's, not theirs, so it is never editable — checked here rather than
 * only hiding a button, so no caller can offer editing where it makes no sense. A
 * message still in flight has no saved copy to edit either; Stop covers that case.
 */
export function canEditMessage(message: Pick<ChatMessage, 'id' | 'role'>): boolean {
  return message.role === 'user' && message.id.trim() !== '';
}

/** The edit to load into the composer, or null when this message cannot be edited. */
export function startEditing(message: Pick<ChatMessage, 'id' | 'role' | 'content'>): MessageEdit | null {
  if (!canEditMessage(message)) return null;
  return { messageId: message.id, text: message.content };
}

const LABEL_MAX_CHARS = 60;

/** Accessible name for the control, so several Edit buttons are told apart. */
export function editActionLabel(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const shown = collapsed.length <= LABEL_MAX_CHARS ? collapsed : `${collapsed.slice(0, LABEL_MAX_CHARS - 1).trimEnd()}…`;
  return shown === '' ? 'Edit your message' : `Edit your message: ${shown}`;
}

/**
 * Key for the composer. Changing it remounts the composer, which is how the edited
 * text gets in: the draft lives inside the composer so typing does not re-render the
 * whole conversation, and a remount is a clearer way to replace it than an effect.
 */
export function composerKey(edit: MessageEdit | null): string {
  return edit ? `edit-${edit.messageId}` : 'compose';
}

/**
 * The edit still in effect: an edit survives only while its message is on screen, so
 * switching conversation or losing the message drops it without any extra bookkeeping.
 */
export function activeEdit(edit: MessageEdit | null, messages: readonly Pick<ChatMessage, 'id'>[]): MessageEdit | null {
  if (!edit) return null;
  return messages.some((message) => message.id === edit.messageId) ? edit : null;
}
