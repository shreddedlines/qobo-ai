import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { chunkPage, DEFAULT_CHUNK_OPTIONS, splitIntoSections, type TopicRule } from '../../scripts/ingest/lib/chunk.ts';
import { loadIngestConfig } from '../../scripts/ingest/lib/config.ts';
import { parseSnapshot } from '../../scripts/ingest/lib/snapshot.ts';

const kbDir = path.resolve(import.meta.dirname, '../../../kb');
const topics: TopicRule[] = [{ name: 'pricing', patterns: ['₹', '\\bplans?\\b'] }];
const source = (body: string) => ({ url: 'https://qobo.dev/', title: 'Home', pageType: 'home' as const, body });

describe('splitIntoSections', () => {
  it('tracks the heading path for nested headings', () => {
    const sections = splitIntoSections('Intro line\n# Title\nA\n## FAQ\n### Is there a free trial?\nYes.\n## Other\nB');
    assert.deepEqual(
      sections.map((s) => [s.headingPath.join(' > '), s.level, s.lines.length]),
      [
        ['', 0, 1],
        ['Title', 1, 2],
        ['Title > FAQ', 2, 1],
        ['Title > FAQ > Is there a free trial?', 3, 2],
        ['Title > Other', 2, 2],
      ],
    );
  });
});

describe('chunkPage', () => {
  it('keeps FAQ question and answer together with a page/section header', () => {
    const body = ['## Got Questions?', '### Is there a free trial?', 'Yes! Build and preview for free. Pay when you go live, starting at ₹499/month.'].join('\n');
    const [chunk, ...rest] = chunkPage(source(body), topics);
    assert.equal(rest.length, 0);
    assert.equal(chunk!.section, 'Got Questions?');
    assert.match(chunk!.content, /^Page: Home\nSection: Got Questions\?\n\n## Got Questions\?\n### Is there a free trial\?\nYes!/);
    assert.deepEqual(chunk!.topics, ['pricing']);
  });

  it('starts a new chunk at a top-level heading once the current chunk has content', () => {
    const paragraph = 'QOBO helps local businesses launch websites through WhatsApp conversations. '.repeat(8);
    const chunks = chunkPage(source(`## Launch\n${paragraph}\n## Automate\n${paragraph}`), topics);
    assert.deepEqual(
      chunks.map((c) => c.section),
      ['Launch', 'Automate'],
    );
    assert.deepEqual(
      chunks.map((c) => c.chunkIndex),
      [0, 1],
    );
    assert.deepEqual(chunks[0]!.topics, []);
  });

  it('splits oversized sections on line boundaries and repeats the heading', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `Feature ${i}: a long description of a capability that QOBO lists on its website page.`);
    const chunks = chunkPage(source(`## Features\n${lines.join('\n')}`), topics);
    assert.ok(chunks.length >= 3);
    assert.ok(chunks.every((c) => c.tokenEstimate <= DEFAULT_CHUNK_OPTIONS.maxTokens + 40));
    assert.ok(chunks.slice(1).every((c) => c.content.includes('## Features (continued)')));
  });

  it('chunks every real snapshot without losing or duplicating content lines', async () => {
    const config = await loadIngestConfig(path.join(kbDir, 'ingest.config.yaml'));
    const files = (await readdir(path.join(kbDir, 'snapshots'))).filter((file) => file.endsWith('.md'));
    assert.ok(files.length > 0, 'expected crawled snapshots in kb/snapshots');

    for (const file of files) {
      const snapshot = parseSnapshot(await readFile(path.join(kbDir, 'snapshots', file), 'utf8'), file);
      const chunks = chunkPage(
        { url: snapshot.meta.url, title: snapshot.meta.title, pageType: snapshot.meta.page_type, body: snapshot.body },
        config.topics,
      );
      const bodyLines = snapshot.body.split('\n').filter((line) => line.trim());
      const chunkLines = chunks.flatMap((c) => c.content.split('\n\n').slice(1).join('\n\n').split('\n')).filter((line) => line.trim() && !line.endsWith('(continued)'));
      assert.deepEqual(chunkLines, bodyLines, `${file}: chunk lines must equal snapshot lines`);
      assert.ok(chunks.every((c) => c.tokenEstimate <= DEFAULT_CHUNK_OPTIONS.maxTokens + 60), `${file}: chunk too large`);
    }
  });
});
