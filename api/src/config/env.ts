import { z } from 'zod';

const commaSeparated = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // Number of reverse-proxy hops in front of the app (Render = 1). Required for
    // correct client IPs in the per-IP rate limiter.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    CORS_ORIGINS: commaSeparated,

    SUPABASE_URL: z.url(),
    SUPABASE_PUBLISHABLE_KEY: z.string().startsWith('sb_publishable_', 'must be a publishable key (sb_publishable_...)'),
    SUPABASE_SECRET_KEY: z.string().startsWith('sb_secret_', 'must be a secret key (sb_secret_...)'),

    GEMINI_API_KEY: z.string().min(1),
    GEMINI_ROUTER_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    GEMINI_ANSWER_MODEL: z.string().min(1).default('gemini-3.7-flash'),
    // Used when the answer model is overloaded, rate limited or slow. Empty disables the fallback.
    GEMINI_ANSWER_FALLBACK_MODEL: z.string().default('gemini-3.5-flash-lite'),
    GEMINI_EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-2'),
    // Shared by every embedding call in this process (free tier: 100 requests/minute).
    GEMINI_EMBED_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(90),

    // Retrieval: similarity floor calibrated on the real KB (off-topic ≈0.54–0.57, QOBO questions ≈0.68–0.81).
    KB_MATCH_COUNT: z.coerce.number().int().min(1).max(20).default(6),
    KB_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.6),

    TAVILY_API_KEY: z.string().min(1),

    USER_DAILY_MESSAGE_CAP: z.coerce.number().int().min(1).default(50),
    WEB_SEARCH_DAILY_CAP: z.coerce.number().int().min(0).default(100),
    // Per-IP request limits (fixed one-minute windows).
    API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
    CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
    // Upper bound for one chat turn (routing + retrieval/search + generation).
    CHAT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(45_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'must list at least one origin in production' });
    }
    for (const origin of env.CORS_ORIGINS) {
      if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: `invalid origin "${origin}" (expected e.g. https://app.example.com)` });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Parses and validates configuration. Error messages name the variable and the
 * rule that failed but never echo the provided value, so secrets cannot leak
 * into logs.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new EnvValidationError(issues);
  }
  return result.data;
}
