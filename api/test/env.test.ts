import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnvValidationError, loadEnv } from '../src/config/env.ts';
import { validEnvSource } from './helpers/env.ts';

describe('loadEnv', () => {
  it('applies defaults for optional settings', () => {
    const env = loadEnv(validEnvSource);
    assert.equal(env.PORT, 8080);
    assert.equal(env.GEMINI_ROUTER_MODEL, 'gemini-3.1-flash-lite');
    assert.equal(env.GEMINI_ANSWER_MODEL, 'gemini-3.7-flash');
    assert.equal(env.GEMINI_EMBEDDING_MODEL, 'gemini-embedding-2');
    assert.equal(env.USER_DAILY_MESSAGE_CAP, 50);
    assert.deepEqual(env.CORS_ORIGINS, []);
    assert.equal(env.TRUST_PROXY_HOPS, 0);
  });

  it('parses comma-separated CORS origins and numeric strings', () => {
    const env = loadEnv({ ...validEnvSource, CORS_ORIGINS: 'http://localhost:5173, https://qobo-chat.vercel.app', PORT: '3000' });
    assert.deepEqual(env.CORS_ORIGINS, ['http://localhost:5173', 'https://qobo-chat.vercel.app']);
    assert.equal(env.PORT, 3000);
  });

  it('reports every missing required variable', () => {
    const error = captureError(() => loadEnv({}));
    const failedVars = new Set(error.issues.map((issue) => issue.split(':')[0]));
    for (const name of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'GEMINI_API_KEY', 'TAVILY_API_KEY']) {
      assert.ok(failedVars.has(name), `expected an issue for ${name}`);
    }
  });

  it('rejects legacy JWT-style Supabase keys', () => {
    const error = captureError(() => loadEnv({ ...validEnvSource, SUPABASE_SECRET_KEY: 'eyJhbGciOiJIUzI1NiJ9.legacy.service_role' }));
    assert.match(error.issues.join(), /SUPABASE_SECRET_KEY/);
  });

  it('never echoes secret values in the error message', () => {
    const leakedSecret = 'eyJhbGciOiJIUzI1NiJ9.super-secret-value';
    const error = captureError(() => loadEnv({ ...validEnvSource, SUPABASE_SECRET_KEY: leakedSecret }));
    assert.ok(!error.message.includes(leakedSecret));
  });

  it('requires CORS origins in production', () => {
    const error = captureError(() => loadEnv({ ...validEnvSource, NODE_ENV: 'production' }));
    assert.match(error.issues.join(), /CORS_ORIGINS/);
  });

  it('rejects origins with paths or trailing slashes', () => {
    const error = captureError(() => loadEnv({ ...validEnvSource, CORS_ORIGINS: 'https://app.example.com/' }));
    assert.match(error.issues.join(), /invalid origin/);
  });
});

function captureError(fn: () => unknown): EnvValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected loadEnv to throw');
}
