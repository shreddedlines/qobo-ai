import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Env } from '../config/env.ts';

type SupabaseEnv = Pick<Env, 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY' | 'SUPABASE_SECRET_KEY'>;

const serverAuthOptions = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

/** Secret-key client (`service_role`, bypasses RLS). Only for backend-only functions. */
export function createServiceClient(env: SupabaseEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: serverAuthOptions });
}

/** Publishable-key client used for token verification (JWKS lookups). */
export function createAuthClient(env: SupabaseEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, { auth: serverAuthOptions });
}

/** Client acting as the signed-in user, so Row Level Security applies to every query. */
export function createUserClient(env: SupabaseEnv, accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: serverAuthOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export class DatabaseError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Database operation failed: ${operation}`, { cause });
    this.name = 'DatabaseError';
  }
}
