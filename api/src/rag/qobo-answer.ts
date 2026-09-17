import type { Source } from '../conversations/types.ts';
import { applyDiscrepancyGuards, applyStatisticAttributionGuard } from './answer-guards.ts';
import { DISCREPANCIES, findRelevantDiscrepancies, type Discrepancy } from './discrepancies.ts';
import { InvalidModelOutputError, type AnswerGenerator } from './generator.ts';
import { buildAnswerPrompt, QOBO_ANSWER_SYSTEM_INSTRUCTION, type HistoryTurn } from './prompts.ts';
import { CONTACT_SOURCE, contactSentence } from './qobo-facts.ts';
import type { KbRetriever } from './retriever.ts';
import { buildContextSources, resolveCitations } from './sources.ts';

export type QoboAnswerOutcome = 'answered' | 'no_context' | 'insufficient' | 'ungrounded' | 'invalid_output';

export interface QoboAnswerMetadata {
  outcome: QoboAnswerOutcome;
  model: string | null;
  retrieval: { count: number; topSimilarity: number | null; chunkIds: number[] };
  discrepancies: string[];
  guards: string[];
  latencyMs: number;
}

export interface QoboAnswer {
  status: 'answered' | 'insufficient';
  content: string;
  sources: Source[];
  metadata: QoboAnswerMetadata;
}

export interface QoboAnswerRequest {
  /** The user's message, answered by the model. */
  question: string;
  history?: HistoryTurn[];
  /** Self-contained rewrite used for retrieval (e.g. from the router for follow-ups). Defaults to `question`. */
  retrievalQuery?: string;
}

export interface QoboAnswerService {
  answer(request: QoboAnswerRequest): Promise<QoboAnswer>;
}

/** Retrieval or generation failed upstream (quota, outage, timeout). The API maps this to a retryable error. */
export class AnswerUnavailableError extends Error {
  constructor(stage: 'retrieval' | 'generation', cause: unknown) {
    super(`Answer ${stage} failed`, { cause });
    this.name = 'AnswerUnavailableError';
  }
}

export const NOT_FOUND_ANSWER = `I couldn't find that in the information published on QOBO's website, so I don't want to guess. ${contactSentence()}`;

export interface QoboAnswerServiceDeps {
  retriever: KbRetriever;
  generator: AnswerGenerator;
  discrepancies?: Discrepancy[];
  /** Most recent turns passed to the model for context. */
  historyTurns?: number;
  now?: () => number;
}

/**
 * Grounded QOBO answers: retrieve → (known discrepancies) → generate JSON with
 * [S#] citations → keep only valid citations → deterministic guards. Anything
 * the sources cannot support becomes a fixed "not found" reply, never a guess.
 */
export function createQoboAnswerService({ retriever, generator, discrepancies = DISCREPANCIES, historyTurns = 6, now = Date.now }: QoboAnswerServiceDeps): QoboAnswerService {
  return {
    async answer({ question, history = [], retrievalQuery }) {
      const startedAt = now();
      const trimmedQuestion = question.trim();
      const searchQuery = retrievalQuery?.trim() || trimmedQuestion;

      let chunks;
      try {
        chunks = await retriever.retrieve(searchQuery);
      } catch (error) {
        throw new AnswerUnavailableError('retrieval', error);
      }

      const retrieval = {
        count: chunks.length,
        topSimilarity: chunks.length > 0 ? Math.max(...chunks.map((chunk) => chunk.similarity)) : null,
        chunkIds: chunks.map((chunk) => chunk.id),
      };
      const relevant = findRelevantDiscrepancies(`${trimmedQuestion}\n${searchQuery}`, chunks, discrepancies);
      let usedModel: string | null = null;
      const metadata = (outcome: QoboAnswerOutcome, guards: string[] = []): QoboAnswerMetadata => ({
        outcome,
        model: usedModel,
        retrieval,
        discrepancies: relevant.map((d) => d.id),
        guards,
        latencyMs: now() - startedAt,
      });
      const notFound = (outcome: QoboAnswerOutcome): QoboAnswer => ({
        status: 'insufficient',
        content: NOT_FOUND_ANSWER,
        sources: [CONTACT_SOURCE],
        metadata: metadata(outcome),
      });

      if (chunks.length === 0) return notFound('no_context');

      const contextSources = buildContextSources(chunks, relevant);
      const prompt = buildAnswerPrompt({ question: trimmedQuestion, history: history.slice(-historyTurns), sources: contextSources, discrepancies: relevant });

      let draft;
      try {
        draft = await generator.generate({ systemInstruction: QOBO_ANSWER_SYSTEM_INSTRUCTION, prompt });
      } catch (error) {
        if (error instanceof InvalidModelOutputError) {
          usedModel = generator.model;
          return notFound('invalid_output');
        }
        throw new AnswerUnavailableError('generation', error);
      }
      usedModel = draft.model;

      if (draft.status === 'insufficient' || !draft.answer.trim()) return notFound('insufficient');

      const cited = resolveCitations(
        draft.answer,
        draft.citations,
        contextSources,
        discrepancies.map((d) => d.id),
      );
      if (cited.sources.length === 0) return notFound('ungrounded');

      const discrepancyGuard = applyDiscrepancyGuards(cited.content, relevant);
      const statisticsGuard = applyStatisticAttributionGuard(discrepancyGuard.content);

      const sources = [...cited.sources];
      for (const source of discrepancyGuard.extraSources) {
        if (!sources.some((existing) => existing.url === source.url)) sources.push(source);
      }

      return {
        status: 'answered',
        content: statisticsGuard.content,
        sources,
        metadata: metadata('answered', [...discrepancyGuard.applied, ...statisticsGuard.applied]),
      };
    },
  };
}
