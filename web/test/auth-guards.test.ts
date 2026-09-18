import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHAT_PATH, guardDecision, isAuthPath, SIGN_IN_PATH } from '../src/auth/guards.ts';

describe('protected routes', () => {
  it('renders for a signed-in visitor', () => {
    assert.deepEqual(guardDecision({ status: 'signed-in', requiresAuth: true, currentPath: '/chat' }), { action: 'render' });
  });

  it('waits while the stored session is read, instead of redirecting', () => {
    assert.deepEqual(guardDecision({ status: 'loading', requiresAuth: true, currentPath: '/chat' }), { action: 'wait' });
  });

  it('sends a signed-out visitor to sign-in and remembers where they were going', () => {
    assert.deepEqual(guardDecision({ status: 'signed-out', requiresAuth: true, currentPath: '/chat/abc?x=1' }), {
      action: 'redirect',
      to: SIGN_IN_PATH,
      from: '/chat/abc?x=1',
    });
  });
});

describe('auth routes', () => {
  it('renders sign-in and sign-up for a signed-out visitor', () => {
    assert.deepEqual(guardDecision({ status: 'signed-out', requiresAuth: false, currentPath: '/login' }), { action: 'render' });
    assert.deepEqual(guardDecision({ status: 'signed-out', requiresAuth: false, currentPath: '/signup' }), { action: 'render' });
  });

  it('waits before deciding, so the form does not flash for a signed-in visitor', () => {
    assert.deepEqual(guardDecision({ status: 'loading', requiresAuth: false, currentPath: '/login' }), { action: 'wait' });
  });

  it('sends a signed-in visitor to chat', () => {
    assert.deepEqual(guardDecision({ status: 'signed-in', requiresAuth: false, currentPath: '/login' }), { action: 'redirect', to: CHAT_PATH });
  });

  it('returns a signed-in visitor to the page they originally wanted', () => {
    assert.deepEqual(guardDecision({ status: 'signed-in', requiresAuth: false, currentPath: '/login', intendedPath: '/chat/abc' }), {
      action: 'redirect',
      to: '/chat/abc',
    });
  });

  it('ignores an intended path that is unsafe or would loop', () => {
    for (const intendedPath of ['https://evil.example.com', '//evil.example.com', 'javascript:alert(1)', '/login', '/signup']) {
      assert.deepEqual(
        guardDecision({ status: 'signed-in', requiresAuth: false, currentPath: '/login', intendedPath }),
        { action: 'redirect', to: CHAT_PATH },
        intendedPath,
      );
    }
  });
});

describe('isAuthPath', () => {
  it('recognizes the auth screens', () => {
    assert.equal(isAuthPath('/login'), true);
    assert.equal(isAuthPath('/signup'), true);
    assert.equal(isAuthPath('/chat'), false);
  });
});
