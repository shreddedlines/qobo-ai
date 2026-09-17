import type { Intent, Source } from '../conversations/types.ts';
import type { HistoryTurn } from '../rag/prompts.ts';
import type { QoboAnswerMetadata, QoboAnswerService } from '../rag/qobo-answer.ts';
import type { GeneralAnswerMetadata, GeneralAnswerService } from './general-answer.ts';
import type { IntentRouter, RouteDecision } from './router.ts';
import { offTopicReply, smalltalkReply } from './templates.ts';

export type ChatReplyStatus = 'answered' | 'insufficient' | 'redirected';

export interface ChatMetadata {
  router: Pick<RouteDecision, 'source' | 'model' | 'language' | 'smalltalkType'> & { error?: string };
  qobo?: QoboAnswerMetadata;
  general?: GeneralAnswerMetadata;
  latencyMs: number;
}

export interface ChatReply {
  intent: Intent;
  status: ChatReplyStatus;
  content: string;
  sources: Source[];
  metadata: ChatMetadata;
}

export interface ChatRequest {
  message: string;
  history?: HistoryTurn[];
}

export interface ChatService {
  respond(request: ChatRequest): Promise<ChatReply>;
}

export interface ChatServiceDeps {
  router: IntentRouter;
  qobo: QoboAnswerService;
  general: GeneralAnswerService;
  now?: () => number;
}

/**
 * One chat turn. The router's intent decides the code path; off-topic and small
 * talk get fixed replies and never reach an answer model or web search.
 * Upstream failures in the answer paths propagate (AnswerUnavailableError).
 */
export function createChatService({ router, qobo, general, now = Date.now }: ChatServiceDeps): ChatService {
  return {
    async respond({ message, history = [] }) {
      const startedAt = now();
      const decision = await router.route({ message, history });
      const routerMetadata: ChatMetadata['router'] = {
        source: decision.source,
        model: decision.model,
        language: decision.language,
        smalltalkType: decision.smalltalkType,
        ...(decision.error ? { error: decision.error } : {}),
      };
      const finish = (reply: Omit<ChatReply, 'metadata'>, extra: Partial<ChatMetadata> = {}): ChatReply => ({
        ...reply,
        metadata: { router: routerMetadata, ...extra, latencyMs: now() - startedAt },
      });

      switch (decision.intent) {
        case 'off_topic':
          return finish({ intent: 'off_topic', status: 'redirected', content: offTopicReply(decision.language), sources: [] });

        case 'smalltalk':
          return finish({ intent: 'smalltalk', status: 'answered', content: smalltalkReply(decision.smalltalkType, decision.language), sources: [] });

        case 'general': {
          const answer = await general.answer({ question: message, webSearchQuery: decision.webSearchQuery, history });
          if (answer.status === 'redirected') {
            // The model tried to produce code or similar despite the rules.
            return finish({ intent: 'off_topic', status: 'redirected', content: offTopicReply(decision.language), sources: [] }, { general: answer.metadata });
          }
          return finish({ intent: 'general', status: answer.status, content: answer.content, sources: answer.sources }, { general: answer.metadata });
        }

        case 'qobo': {
          const answer = await qobo.answer({ question: message, history, retrievalQuery: decision.standaloneQuery });
          return finish({ intent: 'qobo', status: answer.status, content: answer.content, sources: answer.sources }, { qobo: answer.metadata });
        }
      }
    },
  };
}
