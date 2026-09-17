import type { SupabaseClient } from '@supabase/supabase-js';

import { EMBEDDING_DIM } from './embeddings.ts';

export type KnowledgeBaseStatus =
  | { status: 'ok'; chunkCount: number; snapshotRef: string | null }
  | { status: 'empty' }
  | { status: 'mismatch'; message: string }
  | { status: 'unavailable'; message: string };

interface MetaRow {
  embedding_model: string;
  embedding_dim: number;
  chunk_count: number;
  snapshot_ref: string | null;
}

/**
 * Query embeddings are only comparable with document embeddings from the same
 * model and dimension. A mismatch would silently return irrelevant chunks, so the
 * server refuses to start on `mismatch`.
 */
export async function checkKnowledgeBase(service: Pick<SupabaseClient, 'rpc'>, embeddingModel: string): Promise<KnowledgeBaseStatus> {
  const { data, error } = await service.rpc('get_kb_meta');
  if (error) return { status: 'unavailable', message: error.message };

  const row = (data as MetaRow[] | null)?.[0];
  if (!row || row.chunk_count === 0) return { status: 'empty' };
  if (row.embedding_model !== embeddingModel || row.embedding_dim !== EMBEDDING_DIM) {
    return {
      status: 'mismatch',
      message: `Knowledge base was built with ${row.embedding_model} (${row.embedding_dim}d) but the API is configured for ${embeddingModel} (${EMBEDDING_DIM}d). Rebuild the knowledge base or fix GEMINI_EMBEDDING_MODEL.`,
    };
  }
  return { status: 'ok', chunkCount: row.chunk_count, snapshotRef: row.snapshot_ref };
}
