/**
 * Static scrape targets.
 *
 * In the original `ineedajob` monorepo these lived in the `ScraperTarget` DB table
 * and were polled by a node-cron scheduler. For a standalone scraper they are plain
 * config: the GitHub Actions workflow runs every 4 hours and fans out one job per
 * target via the `--target=<id>` CLI flag, so per-target crons are no longer needed.
 *
 * The `config` objects are carried over verbatim from the original seed so adapter
 * behaviour (pagination caps, detail pages, platform hints) stays identical.
 */

export interface ScrapeTarget {
  /** Stable slug. Used by `--target=<id>` and stored on scrape_runs.adapter. */
  id: string;
  name: string;
  /** Registry key in `adapters/registry.ts`. */
  adapter: string;
  companyName: string;
  /** Slug used to upsert the `companies` row. */
  companySlug: string;
  companyDomain: string;
  entryUrls: string[];
  region: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export const SCRAPE_TARGETS: ScrapeTarget[] = [
  {
    id: 'cathay-pacific',
    name: 'Cathay Pacific Careers',
    adapter: 'cathaypacific',
    companyName: 'Cathay Pacific',
    companySlug: 'cathay-pacific',
    companyDomain: 'cathaypacific.com',
    entryUrls: [
      'https://careers.cathaypacific.com/en/careers/jobs?keyword=&sortby=date&page=1',
      'https://careers.cathaypacific.com/zh_HK/careers/jobs?keyword=&sortby=date&page=1',
    ],
    region: 'HK',
    config: {
      companyName: 'Cathay Pacific',
      maxPages: 5,
      includeDetailPages: true,
      reconcileMissingJobs: true,
    },
    enabled: true,
  },
  {
    id: 'aia',
    name: 'AIA Hong Kong Careers',
    // Reads Workday's public CXS JSON API — no browser. The previous `aia`
    // adapter drove Playwright through the same data, which is why it was slow
    // and why `applicationDeadline` was never populated.
    adapter: 'workday',
    companyName: 'AIA',
    companySlug: 'aia',
    companyDomain: 'aia.com',
    entryUrls: [
      'https://aia.wd3.myworkdayjobs.com/en-US/External?locationCountry=d4afdeb461d446e4babd204bd102dba8',
    ],
    region: 'HK',
    config: {
      companyName: 'AIA',
      companyDomain: 'aia.com',
      // 20 per page (Workday's cap), and AIA has ~116 HK postings.
      maxPages: 8,
      maxJobs: 400,
      includeDetailPages: true,
      maxDetailJobs: 200,
      reconcileMissingJobs: true,
      locationCountry: 'd4afdeb461d446e4babd204bd102dba8',
      locale: 'en',
    },
    enabled: true,
  },
  {
    id: 'axa',
    name: 'AXA Hong Kong Careers',
    adapter: 'axa',
    companyName: 'AXA',
    companySlug: 'axa',
    companyDomain: 'axa.com',
    entryUrls: [
      'https://careers.axa.com/careers-home/jobs?woe=7&lat=22.28552&lng=114.15769&location=Hong%20Kong,%20Central%20and%20Western%20District,%20Hong%20Kong&commuteUnit=DRIVING&commute=60&roadTraffic=BUSY_HOUR&searchType=commute&page=1&limit=100',
    ],
    region: 'HK',
    config: {
      companyName: 'AXA',
      companyDomain: 'axa.com',
      maxPages: 1,
      maxJobs: 100,
      reconcileMissingJobs: true,
    },
    enabled: true,
  },
  {
    id: 'manulife',
    name: 'Manulife Hong Kong Careers',
    // Same Workday CXS API as AIA — see the note on the AIA target.
    adapter: 'workday',
    companyName: 'Manulife',
    companySlug: 'manulife',
    companyDomain: 'manulife.com',
    entryUrls: ['https://manulife.wd3.myworkdayjobs.com/en-US/MFCJH_Jobs'],
    region: 'HK',
    config: {
      companyName: 'Manulife',
      companyDomain: 'manulife.com',
      maxPages: 12,
      maxJobs: 400,
      includeDetailPages: true,
      maxDetailJobs: 200,
      reconcileMissingJobs: true,
      locationCountry: 'd4afdeb461d446e4babd204bd102dba8',
      locationCountryFacet: 'Location_Country',
      locale: 'en',
    },
    enabled: true,
  },
  {
    id: 'hsbc',
    name: 'HSBC Hong Kong Careers',
    adapter: 'corporate-careers',
    companyName: 'HSBC',
    companySlug: 'hsbc',
    companyDomain: 'hsbc.com',
    entryUrls: ['https://portal.careers.hsbc.com/careers?location=Hong+Kong&hl=en'],
    region: 'HK',
    config: {
      platform: 'hsbc',
      companyName: 'HSBC',
      companyDomain: 'hsbc.com',
      maxPages: 5,
      includeDetailPages: true,
      reconcileMissingJobs: true,
    },
    enabled: true,
  },
  {
    id: 'hk-express',
    name: 'HK Express Careers',
    adapter: 'corporate-careers',
    companyName: 'HK Express',
    companySlug: 'hk-express',
    companyDomain: 'hkexpress.com',
    entryUrls: [
      'https://careers.hkexpress.com/en/search/?search-keyword=&work-type=&location=Hong+Kong+SAR&category=',
    ],
    region: 'HK',
    config: {
      platform: 'pageup',
      companyName: 'HK Express',
      companyDomain: 'hkexpress.com',
      maxPages: 3,
      includeDetailPages: true,
      reconcileMissingJobs: true,
    },
    enabled: true,
  },
  {
    id: 'swire-group',
    name: 'Swire Group Careers',
    adapter: 'corporate-careers',
    companyName: 'Swire Group',
    companySlug: 'swire-group',
    companyDomain: 'swire.com',
    entryUrls: ['https://mycareers.swire.com/go/JSSHK/3965401/'],
    region: 'HK',
    config: {
      platform: 'successfactors',
      companyName: 'Swire Group',
      companyDomain: 'swire.com',
      maxPages: 5,
      includeDetailPages: true,
      reconcileMissingJobs: true,
    },
    enabled: true,
  },
  {
    id: 'towngas',
    name: 'Towngas Careers',
    adapter: 'corporate-careers',
    companyName: 'Towngas',
    companySlug: 'towngas',
    companyDomain: 'towngas.com',
    entryUrls: ['https://www.towngas.com/en/Careers/Job-Opportunities/Job-List'],
    region: 'HK',
    config: {
      platform: 'towngas',
      companyName: 'Towngas',
      companyDomain: 'towngas.com',
      maxPages: 1,
      includeDetailPages: true,
      reconcileMissingJobs: true,
    },
    enabled: true,
  },
  {
    id: 'mtr',
    name: 'MTR Careers',
    adapter: 'corporate-careers',
    companyName: 'MTR Corporation',
    companySlug: 'mtr',
    companyDomain: 'mtr.com.hk',
    entryUrls: ['https://careers.mtr.com.hk/careersection/mtr_external/joblist.ftl'],
    region: 'HK',
    config: {
      platform: 'taleo',
      companyName: 'MTR Corporation',
      companyDomain: 'mtr.com.hk',
      maxPages: 3,
      includeDetailPages: true,
      reconcileMissingJobs: true,
    },
    enabled: true,
  },
  {
    id: 'clp',
    name: 'CLP Careers',
    adapter: 'corporate-careers',
    companyName: 'CLP',
    companySlug: 'clp',
    companyDomain: 'clp.com.hk',
    entryUrls: [
      'https://iabhtj.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CLP-Recruitment-System/jobs?mode=job-location&sortBy=POSTING_DATES_DESC',
    ],
    region: 'HK',
    config: {
      platform: 'oracle',
      companyName: 'CLP',
      companyDomain: 'clp.com.hk',
      maxPages: 3,
      includeDetailPages: true,
      reconcileMissingJobs: true,
    },
    enabled: true,
  },
  {
    id: 'morgan-stanley',
    name: 'Morgan Stanley Hong Kong Careers',
    adapter: 'corporate-careers',
    companyName: 'Morgan Stanley',
    companySlug: 'morgan-stanley',
    companyDomain: 'morganstanley.com',
    entryUrls: [
      'https://morganstanley.eightfold.ai/careers?source=mscom&start=0&pid=549798142393&sort_by=timestamp&filter_city=Hong+Kong&filter_employmenttype=full+time&filter_country=Hong+Kong',
    ],
    region: 'HK',
    config: {
      platform: 'eightfold',
      companyName: 'Morgan Stanley',
      companyDomain: 'morganstanley.com',
      maxPages: 5,
      includeDetailPages: true,
      reconcileMissingJobs: true,
    },
    enabled: true,
  },
  {
    id: 'shkp',
    name: 'Sun Hung Kai Properties Careers',
    adapter: 'corporate-careers',
    companyName: 'Sun Hung Kai Properties',
    companySlug: 'shkp',
    companyDomain: 'shkp.com',
    // NOTE: no query string — SHKP robots.txt has "Disallow: /*?" so the
    // joblocat parameter makes the listing URL robot-disallowed.
    entryUrls: ['https://www.shkp.com/en-US/work-with-us/job-vacancies'],
    region: 'HK',
    config: {
      platform: 'shkp',
      companyName: 'Sun Hung Kai Properties',
      companyDomain: 'shkp.com',
      maxPages: 1,
      maxJobs: 100,
      includeDetailPages: false,
      reconcileMissingJobs: true,
    },
    enabled: true,
  },
];

export function getTarget(id: string): ScrapeTarget | undefined {
  return SCRAPE_TARGETS.find((target) => target.id === id);
}

export function enabledTargets(): ScrapeTarget[] {
  return SCRAPE_TARGETS.filter((target) => target.enabled);
}
