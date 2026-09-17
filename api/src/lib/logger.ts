import { pino, type Logger } from 'pino';

import type { Env } from '../config/env.ts';

export type { Logger };

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { service: 'qobo-support-api', env: env.NODE_ENV },
    // Defense in depth: never write credentials or message bodies to logs.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'authorization', 'apiKey', '*.apiKey', 'content', '*.content'],
      censor: '[redacted]',
    },
  });
}
