export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

export const SIGN_IN_PATH = '/login';
export const CHAT_PATH = '/chat';

export interface GuardInput {
  status: AuthStatus;
  /** True for a route that requires a session (/chat, /chat/:id). */
  requiresAuth: boolean;
  /** Current location, remembered so sign-in can return the person to it. */
  currentPath: string;
  /** Location the user was sent away from, if any (router state). */
  intendedPath?: string | undefined;
}

export type GuardDecision =
  | { action: 'render' }
  /** Session state is still unknown: show a placeholder instead of redirecting. */
  | { action: 'wait' }
  | { action: 'redirect'; to: string; from?: string };

/**
 * Decides what a routed page should do for the current session state. Pure, so the
 * redirect rules are unit-tested instead of only observed in a browser.
 */
export function guardDecision({ status, requiresAuth, currentPath, intendedPath }: GuardInput): GuardDecision {
  if (status === 'loading') return { action: 'wait' };

  if (requiresAuth) {
    if (status === 'signed-in') return { action: 'render' };
    // Remember where they were headed so sign-in can send them back.
    return { action: 'redirect', to: SIGN_IN_PATH, from: currentPath };
  }

  // Sign-in and sign-up are pointless once signed in.
  if (status === 'signed-in') {
    return { action: 'redirect', to: isSafeInternalPath(intendedPath) ? intendedPath : CHAT_PATH };
  }
  return { action: 'render' };
}

export function isAuthPath(path: string): boolean {
  return path === SIGN_IN_PATH || path === '/signup';
}

/**
 * Only a single-slash in-app path may be used as a redirect target. "//host" is a
 * protocol-relative URL, so allowing it would send people off-site after signing in.
 */
export function isSafeInternalPath(path: string | undefined): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !isAuthPath(path);
}
