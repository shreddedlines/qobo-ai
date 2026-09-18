/**
 * Mirror of the backend contract (api/src/conversations/types.ts, api/src/chat/routes.ts).
 * The frontend is a separate package, so these are hand-mirrored; test/contract.test.ts
 * reads the backend source and fails if the two drift apart.
 */
export const INTENTS = ['qobo', 'general', 'off_topic', 'smalltalk'] as const;
export type Intent = (typeof INTENTS)[number];

export const MESSAGE_STATUSES = ['answered', 'insufficient', 'redirected'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Server-side limit on a single message. */
export const MAX_MESSAGE_CHARS = 2_000;

export const CHAT_MESSAGE_FIELDS = ['id', 'role', 'content', 'intent', 'status', 'sources', 'createdAt'] as const;

export interface Source {
  title: string;
  url: string;
  kind: 'qobo' | 'web';
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  intent: Intent | null;
  /** Assistant replies only; null for user messages. */
  status: MessageStatus | null;
  sources: Source[];
  createdAt: string;
}

export interface ConversationListResponse {
  conversations: ConversationSummary[];
  nextCursor: string | null;
}

export interface ConversationMessagesResponse {
  conversation: ConversationSummary;
  messages: ChatMessage[];
}

export interface SendMessageRequest {
  message: string;
  /** Client-generated uuid; retrying with the same id replays the saved reply. */
  clientMessageId: string;
  conversationId?: string | null;
  /**
   * Editing: replace this saved user message and its reply in place, rather than
   * appending a new exchange. Requires conversationId.
   */
  replaceMessageId?: string | null;
}

export interface SendMessageResponse {
  conversation: ConversationSummary;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  replayed: boolean;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  database?: 'ok' | 'unavailable';
}
