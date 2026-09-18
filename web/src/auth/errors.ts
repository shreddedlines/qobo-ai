import { isAuthApiError, isAuthRetryableFetchError, type AuthError } from '@supabase/supabase-js';

import type { AuthField } from './validation.ts';

export interface AuthFailure {
  /** Message shown in the error summary and, when `field` is set, under that input. */
  message: string;
  /** Attaches the message to a specific input so the fix is where the problem is. */
  field?: AuthField;
  /** True when the same credentials could work on a second attempt. */
  canRetry: boolean;
}

/**
 * Maps Supabase auth failures to copy people can act on, using the documented
 * error codes (@supabase/auth-js ErrorCode) rather than parsing messages.
 *
 * Sign-in failures stay deliberately vague about whether the email exists —
 * confirming that would leak which addresses have accounts.
 */
export function mapAuthError(error: unknown, mode: 'signin' | 'signup'): AuthFailure {
  if (isAuthRetryableFetchError(error)) {
    return { message: 'Could not reach QOBO. Check your internet connection and try again.', canRetry: true };
  }

  if (isAuthApiError(error)) {
    const code = error.code;

    switch (code) {
      case 'invalid_credentials':
        return { message: 'That email and password do not match an account.', canRetry: false };
      case 'email_not_confirmed':
        return { message: 'Confirm your email address first, then sign in.', field: 'email', canRetry: false };
      case 'email_exists':
      case 'user_already_exists':
        return { message: 'An account already exists for this email. Sign in instead.', field: 'email', canRetry: false };
      case 'email_address_invalid':
        return { message: 'Enter a valid email address.', field: 'email', canRetry: false };
      case 'email_address_not_authorized':
        return { message: 'This email address is not allowed to sign up.', field: 'email', canRetry: false };
      case 'weak_password':
        return { message: 'Choose a stronger password: at least 8 characters, including a letter and a number.', field: 'password', canRetry: false };
      case 'same_password':
        return { message: 'Choose a password you have not used here before.', field: 'password', canRetry: false };
      case 'validation_failed':
        return { message: 'Check the email address and password, then try again.', canRetry: false };
      case 'over_request_rate_limit':
      case 'over_email_send_rate_limit':
        return { message: 'Too many attempts. Wait a minute and try again.', canRetry: true };
      case 'signup_disabled':
      case 'email_provider_disabled':
        return { message: 'New accounts are closed right now. Contact the QOBO team for access.', canRetry: false };
      case 'user_banned':
        return { message: 'This account is blocked. Contact the QOBO team.', canRetry: false };
      case 'session_expired':
      case 'refresh_token_not_found':
      case 'refresh_token_already_used':
        return { message: 'Your session expired. Sign in again.', canRetry: true };
      case 'request_timeout':
        return { message: 'That took too long. Try again.', canRetry: true };
      case 'captcha_failed':
        return { message: 'The security check failed. Reload the page and try again.', canRetry: true };
      default:
        break;
    }

    if (error.status >= 500) {
      return { message: 'Sign-in is temporarily unavailable. Try again in a moment.', canRetry: true };
    }
    return {
      message: mode === 'signup' ? 'Could not create your account. Try again.' : 'Could not sign you in. Try again.',
      canRetry: true,
    };
  }

  return { message: 'Something went wrong. Try again.', canRetry: true };
}

/** True when Supabase created the account but no session (email confirmation is on). */
export function needsEmailConfirmation(result: { session: unknown | null; user: unknown | null }): boolean {
  return result.user !== null && result.session === null;
}

export function isAuthError(error: unknown): error is AuthError {
  return isAuthApiError(error) || isAuthRetryableFetchError(error);
}
