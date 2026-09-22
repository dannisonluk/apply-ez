/**
 * Regression check for the Workday adapter.
 *
 * Run with:  pnpm --filter @apply-ez/scraper-core exec tsx scripts/check-workday.ts
 *
 * Two halves:
 *
 *  1. Pure functions — URL parsing and bullet-field parsing, which are where the
 *     per-tenant differences live.
 *  2. A mock CXS server. This exists because of a bug that only appears against a
 *     real tenant: Workday returns a real `total` on page 0 and `total: 0` on every
 *     later page, and past the last page it WRAPS AROUND and re-serves page 1
 *     instead of returning an empty batch. The first AIA run therefore collected
 *     40 jobs out of 116 and reported success. The mock reproduces both behaviours
 *     so the stop conditions are pinned.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WorkdayAdapter, parseWorkdayBullets, parseWorkdayUrl } from '../src/adapters/workday.adapter.js';
import type { ScrapeContext } from '../src/adapters/adapter.interface.js';
import { hongKongDateOf } from '../src/lib/hk-time.js';
import { configureRateLimit } from '../src/lib/rate-limit.js';

// The checks drive local mock servers on 127.0.0.1. Two knobs keep this suite
// fast and its assertions exact:
//
//   - pacing off — the production 1 req/sec would make the 45-detail crawl below
//     take 45 seconds without adding any coverage, since pacing is what
//     `check-http.ts` tests;
//   - retries off — so a deliberately-refused request is counted once, which is
//     what the circuit assertions depend on. Retry behaviour is also covered by
//     `check-http.ts`.
//
// Both are read per call rather than at import time, so setting them here works
// regardless of module evaluation order.
process.env.SCRAPER_RETRY_MAX_ATTEMPTS = '0';
configureRateLimit({ minTimeMs: 0, maxConcurrent: 8 });

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
  } catch {
    failed += 1;
    console.error(
      `FAIL  ${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`,
    );
  }
}

// ─── parseWorkdayUrl ──────────────────────────────────────────────────────────
const subdomain = parseWorkdayUrl('https://aia.wd3.myworkdayjobs.com/en-US/External?locationCountry=abc');
check('url: subdomain tenant', subdomain?.tenant, 'aia');
check('url: site from last path segment', subdomain?.site, 'External');
check('url: cxs root', subdomain?.cxs, 'https://aia.wd3.myworkdayjobs.com/wday/cxs/aia/External');
check('url: query string ignored', subdomain?.origin, 'https://aia.wd3.myworkdayjobs.com');

const underscoreSite = parseWorkdayUrl('https://manulife.wd3.myworkdayjobs.com/en-US/MFCJH_Jobs');
check('url: site with underscore', underscoreSite?.site, 'MFCJH_Jobs');
check('url: underscore cxs', underscoreSite?.cxs, 'https://manulife.wd3.myworkdayjobs.com/wday/cxs/manulife/MFCJH_Jobs');

// A bare host is deliberately unsupported: the tenant would sit somewhere in the
// path, and picking the wrong segment would build a CXS root that resolves to a
// different company's board. Failing loudly is the intended behaviour.
check(
  'url: bare host is rejected, not guessed',
  parseWorkdayUrl('https://wd3.myworkdayjobs.com/en-US/AIA_Careers'),
  undefined,
);

check('url: rejects a non-Workday host', parseWorkdayUrl('https://careers.example.com/jobs'), undefined);
check('url: rejects garbage', parseWorkdayUrl('not a url'), undefined);
check('url: rejects a Workday host with no site', parseWorkdayUrl('https://aia.wd3.myworkdayjobs.com/'), undefined);

// ─── parseWorkdayBullets ──────────────────────────────────────────────────────
// The whole reason this is shape-based: the two live tenants put the two values
// in opposite positions. Index-based reads would swap them silently.
const aiaBullets = parseWorkdayBullets(['Permanent', 'JR-70285']);
check('bullets: AIA employment type', aiaBullets.employmentType, 'Permanent');
check('bullets: AIA req id', aiaBullets.externalId, 'JR-70285');

const manulifeBullets = parseWorkdayBullets(['JR26070668', 'Toronto']);
check('bullets: Manulife req id', manulifeBullets.externalId, 'JR26070668');
check('bullets: Manulife has no employment type', manulifeBullets.employmentType, undefined);

check('bullets: Fixed Term', parseWorkdayBullets(['Fixed Term', 'R-123']).employmentType, 'Fixed Term');
check('bullets: Intern', parseWorkdayBullets(['Intern', 'R-123']).employmentType, 'Intern');
check('bullets: Part time', parseWorkdayBullets(['Part time', 'R-123']).employmentType, 'Part time');
check('bullets: non-array is tolerated', parseWorkdayBullets(null), {});
check('bullets: empty array', parseWorkdayBullets([]), {});
check('bullets: ignores non-strings', parseWorkdayBullets([42, { a: 1 }, 'Permanent']), { employmentType: 'Permanent' });
check('bullets: a city is not a req id', parseWorkdayBullets(['Permanent', 'Hong Kong']).externalId, undefined);

// ─── mock CXS server ──────────────────────────────────────────────────────────
const TOTAL = 45;
const PAGE_SIZE = 20;
/** Every job path the mock knows about, in listing order. */
const allPaths = Array.from({ length: TOTAL }, (_, index) => `/job/Hong-Kong/Role-${index}_JR-${70000 + index}`);

interface MockOptions {
  /** Facet key the mock accepts. A different key answers 400, like the real API. */
  acceptedFacet: string;
  listingCalls: number;
  detailCalls: number;
}

function makePosting(index: number): Record<string, unknown> {
  return {
    title: `Role ${index}`,
    externalPath: allPaths[index],
    timeType: 'Full time',
    locationsText: 'Hong Kong',
    postedOn: 'Posted Today',
    // Alternate the two real bullet shapes.
    bulletFields:
      index % 2 === 0 ? ['Permanent', `JR-${70000 + index}`] : [`JR-${70000 + index}`, 'Hong Kong'],
  };
}

function startMock(options: MockOptions) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';

    if (req.method === 'POST' && url.endsWith('/jobs')) {
      options.listingCalls += 1;
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as {
          offset?: number;
          appliedFacets?: Record<string, string[]>;
        };
        const facets = parsed.appliedFacets ?? {};
        const keys = Object.keys(facets);
        // Reject an unrecognised facet key exactly as Workday does.
        if (keys.length > 0 && keys[0] !== options.acceptedFacet) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid facet parameter' }));
          return;
        }

        const offset = parsed.offset ?? 0;
        // Past the end, wrap around to page 1 — the real API does this rather
        // than returning an empty batch.
        const effective = offset >= TOTAL ? 0 : offset;
        const slice = Array.from(
          { length: Math.min(PAGE_SIZE, TOTAL - effective) },
          (_, i) => makePosting(effective + i),
        );

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            // Only page 0 carries the real total; later pages report 0.
            total: effective === 0 ? TOTAL : 0,
            jobPostings: slice,
          }),
        );
      });
      return;
    }

    // Detail requests arrive as `{cxsBase}{externalPath}`, so the URL looks like
    // `/wday/cxs/acme/External/job/Hong-Kong/...` — matching on a leading `/job/`
    // would never fire and the detail stage would look like it did nothing.
    const jobMarker = '/job/';
    if (req.method === 'GET' && url.includes(jobMarker)) {
      options.detailCalls += 1;
      const jobPath = url.slice(url.indexOf(jobMarker));
      const index = allPaths.indexOf(jobPath);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jobPostingInfo: {
            title: `Role ${index}`,
            jobDescription: `<p>About the role</p><ul><li>Requirement ${index}</li></ul>`,
            location: 'Hong Kong',
            startDate: '2026-09-22',
            endDate: '2026-10-31',
            timeType: 'Full time',
            jobReqId: `JR-${70000 + index}`,
            country: 'HK',
            externalUrl: `https://acme.wd1.myworkdayjobs.com/External${allPaths[index]}`,
          },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });
  return server;
}

async function withMock<T>(
  options: MockOptions,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = startMock(options);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}/wday/cxs/acme/External`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function context(base: string, overrides: Record<string, unknown> = {}): ScrapeContext {
  return {
    targetId: 'mock',
    urlTemplate: undefined,
    entryUrls: ['https://acme.wd1.myworkdayjobs.com/en-US/External'],
    config: {
      companyName: 'Acme',
      companyDomain: 'acme.com',
      cxsBaseUrl: base,
      maxPages: 20,
      maxJobs: 400,
      includeDetailPages: true,
      maxDetailJobs: 400,
      detailConcurrency: 4,
      ...overrides,
    },
    region: 'HK',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

async function main(): Promise<void> {
  // ── full crawl: must survive total:0 on later pages AND the wrap-around ────
  const options: MockOptions = { acceptedFacet: 'locationCountry', listingCalls: 0, detailCalls: 0 };
  const result = await withMock(options, async (base) => new WorkdayAdapter().scrape(context(base)));

  check('crawl: no errors', result.errors.length, 0);
  check('crawl: every job collected', result.jobs.length, TOTAL);
  check('crawl: no duplicates', new Set(result.jobs.map((job) => job.externalId)).size, TOTAL);
  // 3 listing pages of content + the wrap-around page that contributes nothing new.
  check('crawl: listing calls bounded', options.listingCalls <= 5, true);
  check('crawl: detail fetched for each job', options.detailCalls, TOTAL);

  const first = result.jobs[0];
  check('crawl: title from detail', first?.title, 'Role 0');
  check('crawl: externalId prefers jobReqId', first?.externalId, 'JR-70000');
  check('crawl: location', first?.location, 'Hong Kong');
  check('crawl: workSchedule from timeType', first?.workSchedule, 'Full time');
  // endDate is the whole point of the detail stage — the DOM never exposes it.
  check('crawl: deadline anchored to the HK date', hongKongDateOf(first?.applicationDeadline ?? ''), '2026-10-31');
  check('crawl: publishedAt anchored to the HK date', hongKongDateOf(first?.publishedAt ?? ''), '2026-09-22');
  check('crawl: description is the posting body only', first?.description?.includes('Requirement 0'), true);
  check('crawl: description has no page chrome', first?.description?.includes('Accept cookies'), false);
  check('crawl: employmentType from bullets (AIA shape)', first?.employmentType, 'Permanent');
  check('crawl: employmentType from bullets (Manulife shape)', result.jobs[1]?.employmentType, undefined);
  check('crawl: url from externalUrl', first?.url.startsWith('https://acme.wd1.myworkdayjobs.com/External/job/'), true);

  // ── facet name: the wrong key is a hard 400, and must be reported ──────────
  const badFacet: MockOptions = { acceptedFacet: 'Location_Country', listingCalls: 0, detailCalls: 0 };
  const badResult = await withMock(badFacet, async (base) =>
    new WorkdayAdapter().scrape(
      context(base, { locationCountry: 'd4afdeb461d446e4babd204bd102dba8', locationCountryFacet: 'locationCountry' }),
    ),
  );
  check('facet: wrong key yields no jobs', badResult.jobs.length, 0);
  check('facet: failure is reported', badResult.errors.length > 0, true);
  // The original bug: a bare "listing page failed" with no explanation.
  check(
    'facet: error carries the HTTP status',
    /HTTP 400/.test(String(badResult.errors[0]?.context?.detail ?? '')),
    true,
  );
  check(
    'facet: error echoes the facets used',
    JSON.stringify(badResult.errors[0]?.context?.appliedFacets ?? {}),
    JSON.stringify({ locationCountry: ['d4afdeb461d446e4babd204bd102dba8'] }),
  );

  // The same crawl succeeds once the facet name matches.
  const goodFacet: MockOptions = { acceptedFacet: 'Location_Country', listingCalls: 0, detailCalls: 0 };
  const goodResult = await withMock(goodFacet, async (base) =>
    new WorkdayAdapter().scrape(
      context(base, {
        locationCountry: 'd4afdeb461d446e4babd204bd102dba8',
        locationCountryFacet: 'Location_Country',
      }),
    ),
  );
  check('facet: correct key crawls normally', goodResult.jobs.length, TOTAL);
  check('facet: correct key has no errors', goodResult.errors.length, 0);

  // ── detail stage can be disabled, and respects its own cap ────────────────
  const noDetail: MockOptions = { acceptedFacet: 'locationCountry', listingCalls: 0, detailCalls: 0 };
  const noDetailResult = await withMock(noDetail, async (base) =>
    new WorkdayAdapter().scrape(context(base, { includeDetailPages: false })),
  );
  check('detail: disabled skips detail calls', noDetail.detailCalls, 0);
  check('detail: listing still complete', noDetailResult.jobs.length, TOTAL);
  check('detail: no deadline without detail', noDetailResult.jobs[0]?.applicationDeadline, undefined);
  // The listing still yields a usable title and url.
  check('detail: listing title survives', noDetailResult.jobs[0]?.title, 'Role 0');

  const capped: MockOptions = { acceptedFacet: 'locationCountry', listingCalls: 0, detailCalls: 0 };
  await withMock(capped, async (base) =>
    new WorkdayAdapter().scrape(context(base, { maxDetailJobs: 5 })),
  );
  check('detail: maxDetailJobs is honoured', capped.detailCalls, 5);

  // ── the detail stage aborts when the host refuses everything ──────────────
  // This is the measured production failure rather than a hypothetical: a CDN
  // that starts answering 403 to every request. Before the circuit existed the
  // run would make all 45 detail requests anyway — 45 wasted requests against the
  // thing that had just decided to block us, each one extending the block.
  const refusing = { detailCalls: 0 };
  const refusingServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url.endsWith('/jobs')) {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const offset = (JSON.parse(body || '{}') as { offset?: number }).offset ?? 0;
        const slice = Array.from({ length: Math.min(PAGE_SIZE, TOTAL - offset) }, (_, i) =>
          makePosting(offset + i),
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ total: offset === 0 ? TOTAL : 0, jobPostings: slice }));
      });
      return;
    }
    if (req.method === 'GET' && url.includes('/job/')) {
      refusing.detailCalls += 1;
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><body><h1>403 ERROR</h1></body></html>');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const refused = await (async () => {
    await new Promise<void>((resolve) => refusingServer.listen(0, '127.0.0.1', resolve));
    try {
      const port = (refusingServer.address() as AddressInfo).port;
      return await new WorkdayAdapter().scrape(context(`http://127.0.0.1:${port}/wday/cxs/acme/External`));
    } finally {
      await new Promise<void>((resolve) => refusingServer.close(() => resolve()));
    }
  })();

  // Every runner polls the circuit before claiming its next item, so the crawl
  // stops within one round of tripping rather than at the end of the batch.
  check('circuit: stops far short of the full batch', refusing.detailCalls < 20, true);
  check('circuit: the abort is reported', /aborted after/.test(refused.errors[0]?.message ?? ''), true);
  check('circuit: the report says how far it got', /failed \/ \d+ ok/.test(refused.errors[0]?.message ?? ''), true);
  // The listing itself still lands, so this is a partial success rather than a
  // wipe-out — and the postings keep the fields that do not need the detail stage.
  check('circuit: the listing still yields every job', refused.jobs.length, TOTAL);
  check('circuit: no deadline without detail', refused.jobs[0]?.applicationDeadline, undefined);

  // ── maxJobs caps the crawl ────────────────────────────────────────────────
  const cappedJobs: MockOptions = { acceptedFacet: 'locationCountry', listingCalls: 0, detailCalls: 0 };
  const cappedResult = await withMock(cappedJobs, async (base) =>
    new WorkdayAdapter().scrape(context(base, { maxJobs: 25, maxDetailJobs: 0 })),
  );
  check('crawl: maxJobs caps the result', cappedResult.jobs.length, 25);

  // ── a non-Workday entry URL fails loudly rather than silently ─────────────
  const badUrl = await new WorkdayAdapter().scrape({
    ...context('http://127.0.0.1:1/wday/cxs/acme/External'),
    entryUrls: ['https://careers.example.com/jobs'],
  });
  check('url: non-Workday entry URL reports an error', badUrl.errors.length, 1);
  check('url: no jobs from a bad entry URL', badUrl.jobs.length, 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
