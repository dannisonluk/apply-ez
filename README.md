# apply-ez

Standalone job scraper for Hong Kong corporate careers sites, plus the foundation
for a user-triggered assisted-apply flow.

Extracted from the `ineedajob` (9to6.hk) monorepo. See [`docs/RESEARCH.md`](docs/RESEARCH.md)
for the full architecture, hosting comparison, and auto-apply feasibility analysis.

## What this does

- Scrapes 12 Hong Kong employer careers sites every 4 hours via GitHub Actions
- Normalises, de-duplicates, backfills missing fields, and enriches each posting
- Summarises every **new** posting with an LLM (deadline, YOE, skills, caveats)
- Upserts into Supabase Postgres, tracking `first_seen_at` so the app can show
  exactly which jobs are new
- Daily full crawl detects and expires removed postings

## Layout

```
packages/scraper-core     scraper engine (adapters, pipeline, backfill, LLM, Supabase writer, CLI)
supabase/migrations       Postgres schema
.github/workflows         scheduled scraping
docs/RESEARCH.md          architecture + decisions
```

## Setup

### 1. Database

Create a Supabase project, then run `supabase/migrations/0001_init.sql` in the
SQL editor.

### 2. Local run

```bash
pnpm install
pnpm --filter @apply-ez/scraper-core exec playwright install chromium
cp .env.example .env          # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
```

Inspect what a target would produce, without touching the database:

```bash
pnpm --filter @apply-ez/scraper-core exec tsx src/cli.ts --list
pnpm --filter @apply-ez/scraper-core exec tsx src/cli.ts --target=towngas --dry-run
```

Write to Supabase:

```bash
pnpm --filter @apply-ez/scraper-core exec tsx src/cli.ts --target=towngas
pnpm --filter @apply-ez/scraper-core exec tsx src/cli.ts            # all targets
pnpm --filter @apply-ez/scraper-core exec tsx src/cli.ts --full     # full crawl + reconcile
```

### 3. CI

Add repository secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`OPENROUTER_API_KEY` (the last one is optional — without it new jobs stay
`PENDING` and are summarised on a later run).
`.github/workflows/scrape.yml` then runs every 4 hours.

> **The repository must stay public.** GitHub Actions is unlimited only on public
> repos. A private repo on the Free plan gets 2,000 minutes/month, and 12 targets
> × 6 runs/day is roughly 3,000–4,500 minutes/month.

## Pipeline order

Order matters here — two steps depend on running before another one:

```
adapter.scrape()
  → backfillRawJobs()        must run BEFORE the pipeline strips `description`
  → prepareJobsForIngest()   normalise + validate + de-duplicate; drops deep-content fields
  → enrichJobsWithSummary()  deterministic classification/tags
  → standardizeJobs()
  → enrichJobs()             LLM; reads the RAW jobs, since `description` is gone by now
  → store.upsertJobs()
```

`src/lib/llm/` holds the enrichment layer:

| File | Role |
| --- | --- |
| `schema.ts` | Tool contract, prompt, and the per-field normalisers |
| `openrouter.ts` | OpenRouter client — tool calling, retry policy, quota headers |
| `enrich.ts` | Orchestrator — new-jobs-only, capped, concurrency-limited, fail-soft |

### Why tool calling, not JSON mode

Measured on 2026-09-22 for the two free models in play:

| | Nemotron 3.5 Lightning | Qwen3.8 27B |
| --- | --- | --- |
| Intelligence Index | 12.9 | **33.7** |
| AA-LCR | 60.3% | **82.0%** |
| Non-hallucination | 62.4% | **69.7%** |
| Tool-call error rate | 2.60% | **0.21%** |
| Structured-output error rate | — | **34.12%** |

Qwen is the primary and Nemotron the fallback. The structured-output number is the
reason the whole layer is built on `tool_choice` rather than
`response_format: json_schema` — JSON mode fails roughly one job in three, tool
calling fails about one in five hundred.

### Cost and safety

- Only **new** jobs are summarised, so each posting costs one call in its lifetime.
  A job whose attempt failed is retried on a later run (`enrich_status` is
  `PENDING`/`FAILED`, and `listEnrichmentPendingIds` finds them).
- `OPENROUTER_MAX_JOBS_PER_RUN` caps each target per run so one full crawl cannot
  drain the daily quota. Leftover jobs stay `PENDING` for the next run.
- Free models require enabling prompt logging, so prompts are retained. **Only
  public job-posting text is ever sent.** Resumes and profile data must never be.
- The layer is fail-soft: any error leaves the job `PENDING` and the scrape
  continues. Enrichment can never fail a scrape run.
- The LLM's `deadline` is stored in `extracted`, **not** in `application_deadline`.
  A hallucinated date must not land in a first-class column the app shows as fact.
- Validation is strict about *presence* and lenient about *format*: a malformed
  `deadline` drops that one field instead of discarding an otherwise good summary.

## Field coverage

Adapters differ a lot in what their listing pages expose. `src/lib/job-backfill.ts`
runs between the adapter and the pipeline and recovers the common gaps from the
title and detail-page text. Measured on real dry runs — two very different sources:

| Field | Towngas (custom CMS) | AIA (Workday) |
| --- | --- | --- |
| `location` | 10/10 → 10/10 | 40/40 → 40/40 |
| `experienceMin` | **0/10 → 10/10** | **0/40 → 26/40** |
| `department` | **0/10 → 7/10** | **0/40 → 17/40** |
| `applicationDeadline` | 10/10 → 10/10 | 0/40 → 0/40 |
| `employmentType` | **0/10 → 1/10** | 40/40 → 40/40 |

Read as *adapter alone → after backfill*.

- No adapter extracts `experienceMin` at all — the backfill layer is what makes it
  exist. On AIA it recovers 26 of 40 from the JD body.
- AIA never exposes a deadline, so 0/40 is the honest answer, not a bug. The field
  stays null rather than being invented.
- `employmentType` stays low on Towngas because those postings simply do not state
  it. The AIA adapter sets it directly, which is why backfill has nothing to do there.
- `location` is 0 filled on both because the adapters already provide it.

Run the regression checks:

```bash
pnpm --filter @apply-ez/scraper-core check          # both suites
pnpm --filter @apply-ez/scraper-core check:backfill # 40 assertions
pnpm --filter @apply-ez/scraper-core check:llm      # 91 assertions
```

`check:llm` runs the real OpenRouter client against a local mock server, so the
tool-call path, the 429 retry, and the "don't retry a 400" rule are all verified
without spending any quota.

## Not built yet

- Expo app (SDK 54)
- Assisted-apply flow (WebView autofill + Cloudflare R2 resumes)
