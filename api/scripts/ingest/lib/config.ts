import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';
import { z } from 'zod';

export const PAGE_TYPES = ['home', 'service', 'industry', 'pricing', 'contact', 'company', 'blog', 'legal'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

const regexString = z.string().refine((value) => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}, 'must be a valid regular expression');

const exclusionSchema = z.object({
  /** The smallest element containing every phrase is hidden before capture. */
  containsAll: z.array(z.string().min(3)).min(1),
  reason: z.string().min(3),
  /** For rotating widgets that may not be on screen during a crawl; no issue when unmatched. */
  optional: z.boolean().default(false),
});

const pageRuleSchema = z.object({
  title: z.string().optional(),
  sampleMs: z.number().int().min(0).max(60_000).default(0),
  clickTexts: z.array(z.string().min(1)).default([]),
  expandQuestions: z.boolean().default(true),
  exclude: z.array(exclusionSchema).default([]),
});

const priceRuleSchema = z.object({
  value: z.string().regex(/^₹[\d,]+(?:\.\d+)?(?:M|K|L|Cr)?(?:\/[a-z]+)?$/, 'use the normalized form, e.g. ₹499, ₹499/month or ₹20M'),
  pages: z.array(z.string().min(1)).min(1),
  note: z.string().min(3),
});

const configSchema = z.object({
  site: z.url(),
  sitemap: z.url(),
  maxPages: z.number().int().min(1).max(500).default(60),
  requestDelayMs: z.number().int().min(0).default(600),
  navigationTimeoutMs: z.number().int().min(5_000).default(45_000),
  extraPaths: z.array(z.string().startsWith('/')).default([]),
  excludePathPatterns: z.array(regexString).default([]),
  boilerplate: z
    .object({
      maxLineLength: z.number().int().min(1).default(40),
      minPages: z.number().int().min(2).default(4),
      pageShare: z.number().min(0).max(1).default(0.5),
    })
    .prefault({}),
  shrinkThreshold: z.number().min(0).max(1).default(0.5),
  pageTypes: z.array(z.object({ pattern: regexString, type: z.enum(PAGE_TYPES) })).min(1),
  pages: z.record(z.string().startsWith('/'), pageRuleSchema).default({}),
  prices: z.array(priceRuleSchema).default([]),
  /** Topic tags attached to chunks whose text matches any pattern (case-insensitive). */
  topics: z
    .array(z.object({ name: z.string().regex(/^[a-z_]+$/), patterns: z.array(regexString).min(1) }))
    .default([]),
});

export type IngestConfig = z.infer<typeof configSchema>;
export type PageRule = z.infer<typeof pageRuleSchema>;
export type PriceRule = z.infer<typeof priceRuleSchema>;

export function parseIngestConfig(raw: unknown): IngestConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid ingest config:\n  - ${issues.join('\n  - ')}`);
  }
  return result.data;
}

export async function loadIngestConfig(file: string): Promise<IngestConfig> {
  return parseIngestConfig(parse(await readFile(file, 'utf8')));
}

export function pageRuleFor(config: IngestConfig, path: string): PageRule {
  return config.pages[path] ?? pageRuleSchema.parse({});
}

export function pageTypeFor(config: IngestConfig, path: string): PageType {
  const match = config.pageTypes.find((rule) => new RegExp(rule.pattern).test(path));
  if (!match) throw new Error(`No pageTypes rule matches ${path}`);
  return match.type;
}
