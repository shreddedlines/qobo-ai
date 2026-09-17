import { createApp } from './app.ts';
import { createSupabaseTokenVerifier } from './auth/token-verifier.ts';
import { createSupabaseExchangeStore } from './chat/exchange-store.ts';
import { createSupabaseUserMessageQuota } from './chat/user-quota.ts';
import { EnvValidationError, loadEnv, type Env } from './config/env.ts';
import { createSupabaseConversationStore } from './conversations/store.ts';
import { createAuthClient } from './db/supabase.ts';
import { createSupabaseHealthCheck } from './health/routes.ts';
import { createLogger } from './lib/logger.ts';
import { checkKnowledgeBase } from './rag/kb-compat.ts';
import { createChatRuntime } from './rag/setup.ts';

function readEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const env = readEnvOrExit();
  const logger = createLogger(env);

  const { chatService, service } = createChatRuntime(env);

  const knowledgeBase = await checkKnowledgeBase(service, env.GEMINI_EMBEDDING_MODEL);
  if (knowledgeBase.status === 'mismatch') {
    logger.fatal({ knowledgeBase }, 'knowledge base is incompatible with the configured embedding model');
    process.exit(1);
  }
  if (knowledgeBase.status === 'ok') logger.info({ knowledgeBase }, 'knowledge base ready');
  else logger.warn({ knowledgeBase }, 'knowledge base not ready; QOBO answers will fall back to contact details');

  const app = createApp({
    env,
    logger,
    tokenVerifier: createSupabaseTokenVerifier(createAuthClient(env).auth),
    conversationStore: createSupabaseConversationStore(env),
    healthCheck: createSupabaseHealthCheck(env),
    chatService,
    exchangeStore: createSupabaseExchangeStore(service),
    userQuota: createSupabaseUserMessageQuota(service, env.USER_DAILY_MESSAGE_CAP),
  });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'api listening');
  });
  // A chat turn is bounded by CHAT_REQUEST_TIMEOUT_MS; nothing legitimate needs longer.
  server.requestTimeout = env.CHAT_REQUEST_TIMEOUT_MS + 15_000;
  server.headersTimeout = 20_000;

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal startup error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
