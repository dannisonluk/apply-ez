import type { JobIngest } from '../types/index.js';

export interface ScrapeContext {
  targetId: string;
  urlTemplate: string | undefined;
  entryUrls: string[] | undefined;
  config: Record<string, unknown>;
  region: string;
  logger: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };

  /**
   * External ids already stored for this target, when the run is incremental.
   *
   * `undefined` means a **full** crawl: fetch everything, as before. A `Set` means
   * the caller only needs what is new, and adapters should act on it in two ways:
   *
   *   1. **Skip the detail stage for ids in the set.** Detail pages are the whole
   *      cost of a run — roughly 1,000 requests per full crawl, of which about 80%
   *      re-fetch postings already stored. Nothing is lost by skipping them on a
   *      6-hourly run, because the daily `--full` run refreshes every row.
   *   2. **Stop paginating once a page adds no new ids**, which is what makes this
   *      incremental rather than "full crawl with a cheaper tail". Only valid when
   *      the listing is sorted newest-first; see `sortBy` in each target's config.
   *
   * Deliberately NOT used to skip a job entirely: the listing row is still upserted,
   * so `last_seen_at` keeps moving and a posting that disappears is still detected.
   */
  knownExternalIds?: ReadonlySet<string> | undefined;
}

/** True when the caller wants only what is new (see `knownExternalIds`). */
export function isIncremental(ctx: ScrapeContext): boolean {
  return ctx.knownExternalIds !== undefined;
}

/**
 * True when this job's detail page can be skipped: incremental run, and the job is
 * already stored. A full crawl always returns false, so `--full` behaves exactly as
 * it did before.
 */
export function canSkipDetail(ctx: ScrapeContext, externalId: string): boolean {
  return ctx.knownExternalIds?.has(externalId) === true;
}

/**
 * What an adapter emits for one scraped job BEFORE pipeline normalization.
 *
 * LEAN scope: only core listing fields carry meaning. Legacy deep-content fields
 * (locale/summary/description/requirements/sectionContent/localizedContents) are
 * still tolerated here so adapters keep compiling, but they are no longer part of
 * the ingest contract — `prepareJobsForIngest` strips them at the boundary.
 */
export interface RawJob {
  source: string;
  externalId: string;
  title: string;
  url: string;
  publishedAt: string;
  location?: string | undefined;
  applyUrl?: string | undefined;
  companyName?: string | undefined;
  companyDomain?: string | undefined;
  tags?: string[] | undefined;
  salaryMin?: number | undefined;
  salaryMax?: number | undefined;
  salaryCurrency?: string | undefined;
  remote?: boolean | undefined;
  employmentType?: string | undefined;
  jobLevel?: string | undefined;
  department?: string | undefined;
  applicationDeadline?: string | undefined;
  workSchedule?: string | undefined;
  rawEmploymentType?: string | undefined;
  requiresVisa?: boolean | undefined;
  experienceMin?: number | undefined;
  classification?: JobIngest['classification'] | undefined;
  topMetadata?: JobIngest['topMetadata'] | undefined;

  // Legacy tolerated fields — stripped by the pipeline before ingest.
  locale?: string | undefined;
  summary?: string | undefined;
  description?: string | undefined;
  requirements?: string | undefined;
  sectionContent?: unknown;
  localizedContents?: unknown[];

  [key: string]: unknown;
}

export interface ScrapeResult {
  jobs: RawJob[];
  errors: Array<{ message: string; context?: Record<string, unknown> }>;
}

/**
 * Adapter contract. Implement one per site/platform.
 * `generic` uses selectors from config.selectors; `greenhouse`, `lever`, `jobsdb`, `linkedin` have hand-written logic.
 */
export interface ScraperAdapter {
  readonly name: string;
  scrape(ctx: ScrapeContext): Promise<ScrapeResult>;
}
