# Relevance and enrichment

Two independent axes, deliberately kept apart:

- **Relevance** — "is this the kind of job I want?" A deterministic 0-100 score from the
  title, department, seniority and stated experience. No model involved, so it is
  reproducible and free to re-run.
- **Enrichment** — "what does this posting actually say?" An LLM reads the description
  and returns a summary plus seniority and years-of-experience, which then feed the
  score.

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

## Why tool calling, not JSON mode

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

## Cost and safety

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

## The one-off backlog

The first full crawl writes every posting with `enrich_status = 'PENDING'`, and the
free tier only allows 50 model requests per day — so a 740-row backlog would take
about two weeks to summarise at that rate.

For that first pass the rows were filled in **without a model**, by deriving
`summary` / `extracted` from metadata the row already carried (`yearsOfExperience`,
`contractType`, `department`, `jobFunction`, the `remote` flag) plus the title. That
is enough to make the app's summary, skill search and years-of-experience filter work
immediately, and it costs nothing.

Those rows are deliberately left at `PENDING` with
`enrich_model = 'heuristic:local-v1'`, which means:

- the app shows the summary straight away, labelled *(pending)* — accurate, because
  it is provisional;
- `listEnrichmentPendingIds` still returns them, so the normal run replaces them with
  a summary actually read off the job description, at 50/day, in the background;
- a later model failure leaves the derived summary in place rather than blanking it.

Nothing is foreclosed, and a model-produced summary is always distinguishable from a
derived one in the data.

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
