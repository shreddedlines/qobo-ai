import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkAnswer, evalCaseSchema } from '../scripts/eval/lib/checks.ts';

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
