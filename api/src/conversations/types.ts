export type Intent = 'qobo' | 'general' | 'off_topic' | 'smalltalk';

/** How an assistant reply ended (stored in message metadata). */
export type MessageStatus = 'answered' | 'insufficient' | 'redirected';

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
