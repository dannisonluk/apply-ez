# Operations

How a run is ordered, and the four pieces of state the product depends on: what counts
as new, what counts as expired, what a push token may do, and what a deadline's date
actually means.

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
geo-blocked, or absent entirely — and a 6-hourly ingest must never be held up by
it. Rows land with `enrich_status = 'PENDING'` and are patched afterwards; anything
the model did not reach stays `PENDING` and is retried on the next run, which is
already how the retry mechanism worked. The `jobs written` log line is emitted
before the first LLM call so the log alone proves the invariant.

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
