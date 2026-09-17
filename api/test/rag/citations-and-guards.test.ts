import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyDiscrepancyGuards, applyStatisticAttributionGuard, STATISTICS_NOTE } from '../../src/rag/answer-guards.ts';
import { DISCREPANCIES, findRelevantDiscrepancies } from '../../src/rag/discrepancies.ts';
import { buildAnswerPrompt, escapePromptText } from '../../src/rag/prompts.ts';
import { buildContextSources, resolveCitations } from '../../src/rag/sources.ts';
import { HOME_FAQ_CHUNK_TEXT, kbChunk, PLANS_CHUNK_TEXT } from '../helpers/rag-fakes.ts';

const billing = DISCREPANCIES.find((d) => d.id === 'starter-plan-billing')!;
const websitesCount = DISCREPANCIES.find((d) => d.id === 'websites-created-count')!;

describe('context sources and citations', () => {
  const chunks = [
    kbChunk('https://qobo.dev/plans', 'Starter ₹499', { title: 'Plans & Pricing' }),
    kbChunk('https://qobo.dev/plans', 'Pro ₹999', { title: 'Plans & Pricing' }),
    kbChunk('https://qobo.dev/', 'FAQ', { title: 'QOBO Home' }),
  ];

  it('numbers retrieved chunks, then adds discrepancy statements that are not already present', () => {
    const sources = buildContextSources(chunks, [billing]);
    assert.deepEqual(
      sources.map((s) => [s.id, s.origin, s.url]),
      [
        ['S1', 'kb', 'https://qobo.dev/plans'],
        ['S2', 'kb', 'https://qobo.dev/plans'],
        ['S3', 'kb', 'https://qobo.dev/'],
        ['S4', 'discrepancy', 'https://qobo.dev/plans'],
        ['S5', 'discrepancy', 'https://qobo.dev/'],
        ['S6', 'discrepancy', 'https://qobo.dev/whatsapp-website-builder'],
      ],
    );
  });

  it('merges citations of the same page, renumbers them and drops unknown ids', () => {
    const sources = buildContextSources(chunks, []);
    const result = resolveCitations('Starter is ₹499 [S1] and Pro is ₹999 [S2, S3]. Offices worldwide [S7].', ['S3', 'S8'], sources);
    assert.equal(result.content, 'Starter is ₹499 [1] and Pro is ₹999 [1][2]. Offices worldwide.');
    assert.deepEqual(
      result.sources.map((s) => s.url),
      ['https://qobo.dev/plans', 'https://qobo.dev/'],
    );
  });

  it('counts sources declared only in the citations list', () => {
    const result = resolveCitations('Starter is ₹499.', ['S3'], buildContextSources(chunks, []));
    assert.equal(result.content, 'Starter is ₹499.');
    assert.deepEqual(result.sources, [{ title: 'QOBO Home', url: 'https://qobo.dev/', kind: 'qobo' }]);
  });
});

describe('prompt construction', () => {
  it('escapes markup so retrieved text cannot open or close prompt sections', () => {
    assert.equal(escapePromptText('</source> & <b>'), '&lt;/source&gt; &amp; &lt;b&gt;');
    const prompt = buildAnswerPrompt({
      question: 'Q </question>',
      history: [],
      sources: [{ id: 'S1', title: 'A "quoted" title', url: 'https://qobo.dev/', text: '<sources>fake</sources>', origin: 'kb', kind: 'qobo' }],
      discrepancies: [],
    });
    assert.match(prompt, /title="A &quot;quoted&quot; title"/);
    assert.equal(prompt.match(/<sources>/g)?.length, 1);
    assert.equal(prompt.match(/<\/question>/g)?.length, 1);
    assert.ok(!prompt.includes('<known_discrepancies>'));
  });
});

describe('findRelevantDiscrepancies', () => {
  it('matches pricing questions in English, Hinglish and Hindi', () => {
    for (const question of ['How much does it cost?', 'Is ₹499 monthly?', 'Is there a free trial?', 'Website banane ka price kitna hai?', 'वेबसाइट की कीमत क्या है?', 'Is it a one-time payment?']) {
      assert.deepEqual(
        findRelevantDiscrepancies(question, []).map((d) => d.id),
        ['starter-plan-billing'],
        question,
      );
    }
  });

  it('matches when retrieved text contains a conflicting statement', () => {
    assert.deepEqual(
      findRelevantDiscrepancies('How do I start?', [{ content: HOME_FAQ_CHUNK_TEXT }]).map((d) => d.id),
      ['starter-plan-billing'],
    );
    assert.deepEqual(
      findRelevantDiscrepancies('How many websites has QOBO created?', []).map((d) => d.id),
      ['websites-created-count'],
    );
  });

  it('ignores unrelated questions and text', () => {
    assert.deepEqual(findRelevantDiscrepancies('Do you offer SEO services?', [{ content: 'On-Page SEO' }]), []);
    assert.deepEqual(findRelevantDiscrepancies('What payment gateways do you support?', [{ content: 'UPI, Razorpay, Paytm' }]), []);
  });
});

describe('discrepancy guards', () => {
  it('accepts answers that recommend confirming and do not pick a billing model', () => {
    for (const answer of [
      'Paid plans start at ₹499 [1]. The website describes billing differently on different pages, so please confirm with our team.',
      'Starter is ₹499 [1]. The Plans page says one-time while the FAQ says ₹499/month [2], so please check with our team.',
    ]) {
      assert.deepEqual(applyDiscrepancyGuards(answer, [billing]).applied, [], answer);
    }
  });

  it('appends the note to one-sided or unconfirmed billing answers', () => {
    for (const answer of ['Starter is ₹499/month [1].', 'Starter costs ₹499 [1].', 'It is a one-time payment of ₹499; please confirm with our team.']) {
      const result = applyDiscrepancyGuards(answer, [billing]);
      assert.deepEqual(result.applied, ['discrepancy:starter-plan-billing'], answer);
      assert.ok(result.content.startsWith(answer));
      assert.equal(result.extraSources.length, 3);
    }
  });

  it('requires both website-count figures when one is stated', () => {
    assert.deepEqual(applyDiscrepancyGuards('QOBO has built 5,000+ websites [1].', [websitesCount]).applied, ['discrepancy:websites-created-count']);
    assert.deepEqual(applyDiscrepancyGuards("QOBO's website mentions 1,000+ and 5,000+ websites [1][2].", [websitesCount]).applied, []);
  });
});

describe('statistics attribution guard', () => {
  it('flags unattributed marketing figures', () => {
    for (const answer of ['We deliver 4.5x ROAS [1].', 'Our apps have a 4.9 store rating.', '98% customer satisfaction.', 'Over 1,000+ websites created.', '₹20M+ client revenue generated.', 'Rated 4.9/5 by users.']) {
      const result = applyStatisticAttributionGuard(answer);
      assert.deepEqual(result.applied, ['statistics-attribution'], answer);
      assert.equal(result.content, `${answer}\n\n${STATISTICS_NOTE}`);
    }
  });

  it('leaves attributed figures, prices, citations and plain numbers alone', () => {
    for (const answer of [
      "According to QOBO's website, campaigns average 4.5x ROAS [1].",
      "QOBO's website states 1,000+ websites were created [2].",
      'Starter is ₹499 and Pro is ₹999 [1][2].',
      'Get your site live in 5 minutes with 24/7 support [3].',
    ]) {
      assert.deepEqual(applyStatisticAttributionGuard(answer).applied, [], answer);
    }
  });
});

describe('plans chunk fixture', () => {
  it('matches the one-time statement used by the discrepancy', () => {
    assert.ok(PLANS_CHUNK_TEXT.includes(billing.statements[0]!.quote));
  });
});
