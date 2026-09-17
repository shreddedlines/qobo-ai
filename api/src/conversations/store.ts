import type { AuthUser } from '../auth/token-verifier.ts';
import type { Env } from '../config/env.ts';
import { createUserClient, DatabaseError } from '../db/supabase.ts';
import type { ChatMessage, ConversationSummary, Intent, MessageStatus, Source } from './types.ts';

export const MAX_MESSAGES_PER_CONVERSATION_READ = 500;

export interface ListConversationsOptions {
  limit: number;
  /** Only conversations updated strictly before this ISO timestamp (pagination cursor). */
  before?: string | undefined;
}

export interface ConversationWithMessages {
  conversation: ConversationSummary;
  messages: ChatMessage[];
}

export interface ConversationStore {
  list(user: AuthUser, options: ListConversationsOptions): Promise<ConversationSummary[]>;
  getWithMessages(user: AuthUser, conversationId: string): Promise<ConversationWithMessages | null>;
  /** Returns false when the conversation does not exist or belongs to someone else. */
  delete(user: AuthUser, conversationId: string): Promise<boolean>;
}

export interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  intent: Intent | null;
  status: MessageStatus | null;
  sources: Source[];
  created_at: string;
}

/**
 * Reads and deletes run with the user's own token, so RLS enforces ownership even
 * if a filter here were wrong. The explicit user_id filters are defense in depth
 * and let Postgres use the (user_id, updated_at) index.
 */
export function createSupabaseConversationStore(env: Env): ConversationStore {
  return {
    async list(user, { limit, before }) {
      let query = createUserClient(env, user.accessToken)
        .from('conversations')
        .select('id, title, created_at, updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (before) query = query.lt('updated_at', before);

      const { data, error } = await query.overrideTypes<ConversationRow[], { merge: false }>();
      if (error) throw new DatabaseError('list conversations', error);
      return data.map(toConversationSummary);
    },

    async getWithMessages(user, conversationId) {
      const client = createUserClient(env, user.accessToken);

      const conversation = await client
        .from('conversations')
        .select('id, title, created_at, updated_at')
        .eq('id', conversationId)
        .eq('user_id', user.id)
        .maybeSingle<ConversationRow>();
      if (conversation.error) throw new DatabaseError('get conversation', conversation.error);
      if (!conversation.data) return null;

      const messages = await client
        .from('messages')
        .select('id, role, content, intent, status:metadata->>status, sources, created_at')
        .eq('conversation_id', conversationId)
        .order('seq', { ascending: true })
        .limit(MAX_MESSAGES_PER_CONVERSATION_READ)
        .overrideTypes<MessageRow[], { merge: false }>();
      if (messages.error) throw new DatabaseError('list messages', messages.error);

      return { conversation: toConversationSummary(conversation.data), messages: messages.data.map(toChatMessage) };
    },

    async delete(user, conversationId) {
      const { data, error } = await createUserClient(env, user.accessToken)
        .from('conversations')
        .delete()
        .eq('id', conversationId)
        .eq('user_id', user.id)
        .select('id');
      if (error) throw new DatabaseError('delete conversation', error);
      return data.length > 0;
    },
  };
}

export function toConversationSummary(row: ConversationRow): ConversationSummary {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function toChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    intent: row.intent,
    status: row.status ?? null,
    sources: Array.isArray(row.sources) ? row.sources : [],
    createdAt: row.created_at,
  };
}
