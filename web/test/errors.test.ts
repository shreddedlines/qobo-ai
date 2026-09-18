import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError, API_ERROR_CODES, formatResetTime, isAuthExpired, isQuotaDetails, isRetryable, toUserFacingError } from '../src/api/errors.ts';

const error = (code: (typeof API_ERROR_CODES)[number], status = 400, details?: unknown) => new ApiError({ status, code, message: 'server text', details });

describe('toUserFacingError', () => {
  it('has copy for every API error code', () => {
    for (const code of API_ERROR_CODES) {
      const result = toUserFacingError(error(code));
      assert.ok(result.title.length > 0 && result.detail.length > 0, code);
      assert.ok(!/error \d|HTTP \d|undefined/i.test(`${result.title} ${result.detail}`), `${code} leaks technical detail`);
    }
  });

  it('explains the daily limit with the real numbers and reset time', () => {
    const result = toUserFacingError(error('quota_exceeded', 429, { limit: 50, used: 50, resetsAt: '2026-09-19T00:00:00.000Z' }), 'en-US');
    assert.equal(result.title, 'Daily message limit reached');
    assert.match(result.detail, /all 50 messages for today/);
    assert.match(result.detail, /resets at \d{1,2}:\d{2}/);
    assert.equal(result.canRetry, false);
  });

  it('degrades gracefully when quota details are missing or malformed', () => {
    const result = toUserFacingError(error('quota_exceeded', 429, { limit: 'lots' }));
    assert.match(result.detail, /resets tomorrow/);
  });

  it('offers retry only for transient failures', () => {
    for (const code of ['network', 'timeout', 'service_unavailable', 'rate_limited', 'internal_error'] as const) {
      assert.equal(toUserFacingError(error(code)).canRetry, true, code);
    }
    for (const code of ['unauthorized', 'not_found', 'conflict', 'payload_too_large', 'bad_request', 'quota_exceeded'] as const) {
      assert.equal(toUserFacingError(error(code)).canRetry, false, code);
    }
  });

  it('handles values that are not ApiErrors', () => {
    assert.deepEqual(toUserFacingError(new TypeError('boom')), { title: 'Something went wrong', detail: 'Reload the page and try again.', canRetry: true });
  });
});

describe('error classification', () => {
  it('marks only sensible codes as retryable', () => {
    assert.equal(isRetryable(error('network')), true);
    assert.equal(isRetryable(error('timeout')), true);
    assert.equal(isRetryable(error('service_unavailable')), true);
    assert.equal(isRetryable(error('quota_exceeded')), false);
    assert.equal(isRetryable(new Error('other')), false);
  });

  it('detects an expired session', () => {
    assert.equal(isAuthExpired(error('unauthorized', 401)), true);
    assert.equal(isAuthExpired(error('not_found', 404)), false);
  });

  it('validates quota details', () => {
    assert.equal(isQuotaDetails({ limit: 50, used: 3, resetsAt: '2026-09-19T00:00:00.000Z' }), true);
    assert.equal(isQuotaDetails({ limit: 50 }), false);
    assert.equal(isQuotaDetails(null), false);
  });
});

describe('formatResetTime', () => {
  it('formats a timestamp as a local time', () => {
    assert.match(formatResetTime('2026-09-19T00:00:00.000Z', 'en-US'), /^\d{1,2}:\d{2}(\s?[AP]M)?$/);
  });

  it('falls back when the timestamp is unusable', () => {
    assert.equal(formatResetTime('never'), 'tomorrow');
  });
});
