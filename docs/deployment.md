# Deployment (M7)

```
Browser ──► (frontend, M9: Vercel) ──► Render web service "qobo-support-api"
                                          │  Express 5 on Node 24, free plan, Singapore
                                          ▼
                              Supabase "qobo-prod" (South Asia / Mumbai)
                              Auth · conversations/messages · pgvector knowledge base

Local machine only: knowledge-base crawl + build (Playwright, DATABASE_URL, CA certificate)
```

Two Supabase projects: **`qobo-dev`** for development, tests and eval; **`qobo-prod`** for the deployed demo. They never share data or keys.

## 1. Push the repository to GitHub

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

The repo contains no secrets: everything sensitive lives in git-ignored `.env` files and in Render's environment.

## 2. Create the `qobo-prod` Supabase project

Follow [supabase-setup.md](supabase-setup.md) again with the name `qobo-prod`:

- Region **South Asia (Mumbai)**; save the database password.
- **JWT Keys:** asymmetric (ECC/RSA), not the legacy HS256 secret.
- **Email:** sign-ups on, **confirm email off**, minimum password length 8, letters and digits.
- **Anonymous sign-ins off.**
- Copy the **publishable** and **secret** keys (`sb_publishable_…`, `sb_secret_…`).

Apply the migrations, from the repository root:

```bash
npx supabase@2.117.0 link --project-ref <prod-project-ref>
npx supabase@2.117.0 db push
```

**Then link back to dev**, because `npm run test:hosted` creates and deletes users in the linked project:

```bash
npx supabase@2.117.0 link --project-ref <dev-project-ref>
```

## 3. Build the knowledge base in production

The API never crawls or embeds; it only reads. Fill `api/.env.prod` (git-ignored; copy from `.env.prod.example`) with the **prod** database URL (Connect → Session pooler), the prod CA certificate path, the prod Supabase URL and secret key, and your Gemini key. Then:

```bash
cd api
npm run ingest:build:prod     # chunks + embeds the reviewed snapshots into qobo-prod
npm run ingest:verify:prod    # prints chunk count and top matches for sample questions
```

Expect about 119 chunks and roughly 1.5 minutes (the embedding rate limiter stays under the free-tier quota).

## 4. Create the Render service

1. **Render Dashboard → New → Blueprint**, select the repo. Render reads [`render.yaml`](../render.yaml): a free Node web service, root directory `api`, build `npm ci --include=dev && npm run build`, start `npm start`, health check `/api/health`, Singapore region.
2. Render prompts for the values marked `sync: false`:

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL` | `https://<prod-ref>.supabase.co` |
   | `SUPABASE_PUBLISHABLE_KEY` | prod `sb_publishable_…` |
   | `SUPABASE_SECRET_KEY` | prod `sb_secret_…` |
   | `GEMINI_API_KEY` | billing-enabled key |
   | `TAVILY_API_KEY` | `tvly-…` |
   | `CORS_ORIGINS` | the frontend origin, e.g. `https://qobo-chat.vercel.app` (exact, no trailing slash). Until the frontend exists, use the planned URL and update it in M9. |

   Everything else (models, caps, limits, timeouts, `TRUST_PROXY_HOPS=1`) comes from the blueprint. **Never set `DATABASE_URL` or `DATABASE_CA_CERT_PATH` on Render**: those are for local ingestion only.
3. Apply, and watch the first deploy. On boot the API logs `knowledge base ready` with the chunk count; it **refuses to start** if the knowledge base was embedded with a different model, and warns if it is empty.
4. Note the service URL, `https://<service>.onrender.com`.

## 5. Keep the API and database awake

Render free services sleep after 15 minutes idle (about a minute to wake) and Supabase free projects pause after a week of inactivity. [`.github/workflows/keepalive.yml`](../.github/workflows/keepalive.yml) pings `/api/health?deep=1` every 12 minutes, which touches the database and keeps both awake.

Set it up: repository → **Settings → Variables → Actions → New variable**, `API_BASE_URL = https://<service>.onrender.com`. Run it once from the Actions tab to confirm.

Caveats: GitHub can delay scheduled runs, and disables schedules in public repositories after 60 days without activity. For a demo that must always answer instantly, use an uptime monitor or Render's cheapest paid instance instead.

## 6. Smoke test the deployment

Copy `api/.env.smoke.example` to `api/.env.smoke` (git-ignored) and fill in the **prod** Supabase URL, publishable key, secret key and the allowed origin. Then:

```bash
cd api
npm run smoke -- https://<service>.onrender.com --origin=https://qobo-chat.vercel.app
```

It checks health (allowing a cold start), the deep database check, security headers, 401s on `/api/conversations` and `/api/chat`, the JSON 404, the CORS allowlist, and then one real chat turn: small talk, saved conversation, retry replay and delete. It creates one throwaway user and deletes it afterwards.

## Operations

| Task | How |
| --- | --- |
| Logs | Render → service → Logs. Structured JSON, one line per request, with `requestId`; message text is never logged. |
| Roll back | Render → Deploys → pick the previous successful deploy → Rollback. Or `git revert` and push (auto-deploy on commit). |
| Update content | Re-run the crawl, review the snapshot diff, then `npm run ingest:build:prod`. The knowledge base is replaced in one transaction, so the API keeps serving the old one until it succeeds. |
| Rotate a key | Change it in Render's environment and redeploy. Rotate Supabase keys in the dashboard; update both Render and your local `.env` files. |
| Change caps | `USER_DAILY_MESSAGE_CAP`, `WEB_SEARCH_DAILY_CAP`, `API_RATE_LIMIT_PER_MINUTE`, `CHAT_RATE_LIMIT_PER_MINUTE` in Render. |
| Frontend goes live (M9) | Set `CORS_ORIGINS` to the deployed frontend origin and redeploy. |

### Free-tier limits worth remembering

- **Render:** sleeps after 15 minutes idle; about 1 minute to wake; 512 MB RAM; 750 instance hours a month (one always-on service fits).
- **Supabase:** pauses after 7 days of inactivity; 2 active projects, which `qobo-dev` and `qobo-prod` use up.
- **Gemini:** embeddings are limited client-side to 90 requests/minute; `gemini-3.7-flash` falls back to `gemini-3.5-flash-lite` when it is overloaded.
- **Tavily:** 1,000 credits a month, 1 per general question, capped by `WEB_SEARCH_DAILY_CAP`.
- **In-memory rate limits** reset when the instance restarts or wakes; the per-user daily cap lives in Postgres and does not.
