import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FIELD_ORDER,
  hasErrors,
  PASSWORD_MIN_LENGTH,
  toSummaryItems,
  validateAuthForm,
  validateEmail,
  validateExistingPassword,
  validateNewPassword,
} from '../src/auth/validation.ts';

describe('email validation', () => {
  it('accepts ordinary addresses, ignoring surrounding spaces', () => {
    for (const email of ['user@example.com', ' owner@qobo.dev ', 'first.last+tag@sub.example.co.in']) {
      assert.equal(validateEmail(email), undefined, email);
    }
  });

  it('explains what to enter when it is missing or malformed', () => {
    assert.equal(validateEmail('   '), 'Enter your email address.');
    for (const email of ['user', 'user@', '@example.com', 'user@example', 'two words@example.com', 'user@exa mple.com']) {
      assert.match(validateEmail(email) ?? '', /name@example\.com/, email);
    }
  });

  it('rejects an absurdly long address', () => {
    assert.match(validateEmail(`${'a'.repeat(250)}@example.com`) ?? '', /too long/);
  });
});

describe('password validation', () => {
  it('requires length plus a letter and a number for new passwords', () => {
    assert.equal(validateNewPassword('qobo1234'), undefined);
    assert.equal(validateNewPassword(''), 'Choose a password.');
    assert.match(validateNewPassword('short1') ?? '', new RegExp(`at least ${PASSWORD_MIN_LENGTH} characters`));
    assert.match(validateNewPassword('allletters') ?? '', /letter and one number/);
    assert.match(validateNewPassword('12345678') ?? '', /letter and one number/);
  });

  it('only requires a value when signing in to an existing account', () => {
    assert.equal(validateExistingPassword('x'), undefined, 'existing passwords may predate the current rules');
    assert.equal(validateExistingPassword(''), 'Enter your password.');
  });
});

describe('form validation', () => {
  it('passes a valid sign-up and a valid sign-in', () => {
    assert.deepEqual(validateAuthForm({ email: 'user@example.com', password: 'qobo1234' }, 'signup'), {});
    assert.deepEqual(validateAuthForm({ email: 'user@example.com', password: 'anything' }, 'signin'), {});
  });

  it('applies the stricter password rule only to sign-up', () => {
    const values = { email: 'user@example.com', password: 'weak' };
    assert.ok(validateAuthForm(values, 'signup').password, 'sign-up should reject a weak password');
    assert.equal(validateAuthForm(values, 'signin').password, undefined);
  });

  it('reports every problem at once, in form order', () => {
    const errors = validateAuthForm({ email: 'nope', password: '' }, 'signup');
    assert.equal(hasErrors(errors), true);
    assert.deepEqual(
      toSummaryItems(errors).map((item) => item.field),
      ['email', 'password'],
    );
    assert.deepEqual([...FIELD_ORDER], ['email', 'password']);
  });

  it('produces no summary items for a clean form', () => {
    assert.equal(hasErrors({}), false);
    assert.deepEqual(toSummaryItems({}), []);
  });
});
