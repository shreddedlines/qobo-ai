import type { AnswerDraft, AnswerGenerator, GenerateInput } from '../../src/rag/generator.ts';
import type { KbRetriever } from '../../src/rag/retriever.ts';
import type { RetrievedChunk } from '../../src/rag/sources.ts';

let nextId = 1;

export function kbChunk(url: string, content: string, overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return { id: nextId++, url, title: overrides.title ?? 'Page', section: null, pageType: 'service', content, topics: [], similarity: 0.75, ...overrides };
}

export class FakeRetriever implements KbRetriever {
  readonly queries: string[] = [];
  private readonly chunks: RetrievedChunk[];
  private readonly error: Error | undefined;

  constructor(chunks: RetrievedChunk[] = [], error?: Error) {
    this.chunks = chunks;
    this.error = error;
  }

  async retrieve(query: string): Promise<RetrievedChunk[]> {
    this.queries.push(query);
    if (this.error) throw this.error;
    return this.chunks;
  }
}

type DraftWithoutModel = Omit<AnswerDraft, 'model'> & { model?: string };

export class FakeGenerator implements AnswerGenerator {
  readonly model = 'fake-answer-model';
  readonly inputs: GenerateInput[] = [];
  private readonly respond: DraftWithoutModel | ((input: GenerateInput) => DraftWithoutModel | Promise<DraftWithoutModel>);

  constructor(respond: DraftWithoutModel | ((input: GenerateInput) => DraftWithoutModel | Promise<DraftWithoutModel>)) {
    this.respond = respond;
  }

  async generate(input: GenerateInput): Promise<AnswerDraft> {
    this.inputs.push(input);
    const draft = typeof this.respond === 'function' ? await this.respond(input) : this.respond;
    return { model: this.model, ...draft };
  }
}

export const PLANS_CHUNK_TEXT =
  'Page: Plans & Pricing\nSection: Overview\n\n### STARTER\n₹499\nOwn it forever. Full Features.\n"Whether it\'s the ₹499 starter or a Custom build, you own the code and the domain. No recurring subscriptions, just a one-time investment for a lifetime asset."';

export const HOME_FAQ_CHUNK_TEXT =
  'Page: QOBO Home\nSection: Got Questions? We\'ve Got Answers\n\n### Is there a free trial?\nYes! Build and preview your site for free. Pay only when you go live, starting at ₹499/month. No hidden fees.';
