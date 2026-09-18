import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { isApiError, toUserFacingError } from '../api/errors.ts';
import { Button } from '../ui/Button.tsx';
import type { SendFailure } from './conversation-state.ts';

/**
 * Seconds since the attempt started. A ticking clock is kept in state and the elapsed
 * time is derived from it, so nothing has to be recomputed when `startedAt` changes.
 */
function useElapsedSeconds(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  return Math.max(0, Math.round((now - startedAt) / 1000));
}

export interface WaitingNoticeProps {
  startedAt: number;
}

/**
 * Three dots that rise in turn: a visual sign that work is in progress. Decorative, so
 * it is hidden from assistive technology — the status text beside it carries the meaning.
 */
function TypingDots() {
  return (
    <span aria-hidden="true" className="flex items-center gap-1">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 rounded-full bg-muted animate-typing-dot"
          style={{ animationDelay: `${index * 0.16}s` }}
        />
      ))}
    </span>
  );
}

/**
 * The waiting state, shown from the moment a message is sent until the reply arrives or
 * the attempt fails. The dots animate to show the request is being worked on, but the
 * words stay honest: a reply arrives complete, so nothing here pretends text is being
 * typed into place. Stop lives in the composer, in place of Send.
 *
 * The status text stays stable for screen readers; only the seconds change visually, so
 * the live region does not announce a new number every second.
 */
export function WaitingNotice({ startedAt }: WaitingNoticeProps) {
  const seconds = useElapsedSeconds(startedAt);
  const slow = seconds >= 20;

  return (
    <div className="flex items-center gap-2.5" aria-busy="true">
      <TypingDots />
      <p role="status" className="text-[14px] text-muted">
        {slow ? 'Still generating — a detailed answer can take a minute.' : 'Generating an answer from QOBO’s website…'}
        {seconds >= 5 ? (
          <span aria-hidden="true" className="ml-2 tabular-nums text-muted">
            {seconds}s
          </span>
        ) : null}
      </p>
    </div>
  );
}

export interface SendFailureNoticeProps {
  failure: SendFailure;
  onRetry: () => void;
  onDismiss: () => void;
}

/** What went wrong and what to do about it, with the retry that reuses the same message id. */
export function SendFailureNotice({ failure, onRetry, onDismiss }: SendFailureNoticeProps) {
  if (failure.stopped) {
    return (
      <div role="status" className="rounded-md border border-line bg-raised p-3">
        <p className="text-[14px] font-medium text-ink">You stopped waiting for this reply</p>
        <p className="mt-1 text-[14px] text-muted">
          QOBO may have finished it anyway. Try again to fetch the same reply — it will not use another message from your daily limit.
        </p>
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" onClick={onRetry} className="min-h-11 px-3 text-[14px]">
            Try again
          </Button>
          <Button variant="ghost" onClick={onDismiss} className="min-h-11 px-3 text-[14px]">
            Discard message
          </Button>
        </div>
      </div>
    );
  }

  const { title, detail, canRetry } = toUserFacingError(failure.error);
  const sessionExpired = isApiError(failure.error) && failure.error.code === 'unauthorized';

  return (
    <div role="alert" className="rounded-md border border-danger bg-danger-tint p-3">
      <p className="text-[14px] font-semibold text-danger">{title}</p>
      <p className="mt-1 text-[14px] text-danger-ink">{detail}</p>
      <div className="mt-3 flex gap-2">
        {sessionExpired ? (
          <Link
            to="/login"
            className="inline-flex min-h-11 items-center rounded-md border border-line bg-raised px-3 text-[14px] font-medium text-ink"
          >
            Sign in again
          </Link>
        ) : canRetry ? (
          <Button variant="secondary" onClick={onRetry} className="min-h-11 px-3 text-[14px]">
            Try again
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onDismiss} className="min-h-11 px-3 text-[14px]">
          Discard message
        </Button>
      </div>
    </div>
  );
}
