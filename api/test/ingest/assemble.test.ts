import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assemblePages } from '../../scripts/ingest/lib/assemble.ts';
import type { RawPage } from '../../scripts/ingest/lib/browser.ts';
import { parseIngestConfig } from '../../scripts/ingest/lib/config.ts';
import { parseSnapshot, renderSnapshot } from '../../scripts/ingest/lib/snapshot.ts';

const baseConfig = {
  site: 'https://qobo.dev',
  sitemap: 'https://qobo.dev/sitemap.xml',
  boilerplate: { maxLineLength: 40, minPages: 2, pageShare: 0.5 },
  pageTypes: [
    { pattern: '^/$', type: 'home' },
    { pattern: '^/plans$', type: 'pricing' },
    { pattern: '.*', type: 'service' },
  ],
  prices: [
    { value: '₹499', pages: ['*'], note: 'Starter plan price' },
    { value: '₹999', pages: ['/plans'], note: 'Pro plan price' },
  ],
};

function rawPage(finalPath: string, lines: string[], extra: Partial<RawPage> = {}): RawPage {
  return {
    requestedPath: finalPath,
    finalPath,
    notFound: false,
    documentTitle: 'Qobo.dev',
    lines,
    headings: [],
    hrefs: [],
    exclusions: [],
    ...extra,
  };
}

const filler =
  'QOBO builds professional business websites through a simple WhatsApp conversation, with no coding required, and helps them grow with marketing and automation.';
const crawledAt = '2026-09-17T12:00:00.000Z';

describe('assemblePages', () => {
  it('builds snapshots with headings, contacts, metadata and without boilerplate', () => {
    const config = parseIngestConfig(baseConfig);
    const result = assemblePages(
      config,
      [
        rawPage('/plans', ['Start Building Free', 'Stop Renting.', 'Start Owning.', 'STARTER', '₹', '499', 'PRO', '₹999', filler], {
          headings: [{ level: 1, parts: ['Stop Renting.', 'Start Owning.'] }],
          hrefs: ['https://wa.me/919901631188', 'tel:+919901141616', '/contact-us', 'https://wa.me/919901631188'],
        }),
        rawPage('/', ['Start Building Free', filler, 'Plans start at ₹499']),
      ],
      new Map(),
      crawledAt,
    );

    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.boilerplateRemoved, ['Start Building Free']);

    const plans = result.pages.find((page) => page.file === 'plans.md')!;
    assert.equal(plans.snapshot.meta.title, 'Stop Renting. Start Owning.');
    assert.equal(plans.snapshot.meta.page_type, 'pricing');
    assert.equal(plans.snapshot.meta.url, 'https://qobo.dev/plans');
    assert.deepEqual(plans.prices, ['₹499', '₹999']);
    assert.equal(
      plans.snapshot.body,
      [
        '# Stop Renting. Start Owning.',
        'STARTER',
        '₹499',
        'PRO',
        '₹999',
        filler,
        '',
        '## Contact details linked on this page',
        '- WhatsApp: +91 99016 31188 (https://wa.me/919901631188)',
        '- Phone call: +91 99011 41616 (tel:+919901141616)',
      ].join('\n'),
    );

    const home = result.pages.find((page) => page.file === 'home.md')!;
    assert.equal(home.snapshot.meta.title, 'Qobo.dev');
  });

  it('flags prices that are not reviewed for the page (e.g. mock-up prices)', () => {
    const config = parseIngestConfig(baseConfig);
    const result = assemblePages(config, [rawPage('/website-builder-for-salons', [filler, 'Balayage Master', '₹2,499', 'Pro ₹999'])], new Map(), crawledAt);
    assert.deepEqual(
      result.issues.map((issue) => issue.message),
      ['Price ₹2,499 is not in the reviewed price allowlist for this page', 'Price ₹999 is not in the reviewed price allowlist for this page'],
    );
    assert.ok(result.issues.every((issue) => issue.kind === 'unreviewed_price'));
  });

  it('does not flag optional exclusions for rotating widgets that were off screen', () => {
    const config = parseIngestConfig({
      ...baseConfig,
      pages: { '/': { exclude: [{ containsAll: ['yourbrand.com'], reason: 'rotating ad', optional: true }] } },
    });
    const result = assemblePages(
      config,
      [rawPage('/', [filler], { exclusions: [{ reason: 'rotating ad', matched: 0, maxShare: 0, applied: false }] })],
      new Map(),
      crawledAt,
    );
    assert.deepEqual(result.issues, []);
  });

  it('flags excluded demo content that still reached the snapshot', () => {
    const config = parseIngestConfig({
      ...baseConfig,
      pages: { '/': { exclude: [{ containsAll: ['yourbrand.com', 'competitor.com'], reason: 'rotating ad', optional: true }] } },
    });
    const result = assemblePages(
      config,
      [rawPage('/', [filler, '· YourBrand.com', 'Generic Product', 'competitor.com'], { exclusions: [{ reason: 'rotating ad', matched: 0, maxShare: 0, applied: false }] })],
      new Map(),
      crawledAt,
    );
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ['excluded_content_leaked'],
    );
  });

  it('flags stale or overly broad exclusions, thin pages and shrinking content', () => {
    const config = parseIngestConfig(baseConfig);
    const result = assemblePages(
      config,
      [
        rawPage('/seo-services', [filler], {
          exclusions: [
            { reason: 'mock-up gone', matched: 0, maxShare: 0, applied: false },
            { reason: 'too broad', matched: 1, maxShare: 0.8, applied: false },
          ],
        }),
        rawPage('/our-team', ['Founder']),
      ],
      new Map([['/seo-services', 5_000]]),
      crawledAt,
    );
    assert.deepEqual(result.issues.map((issue) => `${issue.path}:${issue.kind}`).sort(), [
      '/our-team:too_little_content',
      '/seo-services:content_shrunk',
      '/seo-services:exclusion_too_broad',
      '/seo-services:exclusion_unmatched',
    ]);
  });
});

describe('snapshot format', () => {
  it('round-trips frontmatter and body', () => {
    const config = parseIngestConfig(baseConfig);
    const [page] = assemblePages(config, [rawPage('/', [filler, '# not a real heading'])], new Map(), crawledAt).pages;
    const markdown = renderSnapshot(page!.snapshot);
    assert.match(markdown, /^---\nurl: https:\/\/qobo\.dev\/\n/);
    assert.deepEqual(parseSnapshot(markdown), page!.snapshot);
  });

  it('rejects snapshots with tampered or missing metadata', () => {
    assert.throws(() => parseSnapshot('no frontmatter'), /missing frontmatter/);
    assert.throws(() => parseSnapshot('---\nurl: nope\n---\n\nbody'), /invalid frontmatter/);
  });
});

describe('ingest config', () => {
  it('rejects malformed price rules and regexes', () => {
    assert.throws(() => parseIngestConfig({ ...baseConfig, prices: [{ value: '499', pages: ['*'], note: 'no currency' }] }), /prices\.0\.value/);
    assert.throws(() => parseIngestConfig({ ...baseConfig, excludePathPatterns: ['(unclosed'] }), /valid regular expression/);
  });
});
