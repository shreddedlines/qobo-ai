import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

const intentSchema = z.enum(['qobo', 'general', 'off_topic', 'smalltalk']);

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  tags: z.array(z.string()).min(1),
  question: z.string().min(1),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1) })).default([]),
  expect: z.object({
    intent: intentSchema.optional(),
    /** Any of these intents is acceptable (for genuinely ambiguous questions). */
    intentIn: z.array(intentSchema).min(1).optional(),
    status: z.enum(['answered', 'insufficient', 'redirected']).optional(),
    citesAny: z.array(z.url()).optional(),
    /** Every one of these must be cited, not just one of them. */
    citesAll: z.array(z.url()).optional(),
    /** Nothing outside this set may be cited, so an answer cannot cite its way around the question. */
    citesOnly: z.array(z.url()).optional(),
    /** Upper bound on cited pages, to catch an answer that cites everything it was given. */
    maxSources: z.number().int().min(0).optional(),
    /**
     * Every QOBO source must be a page the knowledge base was actually built from.
     * This is what catches an invented qobo.dev URL, which no substring check would.
     */
    groundedInKb: z.literal(true).optional(),
    /** At least one cited source must be a web result. */
    citesWeb: z.boolean().optional(),
    noSources: z.boolean().optional(),
    containsAll: z.array(z.string()).optional(),
    containsAny: z.array(z.string()).optional(),
    notContains: z.array(z.string()).optional(),
  }),
});

/**
 * The pages the reviewed knowledge base was built from.
 *
 * Read from kb/snapshots/manifest.json — the same reviewed crawl the ingestion
 * scripts load — so the allowed set cannot drift from what was actually indexed,
 * and no database is needed to check a citation.
 */
const manifestSchema = z.object({
  site: z.string().url(),
  pages: z.array(z.object({ path: z.string().startsWith('/') })).min(1),
});

/**
 * Compared with a trailing slash removed, so a citation of ".../plans/" is not
 * reported as a different page from ".../plans". The root keeps its slash.
 */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.href;
}

export function kbUrlsFromManifest(manifest: unknown): Set<string> {
  const { site, pages } = manifestSchema.parse(manifest);
  return new Set(pages.map((page) => normalizeUrl(`${site.replace(/\/$/, '')}${page.path}`)));
}

const manifestPath = path.resolve(import.meta.dirname, '../../../..', 'kb', 'snapshots', 'manifest.json');
let cachedKbUrls: Set<string> | undefined;

/** Loaded once per process; the manifest is a small reviewed file in the repository. */
export function loadKbUrls(): Set<string> {
  cachedKbUrls ??= kbUrlsFromManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  return cachedKbUrls;
}

export const evalSuiteSchema = z.array(evalCaseSchema).min(1);
export type EvalCase = z.infer<typeof evalCaseSchema>;

export interface EvaluatedAnswer {
  intent?: string;
  status: string;
  content: string;
  sources: Array<{ url: string; kind?: string }>;
}

/**
 * Returns human-readable failures; an empty list means the case passed.
 *
 * `kbUrls` is the set of pages a QOBO citation may point at. It defaults to the
 * reviewed manifest and is injectable so the checks can be tested without the file.
 */
export function checkAnswer(testCase: EvalCase, answer: EvaluatedAnswer, kbUrls?: ReadonlySet<string>): string[] {
  const failures: string[] = [];
  const text = answer.content.toLowerCase();
  const { expect } = testCase;

  if (expect.intent && answer.intent !== expect.intent) failures.push(`intent is "${answer.intent}", expected "${expect.intent}"`);
  if (expect.intentIn && !expect.intentIn.includes(answer.intent as never)) failures.push(`intent is "${answer.intent}", expected one of ${expect.intentIn.join(', ')}`);
  if (expect.status && answer.status !== expect.status) failures.push(`status is "${answer.status}", expected "${expect.status}"`);
  if (expect.citesAny && !answer.sources.some((source) => expect.citesAny!.includes(source.url))) {
    failures.push(`cites none of ${expect.citesAny.join(', ')}`);
  }
  if (expect.citesAll) {
    const cited = new Set(answer.sources.map((source) => normalizeUrl(source.url)));
    const missing = expect.citesAll.filter((url) => !cited.has(normalizeUrl(url)));
    if (missing.length > 0) failures.push(`does not cite ${missing.join(', ')}`);
  }
  if (expect.citesOnly) {
    const allowed = new Set(expect.citesOnly.map(normalizeUrl));
    const unexpected = answer.sources.map((source) => source.url).filter((url) => !allowed.has(normalizeUrl(url)));
    if (unexpected.length > 0) failures.push(`cites unexpected ${[...new Set(unexpected)].join(', ')}`);
  }
  if (expect.maxSources !== undefined && answer.sources.length > expect.maxSources) {
    failures.push(`cites ${answer.sources.length} sources, at most ${expect.maxSources} expected`);
  }
  if (expect.groundedInKb) {
    const allowed = kbUrls ?? loadKbUrls();
    const invented = answer.sources
      .filter((source) => source.kind === 'qobo')
      .map((source) => source.url)
      .filter((url) => !allowed.has(normalizeUrl(url)));
    if (invented.length > 0) failures.push(`cites QOBO pages outside the knowledge base: ${[...new Set(invented)].join(', ')}`);
  }
  if (expect.citesWeb && !answer.sources.some((source) => source.kind === 'web')) failures.push('cites no web sources');
  if (expect.noSources && answer.sources.length > 0) failures.push(`expected no sources, got ${answer.sources.length}`);
  for (const needle of expect.containsAll ?? []) {
    if (!text.includes(needle.toLowerCase())) failures.push(`missing "${needle}"`);
  }
  if (expect.containsAny && !expect.containsAny.some((needle) => text.includes(needle.toLowerCase()))) {
    failures.push(`contains none of ${expect.containsAny.map((n) => `"${n}"`).join(', ')}`);
  }
  for (const needle of expect.notContains ?? []) {
    if (text.includes(needle.toLowerCase())) failures.push(`must not contain "${needle}"`);
  }
  return failures;
}
