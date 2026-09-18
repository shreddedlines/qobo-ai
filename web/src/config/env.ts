/**
 * Frontend configuration. The API origin is injected at build time as
 * VITE_API_BASE_URL (the deployed Render URL in production).
 */
export interface RuntimeEnv {
  VITE_API_BASE_URL?: string | undefined;
  VITE_SUPABASE_URL?: string | undefined;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string | undefined;
  DEV?: boolean | undefined;
}

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEV_API_BASE_URL = 'http://localhost:8080';

/**
 * Validates and normalizes the API origin. In development an unset value falls back
 * to the local API; in a production build it is required, so a misconfigured deploy
 * fails loudly instead of sending requests to the wrong place.
 */
export function resolveApiBaseUrl(env: RuntimeEnv): string {
  const raw = env.VITE_API_BASE_URL?.trim();

  if (!raw) {
    if (env.DEV) return DEV_API_BASE_URL;
    throw new ConfigError('VITE_API_BASE_URL is not set. Set it to the deployed API origin, e.g. https://qobo-support-api.onrender.com');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`VITE_API_BASE_URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`VITE_API_BASE_URL must use http or https, got "${url.protocol}"`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError(`VITE_API_BASE_URL must be an origin without a path, got "${raw}"`);
  }
  return url.origin;
}

export function apiBaseUrl(): string {
  return resolveApiBaseUrl(import.meta.env as RuntimeEnv);
}

/**
 * Supabase settings for sign-in and sign-up. The publishable key is designed to ship
 * in a browser; the secret key must never appear here, so a pasted secret is rejected.
 */
export function resolveSupabaseConfig(env: RuntimeEnv): SupabaseConfig {
  const rawUrl = env.VITE_SUPABASE_URL?.trim();
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!rawUrl || !key) {
    throw new ConfigError('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set so people can sign in.');
  }
  if (key.startsWith('sb_secret_')) {
    throw new ConfigError('VITE_SUPABASE_PUBLISHABLE_KEY holds a secret key. Use the publishable key (sb_publishable_…); secret keys must stay on the server.');
  }
  if (!key.startsWith('sb_publishable_')) {
    throw new ConfigError('VITE_SUPABASE_PUBLISHABLE_KEY must be a publishable key (sb_publishable_…).');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError(`VITE_SUPABASE_URL is not a valid URL: "${rawUrl}"`);
  }
  if (url.protocol !== 'https:' && !(env.DEV && url.protocol === 'http:')) {
    throw new ConfigError('VITE_SUPABASE_URL must use https.');
  }
  return { url: url.origin, publishableKey: key };
}

export function supabaseConfig(): SupabaseConfig {
  return resolveSupabaseConfig(import.meta.env as RuntimeEnv);
}
