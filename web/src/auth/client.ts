import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { supabaseConfig } from '../config/env.ts';

let client: SupabaseClient | undefined;

/**
 * Supabase is used for authentication only — never for reading or writing chat data,
 * which always goes through our API. The session is persisted and refreshed by
 * supabase-js; `detectSessionInUrl` is off because we use no OAuth redirects.
 */
export function getSupabase(): SupabaseClient {
  client ??= createClient(supabaseConfig().url, supabaseConfig().publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'qobo-support-auth' },
  });
  return client;
}
