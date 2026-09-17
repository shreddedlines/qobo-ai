import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import request from 'supertest';

import { buildTestApp, type TestApp } from './helpers/fakes.ts';

let ctx: TestApp;
let aliceToken: string;
let aliceId: string;
let bobId: string;

beforeEach(() => {
  ctx = buildTestApp();
  const alice = ctx.verifier.addUser();
  aliceToken = alice.token;
  aliceId = alice.user.id;
  bobId = ctx.verifier.addUser().user.id;
});

const asAlice = (req: request.Test) => req.set('Authorization', `Bearer ${aliceToken}`);

describe('authentication', () => {
  it('rejects requests without a bearer token', async () => {
    for (const header of [undefined, 'Basic abc', 'Bearer', 'Bearer a b']) {
      const req = request(ctx.app).get('/api/conversations');
      if (header) req.set('Authorization', header);
      const res = await req;
      assert.equal(res.status, 401, `header: ${header}`);
      assert.equal(res.body.error.code, 'unauthorized');
    }
  });

  it('rejects unknown or expired tokens', async () => {
    const res = await request(ctx.app).get('/api/conversations').set('Authorization', 'Bearer not-a-session');
    assert.equal(res.status, 401);
  });

  it('returns 503 (not 401) when the auth service is unreachable', async () => {
    ctx.verifier.unavailable = true;
    const res = await asAlice(request(ctx.app).get('/api/conversations'));
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
  });
});

describe('GET /api/conversations', () => {
  it("lists only the caller's conversations, newest first", async () => {
    ctx.store.seed(aliceId, 'older', '2026-09-01T10:00:00.000Z');
    ctx.store.seed(aliceId, 'newer', '2026-09-02T10:00:00.000Z');
    ctx.store.seed(bobId, 'bob only', '2026-09-03T10:00:00.000Z');

    const res = await asAlice(request(ctx.app).get('/api/conversations'));
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.conversations.map((c: { title: string }) => c.title),
      ['newer', 'older'],
    );
    assert.equal(res.body.nextCursor, null);
    assert.deepEqual(Object.keys(res.body.conversations[0]).sort(), ['createdAt', 'id', 'title', 'updatedAt']);
  });

  it('paginates with limit and the before cursor', async () => {
    for (let day = 1; day <= 5; day++) ctx.store.seed(aliceId, `day ${day}`, `2026-09-0${day}T10:00:00.000Z`);

    const first = await asAlice(request(ctx.app).get('/api/conversations?limit=2'));
    assert.deepEqual(
      first.body.conversations.map((c: { title: string }) => c.title),
      ['day 5', 'day 4'],
    );
    assert.equal(first.body.nextCursor, '2026-09-04T10:00:00.000Z');

    const second = await asAlice(request(ctx.app).get(`/api/conversations?limit=2&before=${encodeURIComponent(first.body.nextCursor)}`));
    assert.deepEqual(
      second.body.conversations.map((c: { title: string }) => c.title),
      ['day 3', 'day 2'],
    );
  });

  it('rejects invalid query parameters', async () => {
    for (const query of ['limit=0', 'limit=51', 'limit=abc', 'before=yesterday']) {
      const res = await asAlice(request(ctx.app).get(`/api/conversations?${query}`));
      assert.equal(res.status, 400, query);
      assert.equal(res.body.error.code, 'bad_request');
    }
  });
});

describe('GET /api/conversations/:id/messages', () => {
  it('returns the conversation with its messages', async () => {
    const conversation = ctx.store.seed(aliceId, 'hello', '2026-09-01T10:00:00.000Z', 4);
    const res = await asAlice(request(ctx.app).get(`/api/conversations/${conversation.id}/messages`));
    assert.equal(res.status, 200);
    assert.equal(res.body.conversation.id, conversation.id);
    assert.equal(res.body.messages.length, 4);
    assert.deepEqual(Object.keys(res.body.messages[0]).sort(), ['content', 'createdAt', 'id', 'intent', 'role', 'sources']);
  });

  it("returns 404 for another user's conversation, a missing id, or a malformed id", async () => {
    const bobs = ctx.store.seed(bobId, 'private', '2026-09-01T10:00:00.000Z');
    for (const id of [bobs.id, randomUUID(), 'not-a-uuid', "1' or '1'='1"]) {
      const res = await asAlice(request(ctx.app).get(`/api/conversations/${encodeURIComponent(id)}/messages`));
      assert.equal(res.status, 404, id);
      assert.deepEqual(res.body, { error: { code: 'not_found', message: 'Conversation not found' } });
    }
  });
});

describe('DELETE /api/conversations/:id', () => {
  it('deletes an owned conversation once', async () => {
    const conversation = ctx.store.seed(aliceId, 'bye', '2026-09-01T10:00:00.000Z');
    const first = await asAlice(request(ctx.app).delete(`/api/conversations/${conversation.id}`));
    assert.equal(first.status, 204);
    const second = await asAlice(request(ctx.app).delete(`/api/conversations/${conversation.id}`));
    assert.equal(second.status, 404);
  });

  it("cannot delete another user's conversation", async () => {
    const bobs = ctx.store.seed(bobId, 'keep', '2026-09-01T10:00:00.000Z');
    const res = await asAlice(request(ctx.app).delete(`/api/conversations/${bobs.id}`));
    assert.equal(res.status, 404);
    assert.equal(ctx.store.conversations.length, 1);
  });
});
