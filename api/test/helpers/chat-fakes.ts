import { InvalidModelOutputError, type JsonGenerateInput, type JsonGenerator } from '../../src/rag/generator.ts';
import type { DailyQuota } from '../../src/web/quota.ts';
import type { WebSearchProvider, WebSearchResult } from '../../src/web/tavily.ts';

type Responder = (input: JsonGenerateInput<unknown>) => unknown;

/** Returns canned raw JSON, validated through the caller's real zod schema. */
export class FakeJsonGenerator implements JsonGenerator {
  readonly model: string;
  readonly inputs: Array<JsonGenerateInput<unknown>> = [];
  private readonly respond: Responder;

  constructor(respond: unknown | Responder, model = 'fake-json-model') {
    this.respond = typeof respond === 'function' ? (respond as Responder) : () => respond;
    this.model = model;
  }

  async generate<T>(input: JsonGenerateInput<T>): Promise<{ value: T; model: string }> {
    this.inputs.push(input as JsonGenerateInput<unknown>);
    const raw = this.respond(input as JsonGenerateInput<unknown>);
    const parsed = input.schema.safeParse(raw);
    if (!parsed.success) throw new InvalidModelOutputError('fake output does not match schema');
    return { value: parsed.data, model: this.model };
  }
}

export class FakeWebSearch implements WebSearchProvider {
  readonly queries: string[] = [];
  private readonly results: WebSearchResult[];
  private readonly error: Error | undefined;

  constructor(results: WebSearchResult[] = [], error?: Error) {
    this.results = results;
    this.error = error;
  }

  async search(query: string): Promise<WebSearchResult[]> {
    this.queries.push(query);
    if (this.error) throw this.error;
    return this.results;
  }
}

export class FakeQuota implements DailyQuota {
  calls = 0;
  private readonly allowed: boolean | Error;

  constructor(allowed: boolean | Error = true) {
    this.allowed = allowed;
  }

  async consume(): Promise<boolean> {
    this.calls++;
    if (this.allowed instanceof Error) throw this.allowed;
    return this.allowed;
  }
}

export function webResult(url: string, content: string, title = 'Web page'): WebSearchResult {
  return { title, url, content, score: 0.8 };
}

export function routerOutput(overrides: Partial<Record<'intent' | 'smalltalk_type' | 'language' | 'standalone_query' | 'web_search_query', string>> = {}) {
  return { intent: 'qobo', smalltalk_type: 'other', language: 'en', standalone_query: '', web_search_query: '', ...overrides };
}
