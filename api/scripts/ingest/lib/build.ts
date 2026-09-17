import type { Embedder } from '../../../src/rag/embeddings.ts';
import type { KbChunk } from './chunk.ts';

/**
 * Embeds every chunk first and only then hands the complete vector set to
 * `replace`. If any embedding fails (quota exhausted, invalid response), the
 * error propagates before `replace` runs, so the stored knowledge base is untouched.
 */
export async function embedThenReplace(
  chunks: KbChunk[],
  embedder: Embedder,
  replace: (vectors: number[][]) => Promise<void>,
): Promise<number[][]> {
  const vectors = await embedder.embedDocuments(chunks.map((chunk) => ({ title: chunk.title, text: chunk.content })));
  if (vectors.length !== chunks.length) {
    throw new Error(`Embedding produced ${vectors.length} vectors for ${chunks.length} chunks; the knowledge base was not replaced`);
  }
  await replace(vectors);
  return vectors;
}
