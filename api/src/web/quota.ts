import type { SupabaseClient } from '@supabase/supabase-js';

export interface DailyQuota {
  /** Atomically counts one unit; false when today's limit is already reached. Throws if the check itself fails. */
  consume(): Promise<boolean>;
}

/** App-wide daily cap (private.usage_global_daily via consume_global_quota, service role only). */
export function createSupabaseGlobalQuota(service: Pick<SupabaseClient, 'rpc'>, kind: 'web_search', limit: number): DailyQuota {
  return {
    async consume() {
      const { data, error } = await service.rpc('consume_global_quota', { p_kind: kind, p_limit: limit });
      if (error) throw new Error(`consume_global_quota failed: ${error.message}`, { cause: error });
      const row = (data as Array<{ allowed: boolean }> | null)?.[0];
      return row?.allowed === true;
    },
  };
}
