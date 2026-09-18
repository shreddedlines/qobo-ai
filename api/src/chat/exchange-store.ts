import type { SupabaseClient } from '@supabase/supabase-js';

import { DatabaseError } from '../db/supabase.ts';
import type { ChatMessage, ConversationSummary, Intent, MessageStatus, Source } from '../conversations/types.ts';

/** A saved user message and assistant reply. */
export interface StoredExchange {
  conversation: ConversationSummary;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  /** True when this exchange was saved by an earlier request with the same client message id. */
  replayed: boolean;
}

export interface AppendExchangeInput {
  userId: string;
  /** null creates a new conversation. */
  conversationId: string | null;
  clientMessageId: string;
  title: string;
  userContent: string;
  assistantContent: string;
  intent: Intent;
  sources: Source[];
  metadata: Record<string, unknown>;
}

export interface ReplaceExchangeInput extends Omit<AppendExchangeInput, 'conversationId'> {
  conversationId: string;
  /** The person's own saved message whose text is being replaced. */
  targetMessageId: string;
}

export interface ExchangeStore {
  findByClientMessageId(userId: string, clientMessageId: string): Promise<StoredExchange | null>;
  /** Atomic and idempotent. Throws ConversationNotFoundError for missing or foreign conversations. */
  append(input: AppendExchangeInput): Promise<StoredExchange>;
  /**
   * Replaces one saved exchange in place: same conversation, same position, no second
   * copy. Atomic and idempotent, like append. Throws MessageNotReplaceableError when
   * the target is missing, belongs to someone else, or is an assistant reply.
   */
  replace(input: ReplaceExchangeInput): Promise<StoredExchange>;
}

export class ConversationNotFoundError extends Error {
  constructor() {
    super('Conversation not found');
    this.name = 'ConversationNotFoundError';
  }
}

export class MessageNotReplaceableError extends Error {
  constructor() {
    super('Message not found');
    this.name = 'MessageNotReplaceableError';
  }
}

/** Row shape of to_jsonb(public.messages) returned by get_exchange/append_exchange. */
interface MessageJson {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  intent: Intent | null;
  sources: Source[] | null;
  metadata: { status?: MessageStatus } | null;
  created_at: string;
}

interface ExchangeJson {
  conversation_id: string;
  replayed: boolean;
  user_message: MessageJson;
  assistant_message: MessageJson;
}

function toMessage(row: MessageJson): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    intent: row.intent,
    status: row.role === 'assistant' ? (row.metadata?.status ?? null) : null,
    sources: Array.isArray(row.sources) ? row.sources : [],
    createdAt: row.created_at,
  };
}

/**
 * Writes go through the service-role-only SQL functions from M1: append_exchange
 * checks ownership inside Postgres, creates the conversation when needed and
 * stores both messages in one transaction. user_id always comes from the
 * verified token, never from the request body.
 */
export function createSupabaseExchangeStore(service: Pick<SupabaseClient, 'rpc' | 'from'>): ExchangeStore {
  async function conversationFor(userId: string, conversationId: string): Promise<ConversationSummary> {
    const { data, error } = await service
      .from('conversations')
      .select('id, title, created_at, updated_at')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single<{ id: string; title: string; created_at: string; updated_at: string }>();
    if (error) throw new DatabaseError('load conversation after exchange', error);
    return { id: data.id, title: data.title, createdAt: data.created_at, updatedAt: data.updated_at };
  }

  async function toStoredExchange(userId: string, json: ExchangeJson): Promise<StoredExchange> {
    return {
      conversation: await conversationFor(userId, json.conversation_id),
      userMessage: toMessage(json.user_message),
      assistantMessage: toMessage(json.assistant_message),
      replayed: json.replayed,
    };
  }

  return {
    async findByClientMessageId(userId, clientMessageId) {
      const { data, error } = await service.rpc('get_exchange', { p_user_id: userId, p_client_message_id: clientMessageId });
      if (error) throw new DatabaseError('get exchange', error);
      return data ? toStoredExchange(userId, data as ExchangeJson) : null;
    },

    async replace(input) {
      const { data, error } = await service.rpc('replace_exchange', {
        p_user_id: input.userId,
        p_conversation_id: input.conversationId,
        p_target_message_id: input.targetMessageId,
        p_client_message_id: input.clientMessageId,
        p_title: input.title,
        p_user_content: input.userContent,
        p_assistant_content: input.assistantContent,
        p_intent: input.intent,
        p_sources: input.sources,
        p_metadata: input.metadata,
      });
      if (error) {
        if (error.code === 'P0002') throw new ConversationNotFoundError();
        if (error.code === 'P0003') throw new MessageNotReplaceableError();
        throw new DatabaseError('replace exchange', error);
      }
      return toStoredExchange(input.userId, data as ExchangeJson);
    },

    async append(input) {
      const { data, error } = await service.rpc('append_exchange', {
        p_user_id: input.userId,
        p_conversation_id: input.conversationId,
        p_client_message_id: input.clientMessageId,
        p_title: input.title,
        p_user_content: input.userContent,
        p_assistant_content: input.assistantContent,
        p_intent: input.intent,
        p_sources: input.sources,
        p_metadata: input.metadata,
      });
      if (error) {
        if (error.code === 'P0002') throw new ConversationNotFoundError();
        throw new DatabaseError('append exchange', error);
      }
      return toStoredExchange(input.userId, data as ExchangeJson);
    },
  };
}
