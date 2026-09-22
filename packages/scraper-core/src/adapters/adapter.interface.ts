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
