# Adapters

One section per source that has bitten us. Every one of these describes a failure that
looked healthy from the outside — a `200`, a filled field, a plausible count — so they
are worth reading before touching an adapter.

Strategy and shared machinery: [`SCRAPING.md`](SCRAPING.md).

## Eightfold has two listing APIs, and which one answers is tenant-specific

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

## Oracle Recruiting Cloud, and the parameter that must be there

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

**The detail finder is `ById`, and the name matters.** For a long time this README
said CLP's detail endpoint was unreachable from this tenant — `400` on the finder,
`404` on the single-resource form — and that its postings therefore carried title, date
and location only. The endpoint was always reachable; the finder name was wrong. It is
`ById`, not `jobRequisitionDetails`:

```
recruitingCEJobRequisitionDetails?expand=all&onlyData=true
  &finder=ById;Id="230",siteNumber=CX_1
```

`expand=all` is required here too, or the body fields come back absent rather than
empty. The name is in no documentation and in no static HTML — a Candidate Experience
page is a 4 KB shell and the request only exists at runtime — so it was found by loading
a job page in a browser and reading what it asks for. The cost of the wrong conclusion
was 43 postings stored with no description. The detail response also carries
`Department`, `JobFamily` and the qualifications split, which the listing leaves empty,
so the same request backfills fields the listing never had.

## The Cathay adapter, as a worked example

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
