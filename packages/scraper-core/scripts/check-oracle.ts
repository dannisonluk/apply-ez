/**
 * Regression check for the Oracle Recruiting Cloud adapter.
 *
 * Run with:  pnpm --filter @apply-ez/scraper-core exec tsx scripts/check-oracle.ts
 *
 * Same two halves as `check-workday` / `check-platform-adapters`: pure parsing
 * functions, then a mock API server for the behaviours that only show up against a
 * live tenant.
 *
 * The mock cases are the ones that failed SILENTLY during development against CLP:
 *   - dropping `expand=requisitionList.secondaryLocations` returns HTTP 200 with a
 *     complete-looking envelope, `TotalJobsCount: 39`, and NO rows at all;
 *   - the response's `limit` field reads 200 no matter what was requested, so
 *     treating it as an echo of the request would end pagination after one page.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  OracleAdapter,
  buildJobUrl,
  isValidSiteNumber,
  parseOracleUrl,
} from '../src/adapters/oracle.adapter.js';
import type { ScrapeContext } from '../src/adapters/adapter.interface.js';
import { configureRateLimit } from '../src/lib/rate-limit.js';

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

const CLP_URL =
  'https://iabhtj.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CLP-Recruitment-System/jobs?mode=job-location&sortBy=POSTING_DATES_DESC';

// ─── parseOracleUrl ───────────────────────────────────────────────────────────
const clp = parseOracleUrl(CLP_URL);
check(
  'oracle url: api base',
  clp?.apiBase,
  'https://iabhtj.fa.ocs.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions',
);
check('oracle url: origin', clp?.origin, 'https://iabhtj.fa.ocs.oraclecloud.com');
check('oracle url: locale from the path', clp?.locale, 'en');
check('oracle url: site slug from the path', clp?.siteSlug, 'CLP-Recruitment-System');
check('oracle url: a zh-HK site keeps its locale', parseOracleUrl('https://x.oraclecloud.com/hcmUI/CandidateExperience/zh-HK/sites/S/jobs')?.locale, 'zh-HK');
check('oracle url: no /sites/ segment is tolerated', parseOracleUrl('https://x.oraclecloud.com/hcmUI/CandidateExperience/en/jobs')?.siteSlug, undefined);
check('oracle url: a non-Oracle URL is rejected', parseOracleUrl('https://careers.example.com/jobs'), undefined);
check('oracle url: garbage is rejected', parseOracleUrl('not a url'), undefined);

// ─── isValidSiteNumber ────────────────────────────────────────────────────────
// The site number is interpolated into the finder VALUE, where `;` and `,` are
// delimiters. Anything that could inject another finder parameter is refused.
check('siteNumber: CX_1 is valid', isValidSiteNumber('CX_1'), true);
check('siteNumber: plain digits are valid', isValidSiteNumber('1001'), true);
check('siteNumber: a comma is refused', isValidSiteNumber('CX_1,limit=999'), false);
check('siteNumber: a semicolon is refused', isValidSiteNumber('CX_1;siteNumber=CX_2'), false);
check('siteNumber: a space is refused', isValidSiteNumber('CX 1'), false);
check('siteNumber: empty is refused', isValidSiteNumber(''), false);
check('siteNumber: an over-long value is refused', isValidSiteNumber('C'.repeat(41)), false);

// ─── buildJobUrl ──────────────────────────────────────────────────────────────
check(
  'job url: built from the site slug',
  buildJobUrl({ apiBase: 'x', origin: 'https://h.example.com', locale: 'en', siteSlug: 'My-Site' }, '1163'),
  'https://h.example.com/hcmUI/CandidateExperience/en/sites/My-Site/job/1163',
);
check(
  'job url: falls back to the board when there is no slug',
  buildJobUrl({ apiBase: 'x', origin: 'https://h.example.com', locale: 'en' }, '7'),
  'https://h.example.com/hcmUI/CandidateExperience/en/jobs',
);

// ─── mock API ─────────────────────────────────────────────────────────────────
const TOTAL = 39;

interface OracleState {
  requests: number;
  offsets: number[];
  /** Simulate the missing-`expand` failure: a total, but no rows. */
  dropRows: boolean;
  status: number;
  /** What the mock reports in the envelope's `limit`, regardless of the request. */
  echoLimit: number;
}

function newState(overrides: Partial<OracleState> = {}): OracleState {
  return { requests: 0, offsets: [], dropRows: false, status: 200, echoLimit: 200, ...overrides };
}

function startOracleMock(state: OracleState) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    if (!url.pathname.endsWith('/recruitingCEJobRequisitions')) {
      res.writeHead(404);
      res.end();
      return;
    }
    state.requests += 1;

    if (state.status !== 200) {
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope' }));
      return;
    }

    // The finder is a single query VALUE containing `;` and `,`. Read it whole.
    const finder = url.searchParams.get('finder') ?? '';
    const offset = Number(/offset=(\d+)/.exec(finder)?.[1] ?? 0);
    const limit = Number(/limit=(\d+)/.exec(finder)?.[1] ?? 0);
    const hasExpand = url.searchParams.get('expand') === 'requisitionList.secondaryLocations';
    state.offsets.push(offset);

    const size = Math.max(0, Math.min(limit, TOTAL - offset));
    const rows = Array.from({ length: size }, (_, i) => ({
      Id: String(1000 + offset + i),
      Title: `Role ${offset + i}`,
      PostedDate: '2026-09-22',
      PrimaryLocation: 'Hong Kong',
      PrimaryLocationCountry: 'HK',
    }));

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        items: [
          {
            TotalJobsCount: TOTAL,
            SiteNumber: 'CX_1',
            ...(hasExpand && !state.dropRows ? { requisitionList: rows } : {}),
          },
        ],
        count: 1,
        limit: state.echoLimit,
        hasMore: false,
      }),
    );
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

function oracleContext(origin: string, overrides: Record<string, unknown> = {}): ScrapeContext {
  return {
    targetId: 'mock-clp',
    urlTemplate: undefined,
    entryUrls: [CLP_URL],
    config: {
      companyName: 'CLP',
      companyDomain: 'clp.com.hk',
      apiBase: `${origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`,
      siteNumber: 'CX_1',
      pageLimit: 25,
      maxJobs: 300,
      ...overrides,
    },
    region: 'HK',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

async function main(): Promise<void> {
  // ── happy path, and pagination driven by TotalJobsCount ────────────────────
  const state = newState();
  const result = await withServer(startOracleMock(state), (origin) =>
    new OracleAdapter().scrape(oracleContext(origin)),
  );

  check('oracle crawl: every posting collected', result.jobs.length, TOTAL);
  check('oracle crawl: no duplicates', new Set(result.jobs.map((j) => j.externalId)).size, TOTAL);
  check('oracle crawl: no errors', result.errors.length, 0);
  // 39 postings at a page limit of 25 is two pages: 0 and 25.
  check('oracle crawl: two pages requested', state.requests, 2);
  check('oracle crawl: offsets advanced by the page size', state.offsets, [0, 25]);
  // The envelope reports `limit: 200`; pagination must not believe it.
  check('oracle crawl: the echoed limit is ignored', state.echoLimit, 200);
  check('oracle crawl: externalId is the Id as a string', result.jobs[0]?.externalId, '1000');
  check('oracle crawl: title', result.jobs[0]?.title, 'Role 0');
  check('oracle crawl: location', result.jobs[0]?.location, 'Hong Kong');
  check('oracle crawl: company name', result.jobs[0]?.companyName, 'CLP');
  check('oracle crawl: url points at the CLP site slug', /\/sites\/CLP-Recruitment-System\/job\/1000$/.test(result.jobs[0]?.url ?? ''), true);
  check('oracle crawl: applyUrl matches url', result.jobs[0]?.applyUrl, result.jobs[0]?.url);
  check('oracle crawl: publishedAt from PostedDate', result.jobs[0]?.publishedAt?.startsWith('2026-09-2'), true);
  check('oracle crawl: no description is claimed', result.jobs[0]?.description, undefined);

  // ── the expand trap ────────────────────────────────────────────────────────
  // HTTP 200, `TotalJobsCount: 39`, zero rows. Reporting this as a clean empty
  // board is the failure mode this adapter exists to prevent.
  const trapState = newState({ dropRows: true });
  const trapResult = await withServer(startOracleMock(trapState), (origin) =>
    new OracleAdapter().scrape(oracleContext(origin)),
  );
  check('oracle expand trap: reported as an error', trapResult.errors.length, 1);
  check('oracle expand trap: no jobs', trapResult.jobs.length, 0);
  check('oracle expand trap: the error names expand', /expand=requisitionList\.secondaryLocations/.test(trapResult.errors[0]?.message ?? ''), true);
  check('oracle expand trap: the error names the reported total', /39 postings/.test(trapResult.errors[0]?.message ?? ''), true);

  // ── config guards: no request is made at all ───────────────────────────────
  const noSiteState = newState();
  const noSiteResult = await withServer(startOracleMock(noSiteState), (origin) =>
    new OracleAdapter().scrape(oracleContext(origin, { siteNumber: '' })),
  );
  check('oracle guard: a missing siteNumber is an error', noSiteResult.errors.length, 1);
  check('oracle guard: the error explains where to find it', /siteNumber/.test(noSiteResult.errors[0]?.message ?? ''), true);
  check('oracle guard: nothing was requested', noSiteState.requests, 0);

  const badSiteState = newState();
  const badSiteResult = await withServer(startOracleMock(badSiteState), (origin) =>
    new OracleAdapter().scrape(oracleContext(origin, { siteNumber: 'CX_1,limit=999' })),
  );
  check('oracle guard: an injectable siteNumber is refused', badSiteResult.errors.length, 1);
  check('oracle guard: nothing was requested', badSiteState.requests, 0);

  const noUrlResult = await new OracleAdapter().scrape({
    ...oracleContext('http://127.0.0.1:1'),
    entryUrls: ['https://careers.example.com/jobs'],
  });
  check('oracle guard: a non-Oracle entryUrl is refused', noUrlResult.errors.length, 1);
  check('oracle guard: the message names the URL shape', /CandidateExperience/.test(noUrlResult.errors[0]?.message ?? ''), true);

  // ── a failing listing is reported, not swallowed ───────────────────────────
  const downState = newState({ status: 503 });
  const downResult = await withServer(startOracleMock(downState), (origin) =>
    new OracleAdapter().scrape(oracleContext(origin)),
  );
  check('oracle down: reported as an error', downResult.errors.length, 1);
  check('oracle down: no jobs', downResult.jobs.length, 0);
  check('oracle down: the error names the offset', /offset=0/.test(downResult.errors[0]?.message ?? ''), true);

  // ── maxJobs caps the mapping, not just the loop ────────────────────────────
  const capState = newState();
  const capResult = await withServer(startOracleMock(capState), (origin) =>
    new OracleAdapter().scrape(oracleContext(origin, { maxJobs: 10 })),
  );
  check('oracle cap: maxJobs limits the output', capResult.jobs.length, 10);

  if (failed > 0) {
    console.error(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }
  console.log(`oracle: ${passed} assertions passed`);
}

await main();
