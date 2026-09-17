/**
 * Runs eval/questions.yaml against the live answer pipeline and writes a report.
 *
 *   npm run eval -- --tags qobo            # M4 subset
 *   npm run eval -- --only pricing-cost    # single case
 *
 * Paces requests (EVAL_DELAY_MS, default 6000) to stay within free-tier quotas.
 * Exits with code 1 when any case fails.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

import { loadEnv } from '../../src/config/env.ts';
import type { QoboAnswer } from '../../src/rag/qobo-answer.ts';
import { createRagRuntime } from '../../src/rag/setup.ts';
import { checkAnswer, evalSuiteSchema, type EvalCase } from './lib/checks.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function argValues(flag: string): string[] {
  const index = process.argv.indexOf(flag);
  return index === -1 ? [] : (process.argv[index + 1] ?? '').split(',').filter(Boolean);
}

interface CaseResult {
  testCase: EvalCase;
  answer?: QoboAnswer;
  error?: string;
  failures: string[];
}

async function main(): Promise<void> {
  const suite = evalSuiteSchema.parse(parse(await readFile(path.join(repoRoot, 'eval', 'questions.yaml'), 'utf8')));
  const tags = argValues('--tags');
  const only = argValues('--only');
  const cases = suite.filter((c) => (only.length === 0 || only.includes(c.id)) && (tags.length === 0 || c.tags.some((tag) => tags.includes(tag))));
  if (cases.length === 0) throw new Error('No eval cases match the filters');

  const env = loadEnv({ ...process.env, TAVILY_API_KEY: process.env.TAVILY_API_KEY || 'unused-in-m4', LOG_LEVEL: 'silent' });
  const { answerService } = createRagRuntime(env);
  const delayMs = Number(process.env.EVAL_DELAY_MS ?? 6_000);

  const results: CaseResult[] = [];
  for (const [index, testCase] of cases.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const answer = await answerService.answer({ question: testCase.question });
      const failures = checkAnswer(testCase, answer);
      results.push({ testCase, answer, failures });
      console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${testCase.id}${failures.length ? `: ${failures.join('; ')}` : ''}`);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}${error.cause instanceof Error ? ` (${error.cause.message.slice(0, 200)})` : ''}` : String(error);
      results.push({ testCase, error: message, failures: [`error: ${message}`] });
      console.log(`ERROR ${testCase.id}: ${message}`);
    }
  }

  const passed = results.filter((r) => r.failures.length === 0).length;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = only.length ? 'only' : tags.length ? tags.join('+') : 'all';
  const outDir = path.join(repoRoot, 'eval', 'results');
  await mkdir(outDir, { recursive: true });

  const markdown = [
    `# Eval results (${label})`,
    '',
    `- Run: ${new Date().toISOString()}`,
    `- Models: answer ${env.GEMINI_ANSWER_MODEL}, embeddings ${env.GEMINI_EMBEDDING_MODEL}`,
    `- Retrieval: top ${env.KB_MATCH_COUNT}, min similarity ${env.KB_MIN_SIMILARITY}`,
    `- **Passed ${passed}/${results.length}**`,
    '',
    '| Case | Result | Outcome | Top similarity | Guards | Notes |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => {
      const m = r.answer?.metadata;
      return `| ${r.testCase.id} | ${r.failures.length === 0 ? 'PASS' : 'FAIL'} | ${m?.outcome ?? 'error'} | ${m?.retrieval.topSimilarity?.toFixed(3) ?? '—'} | ${m?.guards.join(', ') || '—'} | ${r.failures.join('; ').replace(/\|/g, '\\|') || '—'} |`;
    }),
    '',
    '## Answers',
    ...results.flatMap((r) => [
      '',
      `### ${r.testCase.id}`,
      '',
      `**Q:** ${r.testCase.question}`,
      '',
      r.answer ? r.answer.content : `_Error: ${r.error}_`,
      '',
      ...(r.answer?.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`) ?? []),
    ]),
    '',
  ].join('\n');

  await writeFile(path.join(outDir, `${stamp}-${label}.md`), markdown, 'utf8');
  await writeFile(path.join(outDir, `${stamp}-${label}.json`), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(`\nPassed ${passed}/${results.length}. Report: eval/results/${stamp}-${label}.md`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
