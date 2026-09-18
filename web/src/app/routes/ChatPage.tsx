import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { isApiError, toUserFacingError } from '../../api/errors.ts';
import { Composer } from '../../chat/Composer.tsx';
import { pendingEntry } from '../../chat/conversation-state.ts';
import { MessageView, UserMessage } from '../../chat/MessageView.tsx';
import { SendFailureNotice, WaitingNotice } from '../../chat/PendingNotices.tsx';
import { useChat } from '../../chat/useChat.ts';
import { useHistory } from '../../history/HistoryProvider.tsx';
import { Button } from '../../ui/Button.tsx';
import { ApiStatus } from '../ApiStatus.tsx';

const EXAMPLES = [
  'How does QOBO build a website through WhatsApp?',
  'What do your plans include?',
  'Do you offer SEO services?',
];

/** Placeholder lines while a saved conversation loads: stable, so nothing jumps. */
function HistorySkeleton() {
  return (
    <div className="flex flex-col gap-4 py-8" aria-busy="true">
      <p role="status" className="sr-only">
        Loading this conversation.
      </p>
      {[72, 100, 88].map((width, index) => (
        <div key={index} className="h-4 rounded-sm bg-line" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

export function ChatPage() {
  const { conversationId = null } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { state, send, retry, stop, dismissFailure, reloadHistory } = useChat(conversationId);
  const { noteConversation } = useHistory();
  const endRef = useRef<HTMLDivElement>(null);

  const pending = pendingEntry(state);
  const arrivedReply = state.lastReplyId === null ? null : state.messages.find((message) => message.id === state.lastReplyId);
  const quotaReached = isApiError(state.failure?.error) && state.failure.error.code === 'quota_exceeded';
  const hasConversation = state.messages.length > 0 || pending !== null || state.loadingHistory;

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [state.messages.length, pending?.kind]);

  async function handleSend(text: string) {
    const response = await send(text);
    if (!response) return;

    // Keep the sidebar in step: a new conversation appears, an existing one moves up.
    noteConversation(response.conversation);
    if (response.conversation.id !== conversationId) {
      // A new conversation now has an address of its own, without reloading it.
      navigate(`/chat/${response.conversation.id}`, { replace: true });
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Conversation and composer share one centred column, narrower than the page shell. */}
      <div className="mx-auto flex w-full max-w-[44rem] flex-1 flex-col">
        {state.loadingHistory ? <HistorySkeleton /> : null}

        {state.historyError ? (
          <div role="alert" className="mt-8 rounded-md border border-danger bg-danger-tint p-4">
            <p className="text-[15px] font-semibold text-danger">{toUserFacingError(state.historyError).title}</p>
            <p className="mt-1 text-[14px] text-danger-ink">{toUserFacingError(state.historyError).detail}</p>
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" onClick={reloadHistory} className="min-h-11 px-3 text-[14px]">
                Try again
              </Button>
              <Link
                to="/chat"
                className="inline-flex min-h-11 items-center rounded-md px-3 text-[14px] font-medium text-ink underline underline-offset-2"
              >
                Start a new chat
              </Link>
            </div>
          </div>
        ) : null}

        {!hasConversation && !state.historyError ? (
          <div className="flex flex-1 flex-col justify-center py-16">
            <h1 className="font-display text-3xl leading-tight font-semibold text-ink">What can QOBO help you with?</h1>
            <p className="measure mt-3 text-[15px] text-muted">
              Ask about websites, online stores, marketing or automation. Answers come from QOBO&rsquo;s own website, with links to the
              pages they came from.
            </p>

            {/* One group of examples: a single hairline-divided list, not three identical cards. */}
            <ul className="measure mt-8 divide-y divide-line border-y border-line">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    onClick={() => void handleSend(example)}
                    className="flex min-h-11 w-full cursor-pointer items-center py-3 text-left text-[15px] text-ink hover:text-brand-ink"
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>

          </div>
        ) : null}

        {state.messages.length > 0 || pending ? (
          <div className="flex flex-col gap-8 py-8">
            {state.title ? <h1 className="sr-only">{state.title}</h1> : null}
            {state.messages.map((message) => (
              <MessageView key={message.id} message={message} />
            ))}

            {pending ? (
              <div className="flex flex-col gap-3">
                <UserMessage text={pending.text} />
                {pending.kind === 'waiting' && pending.startedAt !== undefined ? (
                  <WaitingNotice startedAt={pending.startedAt} />
                ) : null}
                {state.failure ? (
                  <SendFailureNotice failure={state.failure} onRetry={() => void retry()} onDismiss={dismissFailure} />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* A reply arrives complete, so its arrival is announced once, politely, with
            how many sources came with it. The reply itself is then read on demand. */}
        <p role="status" aria-live="polite" className="sr-only">
          {arrivedReply
            ? `QOBO replied. ${arrivedReply.sources.length === 0 ? 'No sources' : `${arrivedReply.sources.length} ${arrivedReply.sources.length === 1 ? 'source' : 'sources'}`}.`
            : ''}
        </p>

        <div ref={endRef} />
      </div>

      <div className="sticky bottom-0 border-t border-line bg-sunken py-4">
        <div className="mx-auto w-full max-w-[44rem]">
          <Composer
            sending={state.outgoing !== null}
            onSend={(text) => void handleSend(text)}
            onStop={stop}
            {...(quotaReached ? { disabledReason: toUserFacingError(state.failure?.error).detail } : {})}
          />
          <div className="mt-3">
            <ApiStatus />
          </div>
        </div>
      </div>
    </div>
  );
}
