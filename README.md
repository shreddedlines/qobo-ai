# QOBO AI Customer Support Chatbot

An AI support assistant for [QOBO](https://qobo.dev/) that answers questions grounded in QOBO's own website, redirects unrelated requests, and uses cited web research for general questions about websites and digital business.

> **Status:** backend in progress (backend-first MVP). The React frontend is a later, separate milestone.

## Repository layout

| Path | Purpose |
| --- | --- |
| `api/` | Express 5 + TypeScript backend (Node 24): auth verification, chat pipeline, RAG, ingestion scripts |
| `supabase/migrations/` | Postgres schema, grants, Row Level Security, SQL functions |
| `kb/` | Knowledge-base crawl config, reviewed page snapshots of qobo.dev |
| `eval/` | Evaluation questions and generated result reports |
| `docs/` | Guides: [Supabase setup](docs/supabase-setup.md), [knowledge base](docs/knowledge-base.md), [chat and answer pipeline](docs/answer-pipeline.md), [HTTP API](docs/api.md) |
| `web/` | React + Vite frontend (not started) |

## Stack

- **Backend:** Node 24, Express 5, TypeScript, zod, pino
- **Database/Auth:** Supabase Auth, Postgres, pgvector
- **AI:** Gemini (routing, answers, `gemini-embedding-2` embeddings), Tavily (web research)
- **Ingestion:** Playwright (qobo.dev is a client-rendered SPA)
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

Environment variables are documented in [`api/.env.example`](api/.env.example) and validated at startup; the server refuses to start with missing or malformed configuration.
