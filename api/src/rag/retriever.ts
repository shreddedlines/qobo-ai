import type { SupabaseClient } from '@supabase/supabase-js';

import type { Embedder } from './embeddings.ts';
import type { RetrievedChunk } from './sources.ts';

export interface KbRetriever {
  retrieve(query: string): Promise<RetrievedChunk[]>;
}

export class RetrievalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RetrievalError';
  }
}

interface MatchRow {
  id: number;
  url: string;
  title: string;
  section: string | null;
  page_type: string;
  content: string;
  topics: string[] | null;
  similarity: number;
}

export interface SupabaseRetrieverOptions {
  service: Pick<SupabaseClient, 'rpc'>;
  embedder: Embedder;
  matchCount: number;
  minSimilarity: number;
}

/** Query embedding (shared rate limiter + retries) → match_kb_chunks via the service role. */
export function createSupabaseKbRetriever({ service, embedder, matchCount, minSimilarity }: SupabaseRetrieverOptions): KbRetriever {
  return {
    async retrieve(query) {
      const embedding = await embedder.embedQuery(query);
      const { data, error } = await service.rpc('match_kb_chunks', {
        p_query_embedding: embedding,
        p_match_count: matchCount,
        p_min_similarity: minSimilarity,
      });
      if (error) throw new RetrievalError(`match_kb_chunks failed: ${error.message}`, { cause: error });

      return ((data ?? []) as MatchRow[]).map((row) => ({
        id: Number(row.id),
        url: row.url,
        title: row.title,
        section: row.section,
        pageType: row.page_type,
        content: row.content,
        topics: row.topics ?? [],
        similarity: Number(row.similarity),
      }));
    },
  };
}
