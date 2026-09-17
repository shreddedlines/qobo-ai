import type { ErrorRequestHandler, RequestHandler } from 'express';

import type { Logger } from '../lib/logger.ts';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'payload_too_large'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'upstream_error'
  | 'service_unavailable'
  | 'timeout'
  | 'conflict'
  | 'internal_error';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, 'not_found', 'Route not found'));
};

/** Converts any thrown error into a consistent JSON body without leaking internals. */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    let httpError: HttpError;

    if (err instanceof HttpError) {
      httpError = err;
    } else if (isBodyParserError(err)) {
      httpError =
        err.type === 'entity.too.large'
          ? new HttpError(413, 'payload_too_large', 'Request body is too large')
          : new HttpError(400, 'bad_request', 'Malformed request body');
    } else {
      httpError = new HttpError(500, 'internal_error', 'Something went wrong. Please try again.');
    }

    if (httpError.status >= 500) {
      logger.error({ err, method: req.method, path: req.path }, 'request failed');
    }

    const body: ErrorBody = { error: { code: httpError.code, message: httpError.message } };
    if (httpError.details !== undefined) body.error.details = httpError.details;
    res.status(httpError.status).json(body);
  };
}

function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return typeof err === 'object' && err !== null && 'type' in err && typeof (err as { type: unknown }).type === 'string' && 'status' in err;
}
