import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { setAccessTokenProvider } from '../api/instance.ts';
import { getSupabase } from './client.ts';
import { mapAuthError, needsEmailConfirmation, type AuthFailure } from './errors.ts';
import type { AuthStatus } from './guards.ts';
import type { AuthFormValues } from './validation.ts';

export interface AuthUser {
  id: string;
  email: string | null;
}

export type AuthResult = { ok: true; needsConfirmation?: boolean } | { ok: false; failure: AuthFailure };

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  signIn(values: AuthFormValues): Promise<AuthResult>;
  signUp(values: AuthFormValues): Promise<AuthResult>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const supabase = getSupabase();

    // Requests always ask for the current token, so refreshes are picked up.
    setAccessTokenProvider(async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    });

    let active = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        setUser(data.session ? { id: data.session.user.id, email: data.session.user.email ?? null } : null);
        setStatus(data.session ? 'signed-in' : 'signed-out');
      })
      .catch(() => {
        if (active) setStatus('signed-out');
      });

    // Covers sign-in, sign-out, token refresh and changes made in another tab.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session ? { id: session.user.id, email: session.user.email ?? null } : null);
      setStatus(session ? 'signed-in' : 'signed-out');
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async ({ email, password }: AuthFormValues): Promise<AuthResult> => {
    const { error } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password });
    if (error) return { ok: false, failure: mapAuthError(error, 'signin') };
    return { ok: true };
  }, []);

  const signUp = useCallback(async ({ email, password }: AuthFormValues): Promise<AuthResult> => {
    const { data, error } = await getSupabase().auth.signUp({ email: email.trim(), password });
    if (error) return { ok: false, failure: mapAuthError(error, 'signup') };
    return { ok: true, needsConfirmation: needsEmailConfirmation(data) };
  }, []);

  const signOut = useCallback(async () => {
    await getSupabase().auth.signOut();
    setUser(null);
    setStatus('signed-out');
  }, []);

  const value = useMemo<AuthContextValue>(() => ({ status, user, signIn, signUp, signOut }), [status, user, signIn, signUp, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
