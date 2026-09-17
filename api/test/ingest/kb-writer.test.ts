import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { KbChunk } from '../../scripts/ingest/lib/chunk.ts';
import { replaceKnowledgeBase } from '../../scripts/ingest/lib/kb-writer.ts';
import { EMBEDDING_DIM } from '../../src/rag/embeddings.ts';
import { createTestDb, type TestDb } from '../db/harness.ts';

let t: TestDb;

function chunk(url: string, index: number, content: string, topics: string[] = []): KbChunk {
  return { url, title: 'Page', pageType: 'service', section: null, chunkIndex: index, content, topics, tokenEstimate: 10 };
}

function unitVector(axis: number): number[] {
  const values = new Array<number>(EMBEDDING_DIM).fill(0);
  values[axis] = 1;
  return values;
}

const meta = { embeddingModel: 'gemini-embedding-2', crawledAt: '2026-09-17T12:00:00.000Z', snapshotRef: 'sha256:abc' };

async function count(): Promise<number> {
  const { rows } = await t.db.query<{ n: number }>('select count(*)::int as n from private.kb_chunks');
  return rows[0]!.n;
}

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

describe('replaceKnowledgeBase', () => {
  it('stores chunks and metadata, then replaces them on the next build', async () => {
    await replaceKnowledgeBase(t.db, [chunk('https://qobo.dev/a', 0, 'first'), chunk('https://qobo.dev/b', 0, 'second', ['pricing'])], [unitVector(0), unitVector(1)], meta);
    assert.equal(await count(), 2);

    await replaceKnowledgeBase(t.db, [chunk('https://qobo.dev/plans', 0, 'Starter ₹499', ['pricing'])], [unitVector(5)], { ...meta, snapshotRef: 'sha256:def' });
    assert.equal(await count(), 1);

    const rows = await t.as('service_role', null, async (tx) => ({
      meta: (
        await tx.query<{ embedding_model: string; embedding_dim: number; chunk_count: number; snapshot_ref: string }>(
          'select embedding_model, embedding_dim, chunk_count, snapshot_ref from public.get_kb_meta()',
        )
      ).rows,
      matches: (await tx.query<{ url: string; topics: string[] }>('select url, topics from public.match_kb_chunks($1::extensions.vector, 5, 0.9)', [`[${unitVector(5).join(',')}]`])).rows,
    }));
    assert.deepEqual(rows.meta, [{ embedding_model: 'gemini-embedding-2', embedding_dim: 768, chunk_count: 1, snapshot_ref: 'sha256:def' }]);
    assert.deepEqual(rows.matches, [{ url: 'https://qobo.dev/plans', topics: ['pricing'] }]);
  });

  it('keeps the previous knowledge base when a write fails midway', async () => {
    await replaceKnowledgeBase(t.db, [chunk('https://qobo.dev/keep', 0, 'keep me')], [unitVector(2)], meta);
    // Duplicate (url, chunk_index) violates the unique constraint on the second insert.
    await assert.rejects(
      replaceKnowledgeBase(t.db, [chunk('https://qobo.dev/x', 0, 'x'), chunk('https://qobo.dev/x', 0, 'dup')], [unitVector(3), unitVector(4)], meta),
    );
    const { rows } = await t.db.query<{ url: string }>('select url from private.kb_chunks');
    assert.deepEqual(rows, [{ url: 'https://qobo.dev/keep' }]);
  });

  it('validates inputs before touching the database', async () => {
    await assert.rejects(replaceKnowledgeBase(t.db, [], [], meta), /zero chunks/);
    await assert.rejects(replaceKnowledgeBase(t.db, [chunk('u', 0, 'c')], [], meta), /count mismatch/);
    await assert.rejects(replaceKnowledgeBase(t.db, [chunk('u', 0, 'c')], [[1, 0]], meta), /expected 768/);
  });
});
