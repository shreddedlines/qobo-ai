/**
 * Smoke test for a deployed frontend, over plain HTTP — no browser needed.
 *
 *   node scripts/smoke.mjs https://qobo-support.vercel.app
 *
 * It checks the things that break a static deploy in ways local development never
 * shows: a missing single-page rewrite (deep links 404 on refresh), a bundle built
 * against the wrong API, a stale-cached index.html, missing security headers, and
 * secrets accidentally shipped to the browser.
 */
const [, , rawUrl] = process.argv;
const EXPECTED_API = process.env.EXPECTED_API_ORIGIN ?? 'https://qobo-support-api.onrender.com';

if (!rawUrl) {
  console.error('usage: node scripts/smoke.mjs <deployed-origin>');
  process.exit(2);
}

const origin = new URL(rawUrl).origin;
const results = [];
const check = (name, passed, detail = '') => {
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const get = async (path, options = {}) => {
  const response = await fetch(`${origin}${path}`, { redirect: 'follow', ...options });
  return { response, body: await response.text() };
};

// 1. The app is served at all.
const root = await get('/');
check('the site responds with HTML', root.response.ok && root.body.includes('<div id="root">'), `HTTP ${root.response.status}`);
check('the page keeps its title', root.body.includes('<title>QOBO Support</title>'));

// 2. Deep links work: this is the single-page rewrite.
const deepLink = await get('/chat/11111111-1111-4111-8111-111111111111');
check(
  'a deep link to a conversation serves the app instead of 404',
  deepLink.response.ok && deepLink.body.includes('<div id="root">'),
  `HTTP ${deepLink.response.status}`,
);

// 3. index.html must not be cached, or browsers keep asking for old asset hashes.
const cacheControl = root.response.headers.get('cache-control') ?? '';
check('index.html is not cached', /no-cache|no-store|max-age=0/.test(cacheControl), cacheControl || '(no header)');

// 4. The bundle talks to the expected API, and to nothing unexpected.
const assetPaths = [...root.body.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]);
check('the page references built assets', assetPaths.length > 0, assetPaths.join(', '));

let bundle = '';
for (const path of assetPaths) {
  const asset = await get(path);
  if (!asset.response.ok) check(`asset ${path} is served`, false, `HTTP ${asset.response.status}`);
  bundle += asset.body;
}

check('the bundle is built against the production API', bundle.includes(EXPECTED_API), EXPECTED_API);
// The bundle also contains the development fallback origin as an inert constant: it is
// only used when import.meta.env.DEV is true, and a production build without
// VITE_API_BASE_URL fails to start rather than falling back. Which origin the app
// really calls is verified in the browser, by watching the health request.

// 5. Nothing server-side was inlined into the bundle.
const leaks = [
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]+/],
  ['legacy Supabase JWT key', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
  ['Gemini API key', /AIza[0-9A-Za-z_-]{30,}/],
  ['Tavily API key', /tvly-[A-Za-z0-9_-]{8,}/],
  ['database connection string', /postgres(ql)?:\/\//],
].filter(([, pattern]) => pattern.test(bundle));
check('no server secrets are in the served bundle', leaks.length === 0, leaks.map(([name]) => name).join(', '));
check('the bundle carries a publishable Supabase key', /sb_publishable_[A-Za-z0-9_-]+/.test(bundle));

// 6. Security headers. These come from vercel.json, so `vite preview` does not serve
// them: set SKIP_HEADER_CHECKS=1 when smoking a local preview build.
const headerChecks = [
  ['content-security-policy', /connect-src[^;]*onrender\.com/],
  ['x-content-type-options', /nosniff/],
  ['referrer-policy', /strict-origin/],
];
if (process.env.SKIP_HEADER_CHECKS === '1') {
  console.log('SKIP  security headers (local preview cannot serve vercel.json headers)');
} else {
  for (const [header, expected] of headerChecks) {
    const value = root.response.headers.get(header) ?? '';
    check(`${header} is set`, expected.test(value), value.slice(0, 90) || '(missing)');
  }
}

// 7. The API the bundle points at is awake, and accepts this origin.
const health = await fetch(`${EXPECTED_API}/api/health`);
check('the production API is reachable', health.ok, `HTTP ${health.status} ${(await health.text()).slice(0, 40)}`);

const preflight = await fetch(`${EXPECTED_API}/api/chat`, {
  method: 'OPTIONS',
  headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
});
const allowed = preflight.headers.get('access-control-allow-origin');
check('the API allows this frontend origin (CORS)', allowed === origin, `allow-origin: ${allowed ?? '(none)'} for ${origin}`);

// 8. An unauthenticated call is refused, so nothing is world-readable.
const unauthenticated = await fetch(`${EXPECTED_API}/api/conversations`, { headers: { Origin: origin } });
check('conversations require a signed-in user', unauthenticated.status === 401, `HTTP ${unauthenticated.status}`);

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed for ${origin}`);
process.exit(failed.length === 0 ? 0 : 1);
