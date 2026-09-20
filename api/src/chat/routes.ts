import { Router, type Response } from 'express';
import { z } from 'zod';

import { getAuthUser } from '../auth/require-auth.ts';
import type { AuthUser } from '../auth/token-verifier.ts';
import type { ConversationStore } from '../conversations/store.ts';
import { HttpError, type ErrorCode } from '../http/errors.ts';
import type { Logger } from '../lib/logger.ts';
import { TimeoutError, withTimeout } from '../lib/timeout.ts';
import type { StreamHandlers } from '../rag/generator.ts';
import type { HistoryTurn } from '../rag/prompts.ts';
import { AnswerUnavailableError } from '../rag/qobo-answer.ts';
import { createAnswerStream } from './answer-stream.ts';
import type { ChatReply, ChatService } from './chat-service.ts';
import { ConversationNotFoundError, MessageNotReplaceableError, type ExchangeStore, type StoredExchange } from './exchange-store.ts';
import { nextUtcMidnight, type UserMessageQuota } from './user-quota.ts';

export const MAX_MESSAGE_CHARS = 2_000;
/** Recent messages (user + assistant) passed to the router and answer models. */
export const HISTORY_MESSAGES = 10;
const MAX_TITLE_CHARS = 60;

/**
 * A comment frame every so often, so a proxy between here and the browser does not
 * close a stream that is simply still thinking (routing and retrieval come before
 * the first token). Ignored by every SSE parser.
 */
export const STREAM_HEARTBEAT_MS = 15_000;

const chatRequestSchema = z
  .object({
    message: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1, 'message must not be empty').max(MAX_MESSAGE_CHARS, `message must be at most ${MAX_MESSAGE_CHARS} characters`)),
    clientMessageId: z.uuid(),
    conversationId: z.uuid().nullish(),
    /**
     * Edit: replace this saved user message and its reply instead of appending. The
     * conversation it belongs to must be named too, so ownership is checked against
     * both before anything is regenerated.
     */
    replaceMessageId: z.uuid().nullish(),
  })
  .refine((body) => !body.replaceMessageId || Boolean(body.conversationId), {
    message: 'conversationId is required when replaceMessageId is set',
    path: ['conversationId'],
  });

type ChatRequestBody = z.infer<typeof chatRequestSchema>;

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

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

export type StreamEvent = 'delta' | 'reset' | 'done' | 'error';

export interface StreamErrorFrame {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Writes the event stream. Once the first byte is out the status line is fixed, so
 * everything after that — including failures — is delivered as a frame.
 */
export function createFrameWriter(res: Response) {
  let open = true;
  res.on('close', () => {
    open = false;
  });

  return {
    /** Opens the stream. Nothing may set a header or a status after this. */
    open(): void {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      // no-transform tells proxies not to buffer or rewrite; X-Accel-Buffering is
      // the same instruction for nginx, which Render's router is built on.
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    },

    send(event: StreamEvent, data: unknown): void {
      // JSON.stringify never produces a raw newline, so one data: line always holds it.
      if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },

    heartbeat(): void {
      if (open) res.write(': keep-alive\n\n');
    },

    /**
     * Closes the stream for good. The flag goes down first: 'close' arrives a tick
     * later, and a delta from work that outlived the response — the pipeline keeps
     * running after a timeout — must not reach res.write() in between.
     */
    end(): void {
      if (!open) return;
      open = false;
      res.end();
    },
  };
}

/** The error frame for a failure the browser should act on, in the JSON error body's shape. */
function errorFrame(error: unknown, logger: Logger, requestId: unknown): StreamErrorFrame {
  if (error instanceof HttpError) {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  logger.error({ err: error, requestId }, 'chat stream failed');
  return { code: 'internal_error', message: 'Something went wrong. Please try again.' };
}

/**
 * POST /api/chat        — one chat turn, answered in full.
 * POST /api/chat/stream — the same turn, reported as it is written (SSE).
 *
 *   1. validate → 2. replay if this clientMessageId was already saved (no quota, no model calls)
 *   3. load history (RLS-scoped; 404 for foreign conversations) → 4. consume the daily cap
 *   5. run the chat pipeline under a timeout → 6. save both messages atomically.
 *
 * Both routes run exactly these steps. Nothing is saved when the pipeline fails or
 * times out, so the client can retry with the same clientMessageId.
 */
export function createChatRouter({ chatService, exchanges, conversations, quota, timeoutMs, logger }: ChatRouterDeps): Router {
  const router = Router();

  function parseBody(body: unknown): ChatRequestBody {
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'bad_request', 'Invalid chat request', parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`));
    }
    return parsed.data;
  }

  /**
   * Steps 2–4: everything that must settle before a model is called. Resolves the
   * saved exchange when this message was already answered, otherwise the history the
   * turn will be generated against — by which point the daily cap has been charged.
   */
  async function prepareTurn(user: AuthUser, body: ChatRequestBody): Promise<{ replay: StoredExchange } | { history: HistoryTurn[] }> {
    const { clientMessageId, conversationId = null, replaceMessageId = null } = body;

    const existing = await exchanges.findByClientMessageId(user.id, clientMessageId);
    if (existing) {
      if (conversationId && existing.conversation.id !== conversationId) {
        throw new HttpError(409, 'conflict', 'clientMessageId was already used in another conversation');
      }
      return { replay: existing };
    }

    let history: HistoryTurn[] = [];
    if (conversationId) {
      const conversation = await conversations.getWithMessages(user, conversationId);
      if (!conversation) throw new HttpError(404, 'not_found', 'Conversation not found');

      let earlier = conversation.messages;
      if (replaceMessageId) {
        // Regenerate with the conversation as it stood when this message was asked:
        // its own turn and everything after it are not context for it.
        const target = conversation.messages.findIndex((m) => m.id === replaceMessageId);
        if (target === -1 || conversation.messages[target]?.role !== 'user') {
          throw new HttpError(404, 'not_found', 'Message not found');
        }
        earlier = conversation.messages.slice(0, target);
      }
      history = earlier.slice(-HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
    }

    const usage = await quota.consume(user.id);
    if (!usage.allowed) {
      throw new HttpError(429, 'quota_exceeded', `You've reached today's limit of ${usage.limit} messages. Please try again tomorrow.`, {
        limit: usage.limit,
        used: usage.used,
        resetsAt: nextUtcMidnight(),
      });
    }

    return { history };
  }

  /** Step 5. Streaming, when asked for, changes what the caller sees on the way — not the reply. */
  async function runPipeline(body: ChatRequestBody, history: HistoryTurn[], requestId: unknown, stream?: StreamHandlers): Promise<ChatReply> {
    try {
      return await withTimeout(chatService.respond({ message: body.message, history, ...(stream ? { stream } : {}) }), timeoutMs);
    } catch (error) {
      if (error instanceof TimeoutError) {
        logger.warn({ requestId, timeoutMs }, 'chat turn timed out');
        throw new HttpError(504, 'timeout', 'The assistant took too long to respond. Please try again.');
      }
      if (error instanceof AnswerUnavailableError) {
        logger.warn({ requestId, err: error }, 'chat answer unavailable');
        throw new HttpError(503, 'service_unavailable', 'The assistant is temporarily unavailable. Please try again in a moment.');
      }
      throw error;
    }
  }

  /**
   * Step 6. Nothing has been written before this, which is what makes an edit safe to
   * retry — and what keeps a half-streamed answer out of the database.
   */
  async function saveExchange(user: AuthUser, body: ChatRequestBody, reply: ChatReply): Promise<StoredExchange> {
    const { message, clientMessageId, conversationId = null, replaceMessageId = null } = body;
    const stored = {
      userId: user.id,
      clientMessageId,
      title: titleFromMessage(message),
      userContent: message,
      assistantContent: reply.content,
      intent: reply.intent,
      sources: reply.sources,
      metadata: replyMetadata(reply),
    };

    try {
      return replaceMessageId && conversationId
        ? await exchanges.replace({ ...stored, conversationId, targetMessageId: replaceMessageId })
        : await exchanges.append({ ...stored, conversationId });
    } catch (error) {
      if (error instanceof MessageNotReplaceableError) throw new HttpError(404, 'not_found', 'Message not found');
      if (error instanceof ConversationNotFoundError) throw new HttpError(404, 'not_found', 'Conversation not found');
      throw error;
    }
  }

  router.post('/', async (req, res) => {
    const body = parseBody(req.body);
    const user = getAuthUser(res);

    const prepared = await prepareTurn(user, body);
    if ('replay' in prepared) {
      res.json(toResponse(prepared.replay));
      return;
    }

    let reply: ChatReply;
    try {
      reply = await runPipeline(body, prepared.history, res.locals.requestId);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'service_unavailable') res.setHeader('Retry-After', '10');
      throw error;
    }

    res.json(toResponse(await saveExchange(user, body, reply)));
  });

  /**
   * The same turn as POST /, reported as it is written.
   *
   * Everything that can be settled before a model runs — validation, replay,
   * ownership, the daily cap — is answered with an ordinary JSON status, exactly as
   * POST / answers it. The stream opens only once generation is about to start; from
   * then on a failure is an `error` frame, because the status line is already sent.
   *
   * Deltas are provisional: citation markers are stripped on the way out, and the
   * `done` frame carries the canonical reply, with resolved citations and guards, that
   * POST / would have returned. A turn with nothing to stream — a replay, off-topic,
   * small talk — simply sends `done`.
   */
  router.post('/stream', async (req, res) => {
    const body = parseBody(req.body);
    const user = getAuthUser(res);
    const requestId = res.locals.requestId;

    const prepared = await prepareTurn(user, body);

    const frames = createFrameWriter(res);
    frames.open();

    if ('replay' in prepared) {
      frames.send('done', toResponse(prepared.replay));
      frames.end();
      return;
    }

    const answer = createAnswerStream({
      onDelta: (text) => frames.send('delta', { text }),
      onReset: () => frames.send('reset', {}),
    });

    const heartbeat = setInterval(() => frames.heartbeat(), STREAM_HEARTBEAT_MS);
    heartbeat.unref();

    try {
      const reply = await runPipeline(body, prepared.history, requestId, answer);
      answer.flush();

      // The answer is complete and guarded before a single row is written.
      frames.send('done', toResponse(await saveExchange(user, body, reply)));
    } catch (error) {
      frames.send('error', errorFrame(error, logger, requestId));
    } finally {
      clearInterval(heartbeat);
      frames.end();
    }
  });

  return router;
}
