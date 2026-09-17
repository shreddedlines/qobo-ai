import { createHash } from 'node:crypto';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { PAGE_TYPES } from './config.ts';

const frontmatterSchema = z.object({
  url: z.url(),
  path: z.string().startsWith('/'),
  title: z.string().min(1),
  page_type: z.enum(PAGE_TYPES),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  crawled_at: z.iso.datetime(),
});

export type SnapshotMeta = z.infer<typeof frontmatterSchema>;

export interface Snapshot {
  meta: SnapshotMeta;
  /** Markdown body (headings, text lines, contact section). */
  body: string;
}

export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function renderSnapshot(snapshot: Snapshot): string {
  return `---\n${stringify(snapshot.meta, { lineWidth: 0 })}---\n\n${snapshot.body.trimEnd()}\n`;
}

export function parseSnapshot(markdown: string, fileName = 'snapshot'): Snapshot {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(markdown.replace(/\r\n/g, '\n'));
  if (!match) throw new Error(`${fileName}: missing frontmatter`);
  const meta = frontmatterSchema.safeParse(parse(match[1]!));
  if (!meta.success) {
    throw new Error(`${fileName}: invalid frontmatter (${meta.error.issues.map((i) => i.path.join('.')).join(', ')})`);
  }
  return { meta: meta.data, body: match[2]!.trimEnd() };
}
