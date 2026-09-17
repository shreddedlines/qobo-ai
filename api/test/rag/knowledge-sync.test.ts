import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

import { parseSnapshot } from '../../scripts/ingest/lib/snapshot.ts';
import { evalSuiteSchema } from '../../scripts/eval/lib/checks.ts';
import { DISCREPANCIES } from '../../src/rag/discrepancies.ts';
import { CONTACT_SOURCE, QOBO_CONTACT } from '../../src/rag/qobo-facts.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

async function snapshotsByUrl(): Promise<Map<string, string>> {
  const dir = path.join(repoRoot, 'kb', 'snapshots');
  const map = new Map<string, string>();
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.md'))) {
    const snapshot = parseSnapshot(await readFile(path.join(dir, file), 'utf8'), file);
    map.set(snapshot.meta.url, snapshot.body);
  }
  return map;
}

/** Snapshots split long statements across lines and headings; compare on normalized text. */
const normalize = (text: string) => text.replace(/[#*]/g, '').replace(/\s+/g, ' ').trim();

describe('hand-maintained answer data stays in sync with the reviewed snapshots', () => {
  it('every discrepancy statement is quoted verbatim from its page', async () => {
    const snapshots = await snapshotsByUrl();
    for (const discrepancy of DISCREPANCIES) {
      for (const statement of discrepancy.statements) {
        const body = snapshots.get(statement.url);
        assert.ok(body, `${discrepancy.id}: no snapshot for ${statement.url}`);
        assert.ok(normalize(body).includes(normalize(statement.quote)), `${discrepancy.id}: "${statement.quote}" not found on ${statement.url}`);
      }
      assert.ok(discrepancy.contentMarkers.every((marker) => [...snapshots.values()].some((body) => body.includes(marker))), `${discrepancy.id}: a content marker no longer appears in any snapshot`);
    }
  });

  it('contact details used in fallback replies match the contact page', async () => {
    const body = (await snapshotsByUrl()).get(CONTACT_SOURCE.url);
    assert.ok(body);
    assert.ok(body.includes(`WhatsApp: ${QOBO_CONTACT.whatsappDisplay} (${QOBO_CONTACT.whatsappUrl})`));
    assert.ok(body.includes(`Phone call: ${QOBO_CONTACT.phoneDisplay}`));
    assert.ok(body.includes(QOBO_CONTACT.email));
  });

  it('eval questions are valid and unique', async () => {
    const suite = evalSuiteSchema.parse(parse(await readFile(path.join(repoRoot, 'eval', 'questions.yaml'), 'utf8')));
    assert.equal(new Set(suite.map((c) => c.id)).size, suite.length);
    const snapshots = await snapshotsByUrl();
    for (const url of suite.flatMap((c) => c.expect.citesAny ?? [])) assert.ok(snapshots.has(url), `eval cites unknown page ${url}`);
  });
});
