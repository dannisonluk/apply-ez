/**
 * Regression check for the Eightfold and Phenom platform adapters.
 *
 * Run with:  pnpm --filter @apply-ez/scraper-core exec tsx scripts/check-platform-adapters.ts
 *
 * Same two halves as `check-workday`: pure parsing functions, then a mock API
 * server for the behaviours that only show up against a live tenant.
 *
 * The mock cases here are the ones that failed SILENTLY in development:
 *   - Phenom accepts an unknown filter parameter and returns the global board, so
 *     a missing `location` filter looks like a successful crawl of 1,515
 *     non-Hong-Kong postings.
 *   - Eightfold drops a fraction of detail requests under concurrency, which
 *     shows up as postings with no description rather than as an error.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EightfoldAdapter,
  fromUnixSeconds,
  parseEightfoldUrl,
} from '../src/adapters/eightfold.adapter.js';
import { PhenomAdapter, fromOffsetIso, parsePhenomUrl } from '../src/adapters/phenom.adapter.js';
import type { ScrapeContext } from '../src/adapters/adapter.interface.js';
import { configureRateLimit } from '../src/lib/rate-limit.js';

// Same two knobs as `check-workday.ts`, for the same reasons: pacing off because
// the production 1 req/sec would add a minute of wall clock without adding
// coverage, and retries off so a deliberately-failed request is counted once.
// Both are read per call rather than at import time.
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

// ─── parseEightfoldUrl ────────────────────────────────────────────────────────
const ef = parseEightfoldUrl('https://portal.careers.hsbc.com/careers?location=Hong+Kong&hl=en', 'hsbc.com');
check('ef url: api base', ef?.apiBase, 'https://portal.careers.hsbc.com/api/apply/v2/jobs');
check('ef url: domain falls back to config', ef?.domain, 'hsbc.com');
// `+` in a query string decodes to a space; the API needs "Hong Kong".
check('ef url: location decoded', ef?.location, 'Hong Kong');
check('ef url: hl', ef?.hl, 'en');
check('ef url: hl defaults to en', parseEightfoldUrl('https://x.example.com/careers', 'x.com')?.hl, 'en');
check('ef url: no location is allowed', parseEightfoldUrl('https://x.example.com/careers', 'x.com')?.location, undefined);
check('ef url: explicit ?domain= wins', parseEightfoldUrl('https://x.example.com/c?domain=other.com', 'x.com')?.domain, 'other.com');
check('ef url: no domain anywhere is rejected', parseEightfoldUrl('https://x.example.com/careers'), undefined);
check('ef url: garbage is rejected', parseEightfoldUrl('not a url', 'x.com'), undefined);

// ─── fromUnixSeconds ──────────────────────────────────────────────────────────
check('unix: seconds', fromUnixSeconds(1760608068), '2025-10-16T09:47:48.000Z');
// A tenant that one day sends milliseconds must not produce a year-57000 date.
check('unix: milliseconds are detected', fromUnixSeconds(1760608068000), '2025-10-16T09:47:48.000Z');
check('unix: zero is rejected', fromUnixSeconds(0), undefined);
check('unix: negative is rejected', fromUnixSeconds(-5), undefined);
check('unix: non-number is rejected', fromUnixSeconds('1760608068'), undefined);
check('unix: NaN is rejected', fromUnixSeconds(Number.NaN), undefined);

// ─── parsePhenomUrl ───────────────────────────────────────────────────────────
const ph = parsePhenomUrl('https://careers.axa.com/careers-home/jobs?location=Hong%20Kong&lang=en-us');
check('ph url: origin', ph?.origin, 'https://careers.axa.com');
check('ph url: location', ph?.location, 'Hong Kong');
check('ph url: lang', ph?.lang, 'en-us');
check('ph url: commute params are not read', parsePhenomUrl('https://careers.axa.com/jobs?woe=7&lat=22.28&searchType=commute')?.location, undefined);
check('ph url: garbage is rejected', parsePhenomUrl('not a url'), undefined);

// ─── fromOffsetIso ────────────────────────────────────────────────────────────
// An explicit `+0000` offset must be parsed directly, not anchored to Hong Kong
// — anchoring a timestamp that already states its zone would shift it 8 hours.
check('offset: +0000 preserved', fromOffsetIso('2026-08-14T09:10:00+0000'), '2026-08-14T09:10:00.000Z');
check('offset: +0800 converted to UTC', fromOffsetIso('2026-08-14T09:10:00+0800'), '2026-08-14T01:10:00.000Z');
check('offset: invalid rejected', fromOffsetIso('not a date'), undefined);
check('offset: non-string rejected', fromOffsetIso(12345), undefined);

// ─── mocks ────────────────────────────────────────────────────────────────────
const EF_TOTAL = 25;
const PH_TOTAL = 30;

function startEightfoldMock(state: { detailCalls: number; failDetailIds: Set<string> }) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    const json = (body: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.endsWith('/api/apply/v2/jobs')) {
      const start = Number.parseInt(url.searchParams.get('start') ?? '0', 10);
      const num = Number.parseInt(url.searchParams.get('num') ?? '20', 10);
      const slice = Array.from({ length: Math.max(0, Math.min(num, EF_TOTAL - start)) }, (_, i) => ({
        id: 1000 + start + i,
        name: `EF Role ${start + i}`,
        location: 'Hong Kong',
        department: 'Retail Banking',
        business_unit: 'HK',
        t_create: 1760608068,
        canonicalPositionUrl: `https://portal.careers.hsbc.com/careers/job/${1000 + start + i}`,
        // The listing genuinely has no description — a detail fetch is mandatory.
        job_description: '',
      }));
      json({ count: EF_TOTAL, positions: slice });
      return;
    }

    if (url.pathname.includes('/api/apply/v2/jobs/')) {
      state.detailCalls += 1;
      const id = url.pathname.split('/').pop() ?? '';
      // Fail ONCE per id, then succeed. `Set.delete` returning whether it removed
      // anything is what makes this a transient failure rather than a permanent
      // one — which is the whole point, since the retry pass exists precisely to
      // recover from drops that succeed on a second attempt.
      if (state.failDetailIds.delete(id)) {
        json({ error: 'transient' }, 503);
        return;
      }
      json({
        id: Number(id),
        name: `EF Role ${Number(id) - 1000}`,
        location: 'Hong Kong',
        department: 'Retail Banking',
        job_description: `<p>Body for ${id}</p>`,
        apply_redirect_url: `https://career2.successfactors.eu/apply?req=${id}`,
      });
      return;
    }

    json({ error: 'not found' }, 404);
  });
}

function startPhenomMock(state: { failFirstPage: boolean }) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    const json = (body: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (!url.pathname.endsWith('/api/jobs')) {
      json({ error: 'not found' }, 404);
      return;
    }

    // Reproduces the real trap: an unrecognised filter is accepted and ignored,
    // so the caller gets the GLOBAL board instead of an error.
    const location = url.searchParams.get('location');
    if (!location) {
      const global = Array.from({ length: 40 }, (_, i) => ({
        data: { slug: String(90000 + i), title: `Global Role ${i}`, country: 'France', city: 'Paris' },
      }));
      json({ totalCount: 1515, count: 40, jobs: global });
      return;
    }

    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '25', 10);
    const offset = (page - 1) * limit;
    const slice = Array.from({ length: Math.max(0, Math.min(limit, PH_TOTAL - offset)) }, (_, i) => ({
      data: {
        slug: String(20000 + offset + i),
        title: `AXA Role ${offset + i}`,
        description: `<p>AXA body ${offset + i}</p>`,
        city: 'HONG KONG',
        country: 'Hong Kong',
        short_location: 'HONG KONG, Hong Kong',
        employment_type: 'FULL_TIME',
        tags1: ['Full-time'],
        tags2: ['Permanent contract'],
        categories: [{ name: 'CLAIMS AND ASSISTANCE' }],
        posted_date: '2026-08-14T09:10:00+0000',
        apply_url: `https://careers-en-axa.icims.com/jobs/${20000 + offset + i}/login`,
      },
    }));
    json({ totalCount: PH_TOTAL, count: PH_TOTAL, jobs: slice });
  });
}

async function withServer<T>(server: ReturnType<typeof createServer>, fn: (origin: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function efContext(origin: string, overrides: Record<string, unknown> = {}): ScrapeContext {
  return {
    targetId: 'mock-ef',
    urlTemplate: undefined,
    entryUrls: ['https://portal.careers.hsbc.com/careers?location=Hong+Kong&hl=en'],
    config: {
      companyName: 'HSBC',
      companyDomain: 'hsbc.com',
      apiBase: `${origin}/api/apply/v2/jobs`,
      num: 10,
      maxJobs: 100,
      includeDetailPages: true,
      maxDetailJobs: 100,
      detailConcurrency: 4,
      ...overrides,
    },
    region: 'HK',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function phContext(origin: string, overrides: Record<string, unknown> = {}): ScrapeContext {
  return {
    targetId: 'mock-ph',
    urlTemplate: undefined,
    entryUrls: ['https://careers.axa.com/careers-home/jobs?location=Hong%20Kong&lang=en-us'],
    config: {
      companyName: 'AXA',
      companyDomain: 'axa.com',
      apiBase: `${origin}/api/jobs`,
      limit: 10,
      maxJobs: 100,
      ...overrides,
    },
    region: 'HK',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

async function main(): Promise<void> {
  // ── Eightfold: pagination, mandatory detail, and the retry pass ────────────
  const efState = { detailCalls: 0, failDetailIds: new Set<string>(['1003', '1007']) };
  const efResult = await withServer(startEightfoldMock(efState), (origin) =>
    new EightfoldAdapter().scrape(efContext(origin)),
  );

  check('ef crawl: every posting collected', efResult.jobs.length, EF_TOTAL);
  check('ef crawl: no duplicates', new Set(efResult.jobs.map((j) => j.externalId)).size, EF_TOTAL);
  check('ef crawl: no errors after retry recovers', efResult.errors.length, 0);
  // 25 first-pass attempts + 2 retries for the two injected failures.
  check('ef crawl: failed details were retried', efState.detailCalls, EF_TOTAL + 2);
  check('ef crawl: description from detail', efResult.jobs[0]?.description?.includes('Body for'), true);
  check('ef crawl: apply URL from detail (ATS link)', efResult.jobs[0]?.applyUrl?.startsWith('https://career2.successfactors.eu/'), true);
  check('ef crawl: url is the public posting', efResult.jobs[0]?.url, 'https://portal.careers.hsbc.com/careers/job/1000');
  check('ef crawl: department', efResult.jobs[0]?.department, 'Retail Banking');
  check('ef crawl: publishedAt from unix seconds', efResult.jobs[0]?.publishedAt, '2025-10-16T09:47:48.000Z');

  // A failure that survives the retry must be reported, not swallowed. A
  // dedicated server that serves the listing but 503s every detail is simpler
  // than making the shared mock track how many times each id has failed.
  const downServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    if (url.pathname.endsWith('/api/apply/v2/jobs')) {
      const slice = Array.from({ length: 3 }, (_, i) => ({
        id: 5000 + i,
        name: `Down Role ${i}`,
        location: 'Hong Kong',
        canonicalPositionUrl: `https://portal.careers.hsbc.com/careers/job/${5000 + i}`,
        job_description: '',
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: 3, positions: slice }));
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'down' }));
  });

  const hardResult = await withServer(downServer, (origin) =>
    new EightfoldAdapter().scrape(efContext(origin)),
  );
  check('ef detail: persistent failure is reported', hardResult.errors.length, 1);
  check('ef detail: error names the count', /3\/3 postings failed/.test(hardResult.errors[0]?.message ?? ''), true);
  check('ef detail: the postings still land without detail', hardResult.jobs.length, 3);
  check('ef detail: no description when detail is down', hardResult.jobs[0]?.description, undefined);
  check('ef detail: url still usable without detail', hardResult.jobs[0]?.url, 'https://portal.careers.hsbc.com/careers/job/5000');

  // ── the detail stage aborts when the host refuses everything ──────────────
  // The measured production failure, not a hypothetical: CloudFront answering
  // 403 to every request. Without the circuit the run made all 247 detail
  // requests anyway — 247 wasted requests against the thing that had just
  // blocked us, each one extending the block.
  const blocked = { detailCalls: 0 };
  const blockedServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    if (url.pathname.endsWith('/api/apply/v2/jobs')) {
      const slice = Array.from({ length: 30 }, (_, i) => ({
        id: 7000 + i,
        name: `Blocked Role ${i}`,
        location: 'Hong Kong',
        canonicalPositionUrl: `https://portal.careers.hsbc.com/careers/job/${7000 + i}`,
        job_description: '',
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: 30, positions: slice }));
      return;
    }
    if (url.pathname.includes('/api/apply/v2/jobs/')) {
      blocked.detailCalls += 1;
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><body><h1>403 ERROR</h1></body></html>');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const blockedLogs: string[] = [];
  const blockedResult = await withServer(blockedServer, (origin) =>
    new EightfoldAdapter().scrape({
      ...efContext(origin),
      logger: {
        info: (msg: string) => {
          blockedLogs.push(msg);
        },
        warn: () => {},
        error: () => {},
      },
    }),
  );

  check('ef circuit: stops far short of the full batch', blocked.detailCalls < 20, true);
  check('ef circuit: the abort is reported', /aborted after/.test(blockedResult.errors[0]?.message ?? ''), true);
  // The retry pass is skipped once the circuit is open: a host refusing
  // everything is not having a bad moment, and retrying would double the load
  // against it. Asserted on the log line rather than on a call count, because a
  // count cannot separate "8 first-pass + 8 retries" from "16 first-pass".
  check(
    'ef circuit: no retry pass against a refusing host',
    blockedLogs.includes('eightfold: retrying failed details'),
    false,
  );
  check('ef circuit: the listings still land', blockedResult.jobs.length, 30);
  check('ef circuit: no description when blocked', blockedResult.jobs[0]?.description, undefined);

  const noDetail = { detailCalls: 0, failDetailIds: new Set<string>() };
  const noDetailResult = await withServer(startEightfoldMock(noDetail), (origin) =>
    new EightfoldAdapter().scrape(efContext(origin, { includeDetailPages: false })),
  );
  check('ef detail: disabled makes no detail calls', noDetail.detailCalls, 0);
  check('ef detail: listing still complete without detail', noDetailResult.jobs.length, EF_TOTAL);
  check('ef detail: no description without detail', noDetailResult.jobs[0]?.description, undefined);

  // ── Phenom: one call, no detail stage, and the location guard ──────────────
  const phResult = await withServer(startPhenomMock({ failFirstPage: false }), (origin) =>
    new PhenomAdapter().scrape(phContext(origin)),
  );
  check('ph crawl: every posting collected', phResult.jobs.length, PH_TOTAL);
  check('ph crawl: no duplicates', new Set(phResult.jobs.map((j) => j.externalId)).size, PH_TOTAL);
  check('ph crawl: no errors', phResult.errors.length, 0);
  // The description comes from the listing, so there is no detail stage at all.
  check('ph crawl: description from the listing', phResult.jobs[0]?.description?.includes('AXA body'), true);
  check('ph crawl: department from categories', phResult.jobs[0]?.department, 'CLAIMS AND ASSISTANCE');
  check('ph crawl: employmentType from tags2', phResult.jobs[0]?.employmentType, 'Permanent contract');
  check('ph crawl: workSchedule from tags1', phResult.jobs[0]?.workSchedule, 'Full-time');
  check('ph crawl: postedAt from explicit offset', phResult.jobs[0]?.publishedAt, '2026-08-14T09:10:00.000Z');
  check('ph crawl: apply URL is the ATS link', phResult.jobs[0]?.applyUrl?.includes('icims.com'), true);
  check('ph crawl: public url', phResult.jobs[0]?.url, 'https://careers.axa.com/careers-home/jobs/20000?lang=en-us');

  // The guard that stops a global-board crawl being stored as Hong Kong jobs.
  const noLocation = await withServer(startPhenomMock({ failFirstPage: false }), (origin) =>
    new PhenomAdapter().scrape({
      ...phContext(origin),
      entryUrls: ['https://careers.axa.com/careers-home/jobs'],
    }),
  );
  check('ph guard: refuses without a location filter', noLocation.jobs.length, 0);
  check('ph guard: explains why', /global job board/.test(noLocation.errors[0]?.message ?? ''), true);

  // An explicit config.location overrides the URL.
  const fromConfig = await withServer(startPhenomMock({ failFirstPage: false }), (origin) =>
    new PhenomAdapter().scrape({
      ...phContext(origin, { location: 'Hong Kong' }),
      entryUrls: ['https://careers.axa.com/careers-home/jobs'],
    }),
  );
  check('ph guard: config.location satisfies the filter', fromConfig.jobs.length, PH_TOTAL);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
