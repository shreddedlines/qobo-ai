# QOBO AI Customer Support Chatbot

An AI support assistant for [QOBO](https://qobo.dev/) that answers questions grounded in QOBO's own website, redirects unrelated requests, and uses cited web research for general questions about websites and digital business.

> **Status:** live.
> Frontend: <https://web-lake-two-86.vercel.app>
> API: <https://qobo-support-api.onrender.com> (health: `/api/health`).
> See [deployment](docs/deployment.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| `api/` | Express 5 + TypeScript backend (Node 24): auth verification, chat pipeline, RAG, ingestion scripts |
| `supabase/migrations/` | Postgres schema, grants, Row Level Security, SQL functions |
| `kb/` | Knowledge-base crawl config, reviewed page snapshots of qobo.dev |
| `eval/` | Evaluation questions and generated result reports |
| `docs/` | Guides: [Supabase setup](docs/supabase-setup.md), [knowledge base](docs/knowledge-base.md), [chat and answer pipeline](docs/answer-pipeline.md), [HTTP API](docs/api.md), [deployment](docs/deployment.md) |
| `render.yaml`, `.github/workflows/` | Render blueprint, CI checks and the keep-alive ping |
| `web/` | React 19 + Vite frontend: Supabase auth, chat with citations, conversation history and renaming, message editing, a collapsible sidebar, light/dark themes |

## What the app does

- **Accounts:** email and password sign-up, sign-in and sign-out through Supabase Auth; every API call carries the signed-in user's own token.
- **QOBO-grounded answers:** questions about QOBO are answered from a vector search over reviewed snapshots of qobo.dev, and the assistant says so when its sources don't cover the question.
- **Web research:** general questions about websites and digital business are answered from cited web results; unrelated requests are redirected.
- **Sources:** every answer lists the pages it drew on, labelled as QOBO's website or general web research, with links.
- **Conversation history:** conversations and their messages persist per user, grouped by recency in the sidebar and restored on reload.
- **Edit a sent message:** editing one of your own messages replaces that message *and* its reply in place, in the same conversation — nothing is appended and no old version is kept.
- **Rename a conversation:** conversations can be given a name from the sidebar, which persists across reloads.
- **Collapsible sidebar:** the sidebar can be hidden so the conversation takes the full width; the preference is remembered. Below desktop width it becomes a drawer.
- **Generating indicator:** an animated indicator appears as soon as a message is sent and stays until the reply or an error arrives. Replies are not streamed.
- **Keyboard and theme support:** full keyboard navigation, screen-reader announcements, and light/dark themes that follow the system setting or a manual toggle.

## Stack

- **Backend:** Node 24, Express 5, TypeScript, zod, pino
- **Database/Auth:** Supabase Auth, Postgres, pgvector
- **AI:** Gemini (routing, answers, `gemini-embedding-2` embeddings), Tavily (web research)
- **Ingestion:** Playwright (qobo.dev is a client-rendered SPA)
- **Frontend:** React 19, Vite, TypeScript, Tailwind 4, react-router; no UI framework and no Markdown dependency (replies are parsed to React elements, so no HTML from the model is ever inserted)
- **Hosting:** Render (API, live), Vercel (frontend, configured in `web/vercel.json`)
- **Tests:** Node's built-in test runner (`node:test`) + supertest

## Backend quick start

```bash
cd api
npm install
cp .env.example .env   # fill in real values
npm run dev            # http://localhost:8080/api/health
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs `src/server.ts` directly with Node type stripping and file watching |
| `npm test` | Unit, API and database tests (migrations run in-process on PGlite; no network) |
| `npm run test:hosted` | Security + API tests against a real Supabase **dev** project (see [docs/supabase-setup.md](docs/supabase-setup.md)) |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm run build` && `npm start` | Compiles to `dist/` and runs the production build |
| `npm run ingest:crawl` | Renders qobo.dev in headless Edge and writes reviewable snapshots to `kb/snapshots/` |
| `npm run ingest:build` | Chunks, embeds (rate-limited, retries 429s) and loads reviewed snapshots into Supabase (`--dry-run` for stats only) |
| `npm run ingest:verify` | Checks the stored knowledge base and prints top retrieval matches for sample questions |
| `npm run ask -- "message"` | Sends one message through the full chat pipeline (router, QOBO answers, web research, redirects) |
| `npm run eval` | Runs `eval/questions.yaml` through the live chat pipeline (`--tags routing,web` for subsets); reports go to git-ignored `eval/results/` |
| `npm run smoke -- <url>` | Smoke-tests a deployed API (health, auth, CORS, one real chat turn) |
| `npm run ingest:build:prod` / `ingest:verify:prod` | Builds and verifies the knowledge base in the production project |

Environment variables are documented in [`api/.env.example`](api/.env.example) and validated at startup; the server refuses to start with missing or malformed configuration.

## Frontend quick start

```bash
cd web
npm install
cp .env.example .env.local   # fill in real values
npm run dev                  # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on port 5173 (the API's `CORS_ORIGINS` must include `http://localhost:5173`) |
| `npm test` | Unit tests for validation, auth error mapping, route guards, Markdown and citation parsing, chat state, history grouping and themes |
| `npm run typecheck` / `npm run lint` | Static checks (TypeScript project references; ESLint with the React Compiler rules) |
| `npm run build` | Type-checks, builds to `dist/`, then scans the bundle for server secrets and fails if it finds any |
| `npm run preview` | Serves the production build locally on port 5173 |
| `npm run verify:bundle` | Re-runs the secret scan against an existing `dist/` |
| `npm run smoke -- <url>` | Smoke-tests a deployed frontend: single-page rewrite, caching, bundle/API wiring, security headers, CORS, no leaked secrets |

Three variables are required at **build** time, because Vite inlines them (see [`web/.env.example`](web/.env.example)):

| Variable | Value |
| --- | --- |
| `VITE_API_BASE_URL` | `https://qobo-support-api.onrender.com` |
| `VITE_SUPABASE_URL` | The Supabase project URL for the environment being built |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The project's **publishable** key (`sb_publishable_…`) |

Only these three reach the browser. The app refuses to start if `VITE_SUPABASE_PUBLISHABLE_KEY` holds a secret key (`sb_secret_…`), and `npm run build` fails if any server secret ends up in the bundle. Every AI, search and service-role credential stays on the API.

## Evaluation

`npm run eval` sends every case in [`eval/questions.yaml`](eval/questions.yaml) through the live chat pipeline and scores it with rule-based assertions: the router's intent, the reply's status, expected and forbidden content, and the pages cited. A newer grounding check resolves every QOBO citation against the reviewed page list in `kb/snapshots/manifest.json`, so an invented `qobo.dev` URL fails the case — something no substring check can catch. There are no reference answers and no model-as-judge, so these are pass/fail assertions rather than a measure of answer quality.

Latest full run (2026-09-20), **34 of 34 cases passed** — a 100% pass rate against those assertions:

| Tag | Passed | Tag | Passed |
| --- | --- | --- | --- |
| QOBO | 19/19 | Off-topic | 8/8 |
| Routing | 17/17 | Web | 4/4 |
| Pricing | 8/8 | Smalltalk | 3/3 |
| Statistics | 2/2 | | |

- **Citations:** 21 of the 34 cases use the citation/grounding assertions (`citesAll`, `citesOnly`, `maxSources`, `groundedInKb`). Across them, **41 individual QOBO citations** were resolved against the approved 25-page knowledge base, with **0 fabricated QOBO URLs**.
- **Static and unit checks:** 329/329 API tests pass; typecheck and lint pass.

> **Which model this measured.** That run was served almost entirely by the fallback `gemini-3.5-flash-lite`; only `pricing-free-trial` was answered by the configured primary `gemini-3.7-flash`. The 34/34 result is therefore **not** a benchmark of `gemini-3.7-flash`.

## Deployed architecture

```
Browser ──► Vercel (static React build, web/)
               │  fetch with the user's Supabase access token
               ▼
          Render (Express API, api/)  ──► Supabase Postgres + pgvector (RLS)
               │                      └─► Supabase Auth (JWT verified via signing keys)
               ├─► Gemini  (routing, answers, embeddings)
               └─► Tavily  (web research for general questions)
```

The browser never talks to Gemini, Tavily or Postgres, and never holds anything but the publishable key and the signed-in user's own token.
