# Knowledge base: crawl → review → build

The chatbot answers QOBO questions only from a knowledge base built from https://qobo.dev. The site is a client-rendered React app, so plain HTTP fetching returns an empty page. Ingestion therefore uses a real browser. The pipeline has a human review step so that nothing unreviewed reaches the bot.

```
kb/ingest.config.yaml ──► npm run ingest:crawl ──► kb/snapshots/*.md + manifest.json ──► (review the git diff)
                                                                                          │
                          npm run ingest:build ◄───────────────────────────────────────────┘
                          chunk → embed (gemini-embedding-2, 768d) → replace private.kb_chunks in one transaction
```

## 1. Crawl (`npm run ingest:crawl`, from `api/`)

- **Discovery:** the sitemap, plus `extraPaths` (live routes the sitemap omits), plus same-site links found on rendered pages.
- **Browser:** headless **Microsoft Edge** by default on Windows. Application-control policies can block Playwright's downloaded Chromium, and the installed Edge is signed. Override with `INGEST_BROWSER_CHANNEL=chrome` or `chromium`.
- **Per page:**
  1. Wait for rendering and scroll through the page.
  2. Hide excluded mock-ups.
  3. Expand FAQ toggles and click any configured tabs.
  4. Sample rotating carousels.
  5. Merge all captures in page order.
  6. Record `tel:` / `mailto:` / WhatsApp links, so a call number is never confused with a WhatsApp number.
- **Handled automatically:** client-side redirects (the target is crawled once), soft 404 pages (skipped), duplicate lines from marquees, and CTA and nav text that repeats across pages.
- **Output:** one Markdown snapshot per page, with frontmatter (URL, title, type, content hash), plus `manifest.json` listing pages, redirects, skipped URLs, removed boilerplate and **issues**.

### Issues that block the build

| Issue | Meaning | Typical fix |
| --- | --- | --- |
| `unreviewed_price` | A ₹ amount not in the `prices` allowlist for that page | Real price: add it with a note. Demo/mock-up price: add an `exclude` rule |
| `excluded_content_leaked` | Text from an excluded mock-up is still in the snapshot | Anchor the rule on the widget container, not on rotating text |
| `exclusion_unmatched` | An exclusion rule matched nothing | The site changed; update or remove the rule (or mark it `optional`) |
| `exclusion_too_broad` | A rule would hide more than 40% of the page | Use more specific anchor phrases |
| `content_shrunk` / `too_little_content` | The page lost more than half its text, or almost nothing was extracted | Usually a rendering failure; re-run, then investigate |

The crawl exits with code 1 while issues remain.

## 2. Review

Before building, review the diff of `kb/snapshots/` and `kb/ingest.config.yaml`:

- New or changed **prices** and plan terms (the allowlist notes explain each accepted amount)
- Contradictions between pages, recorded in `kb/discrepancies.yaml` so the bot handles them explicitly
- Leftover demo content (fictional names, example stores, fake ads)
- Missing sections, such as FAQ answers or tab content

## 3. Build (`npm run ingest:build`, from `api/`)

```bash
npm run ingest:build -- --dry-run   # chunk statistics + kb/.build/chunks.preview.json, no keys needed
npm run ingest:build                # embeds and replaces the knowledge base
```

- **Refuses to run** if the manifest has issues or if a snapshot was hand-edited (content hash mismatch). All fixes go through the crawl config, so builds stay reproducible.
- **Chunking** follows headings, targets about 350 estimated tokens and caps at 500. FAQ question-and-answer pairs stay whole. Each chunk starts with `Page:` / `Section:` lines and carries topic tags (`pricing`, `contact`) from the config.
- **Embeddings:**
  - `gemini-embedding-2` at 768 dimensions.
  - Documents use the prefix `title: … | text: …`.
  - Every text is sent as its own `Content` object, because the model otherwise aggregates a list into one vector; the embedder asserts the count and dimension.
- **Quota handling:**
  - A client-side sliding-window limiter keeps embedding requests at or below `GEMINI_EMBED_REQUESTS_PER_MINUTE` (default 90, under the free tier's 100/minute). Each text in a batch counts as one request, and retried attempts count too. At 90/minute, 119 chunks take about 1.5 minutes.
  - HTTP 429 and transient 5xx errors are retried with exponential backoff (up to 6 retries, at most 2 minutes per wait). A 429 waits at least the server's `RetryInfo.retryDelay`. The SDK's own retries are disabled so retries don't stack.
  - **Nothing is written until every chunk has an embedding.** The database connection is only opened after the last batch succeeds, so a quota failure leaves the existing knowledge base untouched.
- **Storage:**
  - One transaction deletes and re-inserts `private.kb_chunks` and upserts `private.kb_meta` (model, dimension, chunk count, crawl time, snapshot reference). A failed build leaves the previous knowledge base untouched.
  - Needs `GEMINI_API_KEY`, `DATABASE_URL` (the Supabase **session pooler** string) and `DATABASE_CA_CERT_PATH` (Supabase → Database settings → SSL configuration → download certificate) in `api/.env`. These variables are for the local build only; never set them on the API host.

## 4. Verify (`npm run ingest:verify`, from `api/`)

Reads `kb_meta`, checks that its embedding model and dimension match the configuration, then embeds sample questions and prints the top matches from `match_kb_chunks`. This is the same retrieval path the API uses. Pass your own questions as arguments:

```bash
npm run ingest:verify -- "Can QOBO build an online store?"
```
