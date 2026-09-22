# apply-ez

A Hong Kong job tracker: a scraper that watches 12 corporate careers sites, and an
Android app that lists what is new and drives a user-triggered assisted-apply flow.

Extracted from the `ineedajob` (9to6.hk) monorepo. See [`docs/RESEARCH.md`](docs/RESEARCH.md)
for the full architecture, hosting comparison, and auto-apply feasibility analysis.

## What this does

- Scrapes 12 Hong Kong employer careers sites every 4 hours via GitHub Actions
- Normalises, de-duplicates, backfills missing fields, and enriches each posting
- Summarises every **new** posting with an LLM (deadline, YOE, skills, caveats)
- Upserts into Supabase Postgres, tracking `first_seen_at` so the app can show
  exactly which jobs are new
- Pushes a notification to registered devices when a run finds new jobs
- Daily full crawl detects and expires removed postings
- Expo app: new-job list with filters and search, job detail, settings

## Layout

```
packages/scraper-core     scraper engine (adapters, pipeline, backfill, LLM, push, CLI)
apps/mobile               Expo app (SDK 54)
supabase/migrations       Postgres schema
.github/workflows         scheduled scraping
docs/RESEARCH.md          architecture + decisions
```

**The two projects are deliberately separate npm installs.** `apps/mobile` is not a
pnpm workspace member. Expo's Metro bundler and pnpm's symlinked `node_modules`
need `node-linker=hoisted` to cooperate, and that setting would apply to the whole
repository — including the scraper, whose Playwright/tsx/tsc setup is already
verified working. Since the app and the scraper share no runtime code (they talk
over Supabase's HTTP API), a second install costs nothing and removes a whole class
of build fragility.

## Setup

### 1. Database

Create a Supabase project, then run `supabase/migrations/0001_init.sql` and
`0002_push_tokens.sql` in the SQL editor.

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

### 3. App

```bash
cd apps/mobile
npm install
cp .env.example .env          # fill in EXPO_PUBLIC_SUPABASE_URL + ..._ANON_KEY
npm start
```

The anon key is safe in the app bundle — it is public by design and every table it
can reach is guarded by RLS. The **service-role key must never appear here**; it
belongs only in the scraper's GitHub Actions secrets.

Push notifications need a development build (`npx expo run:android`), not Expo Go:
remote push was removed from Expo Go on Android in SDK 53. Registration fails soft
with an explanatory message, so the rest of the app works either way. Sending also
needs an EAS project id (`eas init`) because `getExpoPushTokenAsync` requires one.

### 4. CI

Add repository secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`OPENROUTER_API_KEY` (optional — without it new jobs stay `PENDING` and are
summarised on a later run). `EXPO_ACCESS_TOKEN` is only needed if Enhanced Push
Security is enabled on the Expo project.
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

## New-job detection

The one rule the whole product depends on:

```
new  ==  first_seen_at > lastOpenedAt
```

- `first_seen_at` is set by the **database default on INSERT** and is deliberately
  absent from the scraper's upsert payload, so a conflict-update cannot clobber it.
- `published_at` must never be used for this. Many careers sites omit it, so the
  scraper falls back to `now()` — which would make every job look new on every run.
- The app captures `lastOpenedAt` at the **start** of a session and only then
  updates it. That is what makes the badge behave: the jobs you are looking at stay
  flagged for this session, and the flag clears the next time you open the app.
- On first launch there is no baseline, so nothing is flagged — the badge starts
  honest at zero rather than claiming the entire backlog is new.

## Push notifications

The scraper sends them, because it is the only thing that knows a run found new
jobs — no separate worker needed.

- Sent only after the write succeeds, so a device is never told about a job that
  failed to persist.
- Tokens Expo reports as `DeviceNotRegistered` are disabled immediately. Leaving
  them enabled would mean retrying dead devices on every run, forever.
- The full crawl has `PUSH_ENABLED=false`. It runs at 03:20 Hong Kong time and can
  surface a large batch of older postings the incremental run never paginated to;
  waking the user for a backfill would be noise.
- Tapping the notification opens the list with the **New** filter applied. The
  scraper does not know the database uuid of what it just wrote, so it sends
  `{ route: 'new-jobs' }` rather than a job id.
- `push_tokens` grants anon INSERT and UPDATE but deliberately **not SELECT** — a
  push token is a capability, so blocking reads stops tokens being harvested from
  the client. Only the service role can list them.

## Timezones

Deadlines are parsed against **Hong Kong time**, not the runtime's timezone.

`new Date('2026-10-31')` is interpreted in the machine's local zone, so the same
posting produced instants eight hours apart on a UTC CI runner versus a UTC+8
development laptop — enough to shift a deadline onto the wrong calendar day in the
app. `src/lib/hk-time.ts` parses explicitly: a date with no time becomes 23:59:59
HKT on that day (so a deadline covers its whole final day), a date with a time
becomes that wall-clock time in HKT, and an explicit zone in the text is respected.

Hong Kong has been UTC+8 with no daylight saving since 1979, so the offset is a
constant and no `Intl` timezone arithmetic is needed.

`check-hk-time.ts` asserts exact ISO strings, which only holds if the parser ignores
the ambient timezone. It is run under two genuinely different zones to prove it —
note that Windows/Node silently ignores IANA names it cannot map, so `TZ=UTC` and
`TZ=EST5EDT` are used rather than `TZ=Asia/Hong_Kong`, which would just be the
machine's own zone.

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
pnpm --filter @apply-ez/scraper-core check          # all four suites, 215 assertions
pnpm --filter @apply-ez/scraper-core check:backfill # 40
pnpm --filter @apply-ez/scraper-core check:hk-time  # 51
pnpm --filter @apply-ez/scraper-core check:llm      # 91
pnpm --filter @apply-ez/scraper-core check:push     # 33

cd apps/mobile && npm run typecheck
```

`check:llm` and `check:push` run the real HTTP clients against local mock servers,
so the tool-call path, the 429 retry policy, and the `DeviceNotRegistered`
classification are all verified without spending API quota or touching a device.

## Not built yet

- Assisted-apply flow (WebView autofill + Cloudflare R2 resumes). Every application
  will require a final manual confirmation — see `docs/RESEARCH.md` §5.
- Resume upload. The three slots (tech / data / general) exist in Settings as
  placeholders.
- No i18n. The UI is English; job postings and AI summaries follow the posting's own
  language.
