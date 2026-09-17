/**
 * Builds the knowledge base from reviewed snapshots: chunk → embed → replace in Postgres.
 *
 *   npm run ingest:build -- --dry-run   # chunk statistics only; no API keys needed
 *   npm run ingest:build                # needs GEMINI_API_KEY and DATABASE_URL in api/.env
 *
 * DATABASE_URL is the Supabase session pooler connection string. TLS is verified
 * against the Supabase CA certificate (DATABASE_CA_CERT_PATH).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { GoogleGenAI } from '@google/genai';
import pg from 'pg';
import { z } from 'zod';

import { createSlidingWindowLimiter } from '../../src/lib/rate-limiter.ts';
import { createGeminiEmbedder } from '../../src/rag/embeddings.ts';
import { embedThenReplace } from './lib/build.ts';
import { loadIngestConfig } from './lib/config.ts';
import { replaceKnowledgeBase } from './lib/kb-writer.ts';
import { prepareKnowledgeBase } from './lib/knowledge-base.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const kbDir = path.join(repoRoot, 'kb');

const buildEnvSchema = z.object({
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-2'),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  DATABASE_CA_CERT_PATH: z.string().min(1).optional(),
  DATABASE_SSL_INSECURE: z.enum(['true', 'false']).default('false'),
  // Stay below the Gemini free-tier embedding quota (100 requests/minute; each text counts).
  GEMINI_EMBED_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(90),
  GEMINI_EMBED_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
});

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const config = await loadIngestConfig(path.join(kbDir, 'ingest.config.yaml'));
  const { manifest, chunks, snapshotRef } = await prepareKnowledgeBase(path.join(kbDir, 'snapshots'), config);

  const tokens = chunks.map((chunk) => chunk.tokenEstimate).sort((a, b) => a - b);
  const byTopic = Object.fromEntries(config.topics.map((topic) => [topic.name, chunks.filter((c) => c.topics.includes(topic.name)).length]));
  console.log(`Snapshots: ${manifest.pages.length} | chunks: ${chunks.length} | ref: ${snapshotRef}`);
  console.log(
    `Estimated tokens per chunk: min ${tokens[0]}, median ${tokens[Math.floor(tokens.length / 2)]}, max ${tokens.at(-1)}, total ${tokens.reduce((a, b) => a + b, 0)}`,
  );
  console.log(`Chunks by topic: ${JSON.stringify(byTopic)}`);

  if (dryRun) {
    const previewDir = path.join(kbDir, '.build');
    await mkdir(previewDir, { recursive: true });
    await writeFile(path.join(previewDir, 'chunks.preview.json'), `${JSON.stringify(chunks, null, 2)}\n`, 'utf8');
    console.log('Dry run: wrote kb/.build/chunks.preview.json (not committed). Nothing was embedded or stored.');
    return;
  }

  const envResult = buildEnvSchema.safeParse(process.env);
  if (!envResult.success) {
    throw new Error(`Missing build configuration: ${envResult.error.issues.map((issue) => `${issue.path.join('.')} (${issue.message})`).join(', ')}`);
  }
  const env = envResult.data;

  // Fail on TLS configuration before spending any embedding quota.
  const ssl = await sslOptions(env);

  const perMinute = env.GEMINI_EMBED_REQUESTS_PER_MINUTE;
  const batchSize = Math.min(env.GEMINI_EMBED_BATCH_SIZE, perMinute);
  const embedder = createGeminiEmbedder(
    // Disable the SDK's own retries so this is the only retry layer (it honours retryDelay).
    new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { retryOptions: { attempts: 1 } } }).models,
    env.GEMINI_EMBEDDING_MODEL,
    {
      batchSize,
      rateLimiter: createSlidingWindowLimiter({ limit: perMinute, windowMs: 60_000 }),
      retry: {
        retries: 6,
        baseDelayMs: 2_000,
        maxDelayMs: 120_000,
        onRetry: ({ attempt, delayMs, error }) =>
          console.warn(`  retry ${attempt} in ${(delayMs / 1000).toFixed(1)}s after ${(error as { status?: number }).status ?? 'error'}`),
      },
      onBatchComplete: (done, total) => console.log(`  embedded ${done}/${total}`),
    },
  );
  const estimatedMinutes = Math.max(0, Math.ceil(chunks.length / perMinute) - 1);
  console.log(
    `Embedding ${chunks.length} chunks with ${embedder.model} (${embedder.dimension}d), batches of ${batchSize}, ≤${perMinute}/min` +
      (estimatedMinutes > 0 ? ` (about ${estimatedMinutes} min of rate-limit waiting)` : ''),
  );

  await embedThenReplace(chunks, embedder, async (vectors) => {
    const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl });
    await client.connect();
    try {
      await replaceKnowledgeBase(client, chunks, vectors, { embeddingModel: embedder.model, crawledAt: manifest.crawledAt, snapshotRef });
    } finally {
      await client.end();
    }
  });
  console.log(`Knowledge base replaced: ${chunks.length} chunks (${snapshotRef}).`);
}

async function sslOptions(env: z.infer<typeof buildEnvSchema>): Promise<pg.ClientConfig['ssl']> {
  if (env.DATABASE_CA_CERT_PATH) {
    return { ca: await readFile(env.DATABASE_CA_CERT_PATH, 'utf8'), rejectUnauthorized: true };
  }
  if (env.DATABASE_SSL_INSECURE === 'true') {
    console.warn('WARNING: DATABASE_SSL_INSECURE=true — the database TLS certificate is NOT verified.');
    return { rejectUnauthorized: false };
  }
  throw new Error('Set DATABASE_CA_CERT_PATH to the Supabase CA certificate (Database settings → SSL configuration).');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
