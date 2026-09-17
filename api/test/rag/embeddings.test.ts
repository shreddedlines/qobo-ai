import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createGeminiEmbedder,
  EMBEDDING_DIM,
  EmbeddingError,
  formatDocumentForEmbedding,
  formatQueryForEmbedding,
  toVectorLiteral,
  type EmbedContentClient,
} from '../../src/rag/embeddings.ts';

type EmbedParams = Parameters<EmbedContentClient['embedContent']>[0];

function vector(seed: number, length = EMBEDDING_DIM): number[] {
  return Array.from({ length }, (_, i) => (i === seed % length ? 3 : 0));
}

function fakeClient(respond: (params: EmbedParams) => { embeddings?: Array<{ values?: number[] }> }) {
  const calls: EmbedParams[] = [];
  const client = {
    embedContent: async (params: EmbedParams) => {
      calls.push(params);
      return respond(params);
    },
  } as unknown as EmbedContentClient;
  return { client, calls };
}

const onePerContent = (params: EmbedParams) => ({
  embeddings: (params.contents as unknown[]).map((_, i) => ({ values: vector(i) })),
});

describe('embedding formats', () => {
  it('uses the gemini-embedding-2 asymmetric retrieval prefixes', () => {
    assert.equal(formatDocumentForEmbedding('Plans', 'Starter ₹499'), 'title: Plans | text: Starter ₹499');
    assert.equal(formatDocumentForEmbedding('  ', 'x'), 'title: none | text: x');
    assert.equal(formatQueryForEmbedding('How much is QOBO?'), 'task: question answering | query: How much is QOBO?');
  });

  it('renders pgvector literals', () => {
    assert.equal(toVectorLiteral([0.5, -1, 0]), '[0.5,-1,0]');
  });
});

describe('createGeminiEmbedder', () => {
  it('wraps each text in its own Content object so embeddings are not aggregated', async () => {
    const { client, calls } = fakeClient(onePerContent);
    const embedder = createGeminiEmbedder(client, 'gemini-embedding-2');
    await embedder.embedDocuments([
      { title: 'A', text: 'first' },
      { title: 'B', text: 'second' },
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.contents, [
      { role: 'user', parts: [{ text: 'title: A | text: first' }] },
      { role: 'user', parts: [{ text: 'title: B | text: second' }] },
    ]);
    assert.deepEqual(calls[0]!.config, { outputDimensionality: 768 });
    assert.equal(calls[0]!.model, 'gemini-embedding-2');
  });

  it('batches large inputs and preserves order', async () => {
    const { client, calls } = fakeClient(onePerContent);
    const embedder = createGeminiEmbedder(client, 'm', { batchSize: 2 });
    const vectors = await embedder.embedDocuments(Array.from({ length: 5 }, (_, i) => ({ title: 't', text: String(i) })));
    assert.equal(calls.length, 3);
    assert.equal(vectors.length, 5);
  });

  it('returns unit-length query vectors with the query prefix', async () => {
    const { client, calls } = fakeClient(onePerContent);
    const result = await createGeminiEmbedder(client, 'm').embedQuery('pricing?');
    assert.deepEqual(calls[0]!.contents, [{ role: 'user', parts: [{ text: 'task: question answering | query: pricing?' }] }]);
    assert.ok(Math.abs(Math.hypot(...result) - 1) < 1e-9);
  });

  it('fails loudly when the API aggregates inputs into one embedding', async () => {
    const { client } = fakeClient(() => ({ embeddings: [{ values: vector(0) }] }));
    await assert.rejects(
      createGeminiEmbedder(client, 'm').embedDocuments([
        { title: 'a', text: 'a' },
        { title: 'b', text: 'b' },
      ]),
      (error: Error) => error instanceof EmbeddingError && /Expected 2 embeddings/.test(error.message),
    );
  });

  it('rejects wrong dimensions, zero vectors and non-finite values', async () => {
    for (const values of [vector(0, 3072), new Array(EMBEDDING_DIM).fill(0), [Number.NaN, ...vector(0, EMBEDDING_DIM - 1)]]) {
      const { client } = fakeClient(() => ({ embeddings: [{ values }] }));
      await assert.rejects(createGeminiEmbedder(client, 'm').embedQuery('q'), EmbeddingError);
    }
  });
});
