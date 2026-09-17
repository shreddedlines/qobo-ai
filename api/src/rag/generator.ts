import { ThinkingLevel, type GoogleGenAI } from '@google/genai';
import { z } from 'zod';

import { googleRetryDelayMs } from '../lib/google-api-errors.ts';
import { isTransientError, withRetry, type RetryOptions } from '../lib/retry.ts';
import { ANSWER_RESPONSE_SCHEMA } from './prompts.ts';

export interface AnswerDraft {
  status: 'answered' | 'insufficient';
  answer: string;
  citations: string[];
  /** Model that produced this draft (the fallback model when the primary was unavailable). */
  model: string;
}

export interface GenerateInput {
  systemInstruction: string;
  prompt: string;
}

export interface AnswerGenerator {
  readonly model: string;
  generate(input: GenerateInput): Promise<AnswerDraft>;
}

export type GenerateContentClient = Pick<GoogleGenAI['models'], 'generateContent'>;

/** The model returned nothing usable (blocked, empty or malformed JSON). Not retried. */
export class InvalidModelOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidModelOutputError';
  }
}

const draftSchema = z.object({
  status: z.enum(['answered', 'insufficient']),
  answer: z.string(),
  citations: z.array(z.string()).default([]),
});

type RetryPolicy = Pick<RetryOptions, 'retries' | 'baseDelayMs' | 'maxDelayMs' | 'giveUpIfServerDelayExceedsMs' | 'sleep' | 'random' | 'onRetry'>;

export interface GeminiGeneratorOptions {
  /**
   * Used when the primary model is overloaded (503), rate limited (429) or too slow.
   * Retrying an overloaded model mostly fails again, so the primary gets a single
   * attempt and the fallback gets the retry policy.
   */
  fallbackModel?: string;
  retry?: RetryPolicy;
  timeoutMs?: number;
  fallbackTimeoutMs?: number;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
  /**
   * After the primary fails, send requests straight to the fallback for this long
   * instead of making every user wait for the primary to time out again.
   */
  primaryCooldownMs?: number;
  now?: () => number;
  onFallback?: (error: unknown) => void;
}

/** Upstream conditions where another model may succeed: rate limits, server errors, timeouts, network failures. */
export function isUnavailableModelError(error: unknown): boolean {
  if (isTransientError(error)) return true;
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'AbortError' || name === 'TimeoutError';
}

export function createGeminiAnswerGenerator(client: GenerateContentClient, model: string, options: GeminiGeneratorOptions = {}): AnswerGenerator {
  const {
    fallbackModel,
    retry = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000, giveUpIfServerDelayExceedsMs: 8_000 },
    timeoutMs = 10_000,
    fallbackTimeoutMs = 20_000,
    thinkingLevel = ThinkingLevel.LOW,
    maxOutputTokens = 2_048,
    primaryCooldownMs = 120_000,
    now = Date.now,
    onFallback,
  } = options;
  let primaryUnavailableUntil = 0;

  async function attempt(targetModel: string, input: GenerateInput, policy: RetryPolicy, attemptTimeoutMs: number): Promise<AnswerDraft> {
    const response = await withRetry(
      () =>
        client.generateContent({
          model: targetModel,
          contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
          config: {
            systemInstruction: input.systemInstruction,
            responseMimeType: 'application/json',
            responseJsonSchema: ANSWER_RESPONSE_SCHEMA,
            thinkingConfig: { thinkingLevel },
            maxOutputTokens,
            abortSignal: AbortSignal.timeout(attemptTimeoutMs),
          },
        }),
      { ...policy, serverDelayMs: googleRetryDelayMs },
    );

    const text = response.text;
    if (!text) {
      const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? 'unknown';
      throw new InvalidModelOutputError(`Model returned no text (reason: ${reason})`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new InvalidModelOutputError('Model output is not valid JSON', { cause: error });
    }
    const draft = draftSchema.safeParse(parsed);
    if (!draft.success) throw new InvalidModelOutputError('Model output does not match the answer schema', { cause: draft.error });
    return { ...draft.data, model: targetModel };
  }

  return {
    model,
    async generate(input) {
      if (!fallbackModel) return attempt(model, input, retry, timeoutMs);
      if (now() < primaryUnavailableUntil) return attempt(fallbackModel, input, retry, fallbackTimeoutMs);
      try {
        return await attempt(model, input, { ...retry, retries: 0 }, timeoutMs);
      } catch (error) {
        if (!isUnavailableModelError(error)) throw error;
        primaryUnavailableUntil = now() + primaryCooldownMs;
        onFallback?.(error);
        return attempt(fallbackModel, input, retry, fallbackTimeoutMs);
      }
    },
  };
}
