# Development

The regression checks, and what each one is actually protecting against. Most of them
exist because a green suite once hid a real bug, so the notes here are about intent
rather than coverage numbers.

Run the regression checks:

```bash
pnpm --filter @apply-ez/scraper-core check           # all twelve suites, 785 assertions
pnpm --filter @apply-ez/scraper-core check:backfill  # 40
pnpm --filter @apply-ez/scraper-core check:hk-time   # 51
pnpm --filter @apply-ez/scraper-core check:location  # 35
pnpm --filter @apply-ez/scraper-core check:relevance # 205
pnpm --filter @apply-ez/scraper-core check:jd-sections # 49
pnpm --filter @apply-ez/scraper-core check:llm       # 91
pnpm --filter @apply-ez/scraper-core check:push      # 33
pnpm --filter @apply-ez/scraper-core check:store     # 19
pnpm --filter @apply-ez/scraper-core check:http      # 37
pnpm --filter @apply-ez/scraper-core check:workday   # 72
pnpm --filter @apply-ez/scraper-core check:platform  # 98
pnpm --filter @apply-ez/scraper-core check:oracle    # 53

pnpm --filter @apply-ez/scraper-core probe:robots    # live: is every target allowed?

pnpm check:sql                                       # migrations, 63 assertions

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

It needs `pglast`, declared in `supabase/scripts/requirements.txt`. It is the one check
that is not part of `pnpm -r check`, because it is Python rather than Node.
