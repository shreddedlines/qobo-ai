import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { buildTestApp } from './helpers/fakes.ts';

describe('app basics', () => {
  const { app, health } = buildTestApp();

  it('responds to the liveness check', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  it('reports database health on the deep check', async () => {
    health.healthy = true;
    const ok = await request(app).get('/api/health?deep=1');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { status: 'ok', database: 'ok' });

    health.healthy = false;
    const degraded = await request(app).get('/api/health?deep=1');
    assert.equal(degraded.status, 503);
    assert.deepEqual(degraded.body, { status: 'degraded', database: 'unavailable' });
    health.healthy = true;
  });

  it('sets security headers, a request id, and hides the framework', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.match(res.headers['x-request-id'] ?? '', /^[0-9a-f-]{36}$/);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: { code: 'not_found', message: 'Route not found' } });
  });

  it('returns 400 for malformed JSON bodies', async () => {
    const res = await request(app).post('/api/anything').set('Content-Type', 'application/json').send('{"broken":');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'bad_request');
  });

  it('returns 413 for oversized JSON bodies', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: 'x'.repeat(40_000) }));
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, 'payload_too_large');
  });
});

describe('CORS', () => {
  const { app } = buildTestApp({ CORS_ORIGINS: 'https://chat.example.com' });

  it('allows configured origins', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://chat.example.com');
    assert.equal(res.headers['access-control-allow-origin'], 'https://chat.example.com');
  });

  it('gives no CORS headers to other origins', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  it('answers preflight requests allowing the Authorization header', async () => {
    const res = await request(app)
      .options('/api/conversations')
      .set('Origin', 'https://chat.example.com')
      .set('Access-Control-Request-Method', 'DELETE')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    assert.equal(res.status, 204);
    assert.match(String(res.headers['access-control-allow-headers']), /Authorization/);
    assert.match(String(res.headers['access-control-allow-methods']), /DELETE/);
  });
});

describe('rate limiting', () => {
  it('returns 429 JSON after the per-IP API limit, but never throttles health checks', async () => {
    const { app, verifier } = buildTestApp({ API_RATE_LIMIT_PER_MINUTE: '3' });
    const { token } = verifier.addUser();

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await request(app).get('/api/conversations').set('Authorization', `Bearer ${token}`)).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);

    const limited = await request(app).get('/api/conversations').set('Authorization', `Bearer ${token}`);
    assert.equal(limited.body.error.code, 'rate_limited');
    assert.ok(limited.headers['ratelimit-policy'] || limited.headers['ratelimit']);

    for (let i = 0; i < 5; i++) {
      assert.equal((await request(app).get('/api/health')).status, 200);
    }
  });

  it('throttles unauthenticated requests too', async () => {
    const { app } = buildTestApp({ API_RATE_LIMIT_PER_MINUTE: '2' });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await request(app).get('/api/conversations')).status);
    assert.deepEqual(statuses, [401, 401, 429]);
  });
});
