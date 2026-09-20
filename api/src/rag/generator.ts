import { ThinkingLevel, type GoogleGenAI } from '@google/genai';
import { z } from 'zod';

import { googleRetryDelayMs } from '../lib/google-api-errors.ts';
import { isTransientError, withRetry, type RetryOptions } from '../lib/retry.ts';
import { createJsonStringFieldExtractor } from './json-stream.ts';
import { ANSWER_RESPONSE_SCHEMA } from './prompts.ts';

export type GenerateContentClient = Pick<GoogleGenAI['models'], 'generateContent' | 'generateContentStream'>;

/** The model returned nothing usable (blocked, empty or malformed JSON). Not retried. */
export class InvalidModelOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidModelOutputError';
  }
}

type RetryPolicy = Pick<RetryOptions, 'retries' | 'baseDelayMs' | 'maxDelayMs' | 'giveUpIfServerDelayExceedsMs' | 'sleep' | 'random' | 'onRetry'>;

export interface JsonGeneratorOptions {
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
  /** Response-schema field whose text `generateStream` reports as it arrives. */
  streamedField?: string;
  now?: () => number;
  onFallback?: (error: unknown) => void;
}

export interface JsonGenerateInput<T> {
  systemInstruction: string;
  prompt: string;
  responseJsonSchema: unknown;
  schema: z.ZodType<T>;
}

export interface JsonGenerator {
  readonly model: string;
  /** Resolves the parsed value and the model that produced it. */
  generate<T>(input: JsonGenerateInput<T>): Promise<{ value: T; model: string }>;
}

/**
 * Called as the answer text arrives. `onReset` means everything handed over so far
 * belongs to an attempt that failed (a retry, or the switch to the fallback model):
 * discard it, because the next attempt starts the answer again from the beginning.
 */
export interface StreamHandlers {
  onDelta(delta: string): void;
  onReset?(): void;
}

export type StreamTarget = StreamHandlers['onDelta'] | StreamHandlers;

/**
 * A JSON generator that can also report an answer as it is produced. The streamed
 * deltas are a provisional view for display only; the resolved value is the same
 * parsed, schema-validated object `generate` returns.
 */
export interface StreamingJsonGenerator extends JsonGenerator {
  /** The field of the response schema whose text is streamed to `onDelta`. */
  readonly streamedField: string;
  generateStream<T>(input: JsonGenerateInput<T>, onDelta: StreamTarget): Promise<{ value: T; model: string }>;
}

/** Upstream conditions where another model may succeed: rate limits, server errors, timeouts, network failures. */
export function isUnavailableModelError(error: unknown): boolean {
  if (isTransientError(error)) return true;
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'AbortError' || name === 'TimeoutError';
}

export function createGeminiJsonGenerator(client: GenerateContentClient, model: string, options: JsonGeneratorOptions = {}): StreamingJsonGenerator {
  const {
    fallbackModel,
    retry = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000, giveUpIfServerDelayExceedsMs: 8_000 },
    timeoutMs = 10_000,
    fallbackTimeoutMs = 20_000,
    thinkingLevel = ThinkingLevel.LOW,
    maxOutputTokens = 2_048,
    primaryCooldownMs = 120_000,
    streamedField = 'answer',
    now = Date.now,
    onFallback,
  } = options;
  let primaryUnavailableUntil = 0;

  /** The same request for both call styles, so streaming cannot drift from generate(). */
  function requestFor<T>(targetModel: string, input: JsonGenerateInput<T>, attemptTimeoutMs: number) {
    return {
      model: targetModel,
      contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
      config: {
        systemInstruction: input.systemInstruction,
        responseMimeType: 'application/json',
        responseJsonSchema: input.responseJsonSchema,
        thinkingConfig: { thinkingLevel },
        maxOutputTokens,
        abortSignal: AbortSignal.timeout(attemptTimeoutMs),
      },
    };
  }

  /** The whole document, parsed and schema-validated. Malformed output is never retried. */
  function parse<T>(text: string | undefined, input: JsonGenerateInput<T>, targetModel: string, reason: string | undefined): { value: T; model: string } {
    if (!text) throw new InvalidModelOutputError(`Model returned no text (reason: ${reason ?? 'unknown'})`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new InvalidModelOutputError('Model output is not valid JSON', { cause: error });
    }
    const result = input.schema.safeParse(parsed);
    if (!result.success) throw new InvalidModelOutputError('Model output does not match the response schema', { cause: result.error });
    return { value: result.data, model: targetModel };
  }

  async function attempt<T>(targetModel: string, input: JsonGenerateInput<T>, policy: RetryPolicy, attemptTimeoutMs: number): Promise<{ value: T; model: string }> {
    const response = await withRetry(() => client.generateContent(requestFor(targetModel, input, attemptTimeoutMs)), { ...policy, serverDelayMs: googleRetryDelayMs });
    return parse(response.text, input, targetModel, response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason);
  }

  /**
   * Consumes the stream, reporting the answer field as it arrives and keeping the raw
   * document for the final parse. Every attempt starts the answer over, so `beginAttempt`
   * tells the caller to drop what a failed attempt already produced.
   */
  async function streamAttempt<T>(
    targetModel: string,
    input: JsonGenerateInput<T>,
    policy: RetryPolicy,
    attemptTimeoutMs: number,
    emit: (delta: string) => void,
    beginAttempt: () => void,
  ): Promise<{ value: T; model: string }> {
    const { text, reason } = await withRetry(
      async () => {
        beginAttempt();
        const answer = createJsonStringFieldExtractor(streamedField);
        let raw = '';
        let finishReason: string | undefined;

        const stream = await client.generateContentStream(requestFor(targetModel, input, attemptTimeoutMs));
        for await (const chunk of stream) {
          finishReason = chunk.candidates?.[0]?.finishReason ?? chunk.promptFeedback?.blockReason ?? finishReason;
          const part = chunk.text;
          if (!part) continue;
          raw += part;
          emit(answer.push(part));
        }
        return { text: raw, reason: finishReason };
      },
      { ...policy, serverDelayMs: googleRetryDelayMs },
    );

    return parse(text, input, targetModel, reason);
  }

  /** Primary, then fallback, with the cooldown both call styles share. */
  async function run<R>(runAttempt: (targetModel: string, policy: RetryPolicy, attemptTimeoutMs: number) => Promise<R>): Promise<R> {
    if (!fallbackModel) return runAttempt(model, retry, timeoutMs);
    if (now() < primaryUnavailableUntil) return runAttempt(fallbackModel, retry, fallbackTimeoutMs);
    try {
      return await runAttempt(model, { ...retry, retries: 0 }, timeoutMs);
    } catch (error) {
      if (!isUnavailableModelError(error)) throw error;
      primaryUnavailableUntil = now() + primaryCooldownMs;
      onFallback?.(error);
      return runAttempt(fallbackModel, retry, fallbackTimeoutMs);
    }
  }

  return {
    model,
    streamedField,

    async generate(input) {
      return run((targetModel, policy, attemptTimeoutMs) => attempt(targetModel, input, policy, attemptTimeoutMs));
    },

    async generateStream(input, onDelta) {
      const handlers: StreamHandlers = typeof onDelta === 'function' ? { onDelta } : onDelta;
      let emitted = false;
      const emit = (delta: string) => {
        if (delta === '') return;
        emitted = true;
        handlers.onDelta(delta);
      };
      const beginAttempt = () => {
        if (!emitted) return;
        emitted = false;
        handlers.onReset?.();
      };

      return run((targetModel, policy, attemptTimeoutMs) => streamAttempt(targetModel, input, policy, attemptTimeoutMs, emit, beginAttempt));
    },
  };
}

// ---------------------------------------------------------------------------
// QOBO answer drafts (M4 interface, unchanged)
// ---------------------------------------------------------------------------

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
  /** Present only when the underlying generator can stream; the draft is the same either way. */
  generateStream?(input: GenerateInput, onDelta: StreamTarget): Promise<AnswerDraft>;
}

/** True when this generator can also report an answer as it is produced. */
export function isStreamingJsonGenerator(generator: JsonGenerator): generator is StreamingJsonGenerator {
  return typeof (generator as Partial<StreamingJsonGenerator>).generateStream === 'function';
}

const draftSchema = z.object({
  status: z.enum(['answered', 'insufficient']),
  answer: z.string(),
  citations: z.array(z.string()).default([]),
});

export type GeminiGeneratorOptions = JsonGeneratorOptions;

export function createGeminiAnswerGenerator(client: GenerateContentClient, model: string, options: GeminiGeneratorOptions = {}): AnswerGenerator {
  return fromJsonGenerator(createGeminiJsonGenerator(client, model, options));
}

/** Adapts a shared JSON generator (and its fallback cooldown) to the QOBO answer interface. */
export function fromJsonGenerator(json: JsonGenerator): AnswerGenerator {
  const request = (input: GenerateInput) => ({ ...input, responseJsonSchema: ANSWER_RESPONSE_SCHEMA, schema: draftSchema });

  const generator: AnswerGenerator = {
    model: json.model,
    async generate(input) {
      const { value, model: usedModel } = await json.generate(request(input));
      return { ...value, model: usedModel };
    },
  };

  if (!isStreamingJsonGenerator(json)) return generator;

  return {
    ...generator,
    async generateStream(input, onDelta) {
      const { value, model: usedModel } = await json.generateStream(request(input), onDelta);
      return { ...value, model: usedModel };
    },
  };
}
