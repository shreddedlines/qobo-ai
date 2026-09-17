import { GoogleGenAI } from '@google/genai';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Env } from '../config/env.ts';
import { createServiceClient } from '../db/supabase.ts';
import { createSlidingWindowLimiter } from '../lib/rate-limiter.ts';
import { createGeminiEmbedder } from './embeddings.ts';
import { createGeminiAnswerGenerator } from './generator.ts';
import { createQoboAnswerService, type QoboAnswerService } from './qobo-answer.ts';
import { createSupabaseKbRetriever } from './retriever.ts';

/**
 * Chat requests are interactive: retry briefly, and fail fast instead of waiting
 * out a long 429 retryDelay or a full rate-limit window.
 */
export const CHAT_RETRY = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000, giveUpIfServerDelayExceedsMs: 8_000 };
export const CHAT_RATE_LIMIT_MAX_WAIT_MS = 5_000;

export interface RagRuntime {
  answerService: QoboAnswerService;
  service: SupabaseClient;
}

export function createRagRuntime(env: Env): RagRuntime {
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

  const answerService = createQoboAnswerService({
    retriever: createSupabaseKbRetriever({ service, embedder, matchCount: env.KB_MATCH_COUNT, minSimilarity: env.KB_MIN_SIMILARITY }),
    generator: createGeminiAnswerGenerator(genai.models, env.GEMINI_ANSWER_MODEL, {
      ...(env.GEMINI_ANSWER_FALLBACK_MODEL ? { fallbackModel: env.GEMINI_ANSWER_FALLBACK_MODEL } : {}),
      retry: CHAT_RETRY,
      timeoutMs: 10_000,
      fallbackTimeoutMs: 20_000,
      primaryCooldownMs: 120_000,
    }),
  });

  return { answerService, service };
}
