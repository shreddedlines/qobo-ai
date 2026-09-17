export type Intent = 'qobo' | 'general' | 'off_topic' | 'smalltalk';

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
  sources: Source[];
  createdAt: string;
}
