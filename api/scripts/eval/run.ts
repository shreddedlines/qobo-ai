/**
 * Runs eval/questions.yaml through the live chat pipeline (router, QOBO answers,
 * web research, fixed redirects) and writes a report.
 *
 *   npm run eval                              # every case
 *   npm run eval -- --tags routing,web        # subsets by tag
 *   npm run eval -- --only pricing-cost       # single case
 *
 * Paces requests (EVAL_DELAY_MS, default 6000) to stay within free-tier quotas.
 * Exits with code 1 when any case fails.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

import type { ChatReply } from '../../src/chat/chat-service.ts';
import { loadEnv } from '../../src/config/env.ts';
import { createChatRuntime } from '../../src/rag/setup.ts';
import { checkAnswer, evalSuiteSchema, type EvalCase } from './lib/checks.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function argValues(flag: string): string[] {
  const index = process.argv.indexOf(flag);
  return index === -1 ? [] : (process.argv[index + 1] ?? '').split(',').filter(Boolean);
}

interface CaseResult {
  testCase: EvalCase;
  answer?: ChatReply;
  error?: string;
  failures: string[];
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

async function main(): Promise<void> {
  const suite = evalSuiteSchema.parse(parse(await readFile(path.join(repoRoot, 'eval', 'questions.yaml'), 'utf8')));
  const tags = argValues('--tags');
  const only = argValues('--only');
  const cases = suite.filter((c) => (only.length === 0 || only.includes(c.id)) && (tags.length === 0 || c.tags.some((tag) => tags.includes(tag))));
  if (cases.length === 0) throw new Error('No eval cases match the filters');

  const env = loadEnv({ ...process.env, LOG_LEVEL: 'silent' });
  const { chatService } = createChatRuntime(env);
  const delayMs = Number(process.env.EVAL_DELAY_MS ?? 6_000);

  const results: CaseResult[] = [];
  for (const [index, testCase] of cases.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const answer = await chatService.respond({ message: testCase.question, history: testCase.history });
      const failures = checkAnswer(testCase, answer);
      results.push({ testCase, answer, failures });
      console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${testCase.id} [${answer.intent}]${failures.length ? `: ${failures.join('; ')}` : ''}`);
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

  const byTag = new Map<string, { passed: number; total: number }>();
  for (const result of results) {
    for (const tag of result.testCase.tags) {
      const entry = byTag.get(tag) ?? { passed: 0, total: 0 };
      entry.total++;
      if (result.failures.length === 0) entry.passed++;
      byTag.set(tag, entry);
    }
  }

  const markdown = [
    `# Eval results (${label})`,
    '',
    `- Run: ${new Date().toISOString()}`,
    `- Models: router ${env.GEMINI_ROUTER_MODEL}, answer ${env.GEMINI_ANSWER_MODEL} (fallback ${env.GEMINI_ANSWER_FALLBACK_MODEL || 'none'}), embeddings ${env.GEMINI_EMBEDDING_MODEL}`,
    `- Retrieval: top ${env.KB_MATCH_COUNT}, min similarity ${env.KB_MIN_SIMILARITY}`,
    `- **Passed ${passed}/${results.length}**; by tag: ${[...byTag].map(([tag, s]) => `${tag} ${s.passed}/${s.total}`).join(', ')}`,
    '',
    '| Case | Result | Intent (router) | Status | Path outcome | Web search | Model | Latency | Guards | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => {
      const m = r.answer?.metadata;
      const pathMeta = m?.qobo ?? m?.general;
      const guards = [...(m?.qobo?.guards ?? []), ...(m?.general?.guards ?? [])].join(', ');
      return [
        r.testCase.id,
        r.failures.length === 0 ? 'PASS' : 'FAIL',
        r.answer ? `${r.answer.intent} (${m!.router.source})` : 'error',
        r.answer?.status ?? '—',
        pathMeta?.outcome ?? '—',
        m?.general ? `${m.general.webSearch} (${m.general.webResultCount})` : '—',
        pathMeta?.model ?? m?.router.model ?? '—',
        m ? `${m.latencyMs}ms` : '—',
        guards || '—',
        escapeCell(r.failures.join('; ')) || '—',
      ]
        .map((cell) => ` ${cell} `)
        .join('|')
        .replace(/^/, '|')
        .concat('|');
    }),
    '',
    '## Answers',
    ...results.flatMap((r) => [
      '',
      `### ${r.testCase.id}`,
      '',
      ...r.testCase.history.map((turn) => `_${turn.role}:_ ${turn.content}`),
      `**Q:** ${r.testCase.question}`,
      '',
      r.answer ? r.answer.content : `_Error: ${r.error}_`,
      '',
      ...(r.answer?.sources.map((s, i) => `${i + 1}. (${s.kind}) [${s.title}](${s.url})`) ?? []),
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
