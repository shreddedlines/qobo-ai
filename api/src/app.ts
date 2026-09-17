import express, { type Express } from 'express';
import helmet from 'helmet';

import { requireAuth } from './auth/require-auth.ts';
import type { TokenVerifier } from './auth/token-verifier.ts';
import type { ChatService } from './chat/chat-service.ts';
import type { ExchangeStore } from './chat/exchange-store.ts';
import { createChatRouter } from './chat/routes.ts';
import type { UserMessageQuota } from './chat/user-quota.ts';
import type { Env } from './config/env.ts';
import { createConversationRouter } from './conversations/routes.ts';
import type { ConversationStore } from './conversations/store.ts';
import { createHealthRouter, type HealthCheck } from './health/routes.ts';
import { createErrorHandler, notFoundHandler } from './http/errors.ts';
import { corsPolicy, perIpRateLimit, requestLogger } from './http/middleware.ts';
import type { Logger } from './lib/logger.ts';

export interface AppDeps {
  env: Env;
  logger: Logger;
  tokenVerifier: TokenVerifier;
  conversationStore: ConversationStore;
  healthCheck: HealthCheck;
  chatService: ChatService;
  exchangeStore: ExchangeStore;
  userQuota: UserMessageQuota;
}

export function createApp(deps: AppDeps): Express {
  const { env, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(corsPolicy(env.CORS_ORIGINS));
  app.use(express.json({ limit: '32kb' }));

  // Health stays outside the rate limiter so uptime pingers are never throttled.
  app.use('/api', createHealthRouter(deps.healthCheck));

  // Throttle before authentication so token guessing is rate limited too.
  app.use('/api', perIpRateLimit(env.API_RATE_LIMIT_PER_MINUTE, 'Too many requests. Please slow down.'));

  app.use('/api/conversations', requireAuth(deps.tokenVerifier), createConversationRouter(deps.conversationStore));

  // Chat turns call paid models: a stricter per-IP limit on top of the API limit and the per-user daily cap.
  app.use(
    '/api/chat',
    perIpRateLimit(env.CHAT_RATE_LIMIT_PER_MINUTE, 'Too many messages. Please wait a moment before sending another.'),
    requireAuth(deps.tokenVerifier),
    createChatRouter({
      chatService: deps.chatService,
      exchanges: deps.exchangeStore,
      conversations: deps.conversationStore,
      quota: deps.userQuota,
      timeoutMs: env.CHAT_REQUEST_TIMEOUT_MS,
      logger,
    }),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
