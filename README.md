# apply-ez

A Hong Kong job tracker: a scraper that watches 12 corporate careers sites, and an
Android app that lists what is new and drives a user-triggered assisted-apply flow.

Extracted from the `ineedajob` (9to6.hk) monorepo.

## What this does

- Scrapes 12 Hong Kong employer careers sites every 6 hours via GitHub Actions
- Normalises, de-duplicates, backfills missing fields, and enriches each posting
- Scores every job 0-100 for relevance by role family, so cabin crew and bar work do
  not drown the list — scored, never dropped
- Summarises every **new** posting with an LLM (deadline, YOE, skills, caveats)
- Upserts into Supabase Postgres, tracking `first_seen_at` so the app can show exactly
  which jobs are new
- Pushes a notification to registered devices when a run finds new jobs
- A daily full crawl detects and expires removed postings, which the app shows in a
  separate **Closed** view rather than letting them vanish
- Records applications behind two server-verified codes, so every submission needs an
  explicit confirmation
- Expo app: new-job list with filters and search, applied-jobs tab, job detail, settings

## Layout

```
packages/scraper-core     scraper engine (adapters, pipeline, backfill, LLM, push, CLI)
apps/mobile               Expo app (SDK 54)
supabase/migrations       Postgres schema
.github/workflows         scheduled scraping
tools/local-android-build build the APK without the EAS queue
docs/                     design notes — see "Where the detail lives" below
```

**The two projects are deliberately separate npm installs.** `apps/mobile` is not a
pnpm workspace member. Expo's Metro bundler and pnpm's symlinked `node_modules` need
`node-linker=hoisted` to cooperate, and that setting would apply to the whole
repository — including the scraper, whose Playwright/tsx/tsc setup is already verified
working. Since the app and the scraper share no runtime code (they talk over Supabase's HTTP
API), a second install costs nothing and removes a whole class of build fragility.

## Setup

### 1. Database

Create a Supabase project, then run the migrations **in order** in the SQL editor.
There is no `psql` or Supabase CLI in this environment, so this is a manual step.

```
supabase/migrations/0001_init.sql                        tables, indexes, RLS
supabase/migrations/0002_push_tokens.sql                 device push tokens
supabase/migrations/0003_relevance_applications_codes.sql
    relevance columns · EXPIRED made visible · app_settings ·
    app_unlock / record_application / list_applications / set_app_codes
supabase/migrations/0004_dedupe_includes_company.sql
    job uniqueness becomes (company_id, source, external_id)
supabase/migrations/0005_jd_sections.sql
    jd_sections — the posting body as titled sections for the detail page
supabase/migrations/0006_push_token_rpc.sql
    register_push_token / disable_push_token, and anon loses direct table access
```

**0004 must be applied before the scraper code that depends on it is deployed.** The
upsert's conflict target changed to `company_id,source,external_id`, and Postgres
rejects an `ON CONFLICT` that matches no constraint — so running the new code against
the old schema fails every write with `42P10`, rather than degrading.

Then push the two application codes to the server:

```bash
pnpm --filter @apply-ez/scraper-core sync:codes
```

See [`OPERATIONS.md`](docs/OPERATIONS.md#application-codes-and-applied-jobs) for what
the codes gate and how they are verified.

### 2. Scraper

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

The anon key is safe in the app bundle — it is public by design and every table it can
reach is guarded by RLS. The **service-role key must never appear here**; it belongs
only in the scraper's GitHub Actions secrets.

Building and shipping the APK is in [`MOBILE.md`](docs/MOBILE.md).

### 4. CI

Add repository secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`OPENROUTER_API_KEY` (optional — without it new jobs stay `PENDING` and are summarised
on a later run). `EXPO_ACCESS_TOKEN` is only needed if Enhanced Push Security is enabled
on the Expo project. `.github/workflows/scrape.yml` then runs every 6 hours.

> **The repository must stay public.** GitHub Actions is unlimited only on public repos.
> A private repo on the Free plan gets 2,000 minutes/month, and 12 targets × 6 runs/day
> is roughly 3,000–4,500 minutes/month.

## Where the detail lives

| Doc | Read it for |
| --- | --- |
| [`RESEARCH.md`](docs/RESEARCH.md) | The original architecture, hosting comparison and auto-apply feasibility analysis |
| [`OPERATIONS.md`](docs/OPERATIONS.md) | Pipeline order; what counts as new; what counts as expired; push; timezones; the application codes |
| [`SCRAPING.md`](docs/SCRAPING.md) | Incremental crawls, backfill, the structured-source-first strategy, politeness, Hong Kong scope, job descriptions |
| [`ADAPTERS.md`](docs/ADAPTERS.md) | Per-platform traps — Workday, Eightfold, Oracle — and the Cathay case study |
| [`RELEVANCE.md`](docs/RELEVANCE.md) | The 0-100 score, the LLM enrichment layer, and why classification stays deterministic |
| [`MOBILE.md`](docs/MOBILE.md) | Running the app, building the APK (EAS and local), push registration |
| [`DEVELOPMENT.md`](docs/DEVELOPMENT.md) | The regression checks and what each one protects against |

## Not built yet

- Assisted-apply flow (WebView autofill + Cloudflare R2 resumes). Every application
  will require a final manual confirmation — see `docs/RESEARCH.md` §5. The two-code
  gate and the application record are built; the autofill is not.
- Resume upload. The three slots (tech / data / general) exist in Settings as
  placeholders, and the apply panel already records which one was used.
- No i18n. The UI is English; job postings and AI summaries follow the posting's own
  language.
- Relevance uses the deterministic rules only. The LLM layer contributes seniority and
  years-of-experience, which feed the score, but role-family classification stays
  deterministic on purpose — one source of truth for the family, so the two layers
  cannot disagree.
