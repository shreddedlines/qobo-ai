import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyHeadings,
  findBoilerplate,
  findPrices,
  mergeCaptures,
  normalizeLines,
  toContactLink,
} from '../../scripts/ingest/lib/clean.ts';
import { aggregateExclusions } from '../../scripts/ingest/lib/browser.ts';
import { parseSitemapLocations, snapshotSlug, toSitePath } from '../../scripts/ingest/lib/urls.ts';

describe('aggregateExclusions', () => {
  it('counts a widget as excluded if any pass matched and applied it', () => {
    const miss = { reason: 'chat mock', matched: 0, maxShare: 0, applied: false };
    const hit = { reason: 'chat mock', matched: 1, maxShare: 0.12, applied: true };
    assert.deepEqual(aggregateExclusions([[miss], [hit], [miss]]), [hit]);
    assert.deepEqual(aggregateExclusions([]), []);
  });
});

describe('mergeCaptures', () => {
  it('keeps first-seen order and inserts rotating carousel lines next to their neighbours', () => {
    const merged = mergeCaptures([
      ['Plans', 'STARTER', '₹499', 'Built for Growth'],
      ['Plans', 'PRO', '₹999', 'Built for Growth'],
      ['Plans', 'STARTER', '₹499', 'Built for Growth'],
    ]);
    assert.deepEqual(merged, ['Plans', 'PRO', '₹999', 'STARTER', '₹499', 'Built for Growth']);
  });

  it('does not reorder content when a capture repeats lines (marquees)', () => {
    assert.deepEqual(mergeCaptures([['A', 'B', 'C', 'A', 'B', 'C', 'D']]), ['A', 'B', 'C', 'D']);
    assert.deepEqual(
      mergeCaptures([
        ['Stack', 'Zero Subscriptions', 'SEO', 'Zero Subscriptions', 'SEO', '## Growth', 'Start free'],
        ['Stack', 'Zero Subscriptions', 'Mobile-First', 'SEO', '## Growth', 'Start free', 'Scale Ready'],
      ]),
      ['Stack', 'Zero Subscriptions', 'Mobile-First', 'SEO', '## Growth', 'Start free', 'Scale Ready'],
    );
  });

  it('keeps each plan next to its own price when captures are normalized first', () => {
    const slides = [
      ['Plans', 'STARTER', '₹', '499', 'Own it forever.', 'Built for Growth'],
      ['Plans', 'PRO', '₹', '999', 'Advanced SEO & High Priority.', 'Built for Growth'],
    ];
    assert.deepEqual(mergeCaptures(slides.map(normalizeLines)), [
      'Plans',
      'PRO',
      '₹999',
      'Advanced SEO & High Priority.',
      'STARTER',
      '₹499',
      'Own it forever.',
      'Built for Growth',
    ]);
  });

  it('returns an empty list for no captures', () => {
    assert.deepEqual(mergeCaptures([]), []);
  });
});

describe('normalizeLines', () => {
  it('joins split currency amounts and collapses whitespace', () => {
    assert.deepEqual(normalizeLines(['STARTER', '₹', '499', '  Own it   forever. ']), ['STARTER', '₹499', 'Own it forever.']);
  });

  it('drops decorative noise and exact duplicates (marquee repeats)', () => {
    const input = ['01', '•', '|', 'Say Hi', 'VIEW LIVE SITE', 'Glamm', 'VIEW LIVE SITE', 'Glamm', '→', '24/7', '5m'];
    assert.deepEqual(normalizeLines(input), ['Say Hi', 'VIEW LIVE SITE', 'Glamm', '24/7', '5m']);
  });

  it('joins every card price before removing duplicate currency lines', () => {
    assert.deepEqual(normalizeLines(['TRIAL', '₹', '0', 'STARTER', '₹', '499', 'PRO', '₹', '999']), [
      'TRIAL',
      '₹0',
      'STARTER',
      '₹499',
      'PRO',
      '₹999',
    ]);
  });

  it('escapes page text that looks like a Markdown heading', () => {
    assert.deepEqual(normalizeLines(['#1 CHOICE FOR CLINICS']), ['\\#1 CHOICE FOR CLINICS']);
  });
});

describe('applyHeadings', () => {
  it('turns multi-line headings into single Markdown headings', () => {
    const lines = ['ZERO-COST START', 'Stop Renting.', 'Start Owning.', 'Experience the magic', 'What We Offer', 'Launch'];
    const headings = [
      { level: 1 as const, parts: ['Stop Renting.', 'Start Owning.'] },
      { level: 2 as const, parts: ['What We Offer'] },
    ];
    assert.deepEqual(applyHeadings(lines, headings), [
      'ZERO-COST START',
      '# Stop Renting. Start Owning.',
      'Experience the magic',
      '## What We Offer',
      'Launch',
    ]);
  });

  it('leaves text alone when heading parts are not consecutive', () => {
    assert.deepEqual(applyHeadings(['Stop Renting.', 'other', 'Start Owning.'], [{ level: 1, parts: ['Stop Renting.', 'Start Owning.'] }]), [
      'Stop Renting.',
      'other',
      'Start Owning.',
    ]);
  });
});

describe('findBoilerplate', () => {
  const options = { maxLineLength: 40, minPages: 3, pageShare: 0.5 };

  it('flags short lines repeated across many pages', () => {
    const pages = [
      ['Start Building Free', 'Unique A'],
      ['Start Building Free', 'Unique B'],
      ['Start Building Free', 'Unique C'],
      ['Unique D'],
    ];
    assert.deepEqual([...findBoilerplate(pages, options)], ['Start Building Free']);
  });

  it('never removes headings or long factual sentences, even when repeated', () => {
    const fact = 'Starting at just ₹499 - perfect for small businesses across India';
    const pages = Array.from({ length: 5 }, () => ['## Why Choose Qobo?', fact]);
    assert.equal(findBoilerplate(pages, options).size, 0);
  });
});

describe('findPrices', () => {
  it('normalizes rupee amounts and billing periods', () => {
    const text = 'Starter ₹499. Pro ₹ 999 or ₹499/month, Rs. 1,499 / mo, INR 2,499 and Onion ₹40/kg';
    assert.deepEqual(findPrices(text), ['₹1,499/month', '₹2,499', '₹40/kg', '₹499', '₹499/month', '₹999']);
  });

  it('keeps magnitude suffixes on marketing figures', () => {
    assert.deepEqual(findPrices('₹20M+ CLIENT REVENUE GENERATED and ₹5 Cr raised, ₹2L budget'), ['₹20M', '₹2L', '₹5Cr']);
  });

  it('ignores numbers without a currency', () => {
    assert.deepEqual(findPrices('4.5x ROAS, 1,000+ websites, 24/7 support'), []);
  });
});

describe('toContactLink', () => {
  it('distinguishes WhatsApp chats from phone calls', () => {
    assert.deepEqual(toContactLink('https://wa.me/919901631188'), { kind: 'whatsapp', value: '+91 99016 31188', href: 'https://wa.me/919901631188' });
    assert.deepEqual(toContactLink('tel:+919901141616'), { kind: 'phone', value: '+91 99011 41616', href: 'tel:+919901141616' });
    assert.deepEqual(toContactLink('https://api.whatsapp.com/send?phone=919901631188&text=Hi'), {
      kind: 'whatsapp',
      value: '+91 99016 31188',
      href: 'https://wa.me/919901631188',
    });
  });

  it('parses email links and ignores other links', () => {
    assert.deepEqual(toContactLink('mailto:hello@qobo.dev?subject=Hi'), { kind: 'email', value: 'hello@qobo.dev', href: 'mailto:hello@qobo.dev' });
    assert.equal(toContactLink('/plans'), null);
    assert.equal(toContactLink('https://instagram.com/qoboai'), null);
  });
});

describe('urls', () => {
  const site = 'https://qobo.dev';

  it('canonicalizes same-site page paths', () => {
    assert.equal(toSitePath('https://qobo.dev/plans/', site), '/plans');
    assert.equal(toSitePath('/plans?ref=nav#pricing', site), '/plans');
    assert.equal(toSitePath('https://qobo.dev', site), '/');
    assert.equal(toSitePath('//qobo.dev//blog', site), '/blog');
  });

  it('rejects other origins, non-http schemes and assets', () => {
    assert.equal(toSitePath('https://wa.me/919901631188', site), null);
    assert.equal(toSitePath('mailto:hello@qobo.dev', site), null);
    assert.equal(toSitePath('/qobo-logo.png', site), null);
    assert.equal(toSitePath('/sitemap.xml', site), null);
  });

  it('parses sitemap locations and decodes entities', () => {
    const xml = '<urlset><url><loc>https://qobo.dev/</loc></url><url><loc> https://qobo.dev/a?x=1&amp;y=2 </loc></url></urlset>';
    assert.deepEqual(parseSitemapLocations(xml), ['https://qobo.dev/', 'https://qobo.dev/a?x=1&y=2']);
  });

  it('derives stable snapshot slugs', () => {
    assert.equal(snapshotSlug('/'), 'home');
    assert.equal(snapshotSlug('/website-builder-for-kirana-stores'), 'website-builder-for-kirana-stores');
    assert.equal(snapshotSlug('/Blog/Post_1'), 'blog-post-1');
  });
});
