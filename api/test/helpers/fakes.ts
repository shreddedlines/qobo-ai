import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import { pino } from 'pino';

import { createApp, type AppDeps } from '../../src/app.ts';
import { AuthUnavailableError, type AuthUser, type TokenVerifier } from '../../src/auth/token-verifier.ts';
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
  messages: ChatMessage[];
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
    return { conversation: { id, title, createdAt, updatedAt }, messages };
  }

  async delete(user: AuthUser, conversationId: string): Promise<boolean> {
    const index = this.conversations.findIndex((c) => c.id === conversationId && c.userId === user.id);
    if (index === -1) return false;
    this.conversations.splice(index, 1);
    return true;
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
  health: FakeHealthCheck;
}

export function buildTestApp(envOverrides: Record<string, string> = {}, depOverrides: Partial<AppDeps> = {}): TestApp {
  const verifier = new FakeTokenVerifier();
  const store = new InMemoryConversationStore();
  const health = new FakeHealthCheck();
  const app = createApp({
    env: testEnv(envOverrides),
    logger: pino({ level: 'silent' }),
    tokenVerifier: verifier,
    conversationStore: store,
    healthCheck: health,
    ...depOverrides,
  });
  return { app, verifier, store, health };
}
