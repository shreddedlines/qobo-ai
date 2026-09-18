import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyDiscrepancyGuards, applyStatisticAttributionGuard, STATISTICS_NOTE } from '../../src/rag/answer-guards.ts';
import { DISCREPANCIES, findRelevantDiscrepancies } from '../../src/rag/discrepancies.ts';
import { buildAnswerPrompt, escapePromptText } from '../../src/rag/prompts.ts';
import { buildContextSources, resolveCitations, stripInventedCitations } from '../../src/rag/sources.ts';
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

describe('invented citations never reach the reader', () => {
  const leakChunks = [
    kbChunk('https://qobo.dev/plans', 'Starter ₹499', { title: 'Plans & Pricing' }),
    kbChunk('https://qobo.dev/', 'FAQ', { title: 'QOBO Home' }),
  ];
  const leakSources = buildContextSources(leakChunks, []);
  const nonCitable = DISCREPANCIES.map((d) => d.id);
  const resolve = (answer: string, declared: string[] = ['S1']) => resolveCitations(answer, declared, leakSources, nonCitable).content;

  it('removes the [Known Discrepancies] label seen in a production answer', () => {
    // The shape of the real leak: the model cited the prompt's own section name.
    const leaked =
      'We offer several plans to help you launch and grow your business: a Starter plan starting at ₹499 [S1]. ' +
      'The website describes the billing terms differently across pages, so we recommend confirming the current ' +
      'billing terms with our team [Known Discrepancies]. For SEO, our Pro plan includes advanced SEO [S1].';

    const content = resolve(leaked);

    assert.ok(!content.includes('[Known Discrepancies]'), content);
    assert.ok(!/known.discrepanc/i.test(content), 'no trace of the label in any casing');
    assert.match(content, /confirming the current billing terms with our team\. For SEO/, 'the sentence closes up cleanly');
    assert.match(content, /Starter plan starting at ₹499 \[1\]/, 'the real citation survives');
    assert.match(content, /advanced SEO \[1\]/);
  });

  it('removes the label however the model writes it', () => {
    for (const label of [
      '[Known Discrepancies]',
      '[known_discrepancies]',
      '[Known Discrepancy]',
      '[ Known Discrepancies ]',
      '[KNOWN DISCREPANCIES]',
      '[discrepancy]',
      '[Sources]',
      '[known discrepancies note]',
    ]) {
      assert.equal(resolve(`Confirm the billing terms with our team ${label}.`), 'Confirm the billing terms with our team.', label);
    }
  });

  it('still removes a configured discrepancy id, as before', () => {
    assert.equal(resolve('Starter is ₹499 [starter-plan-billing].'), 'Starter is ₹499.');
    assert.equal(resolve('Over 1,000 websites [websites-created-count].'), 'Over 1,000 websites.');
  });

  it('removes a source id the model invented', () => {
    assert.equal(resolve('Plans start at ₹499 [S9].'), 'Plans start at ₹499.');
    assert.equal(resolve('Plans start at ₹499 [Source 4].'), 'Plans start at ₹499.');
  });

  it('keeps real citations, including grouped ones', () => {
    assert.equal(resolve('Starter is ₹499 [S1] and the FAQ agrees [S2].', ['S1', 'S2']), 'Starter is ₹499 [1] and the FAQ agrees [2].');
    assert.equal(resolve('Both pages agree [S1, S2].', ['S1', 'S2']), 'Both pages agree [1][2].');
  });

  it('leaves ordinary prose and numbers alone', () => {
    const prose =
      'Plans start at ₹499 per month. We build over WhatsApp — no code, no calls! ' +
      'Ratings of 4.9/5 and 98% uptime are marketing statements. Contact us at +91 99016 31188 (9am-6pm).';
    assert.equal(resolve(prose, []), prose);
  });

  it('leaves a Markdown link intact', () => {
    assert.equal(resolve('See [our plans](https://qobo.dev/plans) for details [S1].'), 'See [our plans](https://qobo.dev/plans) for details [1].');
  });

  it('leaves bracketed numbers that are not citations alone', () => {
    assert.equal(resolve('The array [1, 2, 3] is unrelated.', []), 'The array [1, 2, 3] is unrelated.');
  });

  it('leaves a long bracketed aside alone rather than eating prose', () => {
    const aside = 'Pricing [this is a long parenthetical aside that is clearly prose and not a label] applies.';
    assert.equal(resolve(aside, []), aside);
  });

  it('holds for the pricing answer the discrepancy guard builds on', () => {
    const answer = 'Starter is listed at ₹499 [S1]. The pages disagree on billing [Known Discrepancies], so please confirm with our team.';
    const cited = resolveCitations(answer, ['S1'], buildContextSources(leakChunks, [billing]), nonCitable);
    const guarded = applyDiscrepancyGuards(cited.content, [billing]);

    assert.ok(!guarded.content.includes('Known Discrepancies'), guarded.content);
    assert.match(guarded.content, /Starter is listed at ₹499 \[1\]/, 'the price and its citation are untouched');
    assert.match(guarded.content, /The pages disagree on billing, so please confirm with our team\./, 'the sentence reads normally');
    assert.ok(cited.sources.length > 0, 'the source list is unaffected');
  });
});

describe('stripInventedCitations on its own', () => {
  it('removes a label and leaves everything else', () => {
    assert.equal(stripInventedCitations('Confirm with our team [Known Discrepancies].'), 'Confirm with our team .');
    assert.equal(stripInventedCitations('Starter is ₹499 [1].'), 'Starter is ₹499 [1].');
    assert.equal(stripInventedCitations('Both agree [1][2].'), 'Both agree [1][2].');
    assert.equal(stripInventedCitations('[our plans](https://qobo.dev/plans)'), '[our plans](https://qobo.dev/plans)');
    assert.equal(stripInventedCitations('nothing to do here'), 'nothing to do here');
  });
});
