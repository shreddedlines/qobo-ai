import type { GoogleGenAI } from '@google/genai';

import { googleRetryDelayMs } from '../lib/google-api-errors.ts';
import type { RateLimiter } from '../lib/rate-limiter.ts';
import { withRetry, type RetryOptions } from '../lib/retry.ts';

/**
 * Must match `extensions.vector(768)` in supabase/migrations/*_knowledge_base.sql.
 * Ingestion and query-time retrieval both import these helpers, so documents and
 * queries are always embedded with the same model, dimension and task format.
 */
export const EMBEDDING_DIM = 768;

/** gemini-embedding-2 takes task instructions as text prefixes (not a taskType field). */
export function formatDocumentForEmbedding(title: string, text: string): string {
  return `title: ${title.trim() || 'none'} | text: ${text}`;
}

export function formatQueryForEmbedding(query: string): string {
  return `task: question answering | query: ${query}`;
}

export interface EmbeddingDocument {
  title: string;
  text: string;
}

export interface Embedder {
  readonly model: string;
  readonly dimension: number;
  embedDocuments(documents: EmbeddingDocument[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

export type EmbedContentClient = Pick<GoogleGenAI['models'], 'embedContent'>;

export class EmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EmbeddingError';
  }
}

export interface GeminiEmbedderOptions {
  batchSize?: number;
  /**
   * Quota guard. Each text counts as one request (batch embedding is metered per
   * input), and every attempt, including retries, acquires its units first.
   */
  rateLimiter?: RateLimiter;
  /** Retry policy per batch. HTTP 429 waits at least the server-provided retryDelay. */
  retry?: Pick<RetryOptions, 'retries' | 'baseDelayMs' | 'maxDelayMs' | 'giveUpIfServerDelayExceedsMs' | 'onRetry' | 'sleep' | 'random'>;
  /** Per-attempt request timeout. */
  timeoutMs?: number;
  onBatchComplete?: (embedded: number, total: number) => void;
}

const DEFAULT_RETRY = { retries: 5, baseDelayMs: 1_000, maxDelayMs: 120_000 };

export function createGeminiEmbedder(client: EmbedContentClient, model: string, options: GeminiEmbedderOptions = {}): Embedder {
  const { batchSize = 20, rateLimiter, retry = DEFAULT_RETRY, timeoutMs, onBatchComplete } = options;

  async function embedBatch(batch: string[]): Promise<number[][]> {
    const response = await withRetry(
      async () => {
        await rateLimiter?.acquire(batch.length);
        return client.embedContent({
          model,
          // Each text MUST be its own Content object: gemini-embedding-2 aggregates
          // plain multi-part input into a single embedding.
          contents: batch.map((text) => ({ role: 'user', parts: [{ text }] })),
          config: { outputDimensionality: EMBEDDING_DIM, ...(timeoutMs ? { abortSignal: AbortSignal.timeout(timeoutMs) } : {}) },
        });
      },
      { ...DEFAULT_RETRY, ...retry, serverDelayMs: googleRetryDelayMs },
    );

    const embeddings = response.embeddings ?? [];
    if (embeddings.length !== batch.length) {
      throw new EmbeddingError(`Expected ${batch.length} embeddings from ${model}, received ${embeddings.length}`);
    }
    return embeddings.map((embedding) => validateAndNormalize(embedding.values, model));
  }

  async function embedTexts(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      vectors.push(...(await embedBatch(texts.slice(start, start + batchSize))));
      onBatchComplete?.(vectors.length, texts.length);
    }
    return vectors;
  }

  return {
    model,
    dimension: EMBEDDING_DIM,
    embedDocuments: (documents) => embedTexts(documents.map((doc) => formatDocumentForEmbedding(doc.title, doc.text))),
    async embedQuery(query) {
      const [vector] = await embedTexts([formatQueryForEmbedding(query)]);
      return vector!;
    },
  };
}

function validateAndNormalize(values: number[] | undefined, model: string): number[] {
  if (!values || values.length !== EMBEDDING_DIM) {
    throw new EmbeddingError(`Expected a ${EMBEDDING_DIM}-dimension embedding from ${model}, received ${values?.length ?? 0}`);
  }
  let sumOfSquares = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new EmbeddingError(`Embedding from ${model} contains a non-finite value`);
    sumOfSquares += value * value;
  }
  const norm = Math.sqrt(sumOfSquares);
  if (norm === 0) throw new EmbeddingError(`Embedding from ${model} is a zero vector`);
  return values.map((value) => value / norm);
}

/** pgvector text literal, e.g. "[0.1,0.2]". */
export function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}
