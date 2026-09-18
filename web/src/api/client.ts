import { ApiError, API_ERROR_CODES, type ApiErrorCode } from './errors.ts';
import type {
  ConversationListResponse,
  ConversationMessagesResponse,
  ConversationSummary,
  HealthResponse,
  SendMessageRequest,
  SendMessageResponse,
} from './types.ts';

export interface ApiClientOptions {
  /** Absolute API origin, e.g. https://qobo-support-api.onrender.com (no trailing slash). */
  baseUrl: string;
  /** Returns the current Supabase access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Default per-request timeout. A chat turn is allowed longer (see sendMessage). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

interface RequestConfig extends RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** Health checks are public; everything else needs a token. */
  authenticated?: boolean;
}

export interface ApiClient {
  health(options?: RequestOptions & { deep?: boolean }): Promise<HealthResponse>;
  listConversations(params?: { limit?: number; before?: string }, options?: RequestOptions): Promise<ConversationListResponse>;
  getConversationMessages(conversationId: string, options?: RequestOptions): Promise<ConversationMessagesResponse>;
  deleteConversation(conversationId: string, options?: RequestOptions): Promise<void>;
  /** Changes a conversation's title. Returns the conversation as it is now stored. */
  renameConversation(conversationId: string, title: string, options?: RequestOptions): Promise<ConversationSummary>;
  sendMessage(request: SendMessageRequest, options?: RequestOptions): Promise<SendMessageResponse>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** The API's own chat timeout is 45s; allow a little more before giving up locally. */
export const CHAT_TIMEOUT_MS = 50_000;

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

/** Maps an HTTP status to a code when the body is missing or malformed. */
function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'service_unavailable';
  if (status === 504) return 'timeout';
  if (status >= 500) return 'internal_error';
  return 'bad_request';
}

export function createApiClient({ baseUrl, getAccessToken, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }: ApiClientOptions): ApiClient {
  const origin = baseUrl.replace(/\/+$/, '');

  async function request<T>(config: RequestConfig): Promise<T | undefined> {
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (config.authenticated !== false) {
      const token = await getAccessToken();
      if (!token) {
        throw new ApiError({ status: 401, code: 'unauthorized', message: 'Not signed in' });
      }
      headers.Authorization = `Bearer ${token}`;
    }
    if (config.body !== undefined) headers['Content-Type'] = 'application/json';

    // Combine the caller's signal (e.g. a Stop button) with the timeout.
    const timeout = AbortSignal.timeout(config.timeoutMs ?? timeoutMs);
    const signal = config.signal ? AbortSignal.any([config.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetchImpl(`${origin}${config.path}`, {
        method: config.method,
        headers,
        body: config.body === undefined ? undefined : JSON.stringify(config.body),
        signal,
        credentials: 'omit',
      });
    } catch (error) {
      // A caller-triggered abort is not an error the user needs to see.
      if (config.signal?.aborted) throw error;
      const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ApiError({
        status: 0,
        code: timedOut ? 'timeout' : 'network',
        message: timedOut ? 'The request timed out' : 'The request could not be sent',
        cause: error,
      });
    }

    const requestId = response.headers.get('X-Request-Id');

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined;
      const code = isApiErrorCode(body?.error?.code) ? body.error.code : codeForStatus(response.status);
      const message = typeof body?.error?.message === 'string' ? body.error.message : `Request failed with HTTP ${response.status}`;
      throw new ApiError({ status: response.status, code, message, details: body?.error?.details, requestId });
    }

    if (response.status === 204) return undefined;

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new ApiError({ status: response.status, code: 'internal_error', message: 'The API returned an unreadable response', requestId, cause: error });
    }
  }

  return {
    async health(options = {}) {
      const query = options.deep ? '?deep=1' : '';
      return (await request<HealthResponse>({ method: 'GET', path: `/api/health${query}`, authenticated: false, ...options }))!;
    },

    async listConversations(params = {}, options = {}) {
      const query = new URLSearchParams();
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      if (params.before) query.set('before', params.before);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return (await request<ConversationListResponse>({ method: 'GET', path: `/api/conversations${suffix}`, ...options }))!;
    },

    async getConversationMessages(conversationId, options = {}) {
      return (await request<ConversationMessagesResponse>({
        method: 'GET',
        path: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        ...options,
      }))!;
    },

    async renameConversation(conversationId, title, options = {}) {
      return (await request<ConversationSummary>({
        method: 'PATCH',
        path: `/api/conversations/${encodeURIComponent(conversationId)}`,
        body: { title },
        ...options,
      }))!;
    },

    async deleteConversation(conversationId, options = {}) {
      await request<void>({ method: 'DELETE', path: `/api/conversations/${encodeURIComponent(conversationId)}`, ...options });
    },

    async sendMessage(payload, options = {}) {
      return (await request<SendMessageResponse>({
        method: 'POST',
        path: '/api/chat',
        body: payload,
        timeoutMs: CHAT_TIMEOUT_MS,
        ...options,
      }))!;
    },
  };
}
