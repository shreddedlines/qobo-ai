import type { SupabaseClient } from '@supabase/supabase-js';

import { DatabaseError } from '../db/supabase.ts';

export interface QuotaResult {
  allowed: boolean;
  used: number;
  limit: number;
}

export interface UserMessageQuota {
  /** Atomically counts one chat message for today (UTC); `allowed: false` once the cap is reached. */
  consume(userId: string): Promise<QuotaResult>;
}

/**
 * Backed by private.usage_daily (consume_user_quota). The counter is independent of
 * conversations, so deleting chats does not reset it.
 */
export function createSupabaseUserMessageQuota(service: Pick<SupabaseClient, 'rpc'>, limit: number): UserMessageQuota {
  return {
    async consume(userId) {
      const { data, error } = await service.rpc('consume_user_quota', { p_user_id: userId, p_kind: 'message', p_limit: limit });
      if (error) throw new DatabaseError('consume user quota', error);
      const row = (data as Array<{ allowed: boolean; used: number; quota_limit: number }> | null)?.[0];
      if (!row) throw new DatabaseError('consume user quota', new Error('no quota row returned'));
      return { allowed: row.allowed, used: row.used, limit: row.quota_limit };
    },
  };
}

/** Start of the next UTC day, when daily quotas reset. */
export function nextUtcMidnight(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}
