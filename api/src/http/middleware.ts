import { randomUUID } from 'node:crypto';

import cors from 'cors';
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import type { Logger } from '../lib/logger.ts';
import { HttpError } from './errors.ts';

/** Assigns a request id and logs method, path, status and duration (never bodies). */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0];
      const entry = {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      };
      if (path === '/api/health') logger.debug(entry, 'request');
      else logger.info(entry, 'request');
    });

    next();
  };
}

/**
 * Only exact, configured origins receive CORS headers. Requests without an Origin
 * header (curl, uptime pingers) are not browser requests and still need auth.
 */
export function corsPolicy(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin: (origin, callback) => callback(null, origin !== undefined && allowed.has(origin)),
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
    maxAge: 600,
  });
}

/** Per-IP fixed-window limiter (in memory: fine for one instance, resets on restart). */
export function perIpRateLimit(limitPerMinute: number, message: string): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'rate_limited', message)),
  });
}
