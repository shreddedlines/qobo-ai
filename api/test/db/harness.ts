import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { PGlite, type Transaction } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

const migrationsDir = path.resolve(import.meta.dirname, '../../../supabase/migrations');
const shimPath = path.resolve(import.meta.dirname, 'supabase-shim.sql');

export type DbRole = 'anon' | 'authenticated' | 'service_role';

export interface TestDb {
  db: PGlite;
  /** Runs `fn` inside a transaction as the given role (and JWT subject, for authenticated). */
  as<T>(role: DbRole, userId: string | null, fn: (tx: Transaction) => Promise<T>): Promise<T>;
  createUser(email?: string): Promise<string>;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const db = await PGlite.create({ extensions: { vector } });
  await db.exec(await readFile(shimPath, 'utf8'));

  const migrations = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of migrations) {
    try {
      await db.exec(await readFile(path.join(migrationsDir, file), 'utf8'));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }

  return {
    db,
    as(role, userId, fn) {
      return db.transaction(async (tx) => {
        await tx.exec(`set local role ${role}`);
        const claims = userId ? { sub: userId, role } : { role };
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        return fn(tx);
      });
    },
    async createUser(email) {
      const id = randomUUID();
      await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email ?? `${id}@test.local`]);
      return id;
    },
    close: () => db.close(),
  };
}

/** Deterministic unit-length 768-dimension vector, pointing mostly along `axis`. */
export function testEmbedding(axis: number, wobble = 0): string {
  const values = new Array<number>(768).fill(0);
  values[axis] = 1;
  if (wobble) values[(axis + 1) % 768] = wobble;
  const norm = Math.hypot(...values);
  return `[${values.map((v) => v / norm).join(',')}]`;
}
