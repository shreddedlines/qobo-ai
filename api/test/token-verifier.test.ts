import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuthInvalidJwtError, AuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';

import { AuthUnavailableError, createSupabaseTokenVerifier } from '../src/auth/token-verifier.ts';

type GetClaims = SupabaseClient['auth']['getClaims'];

const USER_ID = '6f1c1c34-2f3b-4d5a-9a6e-0f2b8f1e7c11';

function fakeJwt(payload: Record<string, unknown> = { sub: USER_ID }): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'ES256', kid: 'k1' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

function verifierReturning(result: unknown | (() => never)) {
  let calls = 0;
  const getClaims = (async () => {
    calls++;
    if (typeof result === 'function') return (result as () => never)();
    return result;
  }) as unknown as GetClaims;
  return { verifier: createSupabaseTokenVerifier({ getClaims }), calls: () => calls };
}

const validClaims = (claims: Record<string, unknown>) => ({ data: { claims, header: {}, signature: new Uint8Array() }, error: null });

describe('createSupabaseTokenVerifier', () => {
  it('returns the user for verified authenticated claims', async () => {
    const token = fakeJwt();
    const { verifier } = verifierReturning(validClaims({ sub: USER_ID, role: 'authenticated', email: 'a@b.co' }));
    assert.deepEqual(await verifier.verify(token), { id: USER_ID, email: 'a@b.co', accessToken: token });
  });

  it('rejects structurally invalid tokens without calling Supabase', async () => {
    const { verifier, calls } = verifierReturning(validClaims({ sub: USER_ID, role: 'authenticated' }));
    for (const token of ['', 'abc', 'a.b', 'a.b.c.d', 'not base64!.x.y', 'e30.bm90LWpzb24.sig', `${'a'.repeat(9000)}.b.c`]) {
      assert.equal(await verifier.verify(token), null, `token "${token.slice(0, 20)}" should be rejected`);
    }
    assert.equal(calls(), 0);
  });

  it('rejects anon-role and anonymous-user tokens', async () => {
    assert.equal(await verifierReturning(validClaims({ sub: USER_ID, role: 'anon' })).verifier.verify(fakeJwt()), null);
    assert.equal(
      await verifierReturning(validClaims({ sub: USER_ID, role: 'authenticated', is_anonymous: true })).verifier.verify(fakeJwt()),
      null,
    );
  });

  it('rejects claims without a UUID subject', async () => {
    assert.equal(await verifierReturning(validClaims({ role: 'authenticated' })).verifier.verify(fakeJwt()), null);
    assert.equal(await verifierReturning(validClaims({ sub: 'admin', role: 'authenticated' })).verifier.verify(fakeJwt()), null);
  });

  it('treats invalid signatures and expired tokens as unauthenticated', async () => {
    const { verifier } = verifierReturning({ data: null, error: new AuthInvalidJwtError('Invalid JWT signature') });
    assert.equal(await verifier.verify(fakeJwt()), null);
  });

  it('reports network failures as unavailable rather than unauthenticated', async () => {
    const { verifier } = verifierReturning({ data: null, error: new AuthRetryableFetchError('fetch failed', 0) });
    await assert.rejects(verifier.verify(fakeJwt()), AuthUnavailableError);
  });

  it('reports auth server 5xx responses and unexpected throws as unavailable', async () => {
    const serverError = Object.assign(new AuthInvalidJwtError('upstream'), { status: 502 });
    await assert.rejects(verifierReturning({ data: null, error: serverError }).verifier.verify(fakeJwt()), AuthUnavailableError);
    await assert.rejects(
      verifierReturning(() => {
        throw new TypeError('socket hang up');
      }).verifier.verify(fakeJwt()),
      AuthUnavailableError,
    );
  });
});
