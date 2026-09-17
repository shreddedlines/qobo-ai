import { GoogleGenAI } from '@google/genai';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createChatService, type ChatService } from '../chat/chat-service.ts';
import { createGeneralAnswerService } from '../chat/general-answer.ts';
import { createIntentRouter } from '../chat/router.ts';
import type { Env } from '../config/env.ts';
import { createServiceClient } from '../db/supabase.ts';
import { createSlidingWindowLimiter } from '../lib/rate-limiter.ts';
import { createSupabaseGlobalQuota } from '../web/quota.ts';
import { createTavilySearch } from '../web/tavily.ts';
import { createGeminiEmbedder } from './embeddings.ts';
import { createGeminiJsonGenerator, fromJsonGenerator } from './generator.ts';
import { createQoboAnswerService, type QoboAnswerService } from './qobo-answer.ts';
import { createSupabaseKbRetriever } from './retriever.ts';

/**
 * Chat requests are interactive: retry briefly, and fail fast instead of waiting
 * out a long 429 retryDelay or a full rate-limit window.
 */
export const CHAT_RETRY = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000, giveUpIfServerDelayExceedsMs: 8_000 };
export const CHAT_RATE_LIMIT_MAX_WAIT_MS = 5_000;

export interface ChatRuntime {
  chatService: ChatService;
  answerService: QoboAnswerService;
  service: SupabaseClient;
}

export function createChatRuntime(env: Env): ChatRuntime {
  // One client with SDK retries disabled: withRetry is the single retry layer.
  const genai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { retryOptions: { attempts: 1 } } });
  const service = createServiceClient(env);

  // One limiter per process, shared by every chat-time embedding.
  const embeddingLimiter = createSlidingWindowLimiter({
    limit: env.GEMINI_EMBED_REQUESTS_PER_MINUTE,
    windowMs: 60_000,
    maxWaitMs: CHAT_RATE_LIMIT_MAX_WAIT_MS,
  });
  const embedder = createGeminiEmbedder(genai.models, env.GEMINI_EMBEDDING_MODEL, {
    batchSize: 1,
    rateLimiter: embeddingLimiter,
    retry: CHAT_RETRY,
    timeoutMs: 8_000,
  });
  const retriever = createSupabaseKbRetriever({ service, embedder, matchCount: env.KB_MATCH_COUNT, minSimilarity: env.KB_MIN_SIMILARITY });

  // Shared by QOBO and general answers, so both benefit from the primary-model cooldown.
  const answerModel = createGeminiJsonGenerator(genai.models, env.GEMINI_ANSWER_MODEL, {
    ...(env.GEMINI_ANSWER_FALLBACK_MODEL ? { fallbackModel: env.GEMINI_ANSWER_FALLBACK_MODEL } : {}),
    retry: CHAT_RETRY,
    timeoutMs: 10_000,
    fallbackTimeoutMs: 20_000,
    primaryCooldownMs: 120_000,
  });

  const routerModel = createGeminiJsonGenerator(genai.models, env.GEMINI_ROUTER_MODEL, {
    retry: CHAT_RETRY,
    timeoutMs: 8_000,
    maxOutputTokens: 512,
  });

  const answerService = createQoboAnswerService({ retriever, generator: fromJsonGenerator(answerModel) });
  const chatService = createChatService({
    router: createIntentRouter(routerModel),
    qobo: answerService,
    general: createGeneralAnswerService({
      search: createTavilySearch({ apiKey: env.TAVILY_API_KEY }),
      quota: createSupabaseGlobalQuota(service, 'web_search', env.WEB_SEARCH_DAILY_CAP),
      retriever,
      generator: answerModel,
    }),
  });

  return { chatService, answerService, service };
}
