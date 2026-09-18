import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, DEV_API_BASE_URL, resolveApiBaseUrl, resolveSupabaseConfig } from '../src/config/env.ts';

describe('resolveApiBaseUrl', () => {
  it('uses the deployed origin when provided', () => {
    assert.equal(resolveApiBaseUrl({ VITE_API_BASE_URL: 'https://qobo-support-api.onrender.com' }), 'https://qobo-support-api.onrender.com');
  });

  it('normalizes trailing slashes and whitespace', () => {
    assert.equal(resolveApiBaseUrl({ VITE_API_BASE_URL: '  https://api.example.com/  ' }), 'https://api.example.com');
  });

  it('falls back to the local API in development only', () => {
    assert.equal(resolveApiBaseUrl({ DEV: true }), DEV_API_BASE_URL);
    assert.equal(resolveApiBaseUrl({ VITE_API_BASE_URL: '   ', DEV: true }), DEV_API_BASE_URL);
  });

  it('fails loudly in a production build when unset', () => {
    assert.throws(() => resolveApiBaseUrl({}), (error: Error) => error instanceof ConfigError && /VITE_API_BASE_URL is not set/.test(error.message));
  });

  it('rejects values that are not a plain http(s) origin', () => {
    for (const value of ['not a url', 'ftp://api.example.com', 'https://api.example.com/api', 'https://api.example.com/?x=1', 'https://api.example.com/#a']) {
      assert.throws(() => resolveApiBaseUrl({ VITE_API_BASE_URL: value }), ConfigError, value);
    }
  });
});

describe('resolveSupabaseConfig', () => {
  const valid = { VITE_SUPABASE_URL: 'https://project.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc123' };

  it('returns the origin and publishable key', () => {
    assert.deepEqual(resolveSupabaseConfig(valid), { url: 'https://project.supabase.co', publishableKey: 'sb_publishable_abc123' });
    assert.deepEqual(resolveSupabaseConfig({ ...valid, VITE_SUPABASE_URL: ' https://project.supabase.co/ ' }).url, 'https://project.supabase.co');
  });

  it('requires both values', () => {
    for (const env of [{}, { VITE_SUPABASE_URL: valid.VITE_SUPABASE_URL }, { VITE_SUPABASE_PUBLISHABLE_KEY: valid.VITE_SUPABASE_PUBLISHABLE_KEY }]) {
      assert.throws(() => resolveSupabaseConfig(env), (error: Error) => error instanceof ConfigError && /must be set/.test(error.message));
    }
  });

  it('refuses a secret key pasted into the browser build', () => {
    assert.throws(
      () => resolveSupabaseConfig({ ...valid, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_leaked' }),
      (error: Error) => error instanceof ConfigError && /secret keys must stay on the server/.test(error.message),
    );
  });

  it('rejects legacy or malformed keys and non-https URLs', () => {
    assert.throws(() => resolveSupabaseConfig({ ...valid, VITE_SUPABASE_PUBLISHABLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.legacy.anon' }), ConfigError);
    assert.throws(() => resolveSupabaseConfig({ ...valid, VITE_SUPABASE_URL: 'http://project.supabase.co' }), ConfigError);
    assert.throws(() => resolveSupabaseConfig({ ...valid, VITE_SUPABASE_URL: 'not a url' }), ConfigError);
    // http is allowed only for local development
    assert.equal(resolveSupabaseConfig({ ...valid, VITE_SUPABASE_URL: 'http://127.0.0.1:54321', DEV: true }).url, 'http://127.0.0.1:54321');
  });
});
