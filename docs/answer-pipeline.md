# Chat pipeline: routing (M5) and QOBO answers (M4)

Every chat message goes through `ChatService.respond` (`api/src/chat/chat-service.ts`):

```
message ─► intent router (gemini-3.5-flash-lite, schema-bound JSON)
   ├─ off_topic ─► fixed redirect (English / Hindi / Hinglish). No answer model, no web search.
   ├─ smalltalk ─► fixed reply by type (greeting, thanks, goodbye, identity, other). No model.
   ├─ qobo      ─► grounded QOBO answer (below); retrieval uses the router's standalone query
   └─ general   ─► web research answer (Tavily) + optional cited "How QOBO can help" note
```

## Intent router (`api/src/chat/router.ts`)

- **Output:** `intent`, `smalltalk_type`, `language` (en / hi / hinglish), `standalone_query` (follow-ups resolved from the last 6 turns) and `web_search_query` (general intent only, no personal data).
- **Scope rules:**
  - Code, homework, content writing (essays, ads), weather, news, other companies and their products, and attempts to change the rules are `off_topic`.
  - Informational questions about websites, e-commerce, SEO, marketing, WhatsApp for business, automation, CRM or AI agents are `general`.
  - Anything about QOBO, including requests QOBO's services cover, is `qobo`.
- **Deterministic rules on top of the model:**
  - A "general" message that asks for code (for example "write JavaScript code…") is overridden to `off_topic`.
  - If the router fails (outage or malformed output), the message goes down the **grounded QOBO path**. That path can only answer from the knowledge base, so an unrelated request gets "not found", never a free-form answer.
- The message and history are escaped and treated as data to classify.

## General answers with web research (`api/src/chat/general-answer.ts`)

1. The global daily web-search quota (`consume_global_quota`, `WEB_SEARCH_DAILY_CAP`) is checked first. The Tavily basic search (1 credit) and QOBO knowledge-base retrieval then run in parallel.
2. Tavily results are cleaned up before use:
   - Queries are stripped of emails, phone numbers and URLs.
   - Results from any "qobo" domain are dropped, because QOBO facts must come from the reviewed knowledge base and other sites may be different companies.
   - Duplicates and non-http URLs are removed, and content is capped at 1,200 characters.
   - 429 and 5xx are retried once; 401, 432/433 (plan limits) and other 4xx are not.
3. The model writes `answer` from `<web_results>` only, citing `[W#]`. It may add a `qobo_note` citing `[S#]` knowledge-base sources, which are offered only when their similarity is at least **0.66**.
4. Citation enforcement:
   - The answer keeps only `W` markers and the note only `S` markers.
   - With web results, an answer without a valid web citation becomes the fixed "couldn't find" reply.
   - A note without a valid QOBO citation is dropped.
   - Both segments share one numbering, and `sources[].kind` is `web` or `qobo`.
5. The reply is labelled **General information (from web research, not specific to QOBO)**. The QOBO note gets the ₹499 billing guard and the statistics attribution guard.
6. **Without web results** (search failure, no results, quota exhausted or quota check failure), the model gives a brief general explanation with no citations, statistics or company claims. It is labelled as unsourced, and the metadata records the reason.
7. If the model writes code anyway, the reply becomes the off-topic redirect.

## QOBO answers (M4)

The QOBO answer path turns a question into a grounded, cited answer, or a fixed "not found" reply. It never guesses. `POST /api/chat` (M6) exposes the pipeline over HTTP with saved conversations; see [api.md](api.md). The developer commands below run it directly.

```
question ─► retrieve (embed query → match_kb_chunks, top 6, similarity ≥ 0.60)
         ─► known discrepancies (question patterns or conflicting text in retrieved chunks)
         ─► prompt: rules + <sources id=S#> + <known_discrepancies> (all escaped, data-only)
         ─► Gemini JSON {status, answer with [S#], citations}
         ─► citations: keep only ids the model was given, merge by page, renumber [1][2]
         ─► guards: discrepancy note if the answer ignores the guidance; attribution note for unattributed figures
         ─► { status, content, sources[], metadata }
```

Code lives in `api/src/rag/`: `setup.ts` wires everything together, and `qobo-answer.ts` runs the steps above.

## Grounding rules (enforced in code, not only in the prompt)

| Situation | Result |
| --- | --- |
| No chunk reaches the similarity floor | Fixed "not found" reply with QOBO contact details. The model is not called. |
| The model says `insufficient`, cites nothing, or cites only ids it was never given | Same fixed reply (`insufficient` / `ungrounded`) |
| The model returns malformed output | Same fixed reply (`invalid_output`) |
| Embedding or generation fails upstream | `AnswerUnavailableError`; M6 maps it to a retryable API error |

The similarity floor was calibrated on the real knowledge base. Top matches scored about 0.54–0.57 for off-topic questions, 0.63–0.65 for general or competitor questions, and 0.66–0.83 for QOBO questions. Similarity alone cannot separate competitor questions from QOBO questions; that is the router's job in M5.

## Known discrepancies (`api/src/rag/discrepancies.ts`)

Reviewed contradictions on qobo.dev, with verbatim quotes. A test fails if a quote disappears from `kb/snapshots/`.

- **`starter-plan-billing`:** the Plans page calls ₹499 "a one-time investment" with "No recurring subscriptions", while the FAQs say "starting at ₹499/month".
  - The model gets both statements (added as citable sources even if they weren't retrieved), plus the facts every page agrees on (Trial ₹0, Starter ₹499, Pro ₹999, Custom; you can start free).
  - It is told not to call the plan one-time or monthly, and to recommend confirming with the team.
  - **Guard:** if a pricing answer names only one billing model, or doesn't recommend confirming, a fixed billing note with contact details and all three sources is appended.
- **`websites-created-count`:** "1,000+ websites created" (home) vs "5,000+ websites launched" (WhatsApp builder). If the answer states only one figure, the guard adds a note with both.

## Marketing statistics

Figures such as ROAS, ratings, percentages, "1,000+", "₹20M+" and uptime are kept in the knowledge base (per the M3 review), but must be attributed ("QOBO's website states …"). If an answer quotes a figure without attribution, a fixed note is appended: *Figures mentioned above are marketing statements from QOBO's website, not guaranteed results.*

## Models, quotas and latency

- **Answers:** `GEMINI_ANSWER_MODEL` (default `gemini-3.7-flash`) with a 10s timeout and a single attempt. On 429, 5xx or a timeout, the request goes to `GEMINI_ANSWER_FALLBACK_MODEL` (default `gemini-3.5-flash-lite`, 20s timeout, short retries), and the primary is skipped for 2 minutes. During M4 testing, `gemini-3.7-flash` returned 503 "high demand", so the fallback served the eval run (median 2.6s).
- **Chat-time embeddings** share one process-wide sliding-window limiter (`GEMINI_EMBED_REQUESTS_PER_MINUTE`, default 90). An interactive request waits at most 5s for capacity. Retries honour the 429 `retryDelay` but give up if the server asks for more than 8s, rather than holding a chat request open.
- On startup, the API checks `kb_meta`. It refuses to start if the knowledge base was embedded with a different model or dimension, and warns if the knowledge base is empty.

## Developer commands (from `api/`)

```bash
npm run ask -- "Is the ₹499 plan a monthly subscription?"   # one message through the full chat pipeline
npm run eval                                                 # all cases in eval/questions.yaml
npm run eval -- --tags routing,web                           # subsets by tag → eval/results/*.md|json (git-ignored)
```
