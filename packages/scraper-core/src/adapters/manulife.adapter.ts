import { request } from 'undici';
import type { ScraperAdapter, ScrapeContext, ScrapeResult, RawJob } from './adapter.interface.js';
import {
  HttpStatusError,
  RobotsDisallowedError,
  isRetriableStatus,
  parseRetryAfterMs,
  robotsDisallowedScrapeErrorFromUnknown,
  scraperUserAgent,
  throttledFetch,
  withRetry,
} from '../lib/rate-limit.js';

interface ManulifeConfig {
  companyName?: string;
  companyDomain?: string;
  maxPages?: number;
  maxJobs?: number;
  fullCrawl?: boolean;
  startUrl?: string;
  locale?: string;
  locationCountry?: string;
  locationCountryFacet?: string;
  searchText?: string;
}

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
  id?: string;
  title?: string;
  bulletFields?: string[];
  locationsText?: string;
  postedOn?: string;
  externalPath?: string;
  subtitles?: Array<{ type?: string; caption?: string }>;
  timeType?: string;
}

interface WorkdayResponse {
  jobPostings?: WorkdayJobPosting[];
  total?: number;
}

const DEFAULT_CAREERS_URL = 'https://careers.manulife.com/global/en/search-results';
const DEFAULT_API_URL = 'https://manulife.wd3.myworkdayjobs.com/wday/cxs/manulife/MFCJH_Jobs/jobs';
const DEFAULT_BOARD_BASE_URL = 'https://manulife.wd3.myworkdayjobs.com/en-US/MFCJH_Jobs/';
const DEFAULT_COMPANY_NAME = 'Manulife';
const DEFAULT_MAX_PAGES = 8;
const DEFAULT_MAX_JOBS = 80;
const DEFAULT_LOCALE = 'en';
const DEFAULT_LOCATION_COUNTRY = 'd4afdeb461d446e4babd204bd102dba8';
const DEFAULT_LOCATION_COUNTRY_FACET = 'Location_Country';

function normalizeText(value: string | undefined | null): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function parseDateOrNow(raw: string | undefined): string {
  if (!raw) return new Date().toISOString();
  const normalized = normalizeText(raw).toLowerCase();
  const now = new Date();
  if (normalized === 'posted today' || normalized === 'today') {
    return now.toISOString();
  }
  if (normalized === 'posted yesterday' || normalized === 'yesterday') {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  }
  const daysAgo = normalized.match(/(?:posted\s+)?(\d+)\s+days?\s+ago/);
  if (daysAgo?.[1]) {
    const count = Number.parseInt(daysAgo[1], 10);
    if (Number.isFinite(count)) {
      return new Date(now.getTime() - count * 24 * 60 * 60 * 1000).toISOString();
    }
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function slugSegment(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalizeToApiUrl(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.hostname === 'careers.manulife.com') {
      return DEFAULT_API_URL;
    }

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const isApiPath =
      pathParts.length >= 5 &&
      pathParts[0]?.toLowerCase() === 'wday' &&
      pathParts[1]?.toLowerCase() === 'cxs' &&
      pathParts[pathParts.length - 1]?.toLowerCase() === 'jobs';

    if (isApiPath) return parsed.toString();

    if (parsed.hostname.includes('myworkdayjobs.com')) {
      const tenant = parsed.hostname.split('.')[0] ?? 'manulife';
      const boardName =
        pathParts.find((part) => !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(part)) ?? 'MFCJH_Jobs';
      return `https://${parsed.hostname}/wday/cxs/${tenant}/${boardName}/jobs`;
    }
  } catch {
    return DEFAULT_API_URL;
  }

  return DEFAULT_API_URL;
}

function normalizeToBoardBaseUrl(url: string, preferredLocale?: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'careers.manulife.com') return DEFAULT_BOARD_BASE_URL;

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const isApiPath =
      pathParts.length >= 5 &&
      pathParts[0]?.toLowerCase() === 'wday' &&
      pathParts[1]?.toLowerCase() === 'cxs';
    const boardName = isApiPath
      ? (pathParts[3] ?? 'MFCJH_Jobs')
      : (pathParts.find((part) => !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(part)) ?? 'MFCJH_Jobs');
    const locale = preferredLocale === 'zh-TW' ? 'zh-TW' : 'en-US';

    return `https://${parsed.hostname}/${locale}/${boardName}/`;
  } catch {
    return DEFAULT_BOARD_BASE_URL;
  }
}

function extractLocationFromJob(jobPosting: WorkdayJobPosting): string {
  const job = jobPosting.job ?? jobPosting;

  if (job.locationsText) return normalizeText(job.locationsText);

  if (Array.isArray(job.subtitles)) {
    const locationSubtitle = job.subtitles.find((subtitle) => subtitle.type === 'location' && subtitle.caption);
    if (locationSubtitle?.caption) return normalizeText(locationSubtitle.caption);
  }

  const locationBullet = job.bulletFields?.find((field) => /hong kong|hk/i.test(field));
  if (locationBullet) return normalizeText(locationBullet);

  return 'Hong Kong';
}

function buildJobUrl(boardBaseUrl: string, externalPath: string | undefined, jobId: string): string {
  if (!externalPath) return boardBaseUrl;
  try {
    if (/^https?:\/\//i.test(externalPath)) return new URL(externalPath).toString();
    const cleanPath = externalPath.startsWith('/') ? externalPath.slice(1) : externalPath;
    const normalizedBase = boardBaseUrl.endsWith('/') ? boardBaseUrl : `${boardBaseUrl}/`;
    return new URL(cleanPath, normalizedBase).toString();
  } catch {
    return `${boardBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(jobId)}`;
  }
}

function normalizeExternalId(job: WorkdayJob, jobUrl: string, title: string): string {
  const id = normalizeText(job.id);
  if (id) return `manulife:${id}`;

  const jrId =
    job.bulletFields?.map(normalizeText).find((field) => /^JR[0-9A-Z-]+$/i.test(field)) ??
    normalizeText(job.externalPath).match(/\bJR[0-9A-Z-]+\b/i)?.[0];
  if (jrId) return `manulife:${jrId.toUpperCase()}`;

  const externalPath = normalizeText(job.externalPath);
  const pathId = externalPath.match(/\/([^/?#]+)$/)?.[1];
  if (pathId) return `manulife:${pathId}`;

  return `${jobUrl.replace(/\/+$/, '')}:${slugSegment(title)}`;
}

function buildDescription(title: string, job: WorkdayJob): string {
  const fields = Array.isArray(job.bulletFields) ? job.bulletFields.map(normalizeText).filter(Boolean) : [];
  return [title, ...fields].join('\n') || `${title} at ${DEFAULT_COMPANY_NAME}.`;
}

async function fetchWorkdayJobs(
  apiUrl: string,
  offset: number,
  limit: number,
  locale: string,
  locationCountry: string | undefined,
  locationCountryFacet: string,
  searchText: string,
  logger: ScrapeContext['logger'],
): Promise<WorkdayResponse> {
  return withRetry(
    async () => {
      return throttledFetch(apiUrl, async () => {
        const appliedFacets = locationCountry ? { [locationCountryFacet]: [locationCountry] } : {};
        const response = await request(apiUrl, {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'accept-language': locale === 'zh-TW' ? 'zh-TW,zh;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
            'content-type': 'application/json',
            'user-agent': scraperUserAgent(),
          },
          body: JSON.stringify({
            appliedFacets,
            limit,
            offset,
            searchText,
          }),
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
        logger.warn(`Manulife Workday API retry ${attempt} in ${delayMs}ms`, {
          url: apiUrl,
          error: String(error),
        });
      },
    },
  );
}

export class ManulifeAdapter implements ScraperAdapter {
  readonly name = 'manulife';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const cfg = (ctx.config as ManulifeConfig) ?? {};
    const rawUrl = cfg.startUrl ?? ctx.urlTemplate ?? DEFAULT_CAREERS_URL;
    const apiUrl = normalizeToApiUrl(rawUrl);
    const boardBaseUrl = normalizeToBoardBaseUrl(rawUrl, cfg.locale);
    const companyName = cfg.companyName ?? DEFAULT_COMPANY_NAME;
    const companyDomain = cfg.companyDomain ?? 'manulife.com';
    const locale = cfg.locale ?? DEFAULT_LOCALE;
    const locationCountry = cfg.locationCountry ?? DEFAULT_LOCATION_COUNTRY;
    const locationCountryFacet = cfg.locationCountryFacet ?? DEFAULT_LOCATION_COUNTRY_FACET;
    const searchText = cfg.searchText ?? '';
    const fullCrawl = cfg.fullCrawl === true;
    const maxPages = fullCrawl ? Number.POSITIVE_INFINITY : (cfg.maxPages ?? DEFAULT_MAX_PAGES);
    const maxJobs = fullCrawl ? Number.POSITIVE_INFINITY : (cfg.maxJobs ?? DEFAULT_MAX_JOBS);

    const jobs: RawJob[] = [];
    const errors: ScrapeResult['errors'] = [];
    const seen = new Set<string>();

    ctx.logger.info('Manulife adapter starting', { rawUrl, apiUrl, boardBaseUrl });

    const limit = 20;
    try {
      for (let page = 0; page < maxPages; page += 1) {
        if (jobs.length >= maxJobs) break;

        const offset = page * limit;
        const response = await fetchWorkdayJobs(
          apiUrl,
          offset,
          limit,
          locale,
          locationCountry,
          locationCountryFacet,
          searchText,
          ctx.logger,
        );
        const postings = response.jobPostings ?? [];

        if (postings.length === 0) break;

        for (const posting of postings) {
          if (jobs.length >= maxJobs) break;

          const job = posting.job ?? posting;
          const title = normalizeText(job.title);
          if (!title) continue;

          const jobUrl = buildJobUrl(boardBaseUrl, job.externalPath ?? posting.externalPath, job.id ?? title);
          const externalId = normalizeExternalId(job, jobUrl, title);
          if (seen.has(externalId)) continue;
          seen.add(externalId);

          const location = extractLocationFromJob(posting);
          const description = buildDescription(title, job);

          jobs.push({
            externalId,
            companyName,
            companyDomain,
            locale: locale === 'zh-TW' ? 'zh-HK' : 'en',
            title,
            location,
            description,
            url: jobUrl,
            applyUrl: jobUrl,
            source: 'WORKDAY',
            tags: ['manulife'],
            salaryCurrency: 'HKD',
            ...(job.timeType ? { rawEmploymentType: normalizeText(job.timeType) } : {}),
            publishedAt: parseDateOrNow(job.postedOn),
            localizedContents: [
              {
                locale: locale === 'zh-TW' ? 'zh-HK' : 'en',
                title,
                location,
                description,
                url: jobUrl,
                applyUrl: jobUrl,
              },
            ],
          });
        }

        const total = response.total ?? 0;
        if (total > 0 && offset + postings.length >= total) break;
      }
    } catch (error) {
      const robotsError = robotsDisallowedScrapeErrorFromUnknown(error, { url: apiUrl });
      errors.push(robotsError ?? { message: `Failed to fetch Manulife Workday jobs: ${String(error)}` });
    }

    return { jobs, errors };
  }
}
