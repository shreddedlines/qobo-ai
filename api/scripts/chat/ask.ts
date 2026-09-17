/**
 * Asks the QOBO answer pipeline a question against the real knowledge base and Gemini.
 * Developer tool for M4 (the router and HTTP chat endpoint arrive in M5/M6).
 *
 *   npm run ask -- "Is the ₹499 plan a monthly subscription?"
 */
import { EnvValidationError, loadEnv } from '../../src/config/env.ts';
import { createRagRuntime } from '../../src/rag/setup.ts';

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) throw new Error('Usage: npm run ask -- "your question"');

  // Tavily is not used by the QOBO answer path; allow a placeholder until M5.
  const env = loadEnv({ ...process.env, TAVILY_API_KEY: process.env.TAVILY_API_KEY || 'unused-in-m4' });
  const { answerService } = createRagRuntime(env);
  const answer = await answerService.answer({ question });

  console.log(`\n${answer.content}\n`);
  answer.sources.forEach((source, index) => console.log(`[${index + 1}] ${source.title} — ${source.url}`));
  console.log(`\n${JSON.stringify({ status: answer.status, ...answer.metadata })}`);
}

main().catch((error: unknown) => {
  if (error instanceof EnvValidationError) console.error(error.message);
  else console.error(error);
  process.exitCode = 1;
});
