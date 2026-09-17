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
    /** At least one cited source must be a web result. */
    citesWeb: z.boolean().optional(),
    noSources: z.boolean().optional(),
    containsAll: z.array(z.string()).optional(),
    containsAny: z.array(z.string()).optional(),
    notContains: z.array(z.string()).optional(),
  }),
});

export const evalSuiteSchema = z.array(evalCaseSchema).min(1);
export type EvalCase = z.infer<typeof evalCaseSchema>;

export interface EvaluatedAnswer {
  intent?: string;
  status: string;
  content: string;
  sources: Array<{ url: string; kind?: string }>;
}

/** Returns human-readable failures; an empty list means the case passed. */
export function checkAnswer(testCase: EvalCase, answer: EvaluatedAnswer): string[] {
  const failures: string[] = [];
  const text = answer.content.toLowerCase();
  const { expect } = testCase;

  if (expect.intent && answer.intent !== expect.intent) failures.push(`intent is "${answer.intent}", expected "${expect.intent}"`);
  if (expect.intentIn && !expect.intentIn.includes(answer.intent as never)) failures.push(`intent is "${answer.intent}", expected one of ${expect.intentIn.join(', ')}`);
  if (expect.status && answer.status !== expect.status) failures.push(`status is "${answer.status}", expected "${expect.status}"`);
  if (expect.citesAny && !answer.sources.some((source) => expect.citesAny!.includes(source.url))) {
    failures.push(`cites none of ${expect.citesAny.join(', ')}`);
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
