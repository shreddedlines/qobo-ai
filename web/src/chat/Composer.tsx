import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { MAX_MESSAGE_CHARS } from '../api/types.ts';
import { Button } from '../ui/Button.tsx';
import type { MessageEdit } from './editing.ts';

export interface ComposerProps {
  sending: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Disabled with an explanation, e.g. once the daily limit is reached. */
  disabledReason?: string | undefined;
  /**
   * A message being edited. Its text starts in the box; the parent changes the
   * composer's key when this changes, so the draft is replaced by a remount.
   */
  edit?: MessageEdit | null;
  onCancelEdit?: (() => void) | undefined;
}

/** Show the counter only when the limit is close enough to matter. */
const COUNTER_FROM = MAX_MESSAGE_CHARS - 200;
const MAX_ROWS_HEIGHT = 200;

export function Composer({ sending, onSend, onStop, disabledReason, edit = null, onCancelEdit }: ComposerProps) {
  const [draft, setDraft] = useState(edit?.text ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a point, then scroll.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_ROWS_HEIGHT)}px`;
  }, [draft]);

  // Starting an edit mounts a fresh composer: put the cursor after the existing text,
  // ready to change it, rather than leaving focus back on the message. This is fixed
  // for the life of the mounted composer, so it runs once — a later edit arrives as a
  // new composer, keyed by its message.
  const startsAnEdit = edit !== null;
  useEffect(() => {
    if (!startsAnEdit) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [startsAnEdit]);

  const trimmed = draft.trim();
  const tooLong = trimmed.length > MAX_MESSAGE_CHARS;
  const blocked = disabledReason !== undefined;
  const canSend = trimmed !== '' && !tooLong && !sending && !blocked;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    onSend(trimmed);
    setDraft('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Escape leaves an edit, the same key that closes the dialogs.
    if (event.key === 'Escape' && edit && onCancelEdit) {
      event.preventDefault();
      onCancelEdit();
      return;
    }
    // Enter sends; Shift+Enter is a new line. IME composition must not be interrupted.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {edit ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-raised px-3 py-1.5">
          <p id="composer-editing" role="status" className="text-[13px] text-muted">
            Editing your message. Sending replaces it and QOBO&rsquo;s reply to it.
          </p>
          <Button variant="ghost" onClick={onCancelEdit} className="px-3 text-[14px]">
            Cancel
          </Button>
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <label htmlFor="composer" className="sr-only">
          {edit ? 'Edit your message' : 'Message QOBO'}
        </label>
        <textarea
          id="composer"
          ref={textareaRef}
          rows={1}
          value={draft}
          disabled={blocked}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about QOBO…"
          aria-describedby={edit ? 'composer-editing composer-help' : 'composer-help'}
          aria-invalid={tooLong || undefined}
          className="min-h-11 flex-1 resize-none rounded-md border border-line bg-surface px-4 py-2.5 text-[15px] text-ink placeholder:text-muted disabled:opacity-60"
        />
        {sending ? (
          <Button variant="secondary" onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!canSend}>
            Send
          </Button>
        )}
      </div>

      <div className="flex items-baseline justify-between gap-3">
        <p id="composer-help" className="text-[13px] text-muted">
          {disabledReason ?? (edit ? 'Enter sends the edited message. Escape cancels editing.' : 'Enter sends your message. Shift+Enter starts a new line.')}
        </p>
        {trimmed.length >= COUNTER_FROM ? (
          <p className={`text-[13px] tabular-nums ${tooLong ? 'text-danger' : 'text-muted'}`}>
            {tooLong ? `${trimmed.length - MAX_MESSAGE_CHARS} characters over the limit` : `${MAX_MESSAGE_CHARS - trimmed.length} left`}
          </p>
        ) : null}
      </div>
    </form>
  );
}
