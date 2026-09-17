import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const url = process.env.SUPABASE_URL;
export const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
export const secretKey = process.env.SUPABASE_SECRET_KEY;

if (process.env.ALLOW_DESTRUCTIVE_TESTS !== 'true' || !url || !publishableKey || !secretKey) {
  throw new Error(
    'Hosted tests need SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY and ALLOW_DESTRUCTIVE_TESTS=true (dev project only). See .env.test.example.',
  );
}

export const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
export const service = createClient(url, secretKey, clientOptions);

export interface TestUser {
  id: string;
  client: SupabaseClient;
  accessToken: string;
}

const createdUserIds: string[] = [];

/** Creates a confirmed throwaway user and signs in through the publishable key, like a browser. */
export async function createSignedInUser(): Promise<TestUser> {
  const email = `qobo-hosted-test+${randomUUID()}@example.com`;
  const password = `Test-${randomUUID()}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  createdUserIds.push(data.user.id);

  const client = createClient(url!, publishableKey!, clientOptions);
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return { id: data.user.id, client, accessToken: signIn.data.session.access_token };
}

/** Deletes every user created by this process (their data cascades). */
export async function deleteCreatedUsers(): Promise<void> {
  for (const id of createdUserIds.splice(0)) {
    await service.auth.admin.deleteUser(id);
  }
}

export async function appendExchange(userId: string, conversationId: string | null = null, title = 'Hosted test'): Promise<string> {
  const { data, error } = await service.rpc('append_exchange', {
    p_user_id: userId,
    p_conversation_id: conversationId,
    p_client_message_id: randomUUID(),
    p_title: title,
    p_user_content: 'What does QOBO do?',
    p_assistant_content: 'Test answer',
    p_intent: 'qobo',
    p_sources: [{ title: 'QOBO', url: 'https://qobo.dev/', kind: 'qobo' }],
    p_metadata: {},
  });
  if (error) throw error;
  return (data as { conversation_id: string }).conversation_id;
}
