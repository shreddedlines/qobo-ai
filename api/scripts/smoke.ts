/**
 * Production smoke test: verifies a deployed API over HTTPS.
 *
 *   npm run smoke -- https://qobo-support-api.onrender.com
 *
 * Unauthenticated checks need no credentials. The authenticated chat turn runs
 * when api/.env.smoke provides the DEPLOYED project's Supabase settings:
 *   SMOKE_SUPABASE_URL, SMOKE_SUPABASE_PUBLISHABLE_KEY, SMOKE_SUPABASE_SECRET_KEY
 * It creates a throwaway user, sends one small-talk message (cheapest real turn),
 * checks persistence and retry replay, then deletes the user and its data.
 */
import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name: string, run: () => Promise<string>): Promise<void> {
  try {
    record(name, true, await run());
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const baseUrl = (process.argv.slice(2).find((arg) => arg.startsWith('http')) ?? process.env.SMOKE_BASE_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Usage: npm run smoke -- https://your-api.onrender.com');
  const allowedOrigin = process.argv.slice(2).find((arg) => arg.startsWith('--origin='))?.slice('--origin='.length) ?? process.env.SMOKE_ALLOWED_ORIGIN;
  console.log(`Smoke testing ${baseUrl}\n`);

  // Render free instances sleep after 15 minutes idle and take about a minute to wake.
  await check('health (cold start allowed)', async () => {
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(120_000) });
    const body = (await response.json()) as { status?: string };
    expect(response.status === 200, `expected HTTP 200, got ${response.status}`);
    expect(body.status === 'ok', `expected status ok, got ${JSON.stringify(body)}`);
    return `${Date.now() - startedAt}ms`;
  });

  await check('deep health (database reachable)', async () => {
    const response = await fetch(`${baseUrl}/api/health?deep=1`, { signal: AbortSignal.timeout(30_000) });
    const body = (await response.json()) as { status?: string; database?: string };
    expect(response.status === 200 && body.database === 'ok', `got HTTP ${response.status} ${JSON.stringify(body)}`);
    return 'database ok';
  });

  await check('security headers and no framework fingerprint', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.headers.get('x-content-type-options') === 'nosniff', 'missing X-Content-Type-Options');
    expect(!response.headers.get('x-powered-by'), 'X-Powered-By is exposed');
    expect(response.headers.get('x-request-id'), 'missing X-Request-Id');
    return 'nosniff, no x-powered-by, request id present';
  });

  for (const [name, path, init] of [
    ['conversations', '/api/conversations', {}],
    ['chat', '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi', clientMessageId: randomUUID() }) }],
  ] as const) {
    await check(`${name} requires authentication`, async () => {
      const response = await fetch(`${baseUrl}${path}`, init as RequestInit);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(response.status === 401 && body.error?.code === 'unauthorized', `got HTTP ${response.status} ${JSON.stringify(body)}`);
      return '401 unauthorized';
    });
  }

  await check('unknown routes return JSON 404', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.status === 404 && body.error?.code === 'not_found', `got HTTP ${response.status}`);
    return '404 not_found';
  });

  if (allowedOrigin) {
    await check('CORS allows the configured origin and rejects others', async () => {
      const allowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: allowedOrigin } });
      expect(allowed.headers.get('access-control-allow-origin') === allowedOrigin, `configured origin not allowed (got ${allowed.headers.get('access-control-allow-origin')})`);
      const evil = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'https://evil.example.com' } });
      expect(!evil.headers.get('access-control-allow-origin'), 'unknown origin received CORS headers');
      return `${allowedOrigin} allowed, others rejected`;
    });
  } else {
    record('CORS origin allowlist', true, 'skipped (pass --origin=https://your-frontend to check)');
  }

  const supabaseUrl = process.env.SMOKE_SUPABASE_URL;
  const publishableKey = process.env.SMOKE_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SMOKE_SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !publishableKey || !secretKey) {
    record('authenticated chat turn', true, 'skipped (set SMOKE_SUPABASE_* in api/.env.smoke)');
  } else {
    const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
    const admin = createClient(supabaseUrl, secretKey, clientOptions);
    const email = `qobo-smoke+${randomUUID()}@example.com`;
    const password = `Smoke-${randomUUID()}`;
    let userId: string | undefined;

    try {
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error) throw created.error;
      userId = created.data.user.id;

      const userClient = createClient(supabaseUrl, publishableKey, clientOptions);
      const signIn = await userClient.auth.signInWithPassword({ email, password });
      if (signIn.error) throw signIn.error;
      const authHeaders = { Authorization: `Bearer ${signIn.data.session.access_token}`, 'Content-Type': 'application/json' };
      const clientMessageId = randomUUID();
      let conversationId = '';

      await check('authenticated chat turn (small talk, real models)', async () => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ message: 'hello!', clientMessageId }),
          signal: AbortSignal.timeout(90_000),
        });
        const body = (await response.json()) as { conversation?: { id: string }; assistantMessage?: { intent?: string; content?: string; status?: string }; replayed?: boolean };
        expect(response.status === 200, `got HTTP ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
        expect(body.replayed === false, 'expected a new exchange');
        expect(body.assistantMessage?.content, 'assistant reply is empty');
        conversationId = body.conversation!.id;
        return `intent=${body.assistantMessage?.intent} status=${body.assistantMessage?.status}`;
      });

      await check('conversation is saved and readable', async () => {
        const list = await fetch(`${baseUrl}/api/conversations`, { headers: authHeaders });
        const listBody = (await list.json()) as { conversations: Array<{ id: string }> };
        expect(listBody.conversations.some((c) => c.id === conversationId), 'new conversation missing from the list');

        const messages = await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, { headers: authHeaders });
        const messagesBody = (await messages.json()) as { messages: Array<{ role: string }> };
        expect(messages.status === 200, `messages returned HTTP ${messages.status}`);
        expect(messagesBody.messages.length === 2, `expected 2 messages, got ${messagesBody.messages.length}`);
        return 'listed and readable';
      });

      await check('retrying the same clientMessageId replays', async () => {
        const response = await fetch(`${baseUrl}/api/chat`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ message: 'hello!', clientMessageId }), signal: AbortSignal.timeout(60_000) });
        const body = (await response.json()) as { replayed?: boolean };
        expect(response.status === 200 && body.replayed === true, `got HTTP ${response.status} replayed=${body.replayed}`);
        return 'replayed without a new reply';
      });

      await check('conversation can be deleted', async () => {
        const response = await fetch(`${baseUrl}/api/conversations/${conversationId}`, { method: 'DELETE', headers: authHeaders });
        expect(response.status === 204, `got HTTP ${response.status}`);
        return '204';
      });
    } finally {
      if (userId) {
        const { error } = await admin.auth.admin.deleteUser(userId);
        record('smoke user cleaned up', !error, error ? error.message : 'deleted');
      }
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`Failed: ${failed.map((f) => f.name).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
