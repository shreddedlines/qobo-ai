import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import { pino } from 'pino';

import { createApp, type AppDeps } from '../../src/app.ts';
import { AuthUnavailableError, type AuthUser, type TokenVerifier } from '../../src/auth/token-verifier.ts';
import type { ChatReply, ChatRequest, ChatService } from '../../src/chat/chat-service.ts';
import {
  ConversationNotFoundError,
  MessageNotReplaceableError,
  type AppendExchangeInput,
  type ExchangeStore,
  type ReplaceExchangeInput,
  type StoredExchange,
} from '../../src/chat/exchange-store.ts';
import type { QuotaResult, UserMessageQuota } from '../../src/chat/user-quota.ts';
import type { ConversationStore, ConversationWithMessages, ListConversationsOptions } from '../../src/conversations/store.ts';
import type { ChatMessage, ConversationSummary } from '../../src/conversations/types.ts';
import type { HealthCheck } from '../../src/health/routes.ts';
import { testEnv } from './env.ts';

export class FakeTokenVerifier implements TokenVerifier {
  private readonly users = new Map<string, AuthUser>();
  unavailable = false;

  addUser(): { user: AuthUser; token: string } {
    const token = `token-${randomUUID()}`;
    const user: AuthUser = { id: randomUUID(), email: 'user@test.local', accessToken: token };
    this.users.set(token, user);
    return { user, token };
  }

  async verify(accessToken: string): Promise<AuthUser | null> {
    if (this.unavailable) throw new AuthUnavailableError();
    return this.users.get(accessToken) ?? null;
  }
}

interface StoredConversation extends ConversationSummary {
  userId: string;
  messages: Array<ChatMessage & { clientMessageId?: string }>;
}

/** Mirrors the ownership rules RLS enforces in the real database. */
export class InMemoryConversationStore implements ConversationStore {
  readonly conversations: StoredConversation[] = [];

  seed(userId: string, title: string, updatedAt: string, messageCount = 2): StoredConversation {
    const conversation: StoredConversation = {
      id: randomUUID(),
      userId,
      title,
      createdAt: updatedAt,
      updatedAt,
      messages: Array.from({ length: messageCount }, (_, i) => ({
        id: randomUUID(),
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
        intent: i % 2 === 0 ? null : 'qobo',
        status: i % 2 === 0 ? null : 'answered',
        sources: [],
        createdAt: updatedAt,
      })),
    };
    this.conversations.push(conversation);
    return conversation;
  }

  async list(user: AuthUser, { limit, before }: ListConversationsOptions): Promise<ConversationSummary[]> {
    return this.conversations
      .filter((c) => c.userId === user.id && (!before || c.updatedAt < before))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
  }

  async getWithMessages(user: AuthUser, conversationId: string): Promise<ConversationWithMessages | null> {
    const found = this.conversations.find((c) => c.id === conversationId && c.userId === user.id);
    if (!found) return null;
    const { id, title, createdAt, updatedAt, messages } = found;
    return { conversation: { id, title, createdAt, updatedAt }, messages: messages.map(({ clientMessageId: _ignored, ...message }) => message) };
  }

  async rename(user: AuthUser, conversationId: string, title: string): Promise<ConversationSummary | null> {
    const found = this.conversations.find((c) => c.id === conversationId && c.userId === user.id);
    if (!found) return null;
    found.title = title;
    // Renaming is not activity: updatedAt stays where it was, so the list order holds.
    const { id, title: renamed, createdAt, updatedAt } = found;
    return { id, title: renamed, createdAt, updatedAt };
  }

  async delete(user: AuthUser, conversationId: string): Promise<boolean> {
    const index = this.conversations.findIndex((c) => c.id === conversationId && c.userId === user.id);
    if (index === -1) return false;
    this.conversations.splice(index, 1);
    return true;
  }
}

/** In-memory append_exchange/get_exchange with the same ownership and idempotency rules. */
export class InMemoryExchangeStore implements ExchangeStore {
  readonly appended: AppendExchangeInput[] = [];
  readonly replaced: ReplaceExchangeInput[] = [];
  failWith: Error | undefined;
  private readonly store: InMemoryConversationStore;

  constructor(store: InMemoryConversationStore) {
    this.store = store;
  }

  async findByClientMessageId(userId: string, clientMessageId: string): Promise<StoredExchange | null> {
    for (const conversation of this.store.conversations.filter((c) => c.userId === userId)) {
      const index = conversation.messages.findIndex((m) => m.clientMessageId === clientMessageId);
      if (index !== -1) return this.exchange(conversation, index, true);
    }
    return null;
  }

  async append(input: AppendExchangeInput): Promise<StoredExchange> {
    if (this.failWith) throw this.failWith;
    const existing = await this.findByClientMessageId(input.userId, input.clientMessageId);
    if (existing) return existing;

    const now = new Date().toISOString();
    let conversation = input.conversationId ? this.store.conversations.find((c) => c.id === input.conversationId && c.userId === input.userId) : undefined;
    if (input.conversationId && !conversation) throw new ConversationNotFoundError();
    if (!conversation) {
      conversation = { id: randomUUID(), userId: input.userId, title: input.title, createdAt: now, updatedAt: now, messages: [] };
      this.store.conversations.push(conversation);
    }
    conversation.updatedAt = now;
    conversation.messages.push(
      { id: randomUUID(), role: 'user', content: input.userContent, intent: null, status: null, sources: [], createdAt: now, clientMessageId: input.clientMessageId },
      { id: randomUUID(), role: 'assistant', content: input.assistantContent, intent: input.intent, status: (input.metadata.status as ChatMessage['status']) ?? null, sources: input.sources, createdAt: now },
    );
    this.appended.push(input);
    return this.exchange(conversation, conversation.messages.length - 2, false);
  }

  /** Mirrors replace_exchange: same position, same ids, no second copy. */
  async replace(input: ReplaceExchangeInput): Promise<StoredExchange> {
    if (this.failWith) throw this.failWith;
    const existing = await this.findByClientMessageId(input.userId, input.clientMessageId);
    if (existing) return existing;

    const conversation = this.store.conversations.find((c) => c.id === input.conversationId && c.userId === input.userId);
    if (!conversation) throw new ConversationNotFoundError();

    const userIndex = conversation.messages.findIndex((m) => m.id === input.targetMessageId && m.role === 'user');
    if (userIndex === -1) throw new MessageNotReplaceableError();

    const replyIndex = conversation.messages.findIndex((m, index) => index > userIndex && m.role === 'assistant');
    const target = conversation.messages[userIndex]!;
    conversation.messages[userIndex] = { ...target, content: input.userContent, clientMessageId: input.clientMessageId };

    const reply = replyIndex === -1 ? undefined : conversation.messages[replyIndex];
    const replacementReply: ChatMessage & { clientMessageId?: string } = {
      id: reply?.id ?? randomUUID(),
      role: 'assistant',
      content: input.assistantContent,
      intent: input.intent,
      status: (input.metadata.status as ChatMessage['status']) ?? null,
      sources: input.sources,
      createdAt: reply?.createdAt ?? new Date().toISOString(),
    };
    if (replyIndex === -1) conversation.messages.splice(userIndex + 1, 0, replacementReply);
    else conversation.messages[replyIndex] = replacementReply;

    // The title comes from the first message, so editing that message retitles the chat.
    if (userIndex === 0) conversation.title = input.title;
    conversation.updatedAt = new Date().toISOString();
    this.replaced.push(input);
    return this.exchange(conversation, userIndex, false);
  }

  private exchange(conversation: StoredConversation, userIndex: number, replayed: boolean): StoredExchange {
    const strip = ({ clientMessageId: _ignored, ...message }: ChatMessage & { clientMessageId?: string }): ChatMessage => message;
    const { id, title, createdAt, updatedAt } = conversation;
    return {
      conversation: { id, title, createdAt, updatedAt },
      userMessage: strip(conversation.messages[userIndex]!),
      assistantMessage: strip(conversation.messages[userIndex + 1]!),
      replayed,
    };
  }
}

export class FakeChatService implements ChatService {
  readonly requests: ChatRequest[] = [];
  /**
   * Handed to `request.stream` before the reply resolves, in order: a string is a
   * delta, `null` is a reset (a retry or the fallback discarding what came before).
   */
  streamChunks: Array<string | null> | undefined;
  respondWith: ChatReply | Error | 'hang' = {
    intent: 'qobo',
    status: 'answered',
    content: 'QOBO builds websites through WhatsApp [1].',
    sources: [{ title: 'QOBO Home', url: 'https://qobo.dev/', kind: 'qobo' }],
    metadata: { router: { source: 'model', model: 'router-model', language: 'en', smalltalkType: 'other' }, latencyMs: 12 },
  };

  async respond(request: ChatRequest): Promise<ChatReply> {
    this.requests.push(request);
    if (request.stream) {
      for (const chunk of this.streamChunks ?? []) {
        if (chunk === null) request.stream.onReset?.();
        else request.stream.onDelta(chunk);
      }
    }
    if (this.respondWith === 'hang') return new Promise<never>(() => undefined);
    if (this.respondWith instanceof Error) throw this.respondWith;
    return this.respondWith;
  }
}

export class FakeUserQuota implements UserMessageQuota {
  readonly used = new Map<string, number>();
  limit: number;
  failWith: Error | undefined;

  constructor(limit = 50) {
    this.limit = limit;
  }

  async consume(userId: string): Promise<QuotaResult> {
    if (this.failWith) throw this.failWith;
    const used = this.used.get(userId) ?? 0;
    if (used >= this.limit) return { allowed: false, used, limit: this.limit };
    this.used.set(userId, used + 1);
    return { allowed: true, used: used + 1, limit: this.limit };
  }
}

export class FakeHealthCheck implements HealthCheck {
  healthy = true;
  async database(): Promise<boolean> {
    return this.healthy;
  }
}

export interface TestApp {
  app: Express;
  verifier: FakeTokenVerifier;
  store: InMemoryConversationStore;
  exchanges: InMemoryExchangeStore;
  chat: FakeChatService;
  quota: FakeUserQuota;
  health: FakeHealthCheck;
}

export function buildTestApp(envOverrides: Record<string, string> = {}, depOverrides: Partial<AppDeps> = {}): TestApp {
  const verifier = new FakeTokenVerifier();
  const store = new InMemoryConversationStore();
  const exchanges = new InMemoryExchangeStore(store);
  const chat = new FakeChatService();
  const quota = new FakeUserQuota();
  const health = new FakeHealthCheck();
  const app = createApp({
    env: testEnv(envOverrides),
    logger: pino({ level: 'silent' }),
    tokenVerifier: verifier,
    conversationStore: store,
    healthCheck: health,
    chatService: chat,
    exchangeStore: exchanges,
    userQuota: quota,
    ...depOverrides,
  });
  return { app, verifier, store, exchanges, chat, quota, health };
}
