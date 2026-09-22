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

interface HKJCConfig {
  companyName?: string;
  companyDomain?: string;
  maxPages?: number;
  fullCrawl?: boolean;
  startUrl?: string;
  location?: string; // Location filter (default: HK)
}

const DEFAULT_START_URL = 'https://careers.hkjc.com/go/Apply-Now/7951310/?location=HK';
const DEFAULT_COMPANY_NAME = 'Hong Kong Jockey Club';
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_LOCATION = 'HK'; // Default to Hong Kong

interface TaleoJob {
  jobId?: string;
  requisitionId?: string;
  jobTitle?: string;
  title?: string;
  location?: string;
  city?: string;
  postingDate?: string;
  postedDate?: string;
  jobDescription?: string;
  description?: string;
  applyUrl?: string;
  jobUrl?: string;
  url?: string;
}

function normalizeText(value: string | undefined | null): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function stripHtmlToText(html: string): string {
  const withLineBreaks = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return withLineBreaks
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseDateOrNow(raw: string | undefined): string {
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function toAbsoluteUrl(rawUrl: string, baseUrl: string): string {
  try {
    return rawUrl.startsWith('http') ? new URL(rawUrl).toString() : new URL(rawUrl, baseUrl).toString();
  } catch {
    return rawUrl;
  }
}

function extractJobsFromHtml(html: string, baseUrl: string): TaleoJob[] {
  const jobs: TaleoJob[] = [];

  // Try to extract JSON data from script tags
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRegex)) {
    const scriptContent = match[1] ?? '';
    try {
      // Look for job data in various formats
      const jsonMatch = scriptContent.match(/(?:jobs|requisitions|jobResults)\s*[:=]\s*(\[[\s\S]*?\])/i);
      if (jsonMatch?.[1]) {
        const parsed = JSON.parse(jsonMatch[1]) as unknown[];
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'object' && item !== null) {
              jobs.push(item as TaleoJob);
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Fallback: extract from HTML structure - look for actual job listings
  if (jobs.length === 0) {
    // Look for job cards/items with more specific patterns
    const jobCardRegex = /<div[^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    const jobLinkRegex = /<a[^>]*href=["']([^"']*(?:job|requisition|position)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

    for (const match of html.matchAll(jobLinkRegex)) {
      const href = match[1] ?? '';
      const linkContent = match[2] ?? '';
      const text = stripHtmlToText(linkContent);

      // Skip navigation links and pagination
      if (!href || !text) continue;
      if (text.length < 5) continue; // Skip very short text like "«", "2", etc.
      if (/^(apply now|«|»|previous|next|\d+)$/i.test(text.trim())) continue;
      if (href.includes('sortColumn') || href.includes('sortDirection')) continue;

      const jobIdMatch = href.match(/(?:jobId|requisitionId|job|position)[=\/](\d+)/i);
      const jobId = jobIdMatch?.[1] ?? href;

      jobs.push({
        jobId,
        title: text,
        jobUrl: href,
      });
    }
  }

  return jobs;
}

async function fetchHtmlWithRetry(
  pageUrl: string,
  logger: ScrapeContext['logger'],
): Promise<string> {
  return withRetry(
    async () => {
      return throttledFetch(pageUrl, async () => {
        const response = await request(pageUrl, {
          method: 'GET',
          headers: {
            'user-agent': scraperUserAgent(),
            accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9,zh-HK;q=0.8,zh;q=0.7',
          },
          bodyTimeout: 30_000,
          headersTimeout: 30_000,
        });
        if (response.statusCode >= 400) {
          const retryAfterMs = parseRetryAfterMs(response.headers['retry-after']?.toString());
          throw new HttpStatusError(pageUrl, response.statusCode, 'HTTP error', retryAfterMs);
        }
        return response.body.text();
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
        logger.warn(`HKJC retry ${attempt} in ${delayMs}ms`, {
          url: pageUrl,
          error: String(error),
        });
      },
    },
  );
}

function ensureLocationFilter(url: string, location: string): string {
  try {
    const parsed = new URL(url);

    // Check if location parameter already exists
    if (!parsed.searchParams.has('location')) {
      parsed.searchParams.set('location', location);
    }

    return parsed.toString();
  } catch {
    // If URL parsing fails, append location parameter manually
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}location=${location}`;
  }
}

export class HKJCAdapter implements ScraperAdapter {
  readonly name = 'hkjc';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const cfg = (ctx.config as HKJCConfig) ?? {};
    const rawStartUrl = cfg.startUrl ?? ctx.urlTemplate ?? DEFAULT_START_URL;
    const location = cfg.location ?? DEFAULT_LOCATION;

    // Ensure location filter is in the URL
    const startUrl = ensureLocationFilter(rawStartUrl, location);

    ctx.logger.info('HKJC adapter starting', { rawStartUrl, startUrl, location });

    const companyName = cfg.companyName ?? DEFAULT_COMPANY_NAME;
    const companyDomain = cfg.companyDomain ?? 'hkjc.com';
    const fullCrawl = cfg.fullCrawl === true;
    const maxPages = fullCrawl ? Number.POSITIVE_INFINITY : cfg.maxPages ?? DEFAULT_MAX_PAGES;

    const jobs: RawJob[] = [];
    const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const seenIds = new Set<string>();

    try {
      if (!(await isAllowedByRobots(startUrl))) {
        return { jobs: [], errors: [robotsDisallowedScrapeError(startUrl)] };
      }

      for (let page = 0; page < maxPages; page++) {
        // Build pagination URL properly
        const pageUrl = page === 0 ? startUrl : (() => {
          try {
            const url = new URL(startUrl);
            url.searchParams.set('page', String(page));
            return url.toString();
          } catch {
            const separator = startUrl.includes('?') ? '&' : '?';
            return `${startUrl}${separator}page=${page}`;
          }
        })();

        try {
          ctx.logger.info(`Fetching HKJC page ${page}`, { url: pageUrl });
          const html = await fetchHtmlWithRetry(pageUrl, ctx.logger);
          const extractedJobs = extractJobsFromHtml(html, pageUrl);

          if (extractedJobs.length === 0) {
            ctx.logger.info(`No jobs found on page ${page}, stopping pagination`);
            break;
          }

          for (const job of extractedJobs) {
            const jobId = job.jobId ?? job.requisitionId ?? job.jobUrl ?? '';
            if (!jobId || seenIds.has(jobId)) continue;
            seenIds.add(jobId);

            const title = normalizeText(job.jobTitle ?? job.title);
            if (!title) continue;

            const location = normalizeText(job.location ?? job.city) || 'Hong Kong';
            const description = stripHtmlToText(job.jobDescription ?? job.description ?? title);
            const jobUrl = toAbsoluteUrl(job.jobUrl ?? job.url ?? job.applyUrl ?? '', pageUrl);
            const applyUrl = toAbsoluteUrl(job.applyUrl ?? jobUrl, pageUrl);

            jobs.push({
              externalId: jobId,
              companyName,
              companyDomain,
              locale: 'en',
              title,
              location,
              description,
              url: jobUrl,
              applyUrl,
              source: 'COMPANY_WEBSITE',
              tags: [],
              publishedAt: parseDateOrNow(job.postingDate ?? job.postedDate),
              salaryCurrency: 'HKD',
              localizedContents: [
                {
                  locale: 'en',
                  title,
                  location,
                  description,
                  url: jobUrl,
                  applyUrl,
                },
              ],
            });
          }

          ctx.logger.info(`HKJC page ${page} produced ${extractedJobs.length} jobs`);
        } catch (pageErr) {
          errors.push({
            message: `Failed to fetch page ${page}: ${String(pageErr)}`,
            context: { page, url: pageUrl },
          });
          if (fullCrawl || (pageErr instanceof HttpStatusError && pageErr.statusCode === 404)) {
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
