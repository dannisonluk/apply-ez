import { request } from 'undici';
import type { RawJob } from './adapter.interface.js';
import type { ScraperAdapter, ScrapeContext, ScrapeResult } from './adapter.interface.js';
import {
  HttpStatusError,
  RobotsDisallowedError,
  isAllowedByRobots,
  isRetriableStatus,
  parseRetryAfterMs,
  robotsDisallowedScrapeError,
  robotsDisallowedScrapeErrorFromUnknown,
  scraperUserAgent,
  throttledFetch,
  withRetry,
} from '../lib/rate-limit.js';

interface AIAConfig {
  companyName?: string;
  companyDomain?: string;
  maxPages?: number;
  fullCrawl?: boolean;
  startUrl?: string;
  locale?: string; // 'en' (default) or 'zh-TW'
  locationCountry?: string; // Workday location country ID (default: Hong Kong)
}

const DEFAULT_START_URL = 'https://aia.wd3.myworkdayjobs.com/wday/cxs/aia/External/jobs';
const DEFAULT_COMPANY_NAME = 'AIA';
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_LOCALE = 'en'; // Default to English
const DEFAULT_LOCATION_COUNTRY = 'd4afdeb461d446e4babd204bd102dba8'; // Hong Kong

interface WorkdayJob {
  id?: string;
  title?: string;
  bulletFields?: string[];
  locationsText?: string;
  postedOn?: string;
  externalPath?: string;
  subtitles?: Array<{ type?: string; caption?: string }>;
  timeType?: string;
}

interface WorkdayJobPosting {
  job?: WorkdayJob;
  title?: string;
  bulletFields?: string[];
  locationsText?: string;
  postedOn?: string;
  externalPath?: string;
  subtitles?: Array<{ type?: string; caption?: string }>;
}

interface WorkdayResponse {
  jobPostings?: WorkdayJobPosting[];
  total?: number;
}

interface AiaTopMetadata {
  workSchedule?: string;
  contractType?: string;
}

function normalizeText(value: string | undefined | null): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function parseDateOrNow(raw: string | undefined): string {
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function extractLocationFromJob(jobPosting: WorkdayJobPosting): string {
  const job = jobPosting.job ?? jobPosting;

  // Try locationsText first
  if (job.locationsText) return normalizeText(job.locationsText);

  // Try subtitles
  if (Array.isArray(job.subtitles)) {
    for (const subtitle of job.subtitles) {
      if (subtitle.type === 'location' && subtitle.caption) {
        return normalizeText(subtitle.caption);
      }
    }
  }

  // Try bulletFields
  if (Array.isArray(job.bulletFields) && job.bulletFields.length > 0) {
    const firstField = job.bulletFields[0];
    if (firstField) return normalizeText(firstField);
  }

  return 'Hong Kong';
}

function buildJobUrl(baseUrl: string, externalPath: string | undefined, jobId: string): string {
  if (!externalPath) return baseUrl;
  try {
    if (/^https?:\/\//i.test(externalPath)) return new URL(externalPath).toString();
    const cleanPath = externalPath.startsWith('/') ? externalPath.slice(1) : externalPath;
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return new URL(cleanPath, normalizedBase).toString();
  } catch {
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    return `${normalizedBase}/${jobId}`;
  }
}

function inferAiaMetadata(
  bulletFields: string[] | undefined,
  timeType: string | undefined,
): AiaTopMetadata | undefined {
  const out: AiaTopMetadata = {};
  const schedule = normalizeText(timeType);
  if (schedule) out.workSchedule = schedule;

  const contractFromBullets = (bulletFields ?? []).find((field) => /(contract|permanent|temporary|fixed[- ]term)/i.test(field));
  const normalizedContract = normalizeText(contractFromBullets);
  if (normalizedContract) out.contractType = normalizedContract;

  return Object.keys(out).length > 0 ? out : undefined;
}

async function fetchWorkdayJobs(
  apiUrl: string,
  offset: number,
  limit: number,
  locale: string,
  locationCountry: string,
  logger: ScrapeContext['logger'],
): Promise<WorkdayResponse> {
  return withRetry(
    async () => {
      return throttledFetch(apiUrl, async () => {
        const payload = {
          appliedFacets: {
            locationCountry: [locationCountry], // Filter by location (default: Hong Kong)
          },
          limit,
          offset,
          searchText: '',
        };

        const response = await request(apiUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json',
            'user-agent': scraperUserAgent(),
            'accept-language': locale === 'zh-TW' ? 'zh-TW,zh;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
          },
          body: JSON.stringify(payload),
          bodyTimeout: 30_000,
          headersTimeout: 30_000,
        });

        if (response.statusCode >= 400) {
          const retryAfterMs = parseRetryAfterMs(response.headers['retry-after']?.toString());
          throw new HttpStatusError(apiUrl, response.statusCode, 'HTTP error', retryAfterMs);
        }

        return (await response.body.json()) as WorkdayResponse;
      });
    },
    {
      retries: 3,
      shouldRetry: (error) => {
        if (error instanceof RobotsDisallowedError) return false;
        if (error instanceof HttpStatusError) return isRetriableStatus(error.statusCode);
        return String(error).toLowerCase().includes('timeout');
      },
      onRetry: (error, attempt, delayMs) => {
        logger.warn(`AIA Workday API retry ${attempt} in ${delayMs}ms`, {
          url: apiUrl,
          error: String(error),
        });
      },
    },
  );
}

function normalizeToApiUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // If it's already the API endpoint, return as-is
    if (url.includes('/wday/cxs/') && url.includes('/jobs')) {
      return url;
    }

    // Convert web page URL to API URL
    // From: https://aia.wd3.myworkdayjobs.com/en-US/External?locationCountry=...
    // To:   https://aia.wd3.myworkdayjobs.com/wday/cxs/aia/External/jobs

    const host = parsed.hostname; // aia.wd3.myworkdayjobs.com
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    // Extract company slug from hostname (e.g., "aia" from "aia.wd3.myworkdayjobs.com")
    const companySlug = host.split('.')[0] ?? 'aia';

    // Extract job board name from path (e.g., "External" from "/en-US/External" or "/External")
    const boardName = pathParts.find(part => !part.match(/^[a-z]{2}(-[A-Z]{2})?$/)) ?? 'External';

    // Construct API URL
    return `https://${host}/wday/cxs/${companySlug}/${boardName}/jobs`;
  } catch {
    // If URL parsing fails, return as-is and let it fail later with a better error
    return url;
  }
}

function normalizeToBoardBaseUrl(url: string, preferredLocale?: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    const fallbackLocale = preferredLocale === 'zh-TW' ? 'zh-TW' : 'en-US';
    const localeCandidate = pathParts.find((part) => /^[a-z]{2}(?:-[A-Z]{2})?$/.test(part));
    const locale = localeCandidate ?? fallbackLocale;

    // Workday listing API URLs look like: /wday/cxs/{tenant}/{board}/jobs.
    // In that case, the board segment must come from index 3, not from the first non-locale segment.
    const isApiPath =
      pathParts.length >= 5 &&
      pathParts[0]?.toLowerCase() === 'wday' &&
      pathParts[1]?.toLowerCase() === 'cxs';

    const boardName = isApiPath
      ? (pathParts[3] ?? 'External')
      : (pathParts.find((part) => !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(part)) ?? 'External');

    return `https://${host}/${locale}/${boardName}/`;
  } catch {
    const locale = preferredLocale === 'zh-TW' ? 'zh-TW' : 'en-US';
    return `https://aia.wd3.myworkdayjobs.com/${locale}/External/`;
  }
}

export class AIAAdapter implements ScraperAdapter {
  readonly name = 'aia';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const cfg = (ctx.config as AIAConfig) ?? {};
    const rawUrl = cfg.startUrl ?? ctx.urlTemplate ?? DEFAULT_START_URL;
    const apiUrl = normalizeToApiUrl(rawUrl);
    const boardBaseUrl = normalizeToBoardBaseUrl(rawUrl, cfg.locale);

    ctx.logger.info('AIA adapter starting', { rawUrl, apiUrl, boardBaseUrl });
    const companyName = cfg.companyName ?? DEFAULT_COMPANY_NAME;
    const companyDomain = cfg.companyDomain ?? 'aia.com';
    const maxPages = cfg.fullCrawl === true ? Number.POSITIVE_INFINITY : cfg.maxPages ?? DEFAULT_MAX_PAGES;
    const locale = cfg.locale ?? DEFAULT_LOCALE;
    const locationCountry = cfg.locationCountry ?? DEFAULT_LOCATION_COUNTRY;

    const jobs: RawJob[] = [];
    const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const seenIds = new Set<string>();

    try {
      if (!(await isAllowedByRobots(apiUrl))) {
        return { jobs: [], errors: [robotsDisallowedScrapeError(apiUrl)] };
      }

      const limit = 20;
      let hasMore = true;

      for (let page = 0; page < maxPages && hasMore; page++) {
        const offset = page * limit;

        try {
          ctx.logger.info(`Fetching AIA Workday page ${page}`, { offset, limit });
          const response = await fetchWorkdayJobs(apiUrl, offset, limit, locale, locationCountry, ctx.logger);

          const jobPostings = response.jobPostings ?? [];
          if (jobPostings.length === 0) {
            ctx.logger.info(`No jobs found on page ${page}, stopping pagination`);
            hasMore = false;
            break;
          }

          // Debug: log first job structure
          if (page === 0 && jobPostings.length > 0) {
            ctx.logger.info('First job raw data sample:', { job: jobPostings[0] });
          }

          // Check if we've reached the end
          const total = response.total ?? 0;
          if (offset + jobPostings.length >= total) {
            hasMore = false;
          }

          for (const jobPosting of jobPostings) {
            // Workday wraps job data in a 'job' property
            const job = jobPosting.job ?? jobPosting;
            const detailExternalPath = job.externalPath ?? jobPosting.externalPath;

            // Extract job ID from bulletFields (usually last item like "JR-66283")
            const jobIdFromBullet = job.bulletFields?.find(field => /^JR-\d+$/i.test(field));
            const jobId = jobIdFromBullet ?? detailExternalPath ?? '';

            if (!jobId || seenIds.has(jobId)) continue;
            seenIds.add(jobId);

            const title = normalizeText(job.title);
            if (!title) {
              ctx.logger.warn('Skipping job with no title', { jobId, job });
              continue;
            }

            const location = extractLocationFromJob(jobPosting);
            const description = [title, ...(job.bulletFields ?? [])].filter(Boolean).join('\n');

            // Build job URL from base URL
            const jobUrl = buildJobUrl(boardBaseUrl, detailExternalPath, jobId);

            ctx.logger.info('Processing job', { jobId, title, location, jobUrl });

            const inferredMetadata = inferAiaMetadata(job.bulletFields, 'timeType' in job ? job.timeType : undefined);

            jobs.push({
              externalId: jobId,
              companyName,
              companyDomain,
              locale: locale === 'zh-TW' ? 'zh-HK' : 'en',
              title,
              location,
              description,
              url: jobUrl,
              applyUrl: jobUrl,
              source: 'WORKDAY',
              tags: [],
              publishedAt: parseDateOrNow(job.postedOn),
              salaryCurrency: 'HKD',
              ...(inferredMetadata?.contractType ? { employmentType: inferredMetadata.contractType } : {}),
              ...(inferredMetadata ? { topMetadata: inferredMetadata } : {}),
              localizedContents: [
                {
                  locale: locale === 'zh-TW' ? 'zh-HK' : 'en',
                  title,
                  location,
                  description,
                  url: jobUrl,
                  applyUrl: jobUrl,
                  ...(inferredMetadata ? { topMetadata: inferredMetadata } : {}),
                },
              ],
            });
          }

          ctx.logger.info(`AIA page ${page} produced ${jobPostings.length} jobs (total: ${total})`);
        } catch (pageErr) {
          errors.push({
            message: `Failed to fetch page ${page}: ${String(pageErr)}`,
            context: { page, offset },
          });
          if (cfg.fullCrawl === true || (pageErr instanceof HttpStatusError && pageErr.statusCode === 404)) {
            hasMore = false;
            break;
          }
        }
      }

      return { jobs, errors };
    } catch (err) {
      const robotsError = robotsDisallowedScrapeErrorFromUnknown(err);
      if (robotsError) return { jobs, errors: [robotsError] };
      return { jobs, errors: [{ message: String(err) }] };
    }
  }
}
