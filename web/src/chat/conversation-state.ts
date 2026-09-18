import type { ChatMessage, ConversationSummary, SendMessageResponse } from '../api/types.ts';

export interface OutgoingMessage {
  /** Generated once per user message and reused for every retry, so the API replays
   * the saved reply instead of charging quota and answering twice. */
  clientMessageId: string;
  text: string;
  /** Epoch ms the current attempt started, used for the waiting state's elapsed time. */
  startedAt: number;
  /** Set when this send replaces a saved message rather than adding one. */
  replacesMessageId?: string;
}

export interface SendFailure {
  clientMessageId: string;
  text: string;
  error: unknown;
  /** True when the person pressed Stop, rather than the request failing on its own. */
  stopped: boolean;
}

export interface ChatState {
  conversationId: string | null;
  title: string | null;
  messages: ChatMessage[];
  loadingHistory: boolean;
  historyError: unknown | null;
  outgoing: OutgoingMessage | null;
  failure: SendFailure | null;
  /** Assistant message that arrived during this session, for the screen-reader notice. */
  lastReplyId: string | null;
}

export type ChatAction =
  | { type: 'history/load' }
  | { type: 'history/loaded'; conversation: ConversationSummary; messages: ChatMessage[] }
  | { type: 'history/failed'; error: unknown }
  | { type: 'conversation/reset' }
  | { type: 'send/start'; clientMessageId: string; text: string; startedAt: number; replacesMessageId?: string }
  | { type: 'send/succeeded'; response: SendMessageResponse; replacedMessageId?: string }
  | { type: 'send/failed'; error: unknown }
  | { type: 'send/stopped' }
  | { type: 'failure/dismiss' };

export const initialChatState: ChatState = {
  conversationId: null,
  title: null,
  messages: [],
  loadingHistory: false,
  historyError: null,
  outgoing: null,
  failure: null,
  lastReplyId: null,
};

export function chatStateFor(conversationId: string | null): ChatState {
  return { ...initialChatState, conversationId, loadingHistory: conversationId !== null };
}

/** Appends messages the state does not already hold, so a replayed exchange cannot double up. */
function appendUnique(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const known = new Set(existing.map((message) => message.id));
  const added = incoming.filter((message) => !known.has(message.id));
  return added.length === 0 ? existing : [...existing, ...added];
}

/**
 * Puts an edited exchange where the original was: the edited message takes the target's
 * place and the reply that followed it is replaced by the new one. Nothing is appended
 * and nothing is hidden — this mirrors what replace_exchange did in the database, so the
 * screen matches what a reload would fetch.
 */
export function replaceExchange(
  messages: readonly ChatMessage[],
  targetId: string,
  userMessage: ChatMessage,
  assistantMessage: ChatMessage,
): ChatMessage[] {
  const target = messages.findIndex((message) => message.id === targetId);
  if (target === -1) return appendUnique([...messages], [userMessage, assistantMessage]);

  const result = [...messages];
  result[target] = userMessage;

  const reply = result.findIndex((message, index) => index > target && message.role === 'assistant');
  if (reply === -1) result.splice(target + 1, 0, assistantMessage);
  else result[reply] = assistantMessage;

  return result;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'history/load':
      return { ...state, loadingHistory: true, historyError: null };

    case 'history/loaded':
      return {
        ...state,
        conversationId: action.conversation.id,
        title: action.conversation.title,
        messages: action.messages,
        loadingHistory: false,
        historyError: null,
        // Opening a saved conversation is not a new reply, so nothing is announced.
        lastReplyId: null,
      };

    case 'history/failed':
      return { ...state, loadingHistory: false, historyError: action.error };

    case 'conversation/reset':
      return initialChatState;

    case 'send/start':
      return {
        ...state,
        // The failed attempt is being retried or replaced; its notice goes away.
        failure: null,
        outgoing: {
          clientMessageId: action.clientMessageId,
          text: action.text,
          startedAt: action.startedAt,
          ...(action.replacesMessageId ? { replacesMessageId: action.replacesMessageId } : {}),
        },
      };

    case 'send/succeeded':
      return {
        ...state,
        conversationId: action.response.conversation.id,
        title: action.response.conversation.title,
        messages: action.replacedMessageId
          ? replaceExchange(state.messages, action.replacedMessageId, action.response.userMessage, action.response.assistantMessage)
          : appendUnique(state.messages, [action.response.userMessage, action.response.assistantMessage]),
        outgoing: null,
        failure: null,
        lastReplyId: action.response.assistantMessage.id,
      };

    case 'send/failed':
      if (!state.outgoing) return state;
      return {
        ...state,
        outgoing: null,
        failure: { clientMessageId: state.outgoing.clientMessageId, text: state.outgoing.text, error: action.error, stopped: false },
      };

    case 'send/stopped':
      if (!state.outgoing) return state;
      return {
        ...state,
        outgoing: null,
        failure: { clientMessageId: state.outgoing.clientMessageId, text: state.outgoing.text, error: null, stopped: true },
      };

    case 'failure/dismiss':
      return { ...state, failure: null };
  }
}

export type PendingKind = 'waiting' | 'failed' | 'stopped';

export interface PendingEntry {
  kind: PendingKind;
  clientMessageId: string;
  text: string;
  startedAt?: number;
  /** Set when this send replaces a saved message rather than adding one. */
  replacesMessageId?: string;
}

/**
 * The user message being sent is rendered immediately from local state — optimistically —
 * and disappears only when the API returns the saved copy of it.
 */
export function pendingEntry(state: ChatState): PendingEntry | null {
  if (state.outgoing) {
    return {
      kind: 'waiting',
      clientMessageId: state.outgoing.clientMessageId,
      text: state.outgoing.text,
      startedAt: state.outgoing.startedAt,
      ...(state.outgoing.replacesMessageId ? { replacesMessageId: state.outgoing.replacesMessageId } : {}),
    };
  }
  if (state.failure) {
    return { kind: state.failure.stopped ? 'stopped' : 'failed', clientMessageId: state.failure.clientMessageId, text: state.failure.text };
  }
  return null;
}

export type TimelineEntry = { kind: 'message'; message: ChatMessage } | { kind: 'pending'; pending: PendingEntry };

/**
 * What the conversation shows, in order.
 *
 * An edit being generated stands where the message it replaces stands, and the reply
 * about to be replaced steps aside for the moment — so the edit never appears at the
 * bottom and then jump into position. A failed or stopped attempt goes last, next to
 * the controls for retrying or discarding it, and the original exchange stays visible
 * because it is still what is stored.
 */
export function timeline(state: ChatState): TimelineEntry[] {
  const pending = pendingEntry(state);
  const replacingId = pending?.kind === 'waiting' ? pending.replacesMessageId : undefined;

  const entries: TimelineEntry[] = [];
  let placed = false;
  let replyStepsAside = false;

  for (const message of state.messages) {
    if (pending && replacingId && message.id === replacingId) {
      entries.push({ kind: 'pending', pending });
      placed = true;
      replyStepsAside = true;
      continue;
    }
    if (replyStepsAside && message.role === 'assistant') {
      replyStepsAside = false;
      continue;
    }
    replyStepsAside = false;
    entries.push({ kind: 'message', message });
  }

  if (pending && !placed) entries.push({ kind: 'pending', pending });
  return entries;
}

/** A send is in flight; the composer switches to Stop and refuses a second message. */
export function isSending(state: ChatState): boolean {
  return state.outgoing !== null;
}

/**
 * The id to send with the next attempt. Retrying the same text keeps the failed
 * attempt's id, which is what makes a retry idempotent: if the API did save that
 * exchange (likely after Stop, where the server kept working), it replays the saved
 * reply instead of answering twice.
 *
 * Different text must never reuse the id — the API would replay the earlier exchange
 * and the person would see an answer to a question they just replaced.
 */
export function idForAttempt(state: ChatState, text: string, newId: () => string): string {
  const failure = state.failure;
  return failure && failure.text === text ? failure.clientMessageId : newId();
}
