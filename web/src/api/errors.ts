/**
 * API error handling and the user-facing copy for each failure.
 *
 * Copy rules (frontend-design skill): say what happened and what to do next, in the
 * product's voice. No apologies, no vague "something went wrong" where we know more,
 * and the same words for the same failure everywhere.
 */
export const API_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'not_found',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'quota_exceeded',
  'service_unavailable',
  'timeout',
  'upstream_error',
  'internal_error',
  // Client-side only: the request never reached the API.
  'network',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface QuotaDetails {
  limit: number;
  used: number;
  resetsAt: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(options: { status: number; code: ApiErrorCode; message: string; details?: unknown; requestId?: string | null; cause?: unknown }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId ?? null;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** True for a code the API is allowed to send, so an unknown one cannot slip into the UI. */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

/** The code to assume when the body is missing or unreadable. */
export function apiErrorCodeForStatus(status: number): ApiErrorCode {
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

/** True when sending the same request again could reasonably succeed. */
export function isRetryable(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return (
    error.code === 'network' ||
    error.code === 'timeout' ||
    error.code === 'service_unavailable' ||
    error.code === 'upstream_error' ||
    error.code === 'internal_error'
  );
}

/** True when the user must sign in again. */
export function isAuthExpired(error: unknown): boolean {
  return isApiError(error) && error.code === 'unauthorized';
}

export function isQuotaDetails(details: unknown): details is QuotaDetails {
  if (typeof details !== 'object' || details === null) return false;
  const value = details as Partial<QuotaDetails>;
  return typeof value.limit === 'number' && typeof value.used === 'number' && typeof value.resetsAt === 'string';
}

/** Local time of a quota reset, e.g. "5:30 AM". Falls back to "tomorrow" if unparseable. */
export function formatResetTime(isoTimestamp: string, locale?: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return 'tomorrow';
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
}

export interface UserFacingError {
  title: string;
  detail: string;
  /** Whether the UI should offer a retry action. */
  canRetry: boolean;
}

/** Maps any thrown value to the message shown to the user. */
export function toUserFacingError(error: unknown, locale?: string): UserFacingError {
  if (!isApiError(error)) {
    return { title: 'Something went wrong', detail: 'Reload the page and try again.', canRetry: true };
  }

  switch (error.code) {
    case 'network':
      return { title: 'No connection to QOBO', detail: 'Check your internet connection and try again.', canRetry: true };
    case 'timeout':
      return { title: 'QOBO took too long to reply', detail: 'Send your message again.', canRetry: true };
    case 'service_unavailable':
      return { title: 'QOBO is busy right now', detail: 'Wait a few seconds and try again.', canRetry: true };
    case 'rate_limited':
      return { title: 'Too many messages', detail: 'Wait a few seconds before sending another one.', canRetry: true };
    case 'quota_exceeded': {
      const detail = isQuotaDetails(error.details)
        ? `You've used all ${error.details.limit} messages for today. Your limit resets at ${formatResetTime(error.details.resetsAt, locale)}.`
        : "You've reached today's message limit. It resets tomorrow.";
      return { title: 'Daily message limit reached', detail, canRetry: false };
    }
    case 'unauthorized':
      return { title: 'Your session expired', detail: 'Sign in again to continue.', canRetry: false };
    case 'not_found':
      return { title: 'Conversation not found', detail: 'It may have been deleted. Start a new chat.', canRetry: false };
    case 'conflict':
      return { title: 'Message already sent', detail: 'Reload the conversation to see the reply.', canRetry: false };
    case 'payload_too_large':
      return { title: 'Message too long', detail: 'Shorten your message and send it again.', canRetry: false };
    case 'bad_request':
      return { title: "QOBO couldn't read that message", detail: 'Edit your message and send it again.', canRetry: false };
    case 'upstream_error':
    case 'internal_error':
      return { title: 'Something went wrong', detail: 'Try again in a moment.', canRetry: true };
  }
}
