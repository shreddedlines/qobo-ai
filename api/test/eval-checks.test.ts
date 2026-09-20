import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkAnswer, evalCaseSchema, kbUrlsFromManifest, loadKbUrls, normalizeUrl } from '../scripts/eval/lib/checks.ts';

describe('eval checks for routing and web research', () => {
  const generalCase = evalCaseSchema.parse({
    id: 'general-case',
    tags: ['web'],
    question: 'Website vs web app?',
    expect: { intent: 'general', status: 'answered', citesWeb: true, containsAny: ['General information'] },
  });

  it('passes a routed, web-cited answer', () => {
    assert.deepEqual(checkAnswer(generalCase, { intent: 'general', status: 'answered', content: '**General information** …', sources: [{ url: 'https://example.com', kind: 'web' }] }), []);
  });

  it('reports wrong intent and missing web citations', () => {
    assert.deepEqual(checkAnswer(generalCase, { intent: 'qobo', status: 'answered', content: '**General information**', sources: [{ url: 'https://qobo.dev/', kind: 'qobo' }] }), [
      'intent is "qobo", expected "general"',
      'cites no web sources',
    ]);
  });

  it('supports intentIn, redirected status, noSources and history', () => {
    const offTopic = evalCaseSchema.parse({
      id: 'off-topic',
      tags: ['routing'],
      question: 'How much is the Pro one?',
      history: [{ role: 'user', content: 'What plans do you have?' }],
      expect: { intentIn: ['off_topic', 'smalltalk'], status: 'redirected', noSources: true },
    });
    assert.equal(offTopic.history.length, 1);
    assert.deepEqual(checkAnswer(offTopic, { intent: 'off_topic', status: 'redirected', content: 'Sorry', sources: [] }), []);
    assert.deepEqual(checkAnswer(offTopic, { intent: 'general', status: 'answered', content: 'x', sources: [{ url: 'https://a.example' }] }), [
      'intent is "general", expected one of off_topic, smalltalk',
      'status is "answered", expected "redirected"',
      'expected no sources, got 1',
    ]);
  });
});

describe('citation and grounding checks', () => {
  const PLANS = 'https://qobo.dev/plans';
  const HOME = 'https://qobo.dev/';
  const TEAM = 'https://qobo.dev/our-team';
  /** A page that does not exist: what an invented citation looks like. */
  const FABRICATED = 'https://qobo.dev/pricing-plans';

  const kbUrls = new Set([HOME, PLANS, TEAM].map(normalizeUrl));
  const caseWith = (expect: Record<string, unknown>) => evalCaseSchema.parse({ id: 'pricing', tags: ['pricing'], question: 'How much?', expect });
  const answerCiting = (...urls: string[]) => ({
    intent: 'qobo',
    status: 'answered',
    content: 'Starter is ₹499.',
    sources: urls.map((url) => ({ url, kind: 'qobo' })),
  });

  it('citesAll passes when every expected page is cited', () => {
    assert.deepEqual(checkAnswer(caseWith({ citesAll: [PLANS, HOME] }), answerCiting(HOME, PLANS, TEAM), kbUrls), []);
  });

  it('citesAll fails, and names what is missing, when one is not cited', () => {
    assert.deepEqual(checkAnswer(caseWith({ citesAll: [PLANS, TEAM] }), answerCiting(PLANS), kbUrls), [`does not cite ${TEAM}`]);
  });

  it('citesOnly passes when every citation is in the allowed set', () => {
    assert.deepEqual(checkAnswer(caseWith({ citesOnly: [PLANS, HOME] }), answerCiting(PLANS, HOME), kbUrls), []);
    assert.deepEqual(checkAnswer(caseWith({ citesOnly: [PLANS, HOME] }), answerCiting(PLANS), kbUrls), [], 'citing fewer than allowed is fine');
  });

  it('citesOnly fails, and names the stray page, when something else is cited', () => {
    assert.deepEqual(checkAnswer(caseWith({ citesOnly: [PLANS] }), answerCiting(PLANS, TEAM), kbUrls), [`cites unexpected ${TEAM}`]);
  });

  it('maxSources passes at the limit and fails above it', () => {
    assert.deepEqual(checkAnswer(caseWith({ maxSources: 2 }), answerCiting(PLANS, HOME), kbUrls), []);
    assert.deepEqual(checkAnswer(caseWith({ maxSources: 2 }), answerCiting(PLANS, HOME, TEAM), kbUrls), ['cites 3 sources, at most 2 expected']);
  });

  it('groundedInKb passes when every QOBO citation is a real knowledge-base page', () => {
    assert.deepEqual(checkAnswer(caseWith({ groundedInKb: true }), answerCiting(HOME, PLANS), kbUrls), []);
  });

  it('groundedInKb fails on a fabricated QOBO page', () => {
    assert.deepEqual(checkAnswer(caseWith({ groundedInKb: true }), answerCiting(PLANS, FABRICATED), kbUrls), [
      `cites QOBO pages outside the knowledge base: ${FABRICATED}`,
    ]);
  });

  it('groundedInKb ignores web sources, which are not knowledge-base pages', () => {
    const answer = { intent: 'general', status: 'answered', content: 'x', sources: [{ url: 'https://moz.com/learn/seo', kind: 'web' }, { url: PLANS, kind: 'qobo' }] };
    assert.deepEqual(checkAnswer(caseWith({ groundedInKb: true }), answer, kbUrls), []);
  });

  it('treats a trailing slash as the same page', () => {
    assert.deepEqual(checkAnswer(caseWith({ citesAll: [PLANS], groundedInKb: true }), answerCiting(`${PLANS}/`), kbUrls), []);
  });

  it('reads the allowed pages from the reviewed manifest', () => {
    const urls = loadKbUrls();
    assert.equal(urls.size, 25, 'the reviewed crawl covers 25 pages');
    for (const url of [HOME, PLANS, TEAM, 'https://qobo.dev/contact-us', 'https://qobo.dev/cancellation-refunds']) {
      assert.ok(urls.has(normalizeUrl(url)), `${url} should be a known page`);
    }
    assert.ok(!urls.has(normalizeUrl(FABRICATED)), 'an invented page must not be allowed');
  });

  it('builds the allowed set from the manifest site and paths', () => {
    assert.deepEqual([...kbUrlsFromManifest({ site: 'https://qobo.dev', pages: [{ path: '/' }, { path: '/plans' }] })], [HOME, PLANS]);
  });

  it('leaves the existing assertions alone when the new ones are absent', () => {
    const legacy = caseWith({ intent: 'qobo', status: 'answered', citesAny: [PLANS], containsAll: ['₹499'], notContains: ['₹4,999'] });
    assert.deepEqual(checkAnswer(legacy, answerCiting(PLANS)), []);
    assert.deepEqual(checkAnswer(legacy, { intent: 'qobo', status: 'answered', content: 'It is ₹4,999.', sources: [] }), [
      `cites none of ${PLANS}`,
      'missing "₹499"',
      'must not contain "₹4,999"',
    ]);
  });
});
