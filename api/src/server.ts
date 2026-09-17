import { createApp } from './app.ts';
import { createSupabaseTokenVerifier } from './auth/token-verifier.ts';
import { EnvValidationError, loadEnv, type Env } from './config/env.ts';
import { createSupabaseConversationStore } from './conversations/store.ts';
import { createAuthClient } from './db/supabase.ts';
import { createSupabaseHealthCheck } from './health/routes.ts';
import { createLogger } from './lib/logger.ts';

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

function main(): void {
  const env = readEnvOrExit();
  const logger = createLogger(env);

  const app = createApp({
    env,
    logger,
    tokenVerifier: createSupabaseTokenVerifier(createAuthClient(env).auth),
    conversationStore: createSupabaseConversationStore(env),
    healthCheck: createSupabaseHealthCheck(env),
  });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'api listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
