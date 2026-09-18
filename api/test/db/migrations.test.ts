import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import type { Transaction } from '@electric-sql/pglite';

import { createTestDb, testEmbedding, type TestDb } from './harness.ts';

interface Exchange {
  conversation_id: string;
  replayed: boolean;
  user_message: { id: string; seq: number; role: string; user_id: string; client_message_id: string };
  assistant_message: { id: string; seq: number; role: string; intent: string; sources: unknown[] };
}

interface QuotaRow {
  allowed: boolean;
  used: number;
  quota_limit: number;
}

let t: TestDb;
let alice: string;
let bob: string;

async function appendExchange(
  tx: Transaction,
  userId: string,
  conversationId: string | null,
  clientMessageId: string = randomUUID(),
  text = 'What does QOBO do?',
): Promise<Exchange> {
  const { rows } = await tx.query<{ result: Exchange }>(
    `select public.append_exchange($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) as result`,
    [
      userId,
      conversationId,
      clientMessageId,
      text,
      text,
      'QOBO helps businesses launch, grow, and automate.',
      'qobo',
      JSON.stringify([{ url: 'https://qobo.dev/' }]),
      JSON.stringify({ model: 'test' }),
    ],
  );
  return rows[0]!.result;
}

function serviceAppend(userId: string, conversationId: string | null, clientMessageId?: string): Promise<Exchange> {
  return t.as('service_role', null, (tx) => appendExchange(tx, userId, conversationId, clientMessageId));
}

async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: Error) => {
    assert.match(error.message, pattern);
    return true;
  });
}

before(async () => {
  t = await createTestDb();
  alice = await t.createUser('alice@test.local');
  bob = await t.createUser('bob@test.local');
});

after(async () => {
  await t.close();
});

describe('migrations', () => {
  it('create the expected tables with RLS enabled', async () => {
    const { rows } = await t.db.query<{ name: string; rls: boolean }>(`
      select n.nspname || '.' || c.relname as name, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('public', 'private')
      order by 1`);
    assert.deepEqual(rows, [
      { name: 'private.kb_chunks', rls: true },
      { name: 'private.kb_meta', rls: true },
      { name: 'private.usage_daily', rls: true },
      { name: 'private.usage_global_daily', rls: true },
      { name: 'public.conversations', rls: true },
      { name: 'public.messages', rls: true },
    ]);
  });

  it('leave no public function executable by anon or authenticated', async () => {
    const { rows } = await t.db.query<{ fn: string; role: string }>(`
      select p.proname as fn, r.rolname as role
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated')) as r(rolname)
      where n.nspname = 'public'
        and has_function_privilege(r.rolname, p.oid, 'execute')`);
    assert.deepEqual(rows, []);
  });
});

describe('anon role', () => {
  for (const table of ['public.conversations', 'public.messages']) {
    it(`cannot read ${table}`, async () => {
      await rejectsWith(t.as('anon', null, (tx) => tx.query(`select * from ${table}`)), /permission denied/);
    });
  }

  it('cannot use the private schema', async () => {
    await rejectsWith(t.as('anon', null, (tx) => tx.query('select * from private.kb_chunks')), /permission denied/);
  });

  it('cannot execute backend functions', async () => {
    await rejectsWith(
      t.as('anon', null, (tx) => tx.query(`select * from public.consume_user_quota($1, 'message', 100)`, [alice])),
      /permission denied/,
    );
  });
});

describe('authenticated role', () => {
  let aliceConversation: string;
  let bobConversation: string;

  before(async () => {
    aliceConversation = (await serviceAppend(alice, null)).conversation_id;
    bobConversation = (await serviceAppend(bob, null)).conversation_id;
  });

  it('sees only its own conversations and messages', async () => {
    const result = await t.as('authenticated', alice, async (tx) => ({
      conversations: (await tx.query<{ user_id: string }>('select user_id from public.conversations')).rows,
      messages: (await tx.query<{ user_id: string }>('select user_id from public.messages')).rows,
    }));
    assert.ok(result.conversations.length >= 1);
    assert.ok(result.conversations.every((row) => row.user_id === alice));
    assert.ok(result.messages.length >= 2);
    assert.ok(result.messages.every((row) => row.user_id === alice));
  });

  it('cannot read another user conversation by id', async () => {
    const rows = await t.as('authenticated', alice, async (tx) =>
      (await tx.query('select id from public.conversations where id = $1', [bobConversation])).rows,
    );
    assert.deepEqual(rows, []);
  });

  it('cannot insert conversations', async () => {
    await rejectsWith(
      t.as('authenticated', alice, (tx) => tx.query(`insert into public.conversations (user_id, title) values ($1, 'x')`, [alice])),
      /permission denied/,
    );
  });

  it('cannot forge assistant messages', async () => {
    await rejectsWith(
      t.as('authenticated', alice, (tx) =>
        tx.query(`insert into public.messages (conversation_id, user_id, role, content) values ($1, $2, 'assistant', 'Lifetime plan ₹99')`, [
          aliceConversation,
          alice,
        ]),
      ),
      /permission denied/,
    );
  });

  it('cannot update messages at all', async () => {
    await rejectsWith(t.as('authenticated', alice, (tx) => tx.query(`update public.messages set content = 'edited'`)), /permission denied/);
  });

  it('can rename its own conversation, and nothing else about it', async () => {
    const renamed = await t.as('authenticated', alice, (tx) =>
      tx.query(`update public.conversations set title = 'A better name' where id = $1 returning title`, [aliceConversation]),
    );
    assert.equal(renamed.rows.length, 1, 'the owner may change the title');

    // The grant is scoped to one column: everything else stays out of reach.
    await rejectsWith(
      t.as('authenticated', alice, (tx) => tx.query(`update public.conversations set user_id = $1 where id = $2`, [bob, aliceConversation])),
      /permission denied/,
    );
    for (const statement of ['set created_at = now()', 'set updated_at = now()']) {
      await rejectsWith(
        t.as('authenticated', alice, (tx) => tx.query(`update public.conversations ${statement} where id = $1`, [aliceConversation])),
        /permission denied/,
      );
    }
  });

  it("cannot rename another user's conversation", async () => {
    const attempt = await t.as('authenticated', bob, (tx) =>
      tx.query(`update public.conversations set title = 'stolen' where id = $1 returning id`, [aliceConversation]),
    );
    assert.equal(attempt.rows.length, 0, 'the policy hides rows that are not yours');

    const { rows } = await t.db.query<{ title: string }>(`select title from public.conversations where id = $1`, [aliceConversation]);
    assert.notEqual(rows[0]?.title, 'stolen');
  });

  it('refuses an empty or over-long title at the database level', async () => {
    for (const title of ['', 'x'.repeat(121)]) {
      await rejectsWith(
        t.as('authenticated', alice, (tx) => tx.query(`update public.conversations set title = $1 where id = $2`, [title, aliceConversation])),
        /violates check constraint/,
      );
    }
  });

  it('does not itself reject a whitespace-only title, which is why the API trims first', async () => {
    // char_length('   ') is 3, so the constraint passes. The rename endpoint trims and
    // rejects the result when it is empty; this test exists so nobody assumes the
    // database is guarding that.
    const result = await t.as('authenticated', alice, (tx) =>
      tx.query(`update public.conversations set title = '   ' where id = $1 returning title`, [aliceConversation]),
    );
    assert.equal(result.rows.length, 1);
    await t.db.query(`update public.conversations set title = 'restored' where id = $1`, [aliceConversation]);
  });

  it('cannot call backend functions or reach private tables', async () => {
    await rejectsWith(
      t.as('authenticated', alice, (tx) => appendExchange(tx, alice, aliceConversation)),
      /permission denied/,
    );
    await rejectsWith(
      t.as('authenticated', alice, (tx) => tx.query(`select * from public.consume_user_quota($1, 'message', 1000)`, [alice])),
      /permission denied/,
    );
    await rejectsWith(t.as('authenticated', alice, (tx) => tx.query('select * from private.usage_daily')), /permission denied/);
    await rejectsWith(
      t.as('authenticated', alice, (tx) => tx.query('select * from public.match_kb_chunks($1::extensions.vector)', [testEmbedding(0)])),
      /permission denied/,
    );
  });

  it("cannot delete another user's conversation", async () => {
    const deleted = await t.as('authenticated', alice, async (tx) =>
      (await tx.query('delete from public.conversations where id = $1 returning id', [bobConversation])).rows,
    );
    assert.deepEqual(deleted, []);
    const { rows } = await t.db.query('select id from public.conversations where id = $1', [bobConversation]);
    assert.equal(rows.length, 1);
  });

  it('deletes its own conversation and the messages cascade', async () => {
    const { conversation_id } = await serviceAppend(alice, null);
    const deleted = await t.as('authenticated', alice, async (tx) =>
      (await tx.query('delete from public.conversations where id = $1 returning id', [conversation_id])).rows,
    );
    assert.equal(deleted.length, 1);
    const { rows } = await t.db.query('select id from public.messages where conversation_id = $1', [conversation_id]);
    assert.deepEqual(rows, []);
  });
});

describe('append_exchange (service_role)', () => {
  it('creates a conversation with an ordered user/assistant pair', async () => {
    const exchange = await serviceAppend(alice, null);
    assert.equal(exchange.replayed, false);
    assert.equal(exchange.user_message.role, 'user');
    assert.equal(exchange.assistant_message.role, 'assistant');
    assert.equal(exchange.assistant_message.intent, 'qobo');
    assert.equal(exchange.user_message.user_id, alice);
    assert.ok(Number(exchange.assistant_message.seq) > Number(exchange.user_message.seq));

    const { rows } = await t.db.query<{ title: string }>('select title from public.conversations where id = $1', [exchange.conversation_id]);
    assert.equal(rows[0]?.title, 'What does QOBO do?');
  });

  it('appends to an existing conversation', async () => {
    const first = await serviceAppend(alice, null);
    const second = await serviceAppend(alice, first.conversation_id);
    assert.equal(second.conversation_id, first.conversation_id);
    const { rows } = await t.db.query('select id from public.messages where conversation_id = $1', [first.conversation_id]);
    assert.equal(rows.length, 4);
  });

  it('replays instead of duplicating when the idempotency key repeats', async () => {
    const key = randomUUID();
    const first = await serviceAppend(alice, null, key);
    const retry = await serviceAppend(alice, null, key);
    assert.equal(retry.replayed, true);
    assert.equal(retry.conversation_id, first.conversation_id);
    assert.equal(retry.assistant_message.id, first.assistant_message.id);
    const { rows } = await t.db.query('select id from public.conversations where id = $1', [first.conversation_id]);
    assert.equal(rows.length, 1);
  });

  it("rejects appending to another user's conversation", async () => {
    const bobs = await serviceAppend(bob, null);
    await rejectsWith(serviceAppend(alice, bobs.conversation_id), /conversation not found/);
  });

  it('rejects a conversation id that does not exist', async () => {
    await rejectsWith(serviceAppend(alice, randomUUID()), /conversation not found/);
  });

  it('does not leave a half-written exchange when a message is invalid', async () => {
    const before = await t.db.query('select id from public.conversations');
    await assert.rejects(
      t.as('service_role', null, (tx) =>
        tx.query(`select public.append_exchange($1, null, $2, 'title', 'hello', '', 'qobo')`, [alice, randomUUID()]),
      ),
    );
    const afterRows = await t.db.query('select id from public.conversations');
    assert.equal(afterRows.rows.length, before.rows.length);
  });

  it('enforces owner consistency between messages and conversations', async () => {
    const alices = await serviceAppend(alice, null);
    await assert.rejects(
      t.db.query(`insert into public.messages (conversation_id, user_id, role, content, intent) values ($1, $2, 'assistant', 'x', 'qobo')`, [
        alices.conversation_id,
        bob,
      ]),
      /foreign key/,
    );
  });
});

describe('replace_exchange (service_role)', () => {
  /** Replaces a saved exchange the way the API does, returning the new pair. */
  function serviceReplace(
    userId: string,
    conversationId: string,
    targetMessageId: string,
    options: { text?: string; clientMessageId?: string; title?: string } = {},
  ): Promise<Exchange> {
    const text = options.text ?? 'What do your plans include, and is SEO extra?';
    return t.as('service_role', null, async (tx) => {
      const { rows } = await tx.query<{ result: Exchange }>(
        `select public.replace_exchange($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb) as result`,
        [
          userId,
          conversationId,
          targetMessageId,
          options.clientMessageId ?? randomUUID(),
          options.title ?? text,
          text,
          'Starter is ₹499 and SEO is included.',
          'qobo',
          JSON.stringify([{ url: 'https://qobo.dev/plans' }]),
          JSON.stringify({ model: 'test', status: 'answered' }),
        ],
      );
      return rows[0]!.result;
    });
  }

  async function messagesOf(conversationId: string): Promise<{ seq: number; role: string; content: string; id: string }[]> {
    const { rows } = await t.db.query<{ seq: number; role: string; content: string; id: string }>(
      `select seq, role, content, id from public.messages where conversation_id = $1 order by seq`,
      [conversationId],
    );
    return rows;
  }

  it('replaces both messages in place, leaving no second copy', async () => {
    const first = await serviceAppend(alice, null, undefined);
    const conversationId = first.conversation_id;

    const replaced = await serviceReplace(alice, conversationId, first.user_message.id);

    const rows = await messagesOf(conversationId);
    assert.equal(rows.length, 2, 'the exchange is replaced, not appended to');
    assert.deepEqual(
      rows.map((row) => row.role),
      ['user', 'assistant'],
    );
    assert.equal(rows[0]?.content, 'What do your plans include, and is SEO extra?');
    assert.equal(rows[1]?.content, 'Starter is ₹499 and SEO is included.');
    assert.equal(replaced.replayed, false);
    assert.equal(replaced.conversation_id, conversationId, 'the same conversation');
  });

  it('keeps the exchange in its original position, with its ids', async () => {
    const one = await serviceAppend(alice, null, undefined);
    const conversationId = one.conversation_id;
    const two = await serviceAppend(alice, conversationId, undefined);
    const three = await serviceAppend(alice, conversationId, undefined);

    const before = await messagesOf(conversationId);
    await serviceReplace(alice, conversationId, two.user_message.id, { text: 'edited middle question' });
    const after = await messagesOf(conversationId);

    assert.equal(after.length, 6, 'nothing added, nothing removed');
    assert.deepEqual(
      after.map((row) => row.seq),
      before.map((row) => row.seq),
      'seq values are untouched, so the order cannot shift',
    );
    assert.deepEqual(
      after.map((row) => row.id),
      before.map((row) => row.id),
      'message ids stay stable, so citation anchors keep working',
    );
    assert.equal(after[2]?.content, 'edited middle question', 'the edit sits where the original was');
    assert.equal(after[0]?.content, before[0]?.content, 'the earlier exchange is untouched');
    assert.equal(after[4]?.content, before[4]?.content, 'the later exchange is untouched');
    assert.equal(after[5]?.content, before[5]?.content);
    assert.equal(three.user_message.id, after[4]?.id);
  });

  it('replays a repeated edit instead of replacing twice', async () => {
    const first = await serviceAppend(alice, null, undefined);
    const key = randomUUID();

    const once = await serviceReplace(alice, first.conversation_id, first.user_message.id, { clientMessageId: key, text: 'edited once' });
    const twice = await serviceReplace(alice, first.conversation_id, first.user_message.id, { clientMessageId: key, text: 'edited twice' });

    assert.equal(once.replayed, false);
    assert.equal(twice.replayed, true, 'the same idempotency key returns what was stored');
    const rows = await messagesOf(first.conversation_id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.content, 'edited once', 'the replay does not apply the second text');
  });

  it("refuses to edit another user's message", async () => {
    const aliceExchange = await serviceAppend(alice, null, undefined);

    await rejectsWith(serviceReplace(bob, aliceExchange.conversation_id, aliceExchange.user_message.id), /message not found/);

    const rows = await messagesOf(aliceExchange.conversation_id);
    assert.equal(rows[0]?.content, 'What does QOBO do?', "Alice's message is untouched");
  });

  it('refuses to edit an assistant reply', async () => {
    const exchange = await serviceAppend(alice, null, undefined);

    await rejectsWith(serviceReplace(alice, exchange.conversation_id, exchange.assistant_message.id), /message not found/);

    const rows = await messagesOf(exchange.conversation_id);
    assert.equal(rows[1]?.content, 'QOBO helps businesses launch, grow, and automate.', 'the reply is untouched');
  });

  it('refuses a message that belongs to a different conversation', async () => {
    const first = await serviceAppend(alice, null, undefined);
    const other = await serviceAppend(alice, null, undefined);

    await rejectsWith(serviceReplace(alice, other.conversation_id, first.user_message.id), /message not found/);
  });

  it('refuses an unknown message and an unknown conversation', async () => {
    const exchange = await serviceAppend(alice, null, undefined);
    await rejectsWith(serviceReplace(alice, exchange.conversation_id, randomUUID()), /message not found/);
    await rejectsWith(serviceReplace(alice, randomUUID(), exchange.user_message.id), /message not found/);
  });

  it('retitles the conversation when its first message is edited, and not otherwise', async () => {
    const first = await serviceAppend(alice, null, undefined);
    const conversationId = first.conversation_id;
    const second = await serviceAppend(alice, conversationId, undefined);

    await serviceReplace(alice, conversationId, first.user_message.id, { text: 'new opening question', title: 'new opening question' });
    const { rows: retitled } = await t.db.query<{ title: string }>(`select title from public.conversations where id = $1`, [conversationId]);
    assert.equal(retitled[0]?.title, 'new opening question');

    await serviceReplace(alice, conversationId, second.user_message.id, { text: 'edited follow-up', title: 'edited follow-up' });
    const { rows: unchanged } = await t.db.query<{ title: string }>(`select title from public.conversations where id = $1`, [conversationId]);
    assert.equal(unchanged[0]?.title, 'new opening question', 'editing a later message leaves the title alone');
  });

  it('moves the conversation up the list by touching updated_at', async () => {
    const exchange = await serviceAppend(alice, null, undefined);
    const { rows: before } = await t.db.query<{ updated_at: string }>(`select updated_at from public.conversations where id = $1`, [
      exchange.conversation_id,
    ]);

    await serviceReplace(alice, exchange.conversation_id, exchange.user_message.id);

    const { rows: after } = await t.db.query<{ updated_at: string }>(`select updated_at from public.conversations where id = $1`, [
      exchange.conversation_id,
    ]);
    assert.ok(after[0]!.updated_at >= before[0]!.updated_at);
  });

  it('writes nothing when the replacement content is invalid', async () => {
    const exchange = await serviceAppend(alice, null, undefined);

    await rejectsWith(
      t.as('service_role', null, (tx) =>
        tx.query(`select public.replace_exchange($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`, [
          alice,
          exchange.conversation_id,
          exchange.user_message.id,
          randomUUID(),
          'title',
          '',
          'a reply',
          'qobo',
          '[]',
          '{}',
        ]),
      ),
      /violates check constraint/,
    );

    const rows = await messagesOf(exchange.conversation_id);
    assert.equal(rows[0]?.content, 'What does QOBO do?', 'the original exchange survives a rejected edit');
    assert.equal(rows[1]?.content, 'QOBO helps businesses launch, grow, and automate.');
  });

  it('is not executable by anon or authenticated', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      await rejectsWith(
        t.as(role, alice, (tx) => tx.query(`select public.replace_exchange($1, $2, $3, $4, $5, $6, $7, $8)`, [alice, null, null, null, '', '', '', ''])),
        /permission denied|does not exist/,
      );
    }
  });
});

describe('quotas (service_role)', () => {
  const consume = (userId: string, limit: number) =>
    t.as('service_role', null, async (tx) => (await tx.query<QuotaRow>(`select * from public.consume_user_quota($1, 'message', $2)`, [userId, limit])).rows[0]!);

  it('allows up to the limit and then denies without incrementing', async () => {
    const user = await t.createUser();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await consume(user, 3));
    assert.deepEqual(
      results.map((r) => [r.allowed, r.used]),
      [
        [true, 1],
        [true, 2],
        [true, 3],
        [false, 3],
      ],
    );
  });

  it('keeps separate counters per user', async () => {
    const user1 = await t.createUser();
    const user2 = await t.createUser();
    await consume(user1, 1);
    assert.equal((await consume(user1, 1)).allowed, false);
    assert.equal((await consume(user2, 1)).allowed, true);
  });

  it('is not reset by deleting conversations', async () => {
    const user = await t.createUser();
    await consume(user, 2);
    const { conversation_id } = await serviceAppend(user, null);
    await t.as('authenticated', user, (tx) => tx.query('delete from public.conversations where id = $1', [conversation_id]));
    assert.equal((await consume(user, 2)).used, 2);
    assert.equal((await consume(user, 2)).allowed, false);
  });

  it('denies everything when the limit is zero', async () => {
    const user = await t.createUser();
    const result = await consume(user, 0);
    assert.equal(result.allowed, false);
    assert.equal(result.used, 0);
  });

  it('tracks a global daily quota', async () => {
    const consumeGlobal = () =>
      t.as('service_role', null, async (tx) => (await tx.query<QuotaRow>(`select * from public.consume_global_quota('web_search', 2)`)).rows[0]!);
    assert.equal((await consumeGlobal()).allowed, true);
    assert.equal((await consumeGlobal()).allowed, true);
    assert.equal((await consumeGlobal()).allowed, false);
  });
});

describe('match_kb_chunks (service_role)', () => {
  before(async () => {
    const insert = `insert into private.kb_chunks (url, title, page_type, section, chunk_index, content, topics, token_estimate, embedding)
                    values ($1, $2, 'service', null, $3, $4, $5, 10, $6::extensions.vector)`;
    await t.db.query(insert, ['https://qobo.dev/plans', 'Plans', 0, 'Starter ₹499', ['pricing'], testEmbedding(1)]);
    await t.db.query(insert, ['https://qobo.dev/seo-services', 'SEO', 0, 'On-page SEO', [], testEmbedding(1, 0.8)]);
    await t.db.query(insert, ['https://qobo.dev/our-team', 'Team', 0, 'Founders', [], testEmbedding(400)]);
  });

  it('returns chunks ordered by similarity above the threshold', async () => {
    const rows = await t.as('service_role', null, async (tx) =>
      (await tx.query<{ url: string; similarity: number; topics: string[] }>(
        'select url, similarity, topics from public.match_kb_chunks($1::extensions.vector, 5, 0.5)',
        [testEmbedding(1)],
      )).rows,
    );
    assert.deepEqual(
      rows.map((r) => r.url),
      ['https://qobo.dev/plans', 'https://qobo.dev/seo-services'],
    );
    assert.ok(Math.abs(rows[0]!.similarity - 1) < 1e-6);
    assert.deepEqual(rows[0]!.topics, ['pricing']);
  });

  it('clamps the match count', async () => {
    const rows = await t.as('service_role', null, async (tx) =>
      (await tx.query('select id from public.match_kb_chunks($1::extensions.vector, 0, 0)', [testEmbedding(1)])).rows,
    );
    assert.equal(rows.length, 1);
  });
});
