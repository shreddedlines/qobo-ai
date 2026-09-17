import { loadEnv, type Env } from '../../src/config/env.ts';

/** A complete, valid environment using obviously fake credentials. */
export const validEnvSource: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_000',
  SUPABASE_SECRET_KEY: 'sb_secret_test_000',
  GEMINI_API_KEY: 'test-gemini-key',
  TAVILY_API_KEY: 'test-tavily-key',
};

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ ...validEnvSource, ...overrides });
}
