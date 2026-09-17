import { EMBEDDING_DIM, toVectorLiteral } from '../../../src/rag/embeddings.ts';
import type { KbChunk } from './chunk.ts';

/** Minimal query interface shared by node-postgres clients and PGlite. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

export interface KbMeta {
  embeddingModel: string;
  crawledAt: string;
  snapshotRef: string;
}

/**
 * Replaces the whole knowledge base in one transaction, so the API never sees a
 * half-built or mixed-model knowledge base. On any error the previous one stays.
 */
export async function replaceKnowledgeBase(db: Queryable, chunks: KbChunk[], vectors: number[][], meta: KbMeta): Promise<void> {
  if (chunks.length !== vectors.length) {
    throw new Error(`Chunk/vector count mismatch: ${chunks.length} chunks, ${vectors.length} vectors`);
  }
  if (chunks.length === 0) throw new Error('Refusing to replace the knowledge base with zero chunks');
  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIM) throw new Error(`Vector has ${vector.length} dimensions, expected ${EMBEDDING_DIM}`);
  }

  await db.query('begin');
  try {
    await db.query('delete from private.kb_chunks');
    for (const [index, chunk] of chunks.entries()) {
      await db.query(
        `insert into private.kb_chunks (url, title, page_type, section, chunk_index, content, topics, token_estimate, embedding)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::extensions.vector)`,
        [chunk.url, chunk.title, chunk.pageType, chunk.section, chunk.chunkIndex, chunk.content, chunk.topics, chunk.tokenEstimate, toVectorLiteral(vectors[index]!)],
      );
    }
    await db.query(
      `insert into private.kb_meta (id, embedding_model, embedding_dim, chunk_count, crawled_at, snapshot_ref, updated_at)
       values (true, $1, $2, $3, $4, $5, now())
       on conflict (id) do update set
         embedding_model = excluded.embedding_model,
         embedding_dim = excluded.embedding_dim,
         chunk_count = excluded.chunk_count,
         crawled_at = excluded.crawled_at,
         snapshot_ref = excluded.snapshot_ref,
         updated_at = excluded.updated_at`,
      [meta.embeddingModel, EMBEDDING_DIM, chunks.length, meta.crawledAt, meta.snapshotRef],
    );
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}
