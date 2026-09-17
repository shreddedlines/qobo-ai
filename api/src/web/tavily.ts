import { z } from 'zod';

import { withRetry, type RetryOptions } from '../lib/retry.ts';

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface WebSearchProvider {
  search(query: string): Promise<WebSearchResult[]>;
}

export class WebSearchError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WebSearchError';
    this.status = status;
  }
}

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const MAX_CONTENT_CHARS = 1_200;

const responseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
      score: z.number().nullish(),
    }),
  ),
});

/**
 * Removes personal data before a query leaves our system (Tavily's terms grant it
 * broad rights over submitted queries). The router already asks for a clean query;
 * this is the deterministic backstop.
 */
export function sanitizeSearchQuery(query: string): string {
  return query
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Results about QOBO must come from the reviewed knowledge base; other "Qobo" sites may be different companies. */
function isAllowedResultUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !/qobo/i.test(parsed.hostname);
}

export interface TavilySearchOptions {
  apiKey: string;
  maxResults?: number;
  timeoutMs?: number;
  retry?: Pick<RetryOptions, 'retries' | 'baseDelayMs' | 'maxDelayMs' | 'sleep' | 'random'>;
  fetch?: typeof fetch;
}

/**
 * Tavily basic search (1 credit per request). 429 and 5xx are retried briefly;
 * 401 (bad key), 432/433 (plan or pay-as-you-go limit) and other 4xx are not.
 */
export function createTavilySearch({
  apiKey,
  maxResults = 5,
  timeoutMs = 8_000,
  retry = { retries: 1, baseDelayMs: 500, maxDelayMs: 2_000 },
  fetch: fetchImpl = fetch,
}: TavilySearchOptions): WebSearchProvider {
  return {
    async search(rawQuery) {
      const query = sanitizeSearchQuery(rawQuery);
      if (!query) return [];

      const body = await withRetry(
        async () => {
          let response: Response;
          try {
            response = await fetchImpl(TAVILY_SEARCH_URL, {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query,
                search_depth: 'basic',
                topic: 'general',
                max_results: maxResults,
                include_answer: false,
                include_raw_content: false,
                include_images: false,
              }),
              signal: AbortSignal.timeout(timeoutMs),
            });
          } catch (error) {
            throw new WebSearchError('Web search request failed', undefined, { cause: error });
          }

          if (!response.ok) {
            const detail = await response.json().catch(() => undefined);
            const message = (detail as { detail?: { error?: unknown } } | undefined)?.detail?.error;
            throw new WebSearchError(`Web search returned HTTP ${response.status}${typeof message === 'string' ? `: ${message.slice(0, 200)}` : ''}`, response.status);
          }
          try {
            return await response.json();
          } catch (error) {
            throw new WebSearchError('Web search returned invalid JSON', response.status, { cause: error });
          }
        },
        {
          ...retry,
          isRetryable: (error) =>
            error instanceof WebSearchError && (error.status === undefined ? !(error.cause instanceof DOMException) : error.status === 429 || error.status >= 500),
        },
      );

      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) throw new WebSearchError('Web search response has an unexpected shape', undefined, { cause: parsed.error });

      const seen = new Set<string>();
      return parsed.data.results
        .filter((result) => isAllowedResultUrl(result.url) && result.content?.trim())
        .filter((result) => (seen.has(result.url) ? false : (seen.add(result.url), true)))
        .slice(0, maxResults)
        .map((result) => ({
          title: (result.title?.trim() || new URL(result.url).hostname).slice(0, 200),
          url: result.url,
          content: result.content!.trim().slice(0, MAX_CONTENT_CHARS),
          score: result.score ?? 0,
        }));
    },
  };
}
