import type { RequestHandler, Response } from 'express';

import { HttpError } from '../http/errors.ts';
import { AuthUnavailableError, type AuthUser, type TokenVerifier } from './token-verifier.ts';

const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;

export function requireAuth(verifier: TokenVerifier): RequestHandler {
  return async (req, res, next) => {
    const match = BEARER_PATTERN.exec(req.get('authorization') ?? '');
    if (!match) {
      next(new HttpError(401, 'unauthorized', 'Missing or malformed Authorization header'));
      return;
    }

    try {
      const user = await verifier.verify(match[1]!);
      if (!user) {
        next(new HttpError(401, 'unauthorized', 'Invalid or expired session'));
        return;
      }
      res.locals.user = user;
      next();
    } catch (error) {
      if (error instanceof AuthUnavailableError) {
        next(new HttpError(503, 'service_unavailable', 'Authentication is temporarily unavailable. Please try again.'));
        return;
      }
      next(error);
    }
  };
}

/** Returns the user attached by `requireAuth`. */
export function getAuthUser(res: Response): AuthUser {
  const user = res.locals.user as AuthUser | undefined;
  if (!user) throw new Error('getAuthUser called on a route without requireAuth');
  return user;
}
