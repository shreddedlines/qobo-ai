import { apiBaseUrl } from '../config/env.ts';
import { createApiClient, type ApiClient } from './client.ts';

let client: ApiClient | undefined;
let accessTokenProvider: () => Promise<string | null> = async () => null;

/**
 * Registered by the auth provider so requests carry the current session token.
 * Called per request, so a token refreshed by supabase-js is picked up automatically.
 */
export function setAccessTokenProvider(provider: () => Promise<string | null>): void {
  accessTokenProvider = provider;
}

/**
 * Lazily built so a missing/invalid VITE_API_BASE_URL surfaces during render (where the
 * error boundary can show it) rather than as a blank page at import time.
 */
export function getApiClient(): ApiClient {
  client ??= createApiClient({ baseUrl: apiBaseUrl(), getAccessToken: () => accessTokenProvider() });
  return client;
}
