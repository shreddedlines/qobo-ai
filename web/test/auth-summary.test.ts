import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSummaryItems } from '../src/auth/summary.ts';

const failure = (message: string, field?: 'email' | 'password') => ({ message, canRetry: false, ...(field ? { field } : {}) });

describe('buildSummaryItems', () => {
  it('stays closed until a submit has failed, so the form does not shift while typing', () => {
    assert.deepEqual(buildSummaryItems({ fieldErrors: { email: 'Enter your email address.' }, formFailure: null, showSummary: false }), []);
  });

  it('lists every field problem in form order once a submit has failed', () => {
    assert.deepEqual(
      buildSummaryItems({ fieldErrors: { password: 'Choose a password.', email: 'Enter your email address.' }, formFailure: null, showSummary: true }),
      [
        { field: 'email', message: 'Enter your email address.' },
        { field: 'password', message: 'Choose a password.' },
      ],
    );
  });

  it('adds a form-level failure that belongs to no field', () => {
    assert.deepEqual(buildSummaryItems({ fieldErrors: {}, formFailure: failure('That email and password do not match an account.'), showSummary: true }), [
      { message: 'That email and password do not match an account.' },
    ]);
  });

  it('does not repeat a failure that is already attached to a field', () => {
    assert.deepEqual(
      buildSummaryItems({ fieldErrors: { email: 'That email already has an account. Sign in instead.' }, formFailure: failure('That email already has an account. Sign in instead.', 'email'), showSummary: true }),
      [{ field: 'email', message: 'That email already has an account. Sign in instead.' }],
    );
  });

  it('is empty when there is nothing wrong', () => {
    assert.deepEqual(buildSummaryItems({ fieldErrors: {}, formFailure: null, showSummary: true }), []);
  });
});
