/**
 * Sends one message through the full chat pipeline (router → QOBO answers, web
 * research, fixed redirects) against the real knowledge base, Gemini and Tavily.
 *
 *   npm run ask -- "Is the ₹499 plan a monthly subscription?"
 */
import { EnvValidationError, loadEnv } from '../../src/config/env.ts';
import { createChatRuntime } from '../../src/rag/setup.ts';

async function main(): Promise<void> {
  const message = process.argv.slice(2).join(' ').trim();
  if (!message) throw new Error('Usage: npm run ask -- "your message"');

  const { chatService } = createChatRuntime(loadEnv());
  const reply = await chatService.respond({ message });

  console.log(`\n[${reply.intent} / ${reply.status}]\n\n${reply.content}\n`);
  reply.sources.forEach((source, index) => console.log(`[${index + 1}] (${source.kind}) ${source.title} — ${source.url}`));
  console.log(`\n${JSON.stringify(reply.metadata)}`);
}

main().catch((error: unknown) => {
  if (error instanceof EnvValidationError) console.error(error.message);
  else console.error(error);
  process.exitCode = 1;
});
