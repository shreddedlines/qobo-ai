/**
 * Refuses to ship a bundle that contains a server-side secret.
 *
 * Vite inlines every VITE_* variable into the built JavaScript, so a mistyped variable
 * name is enough to publish a key to the whole internet. This runs as the last step of
 * `npm run build`, which means it also runs on Vercel: a leak fails the deploy instead
 * of going live.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * Patterns that must never appear in anything served to a browser.
 *
 * These match key *values* and real assignments, not prose: source maps include the
 * comments of dependencies, and @supabase/supabase-js documents `service_role` and
 * `SUPABASE_SECRET_KEY` by name, which is not a leak.
 */
const FORBIDDEN = [
  { name: 'Supabase secret key', pattern: /sb_secret_[A-Za-z0-9_-]{8,}/ },
  { name: 'legacy signed Supabase JWT key', pattern: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  { name: 'Google/Gemini API key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Tavily API key', pattern: /tvly-[A-Za-z0-9_-]{16,}/ },
  { name: 'Postgres connection string with credentials', pattern: /postgres(ql)?:\/\/[^\s"'`]+:[^\s"'`]+@/ },
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: 'server-only variable assigned a value',
    pattern: /["'`]?(SUPABASE_SECRET_KEY|GEMINI_API_KEY|TAVILY_API_KEY|DATABASE_URL)["'`]?\s*[:=]\s*["'`][^"'`\n]{8,}["'`]/,
  },
];

function walk(directory) {
  const entries = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) entries.push(...walk(path));
    else entries.push(path);
  }
  return entries;
}

const TEXT_FILE = /\.(js|mjs|cjs|css|html|json|map|txt|svg)$/i;

let files;
try {
  files = walk(DIST).filter((path) => TEXT_FILE.test(path));
} catch (error) {
  console.error(`check-bundle: cannot read ${DIST} — run the build first.`);
  console.error(String(error));
  process.exit(1);
}

const problems = [];
for (const path of files) {
  const contents = readFileSync(path, 'utf8');
  for (const { name, pattern } of FORBIDDEN) {
    const match = pattern.exec(contents);
    if (match) problems.push({ path: path.replace(DIST, ''), name, sample: `${match[0].slice(0, 12)}…` });
  }
}

// The publishable key is meant to be in the bundle; a secret key never is.
const bundled = files
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')
  .match(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g);
const keyKinds = [...new Set((bundled ?? []).map((key) => key.split('_')[1]))];

if (problems.length > 0) {
  console.error('check-bundle: FAILED — the build contains values that must stay on the server:');
  for (const problem of problems) console.error(`  ${problem.path}: ${problem.name} (${problem.sample})`);
  process.exit(1);
}

console.log(`check-bundle: ${files.length} files scanned, no server secrets found.`);
console.log(`check-bundle: Supabase keys in the bundle: ${keyKinds.length === 0 ? 'none' : keyKinds.join(', ')}`);
