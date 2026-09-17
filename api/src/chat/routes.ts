import { Router } from 'express';
import { z } from 'zod';

import { getAuthUser } from '../auth/require-auth.ts';
import type { ConversationStore } from '../conversations/store.ts';
import { HttpError } from '../http/errors.ts';
import type { Logger } from '../lib/logger.ts';
import { TimeoutError, withTimeout } from '../lib/timeout.ts';
import type { HistoryTurn } from '../rag/prompts.ts';
import { AnswerUnavailableError } from '../rag/qobo-answer.ts';
import type { ChatReply, ChatService } from './chat-service.ts';
import { ConversationNotFoundError, type ExchangeStore, type StoredExchange } from './exchange-store.ts';
import { nextUtcMidnight, type UserMessageQuota } from './user-quota.ts';

export const MAX_MESSAGE_CHARS = 2_000;
/** Recent messages (user + assistant) passed to the router and answer models. */
export const HISTORY_MESSAGES = 10;
const MAX_TITLE_CHARS = 60;

const chatRequestSchema = z.object({
  message: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, 'message must not be empty').max(MAX_MESSAGE_CHARS, `message must be at most ${MAX_MESSAGE_CHARS} characters`)),
  clientMessageId: z.uuid(),
  conversationId: z.uuid().nullish(),
});

/** Conversation title from the first message: whitespace collapsed, cut at a word boundary. */
export function titleFromMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_TITLE_CHARS) return collapsed || 'New conversation';
  const cut = collapsed.slice(0, MAX_TITLE_CHARS - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** What gets stored with the assistant message: outcomes, models and timings, no prompts or keys. */
export function replyMetadata(reply: ChatReply): Record<string, unknown> {
  return { status: reply.status, ...reply.metadata };
}

export interface ChatRouterDeps {
  chatService: ChatService;
  exchanges: ExchangeStore;
  conversations: ConversationStore;
  quota: UserMessageQuota;
  timeoutMs: number;
  logger: Logger;
}

function toResponse(exchange: StoredExchange) {
  return {
    conversation: exchange.conversation,
    userMessage: exchange.userMessage,
    assistantMessage: exchange.assistantMessage,
    replayed: exchange.replayed,
  };
}

/**
 * POST /api/chat — one chat turn.
 *   1. validate → 2. replay if this clientMessageId was already saved (no quota, no model calls)
 *   3. load history (RLS-scoped; 404 for foreign conversations) → 4. consume the daily cap
 *   5. run the chat pipeline under a timeout → 6. save both messages atomically.
 * Nothing is saved when the pipeline fails or times out, so the client can retry
 * with the same clientMessageId.
 */
export function createChatRouter({ chatService, exchanges, conversations, quota, timeoutMs, logger }: ChatRouterDeps): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'bad_request', 'Invalid chat request', parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`));
    }
    const { message, clientMessageId, conversationId = null } = parsed.data;
    const user = getAuthUser(res);

    const existing = await exchanges.findByClientMessageId(user.id, clientMessageId);
    if (existing) {
      if (conversationId && existing.conversation.id !== conversationId) {
        throw new HttpError(409, 'conflict', 'clientMessageId was already used in another conversation');
      }
      res.json(toResponse(existing));
      return;
    }

    let history: HistoryTurn[] = [];
    if (conversationId) {
      const conversation = await conversations.getWithMessages(user, conversationId);
      if (!conversation) throw new HttpError(404, 'not_found', 'Conversation not found');
      history = conversation.messages.slice(-HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
    }

    const usage = await quota.consume(user.id);
    if (!usage.allowed) {
      throw new HttpError(429, 'quota_exceeded', `You've reached today's limit of ${usage.limit} messages. Please try again tomorrow.`, {
        limit: usage.limit,
        used: usage.used,
        resetsAt: nextUtcMidnight(),
      });
    }

    let reply: ChatReply;
    try {
      reply = await withTimeout(chatService.respond({ message, history }), timeoutMs);
    } catch (error) {
      if (error instanceof TimeoutError) {
        logger.warn({ requestId: res.locals.requestId, timeoutMs }, 'chat turn timed out');
        throw new HttpError(504, 'timeout', 'The assistant took too long to respond. Please try again.');
      }
      if (error instanceof AnswerUnavailableError) {
        logger.warn({ requestId: res.locals.requestId, err: error }, 'chat answer unavailable');
        res.setHeader('Retry-After', '10');
        throw new HttpError(503, 'service_unavailable', 'The assistant is temporarily unavailable. Please try again in a moment.');
      }
      throw error;
    }

    try {
      const saved = await exchanges.append({
        userId: user.id,
        conversationId,
        clientMessageId,
        title: titleFromMessage(message),
        userContent: message,
        assistantContent: reply.content,
        intent: reply.intent,
        sources: reply.sources,
        metadata: replyMetadata(reply),
      });
      res.json(toResponse(saved));
    } catch (error) {
      if (error instanceof ConversationNotFoundError) throw new HttpError(404, 'not_found', 'Conversation not found');
      throw error;
    }
  });

  return router;
}
