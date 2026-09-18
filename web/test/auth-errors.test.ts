import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';

import { mapAuthError, needsEmailConfirmation } from '../src/auth/errors.ts';

const apiError = (code: string, status = 400) => new AuthApiError('server text', status, code);

describe('mapAuthError', () => {
  it('keeps sign-in failures vague about whether the account exists', () => {
    const failure = mapAuthError(apiError('invalid_credentials', 400), 'signin');
    assert.equal(failure.message, 'That email and password do not match an account.');
    assert.equal(failure.field, undefined, 'must not point at the email field, which would confirm the address');
    assert.equal(failure.canRetry, false);
  });

  it('attaches the message to the field that needs fixing', () => {
    assert.equal(mapAuthError(apiError('email_exists', 422), 'signup').field, 'email');
    assert.equal(mapAuthError(apiError('user_already_exists', 422), 'signup').field, 'email');
    assert.equal(mapAuthError(apiError('email_address_invalid', 400), 'signup').field, 'email');
    assert.equal(mapAuthError(apiError('weak_password', 422), 'signup').field, 'password');
    assert.equal(mapAuthError(apiError('email_not_confirmed', 400), 'signin').field, 'email');
  });

  it('tells people to sign in when the account already exists', () => {
    assert.match(mapAuthError(apiError('email_exists', 422), 'signup').message, /Sign in instead/);
  });

  it('marks transient failures as retryable and permanent ones as not', () => {
    for (const code of ['over_request_rate_limit', 'over_email_send_rate_limit', 'request_timeout', 'session_expired', 'captcha_failed']) {
      assert.equal(mapAuthError(apiError(code, 429), 'signin').canRetry, true, code);
    }
    for (const code of ['invalid_credentials', 'weak_password', 'signup_disabled', 'user_banned', 'email_exists']) {
      assert.equal(mapAuthError(apiError(code, 400), 'signup').canRetry, false, code);
    }
  });

  it('handles a lost connection and server faults', () => {
    const offline = mapAuthError(new AuthRetryableFetchError('fetch failed', 0), 'signin');
    assert.match(offline.message, /internet connection/);
    assert.equal(offline.canRetry, true);

    const serverFault = mapAuthError(apiError('unexpected_failure', 500), 'signin');
    assert.match(serverFault.message, /temporarily unavailable/);
    assert.equal(serverFault.canRetry, true);
  });

  it('falls back per mode for unknown codes and non-auth errors', () => {
    assert.match(mapAuthError(apiError('some_new_code', 400), 'signup').message, /create your account/);
    assert.match(mapAuthError(apiError('some_new_code', 400), 'signin').message, /sign you in/);
    assert.match(mapAuthError(new TypeError('boom'), 'signin').message, /Something went wrong/);
  });

  it('never leaks raw server text or codes to the user', () => {
    for (const code of ['invalid_credentials', 'weak_password', 'over_request_rate_limit', 'unexpected_failure', 'made_up']) {
      const { message } = mapAuthError(apiError(code, 400), 'signin');
      assert.ok(!message.includes('server text') && !message.includes('_'), `${code}: "${message}"`);
    }
  });
});

describe('needsEmailConfirmation', () => {
  it('is true only when a user was created without a session', () => {
    assert.equal(needsEmailConfirmation({ user: { id: 'u1' }, session: null }), true);
    assert.equal(needsEmailConfirmation({ user: { id: 'u1' }, session: { access_token: 'a' } }), false);
    assert.equal(needsEmailConfirmation({ user: null, session: null }), false);
  });
});
