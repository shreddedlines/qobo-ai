import { isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';

export interface AuthUser {
  id: string;
  email: string | null;
  /** The verified access token, used to make RLS-scoped database calls on the user's behalf. */
  accessToken: string;
}

export interface TokenVerifier {
  /** Resolves the user for a valid session token, `null` for an invalid one; throws AuthUnavailableError on outages. */
  verify(accessToken: string): Promise<AuthUser | null>;
}

/** Supabase Auth could not be reached, so validity is unknown (maps to 503, not 401). */
export class AuthUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Authentication service unavailable', { cause });
    this.name = 'AuthUnavailableError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKEN_LENGTH = 8192;

type ClaimsAuthClient = Pick<SupabaseClient['auth'], 'getClaims'>;

/**
 * Verifies Supabase access tokens with `auth.getClaims()`. With asymmetric signing
 * keys this checks the signature and expiry locally against the cached JWKS; the
 * user id is taken only from verified claims, never from the request body.
 */
export function createSupabaseTokenVerifier(auth: ClaimsAuthClient): TokenVerifier {
  return {
    async verify(accessToken) {
      if (!hasJwtShape(accessToken)) return null;

      let result: Awaited<ReturnType<ClaimsAuthClient['getClaims']>>;
      try {
        result = await auth.getClaims(accessToken);
      } catch (error) {
        throw new AuthUnavailableError(error);
      }

      if (result.error) {
        const status = (result.error as { status?: unknown }).status;
        if (isAuthRetryableFetchError(result.error) || (typeof status === 'number' && status >= 500)) {
          throw new AuthUnavailableError(result.error);
        }
        return null;
      }

      const claims = result.data?.claims;
      if (!claims) return null;
      if (claims.role !== 'authenticated' || claims.is_anonymous === true) return null;
      if (typeof claims.sub !== 'string' || !UUID_PATTERN.test(claims.sub)) return null;

      return { id: claims.sub, email: typeof claims.email === 'string' ? claims.email : null, accessToken };
    },
  };
}

/** Cheap structural check so garbage never reaches the JWT decoder. */
function hasJwtShape(token: string): boolean {
  if (token.length > MAX_TOKEN_LENGTH) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return true;
  } catch {
    return false;
  }
}
