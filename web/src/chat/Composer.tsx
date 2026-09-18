import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { MAX_MESSAGE_CHARS } from '../api/types.ts';
import { Button } from '../ui/Button.tsx';

export interface ComposerProps {
  sending: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Disabled with an explanation, e.g. once the daily limit is reached. */
  disabledReason?: string | undefined;
}

/** Show the counter only when the limit is close enough to matter. */
const COUNTER_FROM = MAX_MESSAGE_CHARS - 200;
const MAX_ROWS_HEIGHT = 200;

export function Composer({ sending, onSend, onStop, disabledReason }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a point, then scroll.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_ROWS_HEIGHT)}px`;
  }, [draft]);

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
    // Enter sends; Shift+Enter is a new line. IME composition must not be interrupted.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <label htmlFor="composer" className="sr-only">
          Message QOBO
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
          aria-describedby="composer-help"
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
          {disabledReason ?? 'Enter sends your message. Shift+Enter starts a new line.'}
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
