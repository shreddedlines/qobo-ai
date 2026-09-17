import { z } from 'zod';

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  tags: z.array(z.string()).min(1),
  question: z.string().min(1),
  expect: z.object({
    status: z.enum(['answered', 'insufficient']).optional(),
    citesAny: z.array(z.url()).optional(),
    containsAll: z.array(z.string()).optional(),
    containsAny: z.array(z.string()).optional(),
    notContains: z.array(z.string()).optional(),
  }),
});

export const evalSuiteSchema = z.array(evalCaseSchema).min(1);
export type EvalCase = z.infer<typeof evalCaseSchema>;

export interface EvaluatedAnswer {
  status: string;
  content: string;
  sources: Array<{ url: string }>;
}

/** Returns human-readable failures; an empty list means the case passed. */
export function checkAnswer(testCase: EvalCase, answer: EvaluatedAnswer): string[] {
  const failures: string[] = [];
  const text = answer.content.toLowerCase();
  const { expect } = testCase;

  if (expect.status && answer.status !== expect.status) failures.push(`status is "${answer.status}", expected "${expect.status}"`);
  if (expect.citesAny && !answer.sources.some((source) => expect.citesAny!.includes(source.url))) {
    failures.push(`cites none of ${expect.citesAny.join(', ')}`);
  }
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
