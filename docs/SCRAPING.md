# Scraping

How jobs get from a careers site into the database: what the crawler is allowed to do,
what it fetches, and what it fills in afterwards.

The per-platform traps live in [`ADAPTERS.md`](ADAPTERS.md). The scoring and LLM layers
are in [`RELEVANCE.md`](RELEVANCE.md).

## Incremental crawls

The 6-hourly run is incremental; the daily `--full` run is not. `--full` is the only
mode that gets a complete listing, because `reconcileMissing` infers "absent from the
listing ⇒ missing ⇒ eventually EXPIRED" — handing it a truncated list would retire
live postings.

Two mechanisms, and only one of them is load-bearing:

- **`knownExternalIds` bounds the crawl.** `cli.ts` resolves the stored ids *before*
  the crawl and passes them to the adapter, which may stop paginating once a page
  adds nothing unseen. That is opt-in per target (`incrementalStopOnKnown`) because
  it is only sound where the listing is known to be date-descending. Workday is —
  verified against both tenants — and it ignores a `sortBy` hint, so there is no
  parameter to set. Every other target still crawls to the end.
- **Already-stored postings are filtered out after the crawl**, once, in `cli.ts`.

The second is the one that matters, and it is central on purpose. The upsert writes
`application_deadline`, `apply_url` and `work_schedule` as `?? null`, so a posting
written from a listing-only view — no detail page fetched — would have its stored
deadline and apply URL **erased**. An earlier version of this change skipped the
detail fetch per adapter for known postings, which is exactly that bug; it was caught
by reading what the upsert actually sends. Filtering once after the crawl means an
adapter cannot get it wrong, and it is what makes any detail-skipping safe rather
than destructive.

Measured effect: a full run re-scrapes 736 postings, 588 of which are already stored,
and issues roughly 1,000 detail requests. An incremental run stops at the first page
with nothing new, so the work is proportional to what actually changed.

## Job descriptions

The detail page shows the posting the way a job board does — titled sections with
bullets underneath — rather than only a paragraph of summary. `jd_sections` holds it,
built at ingest by `buildJdSections` in `types/section-content.ts`.

Two shapes arrive from the adapters and both have to end up the same:

- `sectionContent`, a named object (`roleIntroduction` / `keyResponsibilities` /
  `requirements`), which is what the corporate-careers and Cathay adapters produce.
  Already titled, so it needs no heading detection — but an **array of strings is a
  bullet list**, and emitting one paragraph per string loses that.
- `description`, a single blob, which is what Workday has. Its headings have to be
  recovered from the text.

The blob path does its own heading detection rather than reusing
`parseSectionBlocks`, and that is not duplication for its own sake.
`parseSectionBlocks` runs `stripHeadingPrefix`, which **deletes a line that is exactly
"Requirements:" or "Key responsibilities:"** — it exists to clean up a heading glued
onto body text, and it cannot tell that apart from a standalone heading. Those two
strings are the most common headings in the corpus, so the shared parser silently
collapses a typical posting into one untitled section. A dedicated splitter keeps the
existing behaviour intact for its other callers.

The raw `description` is deliberately not stored. It is the largest field a posting
has and nothing reads it once parsed, so keeping both would roughly double the table.

Existing rows stay empty until a crawl refetches their detail pages — the JD is only
available at scrape time and is not recoverable from what is already stored.

`fetchJob` selects `jd_sections`; the list query does not. Pulling it for ~740 rows
would add megabytes to a refresh that runs every six hours, for a column the list
never renders. It also degrades rather than breaks: if migration 0005 has not been
applied, Postgres answers 42703 and the detail page would otherwise fail completely
over one optional column, so the query retries without it.

## Hong Kong scope

Every target is HK-scoped at the source — Workday's `locationCountry`, Phenom's
`location=Hong Kong`, Eightfold's `filter_country=Hong Kong`, PageUp's
`location=Hong Kong SAR`. Those filters leak, and not in a way a target-level tweak
can fix, because the leak is inside the listing API's own filtering: a live crawl of
746 postings contained **6 that were not in Hong Kong** — two "Singapore", one
"Manulife Tower, Manulife (Singapore) Pte Ltd" and three "华东" from SHKP's Shanghai
roles.

`lib/location-scope.ts` is a **denylist**, applied to every target in `cli.ts`:

```
out of scope  ==  names somewhere outside Hong Kong
                  AND does not name Hong Kong
```

An allowlist ("must mention Hong Kong") is the obvious implementation and the wrong
one — it drops legitimate postings whose location is an office name with no city in
it. `Manulife Tower` is a Kwun Tong address. A denylist errs the other way: an
unrecognised overseas location still leaks, which is visible, countable, and cheap to
fix by adding a pattern, rather than silently deleting a job you wanted.

Drops are logged with their locations, because the only way to know the list is still
adequate is to see what it rejected.

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

## Prefer the structured source, then the DOM, then the model

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
| CLP | Oracle Recruiting Cloud `hcmRestApi` | 42 HK postings in one request, then one detail request each for the body |
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

## Politeness is part of correctness

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
