import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createChatService } from '../../src/chat/chat-service.ts';
import type { GeneralAnswer, GeneralAnswerRequest, GeneralAnswerService } from '../../src/chat/general-answer.ts';
import { createIntentRouter } from '../../src/chat/router.ts';
import { offTopicReply, smalltalkReply } from '../../src/chat/templates.ts';
import { AnswerUnavailableError, type QoboAnswer, type QoboAnswerRequest, type QoboAnswerService } from '../../src/rag/qobo-answer.ts';
import { FakeJsonGenerator, routerOutput } from '../helpers/chat-fakes.ts';

class SpyQobo implements QoboAnswerService {
  readonly requests: QoboAnswerRequest[] = [];
  error: Error | undefined;
  async answer(request: QoboAnswerRequest): Promise<QoboAnswer> {
    this.requests.push(request);
    if (this.error) throw this.error;
    return {
      status: 'answered',
      content: 'Pro is listed at ₹999 [1].',
      sources: [{ title: 'Plans & Pricing', url: 'https://qobo.dev/plans', kind: 'qobo' }],
      metadata: { outcome: 'answered', model: 'm', retrieval: { count: 1, topSimilarity: 0.8, chunkIds: [1] }, discrepancies: [], guards: [], latencyMs: 1 },
    };
  }
}

class SpyGeneral implements GeneralAnswerService {
  readonly requests: GeneralAnswerRequest[] = [];
  status: GeneralAnswer['status'] = 'answered';
  async answer(request: GeneralAnswerRequest): Promise<GeneralAnswer> {
    this.requests.push(request);
    return {
      status: this.status,
      content: this.status === 'redirected' ? '' : '**General information** …',
      sources: this.status === 'redirected' ? [] : [{ title: 'Web', url: 'https://example.com/', kind: 'web' }],
      metadata: { outcome: this.status === 'redirected' ? 'code_blocked' : 'answered', model: 'm', webSearch: 'ok', webResultCount: 1, qoboNote: false, qoboTopSimilarity: null, discrepancies: [], guards: [], latencyMs: 1 },
    };
  }
}

function chat(output: unknown) {
  const qobo = new SpyQobo();
  const general = new SpyGeneral();
  const routerModel = new FakeJsonGenerator(output, 'gemini-3.5-flash-lite');
  return { qobo, general, service: createChatService({ router: createIntentRouter(routerModel), qobo, general }) };
}

const history = [
  { role: 'user' as const, content: 'What plans do you have?' },
  { role: 'assistant' as const, content: 'Trial, Starter, Pro and Custom.' },
];

describe('chat service routing', () => {
  it('sends QOBO questions to the RAG pipeline with the standalone query for retrieval', async () => {
    const { service, qobo, general } = chat(routerOutput({ intent: 'qobo', standalone_query: 'How much does the QOBO Pro plan cost?' }));
    const reply = await service.respond({ message: 'How much is the Pro one?', history });

    assert.deepEqual(qobo.requests, [{ question: 'How much is the Pro one?', history, retrievalQuery: 'How much does the QOBO Pro plan cost?' }]);
    assert.equal(general.requests.length, 0);
    assert.equal(reply.intent, 'qobo');
    assert.equal(reply.status, 'answered');
    assert.deepEqual(reply.sources, [{ title: 'Plans & Pricing', url: 'https://qobo.dev/plans', kind: 'qobo' }]);
    assert.equal(reply.metadata.router.source, 'model');
    assert.equal(reply.metadata.qobo?.outcome, 'answered');
  });

  it('sends general questions to web research with the router search query', async () => {
    const { service, qobo, general } = chat(routerOutput({ intent: 'general', standalone_query: 'What is SEO?', web_search_query: 'what is search engine optimization' }));
    const reply = await service.respond({ message: 'what is seo', history });
    assert.deepEqual(general.requests, [{ question: 'what is seo', webSearchQuery: 'what is search engine optimization', history }]);
    assert.equal(qobo.requests.length, 0);
    assert.equal(reply.intent, 'general');
    assert.equal(reply.sources[0]?.kind, 'web');
    assert.equal(reply.metadata.general?.webSearch, 'ok');
  });

  for (const language of ['en', 'hi', 'hinglish'] as const) {
    it(`returns the fixed off-topic redirect (${language}) without calling any answer path`, async () => {
      const { service, qobo, general } = chat(routerOutput({ intent: 'off_topic', language }));
      const reply = await service.respond({ message: 'Give me Python code to reverse a number' });
      assert.deepEqual(
        { intent: reply.intent, status: reply.status, content: reply.content, sources: reply.sources },
        { intent: 'off_topic', status: 'redirected', content: offTopicReply(language), sources: [] },
      );
      assert.equal(qobo.requests.length + general.requests.length, 0);
    });
  }

  it('redirects code-writing requests the router called general', async () => {
    const { service, general } = chat(routerOutput({ intent: 'general', web_search_query: 'python reverse number' }));
    const reply = await service.respond({ message: 'Give me Python code to reverse a number' });
    assert.equal(reply.intent, 'off_topic');
    assert.equal(reply.metadata.router.source, 'override');
    assert.equal(general.requests.length, 0);
  });

  it('turns a general answer that produced code into the off-topic redirect', async () => {
    const { service, general } = chat(routerOutput({ intent: 'general', web_search_query: 'q' }));
    general.status = 'redirected';
    const reply = await service.respond({ message: 'How do contact forms work?' });
    assert.equal(reply.intent, 'off_topic');
    assert.equal(reply.content, offTopicReply('en'));
    assert.equal(reply.metadata.general?.outcome, 'code_blocked');
  });

  it('answers small talk with fixed replies by type and language', async () => {
    for (const [type, language] of [
      ['greeting', 'en'],
      ['thanks', 'hinglish'],
      ['goodbye', 'hi'],
      ['identity', 'en'],
      ['other', 'en'],
    ] as const) {
      const { service, qobo, general } = chat(routerOutput({ intent: 'smalltalk', smalltalk_type: type, language }));
      const reply = await service.respond({ message: 'hi' });
      assert.equal(reply.intent, 'smalltalk');
      assert.equal(reply.status, 'answered');
      assert.equal(reply.content, smalltalkReply(type, language));
      assert.equal(qobo.requests.length + general.requests.length, 0);
    }
    assert.match(smalltalkReply('identity', 'en'), /AI assistant, not a human/);
  });

  it('routes to the grounded QOBO path when the router fails', async () => {
    const { service, qobo } = chat({ intent: 'unknown' });
    const reply = await service.respond({ message: 'Tell me a joke' });
    assert.equal(reply.intent, 'qobo');
    assert.equal(reply.metadata.router.source, 'fallback');
    assert.equal(reply.metadata.router.error, 'invalid_output');
    assert.deepEqual(qobo.requests, [{ question: 'Tell me a joke', history: [], retrievalQuery: 'Tell me a joke' }]);
  });

  it('propagates upstream answer failures', async () => {
    const { service, qobo } = chat(routerOutput({ intent: 'qobo' }));
    qobo.error = new AnswerUnavailableError('generation', new Error('503'));
    await assert.rejects(service.respond({ message: 'Pricing?' }), AnswerUnavailableError);
  });
});

describe('fixed reply templates', () => {
  it('have English, Hindi and Hinglish variants and fall back to English', () => {
    assert.match(offTopicReply('en'), /only help with questions about QOBO/);
    assert.match(offTopicReply('hi'), /QOBO/);
    assert.notEqual(offTopicReply('hi'), offTopicReply('en'));
    assert.notEqual(offTopicReply('hinglish'), offTopicReply('en'));
    assert.equal(offTopicReply('other'), offTopicReply('en'));
    assert.match(smalltalkReply('goodbye', 'en'), /99016 31188/);
  });
});
