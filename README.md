# apply-ez

A Hong Kong job tracker: a scraper that watches 12 corporate careers sites, and an
Android app that lists what is new and drives a user-triggered assisted-apply flow.

Extracted from the `ineedajob` (9to6.hk) monorepo. See [`docs/RESEARCH.md`](docs/RESEARCH.md)
for the full architecture, hosting comparison, and auto-apply feasibility analysis.

## What this does

- Scrapes 12 Hong Kong employer careers sites every 4 hours via GitHub Actions
- Normalises, de-duplicates, backfills missing fields, and enriches each posting
- Scores every job 0-100 for relevance by role family, so cabin crew and bar work
  do not drown the list — scored, never dropped
- Summarises every **new** posting with an LLM (deadline, YOE, skills, caveats)
- Upserts into Supabase Postgres, tracking `first_seen_at` so the app can show
  exactly which jobs are new
- Pushes a notification to registered devices when a run finds new jobs
- Daily full crawl detects and expires removed postings, which the app shows in a
  separate **Closed** view rather than letting them vanish
- Records applications behind two server-verified codes, so the history is
  persistent and every submission needs an explicit confirmation
- Expo app: new-job list with filters and search, applied-jobs tab, job detail,
  settings

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

Create a Supabase project, then run the migrations in order in the SQL editor:

```
supabase/migrations/0001_init.sql                        tables, indexes, RLS
supabase/migrations/0002_push_tokens.sql                 device push tokens
supabase/migrations/0003_relevance_applications_codes.sql
    relevance columns · EXPIRED made visible · app_settings ·
    app_unlock / record_application / list_applications / set_app_codes
```

Then push the two application codes to the server (see
[Application codes](#application-codes-and-applied-jobs)):

```bash
pnpm --filter @apply-ez/scraper-core sync:codes
```

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

Order matters here, and the ordering is load-bearing in three places:

```
adapter.scrape()
  → backfillRawJobs()        must run BEFORE the pipeline strips `description`
  → prepareJobsForIngest()   normalise + validate + de-duplicate; drops deep-content fields
  → enrichJobsWithSummary()  deterministic classification/tags
  → standardizeJobs()
  → applyRelevance()         role family + 0-100 score, on the finalised rows
  → store.upsertJobs()       ── ingest is complete here ──
  → notifyNewJobs()
  → enrichJobs()             LLM; reads the RAW jobs, since `description` is gone by now
  → applyRelevance() again   re-scored with the model's seniority / YOE reading
  → store.applyEnrichment()  patches the summary and refined score onto existing rows
```

**The database write comes before the LLM stage, deliberately.** Enrichment is the
slowest and least reliable step in a run — a free-tier model can be rate-limited,
geo-blocked, or absent entirely — and a 4-hourly ingest must never be held up by
it. Rows land with `enrich_status = 'PENDING'` and are patched afterwards; anything
the model did not reach stays `PENDING` and is retried on the next run, which is
already how the retry mechanism worked. The `jobs written` log line is emitted
before the first LLM call so the log alone proves the invariant.

## Relevance scoring

Every posting is scored 0-100 against one profile, in `src/lib/relevance.ts`:

| | |
| --- | --- |
| Role targets | **Data Analyst** (`DATA`), **Business Analyst** (`BUSINESS_ANALYST`), **Software Engineering** (`TECH`) |
| Experience | **2–3 years** (`TARGET_YOE_MIN` / `TARGET_YOE_MAX`) |

The three target families sit at the top of `FAMILY_WEIGHT`; adjacent work (product,
finance, risk) stays visible but ranks lower, and families that are almost never a
fit (service, aviation ops) fall below the display threshold. Years of experience is
measured as a distance from the 2–3 year band, so a posting asking for 13+ years is
hidden even when the family is a perfect match.

The score is a pure function of the posting's title, department, seniority and
stated minimum experience. **No resume, CV, or profile data is involved** — which
keeps it reproducible, free, debuggable, and keeps the user's documents out of any
third-party model.

Tuning is done against live boards rather than guesses:

```
pnpm --filter @apply-ez/scraper-core why:filtered axa
```

That scrapes a target, scores every posting, and prints the hidden ones with the
exact reason string, so a rule can be judged on real titles.

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

## Relevance filter

A company careers site does not only list jobs you could do. Cathay Pacific's board
carries cabin crew, lounge ambassadors and cargo supervisors alongside its IT roles.
`src/lib/relevance.ts` scores every job 0-100 so the app can put that noise away.

Three decisions worth knowing:

1. **A score, not a boolean.** The scraper measures; the app decides what to show.
   The threshold is a Settings preference (`Loose` 20 / `Balanced` 35 / `Strict` 60),
   so tuning it never requires re-scraping the backlog.
2. **Nothing is ever dropped.** A job that scores 0 is still written, with
   `filter_reason` attached (`blocklist:bartender`, `family:AVIATION_OPS`, …).
   Silently deleting rows is how you lose the one posting you would have wanted, and
   it makes a mis-tuned rule impossible to debug after the fact. The list says how
   many it is hiding and offers to reveal them.
3. **Matching runs on the title and department only — never the description.**
   Adapter descriptions are frequently polluted with page-level text, so a
   description match would score every job on a page identically.

Family rules are ordered most-specific-first and the title outranks the department,
so "Cargo Supervisor" inside "Digital & Information Technology" is still a cargo
role, and "Licensed Aircraft Engineer" does not read as a software job because of
the word "engineer". Parenthetical qualifiers are stripped first, or
"Senior Solution Lead – Subsidiaries (Cathay Cargo Terminal)" would be classified as
cargo work by its own employer's name.

The blocklist is anchored on the title, and deliberately does **not** contain bare
`server`, `host` or `officer` — those would kill "Server Engineer", "Hosting
Platform Lead" and "Compliance Officer".

## Application codes and applied jobs

Two codes, both stored in Supabase as bcrypt hashes and verified inside
`SECURITY DEFINER` functions:

| Code | Gates | Asked |
| --- | --- | --- |
| `UNLOCK_APPLICATION_CODE` | opening the application area, reading the history | once per install |
| `BEFORE_APPLICATION_CODE` | recording a single application | every submit |

The second one is deliberate friction: it is the "are you sure" step that stops a
stray tap from filing a real application. Neither code is ever shipped in the app
bundle, so a stolen APK yields nothing, and `app_settings` has RLS on with no policy
so a database dump reveals only hashes.

Push the hashes once after applying migration 0003, and again whenever you rotate a
code:

```bash
pnpm --filter @apply-ez/scraper-core sync:codes
```

The script verifies its own work by round-tripping through the same `app_unlock`
function the app calls — a silently failed write would otherwise leave the gate
permanently shut.

`applications` has no anon read policy at all. The app reads it through
`list_applications(code)` and writes through `record_application(code, …)`, both
gated by the codes above. A public INSERT policy would have been simpler and worse:
`applications.job_id` is unique, so anyone holding the anon key could have marked
jobs as applied.

## Expired vs active

`status` is set to `EXPIRED` by the daily full-crawl reconcile using a two-strike
policy. Before migration 0003 the anon policy only exposed `status = 'ACTIVE'`, so
an expired job simply vanished — there was no way to tell "this posting closed" from
"this was never scraped". The policy now exposes the whole table and the app splits
the list into **Active** and **Closed**, dimming closed cards and replacing their
deadline pill with "No longer accepting".



Adapters differ a lot in what their listing pages expose. `src/lib/job-backfill.ts`
runs between the adapter and the pipeline and recovers the common gaps from the
title and detail-page text. Measured on real dry runs — three very different sources:

| Field | Towngas (custom CMS) | AIA (Workday) | Cathay Pacific (custom) |
| --- | --- | --- | --- |
| `location` | 10/10 → 10/10 | 40/40 → 40/40 | 45/45 → 45/45 |
| `experienceMin` | **0/10 → 10/10** | **0/40 → 26/40** | **0/45 → 33/45** |
| `department` | **0/10 → 7/10** | **0/40 → 17/40** | 45/45 → 45/45 |
| `applicationDeadline` | 10/10 → 10/10 | 0/40 → 0/40 | **0/45 → 41/45** |
| `employmentType` | **0/10 → 1/10** | 40/40 → 40/40 | 44/45 → 45/45 |

Read as *adapter alone → after backfill*.

- No adapter extracts `experienceMin` at all — the backfill layer is what makes it
  exist. On AIA it recovers 26 of 40 from the JD body.
- AIA never exposes a deadline, so 0/40 is the honest answer, not a bug. The field
  stays null rather than being invented.
- `employmentType` stays low on Towngas because those postings simply do not state
  it. The AIA adapter sets it directly, which is why backfill has nothing to do there.
- `location` is 0 filled on both because the adapters already provide it.

### Prefer the structured source, then the DOM, then the model

When an adapter misses fields the instinct is to throw an LLM at the problem. Before
doing that it is worth checking whether the site already publishes the same data
machine-readably — because a JSON endpoint is exact, free, instant, and gives fields
the rendered DOM never exposes.

Auditing the targets for a structured source turned up three kinds:

| Target | Structured source | Notes |
|---|---|---|
| AIA, Manulife | Workday CXS JSON API | `POST /wday/cxs/{tenant}/{site}/jobs`, detail per posting |
| HSBC | Eightfold `GET /api/apply/v2/jobs` | ~247 HK postings, full description per position |
| Morgan Stanley | Eightfold PCSX `GET /api/pcsx/search` | 61 HK postings, detail per posting; page size fixed at 10 |
| AXA | Phenom `GET /api/jobs` | full description, `posted_date`, `apply_url` |
| CLP | Oracle Recruiting Cloud `hcmRestApi` | 39 HK postings in one request; title/date/location only |
| Cathay | none | server-rendered, no JSON-LD, no XHR — DOM scraping is the only option |

`workday.adapter.ts` is the first one built. It replaces a headless browser with two
plain HTTP calls and, on the live boards, produces:

```
AIA        116 jobs  location 116/116  description 116/116  deadline  19/116   24s
Manulife    75 jobs  location  75/75   description  75/75   deadline  75/75   14s
```

The deadline is the notable one. It comes from `jobPostingInfo.endDate`, which the
rendered page never shows — the Cathay adapter needed an entire detail stage to
recover 41/45 by parsing prose, and the Workday sites could not recover it at all.

Three behaviours of that API are worth knowing, because each one fails silently:

- **Only page 0 returns a real `total`.** Every later page reports `total: 0`.
  Assigning it unconditionally clobbers the good value with a zero — which stopped
  the first AIA crawl after two pages and collected 40 jobs out of 116 *while
  reporting success*.
- **Past the last page it wraps around** and re-serves page 1 rather than returning
  an empty batch, so "empty batch" is not a usable stop signal. The loop stops on
  "this page contributed nothing new" instead, which holds even if `total` is wrong.
- **The facet parameter name differs per tenant.** AIA uses `locationCountry`,
  Manulife uses `Location_Country`. Sending the wrong key is not ignored — Workday
  answers `400` and the listing comes back empty.

The general rule this suggests, and what the adapters now follow: fetch the page or
endpoint once, keep the raw text, and let progressively more expensive parsers try to
structure it. A model is the last tier, not the first — and it can only extract what
the fetcher actually retrieved, so a fetch that returns nothing cannot be rescued by
a better prompt.

#### Eightfold has two listing APIs, and which one answers is tenant-specific

HSBC answers on the older `GET /api/apply/v2/jobs`. Morgan Stanley answers that same
path with `403 {"message":"Not authorized for PCSX"}` — a routing verdict, not a block —
and serves its listings from the newer `GET /api/pcsx/search` instead. Both share the
detail endpoint `/api/apply/v2/jobs/{id}`, so this stayed one adapter with a
`listingApi: 'auto' | 'apply-v2' | 'pcsx'` switch. Two things about PCSX:

- **It ignores `num`.** Ask for 100 and you get 10, every time. Pagination therefore
  advances by what actually came back, never by what was requested — otherwise the loop
  advances 100 rows per page over a 10-row page and silently skips 90% of the board.
  Morgan Stanley's 61 postings arrive as 7 pages of 10.
- **Only `filter_*` params are forwarded** from the entry URL. `start`, `pid` and
  `source` are dropped: they are session state, and forwarding a stale `start` makes
  page 1 look like page 4.

The auto-switch fires **only** on the PCSX-not-authorized message. A plain `403` is a
block and stays a reported failure — switching APIs on any 403 would hide a real one.

#### Oracle Recruiting Cloud, and the parameter that must be there

CLP's board is Oracle HCM. Two traps, both of which look healthy from the outside:

- **Omitting `expand=requisitionList.secondaryLocations` returns HTTP 200, a
  `TotalJobsCount` of 39, and no `requisitionList` key at all.** A status-code-only
  reader sees a clean, empty board. The adapter always sends `expand`, and treats
  "a total was reported but zero rows came back" as an error rather than an empty page.
- **The envelope's `limit` is not an echo of the request.** It reads `200` whether you
  asked for 25 or for 200. Using it as the page size would end pagination after one
  page; the loop uses `TotalJobsCount` and the returned row count instead.

`siteNumber` is not in the careers URL either — CLP's page says `CLP-Recruitment-System`
while the API wants `CX_1`. It is only discoverable in the page's JavaScript, so the
adapter requires it in config and refuses to run without it: a wrong value returns
**another site's** postings with a 200, which is worse than an error.

CLP's detail endpoint is unreachable from this tenant (`400` on the finder, `404` on the
single-resource form), so its postings carry title, date and location only. That is a
real limitation, not a silent one — they are skipped by LLM enrichment, which needs a
description, and relevance is unaffected because it reads the title.

#### Politeness is part of correctness

The first version of these three adapters had its own `fetchJson` in each file, and
every one of them called bare `fetch`. That looked harmless and was not: it bypassed
`throttledFetch`, which is where the project's robots.txt check and per-host rate
limiter live. The DOM adapters all went through it; the new ones silently did not.

The cost showed up as a block rather than a bug report:

```
HSBC   247 listing + 247 detail requests in ~2 minutes  →  HTTP 403 from CloudFront
```

Every request after that was refused too — including `robots.txt` itself. Nothing in
the run said "we are being blocked"; it said `HTTP 403`, which reads like a
permissions problem rather than "you asked 494 times in two minutes".

All platform HTTP now goes through one helper, `lib/http-json.ts`:

| Concern | Mechanism |
|---|---|
| May we fetch this URL? | `throttledFetch` → robots.txt verdict, fail-open if unreadable |
| How fast? | per-host `Bottleneck`, default 1 req/s, raised by any declared `crawl-delay` |
| Who are we? | `scraperUserAgent()` — the declared bot identity, never a browser string |
| Transient failure? | `withRetry` with backoff, honouring `Retry-After` |

Two deliberate choices in there:

- **403 is not retried.** 408/429/5xx and transient socket errors are. A 403 from a
  CDN edge is a block, not a blip, and retrying multiplies load against whatever just
  decided to refuse us — which is how a two-minute block becomes an hourly one.
- **A declared `crawl-delay` is honoured**, and only ever slows us down. AXA asks for
  5 seconds — five times our default pace — which costs ~15s for its 68 postings.

There is also a new guard, because a blocked host should not be hammered:
`FailureCircuit`. A detail stage that has seen ≥8 failures while failing ≥80% of the
time stops claiming new work, and reports `aborted after N failed / M ok` rather than
a partial count that reads like a near-complete crawl. Isolated failures among
successes do not trip it, so the one-pass retry over dropped details still runs.

`probe:robots` answers the question this raised — does the new compliance actually
permit the endpoints the adapters use?

```bash
pnpm --filter @apply-ez/scraper-core probe:robots
# 0 disallowed URL(s), 1 URL(s) under a declared crawl-delay
```

All 12 enabled targets are allowed. Three of them (`towngas`, `mtr`, `clp`) have no
readable `robots.txt` — two genuine 404s and one redirect to the homepage — so they
fail open, which is the pre-existing behaviour rather than something this changed.

### The Cathay adapter, as a worked example

Cathay is the case that shows why "the field is populated" is not the same as "the
field is right". A dry run originally reported `employmentType` filled on 45/45
jobs — and every one of them said `INTERNSHIP`, including a "Senior Solution Lead".
The cause was three separate bugs stacked:

1. **The card selector was wrong.** Cathay renders each result as
   `a.search-listing__item` wrapping a `.search-listing__item__title` div and a
   `.search-listing__item__props` span list. The adapter read the *anchor's* text,
   which is the whole card — so `title` came out as
   `"Senior Solution Lead – Subsidiaries (Cathay Cargo Terminal) Digital &
   Information Technology Hong Kong SAR (China) Permanent"`, and every prop was lost.
   `closest('article, li, div')` walked straight past the anchor to the 2,155-character
   list container, so `description` became the text of *every card on the page* — the
   same blob on all 45 jobs.
2. **The backfill then read that blob.** With "Trainee" present in the page-wide text,
   the employment-type rule matched and stamped `Internship` on everything.
3. **Deadlines were never reachable at all.** Cathay publishes the closing date only
   on the detail page (`Application deadline: 29 Sep 2026`), not on the card, so
   `applicationDeadline` was 0/45.

The fix reads the card's own title node and props, and adds a detail stage
(`fetchCathayJobDetail`) that fetches each posting over plain HTTP — the pages are
server-rendered, so no browser is needed for ~45 requests. The detail stage also
trims the ~750-character equal-opportunities boilerplate off the end, because it
would otherwise occupy the entire tail of the enrichment prompt's head+tail
truncation window, which is exactly where the Requirements section lives.

Two things generalise from this:

- **A filled field is not a correct field.** The old run reported 45/45 and looked
  healthy. Only reading the actual values — `scripts/probe-cathay.ts` dumps them —
  exposed that they were uniformly wrong. That probe is kept in the repo.
- **`page.evaluate` under tsx must be passed a string, not a closure.** esbuild wraps
  named inner functions in its `__name` helper, which does not exist in the browser
  context, so a closure throws `ReferenceError: __name is not defined`.


Run the regression checks:

```bash
pnpm --filter @apply-ez/scraper-core check           # all ten suites, 676 assertions
pnpm --filter @apply-ez/scraper-core check:backfill  # 40
pnpm --filter @apply-ez/scraper-core check:hk-time   # 51
pnpm --filter @apply-ez/scraper-core check:relevance # 205
pnpm --filter @apply-ez/scraper-core check:llm       # 91
pnpm --filter @apply-ez/scraper-core check:push      # 33
pnpm --filter @apply-ez/scraper-core check:store     # 19
pnpm --filter @apply-ez/scraper-core check:http      # 37
pnpm --filter @apply-ez/scraper-core check:workday   # 56
pnpm --filter @apply-ez/scraper-core check:platform  # 98
pnpm --filter @apply-ez/scraper-core check:oracle    # 46

pnpm --filter @apply-ez/scraper-core probe:robots    # live: is every target allowed?

pnpm check:sql                                       # migrations, 46 assertions

cd apps/mobile && npm run typecheck
```

`check:llm` and `check:push` run the real HTTP clients against local mock servers,
so the tool-call path, the 429 retry policy, and the `DeviceNotRegistered`
classification are all verified without spending API quota or touching a device.

`check:store` pins the writer's error classification. PostgREST answers a missing
column with `PGRST204` and a message naming the column, which reads like a typo in
the client rather than a database that is behind the code, so the writer appends an
explicit "you probably have an unapplied migration" hint. The test pins that hint in
both directions — it must fire on `PGRST202`/`PGRST204`/`PGRST205`/`42703`, and must
*not* fire on a `23505` unique violation, a `23514` CHECK violation, a `42501` RLS
denial, or a 5xx. A false positive there would send you to re-apply a migration that
is already live.

`check:http` is mostly assertions about what does **not** happen, because that is
where the bugs were: a disallowed path is *never requested* (not "requested then
discarded"), a 403 is *not retried*, a declared `crawl-delay` is *not ignored*, the
`user-agent` contains no `Mozilla`, and a POST body goes out verbatim. It also covers
`FailureCircuit` — including the latch, since a circuit that reopens after a few
in-flight successes is worse than none.

The mock suites run with pacing and retries switched off, because production pacing
(1 req/s) would make a 45-detail crawl take 45 seconds for no added coverage.
`configureRateLimit()` is the hook for that; it must be called before any scrape
starts, since it discards the per-host limiters. The retry knobs are read per call
rather than at import time, so setting `process.env` at the top of a script works
regardless of module evaluation order.

`check:workday` runs the adapter against a local mock CXS server that deliberately
reproduces the two behaviours that broke the first live run — `total: 0` on later
pages, and wrap-around past the last page. Those are exactly the failures a
happy-path test would miss, so the mock reimplements them rather than serving a
tidy paginated list.

`check:relevance` uses **real Cathay Pacific Hong Kong job titles** as fixtures,
taken from the live board. That matters: the layer's whole job is how it behaves on
the actual mix a careers site publishes, and hand-picked examples would quietly
avoid the awkward cases. Two of the fixtures exist purely as traps — "Server
Engineer" and "Compliance Officer" would both be caught by a naive
`server`/`officer` blocklist.

`check:sql` validates the migrations in two layers, because neither is sufficient
alone. `pglast` wraps libpg_query — the actual PostgreSQL parser — so the DDL,
policies and `GRANT`/`REVOKE` statements are checked against real grammar rather
than a regex. But libpg_query treats a `$$ … $$` body as an opaque string, so the
plpgsql bodies get their own structural checks: balanced dollar-quoting and balanced
`BEGIN`/`END`. That second check is subtler than it looks — a bare `end` closes four
different things (`END;`, `END IF;`, `END LOOP;`, `END CASE;`, plus CASE
*expressions*), so a naive `begin` vs `end` count reports false failures on any
function containing a `CASE`. The counter therefore subtracts the other roles, and
the script **self-tests that counter** against twelve known-good and two
deliberately-broken bodies first — otherwise a counter stuck at `(1, 1)` would
declare every migration clean.

It needs `pglast` (`pip install pglast`); it is the one check that is not part of
`pnpm -r check` for that reason.

## Not built yet

- Assisted-apply flow (WebView autofill + Cloudflare R2 resumes). Every application
  will require a final manual confirmation — see `docs/RESEARCH.md` §5. The two-code
  gate and the application record are built; the autofill is not.
- Resume upload. The three slots (tech / data / general) exist in Settings as
  placeholders, and the apply panel already records which one was used.
- No i18n. The UI is English; job postings and AI summaries follow the posting's own
  language.
- Relevance uses the deterministic rules only. The LLM layer contributes seniority
  and years-of-experience, which feed the score, but role-family classification stays
  deterministic on purpose — one source of truth for the family, so the two layers
  cannot disagree.
