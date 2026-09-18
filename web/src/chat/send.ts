import type { ApiClient } from '../api/client.ts';
import type { SendMessageResponse } from '../api/types.ts';
import { idForAttempt, type ChatAction, type ChatState } from './conversation-state.ts';

export interface SendDeps {
  client: Pick<ApiClient, 'sendMessage'>;
  dispatch: (action: ChatAction) => void;
  newId: () => string;
  now: () => number;
}

/** True for the DOMException a fetch abort produces, however it reaches us. */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export interface SendInput {
  state: ChatState;
  text: string;
  deps: SendDeps;
  signal?: AbortSignal | undefined;
}

/**
 * One send attempt, kept out of the React hook so the order of state changes is
 * testable: the user message is shown before the request goes out (optimistic), the
 * saved copies replace it on success, and Stop is recorded as stopped rather than failed.
 *
 * Returns the saved exchange, or null when the attempt did not produce one.
 */
export async function runSend({ state, text, deps, signal }: SendInput): Promise<SendMessageResponse | null> {
  const message = text.trim();
  if (message === '') return null;

  const clientMessageId = idForAttempt(state, message, deps.newId);
  deps.dispatch({ type: 'send/start', clientMessageId, text: message, startedAt: deps.now() });

  try {
    const response = await deps.client.sendMessage(
      { message, clientMessageId, conversationId: state.conversationId },
      signal ? { signal } : {},
    );
    deps.dispatch({ type: 'send/succeeded', response });
    return response;
  } catch (error) {
    // Stop is the person's own decision, not a failure to explain away.
    if (signal?.aborted === true || isAbortError(error)) deps.dispatch({ type: 'send/stopped' });
    else deps.dispatch({ type: 'send/failed', error });
    return null;
  }
}
