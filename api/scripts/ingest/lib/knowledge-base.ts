import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { chunkPage, type KbChunk } from './chunk.ts';
import type { IngestConfig } from './config.ts';
import { contentHash, parseSnapshot } from './snapshot.ts';

const manifestSchema = z.object({
  crawledAt: z.iso.datetime(),
  pages: z.array(z.object({ path: z.string(), file: z.string(), contentHash: z.string() })).min(1),
  issues: z.array(z.object({ path: z.string(), kind: z.string(), message: z.string() })),
});

export type SnapshotManifest = z.infer<typeof manifestSchema>;

export interface PreparedKnowledgeBase {
  manifest: SnapshotManifest;
  chunks: KbChunk[];
  /** Identifies the exact snapshot set the knowledge base was built from. */
  snapshotRef: string;
}

/**
 * Loads reviewed snapshots and chunks them. Refuses to proceed when the crawl
 * reported unresolved issues or when a snapshot no longer matches the manifest
 * (hand edits must go through the crawler config so they are reproducible).
 */
export async function prepareKnowledgeBase(snapshotsDir: string, config: IngestConfig): Promise<PreparedKnowledgeBase> {
  const manifestRaw = JSON.parse(await readFile(path.join(snapshotsDir, 'manifest.json'), 'utf8')) as unknown;
  const manifest = manifestSchema.parse(manifestRaw);

  if (manifest.issues.length > 0) {
    throw new Error(`The crawl manifest lists ${manifest.issues.length} unresolved issue(s). Fix the crawl config and re-run the crawl first.`);
  }

  const chunks: KbChunk[] = [];
  for (const entry of manifest.pages) {
    const snapshot = parseSnapshot(await readFile(path.join(snapshotsDir, entry.file), 'utf8'), entry.file);
    const actualHash = contentHash(snapshot.body);
    if (actualHash !== snapshot.meta.content_hash || actualHash !== entry.contentHash) {
      throw new Error(`${entry.file} does not match its recorded content hash. Snapshots must come from the crawler; re-run the crawl.`);
    }
    chunks.push(
      ...chunkPage({ url: snapshot.meta.url, title: snapshot.meta.title, pageType: snapshot.meta.page_type, body: snapshot.body }, config.topics),
    );
  }

  const snapshotRef = `sha256:${createHash('sha256')
    .update(manifest.pages.map((page) => `${page.path}:${page.contentHash}`).join('\n'))
    .digest('hex')
    .slice(0, 16)}`;

  return { manifest, chunks, snapshotRef };
}
