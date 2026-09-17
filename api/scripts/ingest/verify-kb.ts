/**
 * Smoke-tests the stored knowledge base through the same path the API uses:
 * gemini-embedding-2 query embedding → public.match_kb_chunks (service role).
 *
 *   npm run ingest:verify
 *   npm run ingest:verify -- "Can QOBO build an online store?"
 */
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { createSlidingWindowLimiter } from '../../src/lib/rate-limiter.ts';
import { createGeminiEmbedder, EMBEDDING_DIM } from '../../src/rag/embeddings.ts';

const envSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().startsWith('sb_secret_'),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-2'),
});

const DEFAULT_QUESTIONS = [
  'How much does a QOBO website cost?',
  'Is the ₹499 plan a monthly subscription?',
  'How do I build a website through WhatsApp?',
  'What is your WhatsApp number and phone number?',
  'Do you offer SEO services?',
  'Can I get a refund?',
];

interface Match {
  url: string;
  section: string | null;
  topics: string[];
  similarity: number;
}

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  const service = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const meta = await service.rpc('get_kb_meta');
  if (meta.error) throw new Error(`get_kb_meta failed: ${meta.error.message}`);
  const row = (meta.data as Array<{ embedding_model: string; embedding_dim: number; chunk_count: number; crawled_at: string; snapshot_ref: string }>)[0];
  if (!row) throw new Error('The knowledge base is empty; run npm run ingest:build first.');
  console.log(`KB: ${row.chunk_count} chunks | ${row.embedding_model} ${row.embedding_dim}d | crawled ${row.crawled_at} | ${row.snapshot_ref}`);
  if (row.embedding_model !== env.GEMINI_EMBEDDING_MODEL || row.embedding_dim !== EMBEDDING_DIM) {
    throw new Error(`Model mismatch: KB uses ${row.embedding_model}/${row.embedding_dim}, config uses ${env.GEMINI_EMBEDDING_MODEL}/${EMBEDDING_DIM}`);
  }

  const embedder = createGeminiEmbedder(new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { retryOptions: { attempts: 1 } } }).models, env.GEMINI_EMBEDDING_MODEL, {
    rateLimiter: createSlidingWindowLimiter({ limit: 90, windowMs: 60_000 }),
  });

  const questions = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  for (const question of questions.length > 0 ? questions : DEFAULT_QUESTIONS) {
    const embedding = await embedder.embedQuery(question);
    const { data, error } = await service.rpc('match_kb_chunks', { p_query_embedding: embedding, p_match_count: 4, p_min_similarity: 0 });
    if (error) throw new Error(`match_kb_chunks failed: ${error.message}`);
    console.log(`\nQ: ${question}`);
    for (const match of data as Match[]) {
      const topics = match.topics.length > 0 ? ` [${match.topics.join(',')}]` : '';
      console.log(`  ${match.similarity.toFixed(3)}  ${match.url.replace('https://qobo.dev', '') || '/'} › ${match.section ?? 'Overview'}${topics}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
