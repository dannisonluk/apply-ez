import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium, type Browser, type BrowserContext, type Page, type Response as PlaywrightResponse } from 'playwright';
import { request } from 'undici';
import type { ScraperAdapter, ScrapeContext, ScrapeResult, RawJob } from './adapter.interface.js';
import type { CathayConfig, CathayTopMetadata } from './cathay/types.js';
import {
  decodeHtmlEntities,
  extractHtmlSection,
  extractTagText,
  normalizeText,
  parseCathayCard,
  stripHtmlToText,
  toAbsoluteUrl,
} from './cathay/text.js';
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

const DEFAULT_START_URL = 'https://careers.cathaypacific.com/en/careers/jobs?keyword=&sortby=date&page=1&locations=hong-kong';
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_SITEMAP_MAX_JOBS = 300;
/**
 * Ceiling on detail-page fetches per run. The Hong Kong slice is ~45 postings, so
 * this is headroom rather than a real limit — it exists so an unexpectedly large
 * board cannot turn one run into thousands of requests.
 */
const DEFAULT_DETAIL_MAX_JOBS = 60;
const require = createRequire(import.meta.url);

let playwrightInstallPromise: Promise<boolean> | null = null;
let playwrightBrowserReady = false;

function localeFromUrl(url: string): 'en' | 'zh-HK' {
  // Always return 'en' for Cathay Pacific to ensure English content
  // The URL filter &locations=hong-kong ensures HK jobs, but we need English language
  const normalized = url.toLowerCase();

  // Check if URL explicitly has English path
  if (normalized.includes('/en/') || normalized.includes('/en_')) return 'en';

  // Check for Chinese indicators
  if (normalized.includes('locale=zh_cn')) return 'zh-HK';
  if (normalized.includes('locale=zh_tw')) return 'zh-HK';
  if (normalized.includes('-zh_cn')) return 'zh-HK';
  if (normalized.includes('-zh_tw')) return 'zh-HK';
  if (normalized.includes('/zh_hk/')) return 'zh-HK';
  if (normalized.includes('/zh-hk/')) return 'zh-HK';
  if (normalized.includes('/zh/')) return 'zh-HK';

  // Default to English for Cathay Pacific
  return 'en';
}

function isTruthy(value: unknown): boolean {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim());
}

function inferCompanyDomain(startUrl: string): string | undefined {
  try {
    const host = new URL(startUrl).hostname.toLowerCase();
    return host.replace(/^careers\./, '').replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}

function extractTitleFromUrl(absoluteUrl: string): string {
  try {
    const slug = new URL(absoluteUrl).pathname.split('/').filter(Boolean).at(-1) ?? '';
    const withoutId = slug.replace(/-\d+(?:-[a-z]{2}_[a-z]{2})?$/i, '');
    const decoded = decodeURIComponent(withoutId).replace(/[-_]+/g, ' ').trim();
    return decoded || slug || absoluteUrl;
  } catch {
    return absoluteUrl;
  }
}

function extractDetailUrlsFromHtml(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();

  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(hrefRegex)) {
    const raw = decodeHtmlEntities(match[1] ?? '').replace(/\\\//g, '/').trim();
    if (!raw) continue;
    const absolute = toAbsoluteUrl(raw, pageUrl);
    if (isCathayJobDetailUrl(absolute)) urls.add(absolute);
  }

  const inlineUrlRegex =
    /(https?:\\\/\\\/[^"'\\s<>]+|https?:\/\/[^"'\\s<>]+|\/(?:en|zh(?:[_-]hk)?|cn)\/careers\/jobs(?:\/[^"'\\s<>]+)?|\/[A-Za-z0-9_-]+\/job\/[^"'\\s<>]+)/gi;
  for (const match of html.matchAll(inlineUrlRegex)) {
    const raw = (match[1] ?? '').replace(/\\\//g, '/').trim();
    if (!raw) continue;
    const absolute = toAbsoluteUrl(raw, pageUrl);
    if (isCathayJobDetailUrl(absolute)) urls.add(absolute);
  }

  return Array.from(urls);
}

function buildPlaceholderJobFromDetailUrl(
  absoluteUrl: string,
  companyName: string,
  sourceDomain: string | undefined,
): RawJob {
  const locale = localeFromUrl(absoluteUrl);
  const title = extractTitleFromUrl(absoluteUrl);

  return {
    externalId: normalizeExternalId(absoluteUrl, absoluteUrl),
    companyName,
    companyDomain: sourceDomain,
    locale,
    title,
    location: undefined,
    description: title,
    url: absoluteUrl,
    applyUrl: absoluteUrl,
    source: 'COMPANY_WEBSITE',
    tags: [],
    publishedAt: new Date().toISOString(),
    salaryCurrency: 'HKD',
    localizedContents: [
      {
        locale,
        title,
        location: undefined,
        description: title,
        url: absoluteUrl,
        applyUrl: absoluteUrl,
      },
    ],
  };
}

function isPlaywrightLaunchFailure(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes('error while loading shared libraries') ||
    message.includes('browsertype.launch') ||
    message.includes('executable doesn\'t exist') ||
    message.includes('target page, context or browser has been closed')
  );
}

function isMissingPlaywrightExecutable(error: unknown): boolean {
  return String(error).toLowerCase().includes('executable doesn\'t exist');
}

async function installPlaywrightChromium(logger: ScrapeContext['logger']): Promise<boolean> {
  if (playwrightBrowserReady) return true;
  if (playwrightInstallPromise) return playwrightInstallPromise;

  playwrightInstallPromise = new Promise<boolean>((resolve) => {
    let cliPath: string;
    try {
      cliPath = require.resolve('playwright/cli');
    } catch (error) {
      logger.warn('Unable to resolve Playwright CLI for runtime browser install', {
        error: String(error),
      });
      resolve(false);
      return;
    }

    const child = spawn(process.execPath, [cliPath, 'install', '--with-deps', 'chromium'], {
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      logger.warn('Playwright runtime install process failed to start', {
        error: String(error),
      });
      resolve(false);
    });
    child.on('close', (code) => {
      if (code === 0) {
        playwrightBrowserReady = true;
        logger.info('Playwright Chromium installed successfully at runtime');
        resolve(true);
        return;
      }

      logger.warn('Playwright runtime browser install failed', {
        exitCode: code,
        output: output.trim().slice(-4000),
      });
      resolve(false);
    });
  }).finally(() => {
    playwrightInstallPromise = null;
  });

  return playwrightInstallPromise;
}

async function launchCathayBrowser(logger: ScrapeContext['logger']): Promise<{
  browser: Browser;
  context: BrowserContext;
}> {
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: scraperUserAgent(),
      viewport: { width: 1440, height: 1200 },
    });
    playwrightBrowserReady = true;
    return { browser, context };
  } catch (error) {
    if (!isPlaywrightLaunchFailure(error)) throw error;
    if (!isMissingPlaywrightExecutable(error)) throw error;

    logger.warn('Playwright browser executable missing, attempting runtime Chromium install', {
      error: String(error),
    });

    const installed = await installPlaywrightChromium(logger);
    if (!installed) throw error;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: scraperUserAgent(),
      viewport: { width: 1440, height: 1200 },
    });
    playwrightBrowserReady = true;
    return { browser, context };
  }
}

async function fetchHtmlWithRetry(
  pageUrl: string,
  logger: ScrapeContext['logger'],
  stage: 'listing' | 'detail' | 'sitemap',
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
      retries: Math.max(1, Number.parseInt(process.env.CATHAY_REQUEST_MAX_RETRIES ?? '4', 10)),
      shouldRetry: (error) => {
        if (error instanceof RobotsDisallowedError) return false;
        if (error instanceof HttpStatusError) return isRetriableStatus(error.statusCode);
        return String(error).toLowerCase().includes('timeout') || String(error).includes('429');
      },
      onRetry: (error, attempt, delayMs) => {
        logger.warn(`Cathay ${stage} retry ${attempt} in ${delayMs}ms`, {
          url: pageUrl,
          error: String(error),
        });
      },
    },
  );
}

/**
 * Section headings that mark the start of the real job description. Used only as a
 * fallback when the dedicated container selector misses.
 */
const JD_START_MARKER =
  /(?:Role\s+Introduction|Job\s+Description|About\s+the\s+Role|The\s+Role|Key\s+Responsibilities|Responsibilities|Job\s+Purpose|Position\s+Overview)/i;

/**
 * Where the job description stops.
 *
 * Cathay appends ~750 characters of equal-opportunities boilerplate to every
 * posting. Left in, it occupies the entire tail of the enrichment prompt's
 * head+tail truncation window — which is precisely where the Requirements section
 * lives — so the model would be handed a privacy notice instead of the
 * qualifications. Cutting here is what keeps "Requirements" in the prompt.
 */
const JD_END_MARKER = /Personal\s+&\s+Application\s+Information|Equal\s+Opportunities\s+Employer/i;

/**
 * The deadline is published in the page's meta header
 * ("Application deadline: 29 Sep 2026"), not in the description body, so it is
 * lifted separately and prepended. The text is passed through verbatim and parsed
 * later by `inferApplicationDeadline` — date parsing stays in one place.
 */
const DEADLINE_SNIPPET = /Application\s+deadline\s*[:：]\s*[^<]{1,60}/i;

/**
 * Fetch and parse one job detail page.
 *
 * The detail page is server-rendered, so a plain HTTP fetch returns the full
 * description and the deadline — no browser needed, which keeps the detail stage
 * cheap enough to run on every job.
 */
async function fetchCathayJobDetail(
  absoluteUrl: string,
  logger: ScrapeContext['logger'],
): Promise<{ title: string | undefined; description: string | undefined } | null> {
  try {
    const html = await fetchHtmlWithRetry(absoluteUrl, logger, 'detail');

    const title = extractTagText(html, 'h1');

    // Preferred: the dedicated description container. Ending at `button-bar`, the
    // sibling immediately after the grid, keeps the share/apply controls out.
    let section =
      extractHtmlSection(
        html,
        /<div[^>]*class="[^"]*job-detail__grid[^"]*"[^>]*>/i,
        /<div[^>]*class="[^"]*button-bar[^"]*"/i,
      ) ??
      extractHtmlSection(
        html,
        /<div[^>]*class="[^"]*job-detail__grid[^"]*"[^>]*>/i,
        /<\/main>/i,
      );

    // Fallback: slice from the first description heading to the end of <main>.
    if (!section) {
      const start = html.search(JD_START_MARKER);
      if (start >= 0) {
        const mainEnd = html.indexOf('</main>', start);
        section = html.slice(start, mainEnd > start ? mainEnd : undefined);
      }
    }

    let description = section ? stripHtmlToText(section) : '';

    // Trim the equal-opportunities boilerplate off the end.
    const endIndex = description.search(JD_END_MARKER);
    if (endIndex > 0) description = description.slice(0, endIndex).trim();

    const deadlineSnippet = html.match(DEADLINE_SNIPPET)?.[0];
    const withDeadline = [deadlineSnippet, description].filter((part) => part && part.length > 0);

    return {
      title: title && title.length >= 3 ? title : undefined,
      description: withDeadline.length > 0 ? withDeadline.join('\n\n') : undefined,
    };
  } catch (error) {
    logger.warn('Cathay detail fetch failed', { url: absoluteUrl, error: String(error) });
    return null;
  }
}

/**
 * Fill description (and, through it, deadline and years-of-experience) from detail
 * pages.
 *
 * Why this stage exists: the listing cards carry no description and no deadline, so
 * without it every Cathay job reaches the LLM enrichment layer with nothing to
 * summarise, every deadline is null, and the deterministic backfill has no text to
 * read a closing date out of. The deadline in particular is only ever published on
 * the detail page ("Application deadline: 29 Sep 2026").
 *
 * Fail-soft by design: a job whose detail page cannot be fetched keeps its listing
 * fields and is still ingested, so a partial outage degrades quality rather than
 * dropping postings.
 */
async function enrichCathayJobsFromDetailPages(
  jobs: RawJob[],
  logger: ScrapeContext['logger'],
  options: { concurrency: number; maxJobs: number },
): Promise<{ enriched: number; failed: number; skipped: number }> {
  const limit = Math.max(0, options.maxJobs);
  const targets = jobs.slice(0, limit === 0 ? jobs.length : limit);
  const skipped = jobs.length - targets.length;

  let enriched = 0;
  let failed = 0;
  const queue = [...targets];

  // The shared throttle still paces requests globally; this only stops the workers
  // from serialising on each other's latency.
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const url = typeof job.url === 'string' ? job.url : '';
      if (!url) continue;

      const detail = await fetchCathayJobDetail(url, logger);
      if (!detail) {
        failed += 1;
        continue;
      }

      // The detail page's h1 is authoritative; the card text is a fallback that can
      // still carry the department and employment type.
      if (detail.title) job.title = detail.title;
      if (detail.description) job.description = detail.description;
      enriched += 1;
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency) }, () => worker()),
  );

  return { enriched, failed, skipped };
}

/**
 * Derive the job location from a Cathay detail URL slug.
 * Detail URLs embed the region: /en/careers/jobs/hong-kong/<slug>-<id>.
 * Returns "Hong Kong" for HK jobs, undefined when the region is unknown.
 */
function locationFromCathayDetailUrl(absoluteUrl: string): string | undefined {  try {
    const u = new URL(absoluteUrl);
    const segments = u.pathname.toLowerCase().split('/').filter(Boolean);
    const jobsIndex = segments.indexOf('jobs');
    const region = jobsIndex >= 0 ? (segments[jobsIndex + 1] ?? '') : '';
    if (/^(hong-?kong|hk)$/.test(region)) return 'Hong Kong';
    if (region) {
      return region
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isCathayJobDetailUrl(absoluteUrl: string): boolean {
  try {
    const u = new URL(absoluteUrl);
    const path = u.pathname.toLowerCase().replace(/\/+$/, '');
    if (/^\/(en|zh|zh_hk|zh-hk|cn)\/careers\/jobs\/[^/]+\/[^/]+-\d+$/.test(path)) return true;
    // SuccessFactors branded pages can be /CSS/job/... or /HAS/job/... etc.
    if (/^\/[a-z0-9_-]+\/job\/(?:[^/]+\/)?[^/]+\/\d{2,}(?:-[a-z]{2}_[a-z]{2})?$/.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

function isLikelyListingPageUrl(absoluteUrl: string): boolean {
  try {
    const u = new URL(absoluteUrl);
    const path = u.pathname.toLowerCase().replace(/\/+$/, '');
    if (/^\/(en|zh|zh_hk|zh-hk|cn)\/careers\/jobs$/.test(path)) return true;
    if (path === '/css/search') return true;
    return false;
  } catch {
    return false;
  }
}

function normalizeExternalId(absoluteUrl: string, fallbackTitle: string): string {
  try {
    const u = new URL(absoluteUrl);
    const slug = u.pathname.split('/').filter(Boolean).at(-1) ?? '';
    const numericIdMatch = slug.match(/(\d{2,})(?:-[a-z]{2}_[a-z]{2})?\/?$/i);
    if (numericIdMatch?.[1]) return numericIdMatch[1];

    if (isLikelyListingPageUrl(absoluteUrl)) {
      return `listing:${u.pathname.toLowerCase()}`;
    }

    const explicitId = u.searchParams.get('jobId') ?? u.searchParams.get('id');
    if (explicitId && /^\d{3,}$/.test(explicitId)) return explicitId;

    u.pathname = u.pathname.replace(/^\/(en|zh|zh_hk|zh-hk)\//i, '/');
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return fallbackTitle;
  }
}

function isHongKongLocation(location: string | undefined | null): boolean {
  if (!location) return false;
  const normalized = location.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  // Hong Kong indicators — "Hong Kong SAR (China)" is the official Cathay listing form.
  if (normalized.includes('hong kong')) return true;
  if (normalized.includes('hongkong')) return true;
  if (normalized.includes('香港')) return true;
  if (/\bsar\b/.test(normalized) && !normalized.includes('mainland')) return true;
  if (normalized === 'hk' || normalized === 'hkg') return true;

  // Non-Hong Kong locations - explicitly reject (checked AFTER HK indicators so
  // "Hong Kong SAR (China)" is not rejected by the "china" rule below).
  if (normalized.includes('singapore') || normalized.includes('新加坡')) return false;
  if (/china/.test(normalized) && !/hong kong|hongkong|香港|\bsar\b/.test(normalized)) return false;
  if (normalized.includes('中国') || normalized.includes('中國')) return false;
  if (normalized.includes('mainland') || normalized.includes('内地') || normalized.includes('內地')) return false;
  if (normalized.includes('shenzhen') || normalized.includes('深圳')) return false;
  if (normalized.includes('beijing') || normalized.includes('北京')) return false;
  if (normalized.includes('shanghai') || normalized.includes('上海')) return false;
  if (normalized.includes('taiwan') || normalized.includes('台湾') || normalized.includes('台灣')) return false;
  if (normalized.includes('japan') || normalized.includes('日本')) return false;
  if (normalized.includes('korea') || normalized.includes('韩国') || normalized.includes('韓國')) return false;
  if (normalized.includes('thailand') || normalized.includes('泰国') || normalized.includes('泰國')) return false;
  if (normalized.includes('vietnam') || normalized.includes('越南')) return false;
  if (normalized.includes('philippines') || normalized.includes('菲律宾') || normalized.includes('菲律賓')) return false;
  if (normalized.includes('india') || normalized.includes('印度')) return false;
  if (normalized.includes('australia') || normalized.includes('澳大利亚') || normalized.includes('澳大利亞')) return false;

  // Unknown location should not pass HK-only filter.
  return false;
}

function isCssHost(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().includes('cathaysubsidiaryservices.com');
  } catch {
    return false;
  }
}

function isCssSearchPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isCssHost(url) && parsed.pathname.toLowerCase().replace(/\/+$/, '') === '/css/search';
  } catch {
    return false;
  }
}

interface CssSearchApiResponseItem {
  response?: Record<string, unknown>;
}

interface CssSearchApiResponse {
  jobSearchResult?: CssSearchApiResponseItem[];
}

interface CathaySearchApiItem {
  featured?: boolean;
  url?: string;
  title?: string;
  jobFunction?: string;
  location?: string;
  contractType?: string;
  localId?: string;
  localeCode_s?: string;
  applicationStartDate_s?: string;
  applicationDeadline_s?: string;
}

interface CathaySearchApiMeta {
  currentPage?: number;
  totalPages?: number;
  itemPerPage?: number;
  totalItems?: number;
}

interface CathaySearchApiResponse {
  items?: CathaySearchApiItem[];
  suggestions?: CathaySearchApiItem[];
  meta?: CathaySearchApiMeta;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function parseCssLocaleTokenFromUrl(url: string): string {
  try {
    const locale = new URL(url).searchParams.get('locale')?.trim();
    if (!locale) return 'en_GB';
    // Keep SuccessFactors locale token style used by detail URL suffix.
    return locale.replace('-', '_');
  } catch {
    return 'en_GB';
  }
}

function parseCssPageNumberFromUrl(url: string): number {
  try {
    const raw = Number.parseInt(new URL(url).searchParams.get('pageNumber') ?? '0', 10);
    if (!Number.isFinite(raw) || raw < 0) return 0;
    return raw;
  } catch {
    return 0;
  }
}

function slugifyCssTitle(rawSlug: string, fallbackTitle: string): string {
  const decoded = decodeHtmlEntities(rawSlug || fallbackTitle)
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return encodeURIComponent(decoded || fallbackTitle || 'job').replace(/%2D/gi, '-');
}

function parseCssDate(raw: string | undefined): string {
  if (!raw) return new Date().toISOString();

  // SuccessFactors listing API commonly returns dd/MM/yyyy.
  // Parse this format first to avoid locale-dependent Date() ambiguity.
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const dayText = match[1];
    const monthText = match[2];
    const yearText = match[3];
    if (!dayText || !monthText || !yearText) return new Date().toISOString();
    const day = Number.parseInt(dayText, 10);
    const month = Number.parseInt(monthText, 10);
    const year = Number.parseInt(yearText, 10);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  return new Date().toISOString();
}

function pickStringFromArray(value: unknown): string | undefined {
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string' && value[0].trim()) {
    return value[0].trim();
  }
  return undefined;
}

function buildCssDetailUrl(pageUrl: string, rawSlug: string, id: string, localeToken: string): string {
  const origin = new URL(pageUrl).origin;
  const encodedSlug = slugifyCssTitle(rawSlug, `job-${id}`);
  return `${origin}/CSS/job/${encodedSlug}/${id}-${localeToken}`;
}

async function fetchCathayListingApiJobs(
  pageUrl: string,
  companyName: string,
  sourceDomain: string | undefined,
  logger: ScrapeContext['logger'],
): Promise<RawJob[]> {
  if (isCssSearchPageUrl(pageUrl)) return [];

  const html = await fetchHtmlWithRetry(pageUrl, logger, 'listing');
  const jobListingMatch = html.match(/<div class="job-listing"[\s\S]*?>/i);
  if (!jobListingMatch?.[0]) return [];
  const node = jobListingMatch[0];

  const dataApi = node.match(/data-api="([^"]+)"/i)?.[1];
  if (!dataApi) return [];
  const dataItemPerPage = parsePositiveInt(node.match(/data-item-per-page="([^"]+)"/i)?.[1], 20);

  let listingUrl: URL;
  try {
    listingUrl = new URL(pageUrl);
  } catch {
    return [];
  }
  const pageNumber = parsePositiveInt(listingUrl.searchParams.get('page') ?? node.match(/data-page="([^"]+)"/i)?.[1], 1);
  const keyword = listingUrl.searchParams.get('keyword') ?? '';
  const sortBy = listingUrl.searchParams.get('sortby') ?? '';
  const locations = listingUrl.searchParams.get('locations') ?? '';

  const apiUrl = new URL(dataApi, pageUrl);
  const params = new URLSearchParams(apiUrl.search);
  params.set('keyword', keyword);
  params.set('page', String(pageNumber));
  params.set('itemperpage', String(dataItemPerPage));
  if (sortBy) params.set('sortby', sortBy);
  params.set('functions', '');
  params.set('jobtype', '');
  if (locations) params.set('locations', locations);
  apiUrl.search = params.toString();

  const body = await withRetry(
    async () => {
      const response = await request(apiUrl.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, */*',
          'user-agent': scraperUserAgent(),
          referer: pageUrl,
          origin: listingUrl.origin,
          'x-requested-with': 'XMLHttpRequest',
        },
        bodyTimeout: 30_000,
        headersTimeout: 30_000,
      });
      if (response.statusCode >= 400) {
        const retryAfterMs = parseRetryAfterMs(response.headers['retry-after']?.toString());
        const text = await response.body.text();
        throw new HttpStatusError(apiUrl.toString(), response.statusCode, text.slice(0, 120) || 'API error', retryAfterMs);
      }
      return response.body.json() as Promise<CathaySearchApiResponse>;
    },
    {
      retries: Math.max(1, Number.parseInt(process.env.CATHAY_REQUEST_MAX_RETRIES ?? '4', 10)),
      shouldRetry: (error) => {
        if (error instanceof HttpStatusError) return isRetriableStatus(error.statusCode);
        return String(error).toLowerCase().includes('timeout') || String(error).includes('429');
      },
      onRetry: (error, attempt, delayMs) => {
        logger.warn(`Cathay listing API retry ${attempt} in ${delayMs}ms`, {
          endpoint: apiUrl.toString(),
          error: String(error),
        });
      },
    },
  );

  const items = Array.isArray(body.items) ? body.items : [];
  const jobs: RawJob[] = [];
  const seen = new Set<string>();
  const locale = 'en';
  const totalItems = body.meta?.totalItems;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const title = normalizeText(item.title);
    const rawUrl = normalizeText(item.url);
    if (!title || !rawUrl) continue;
    const absoluteUrl = toAbsoluteUrl(rawUrl, pageUrl);
    if (!isCathayJobDetailUrl(absoluteUrl)) continue;

    const externalId = normalizeExternalId(absoluteUrl, title);
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const jobFunction = normalizeText(item.jobFunction);
    const location = normalizeText(item.location) || undefined;
    const contractType = normalizeText(item.contractType);
    const publishedAt = parseCssDate(item.applicationStartDate_s);
    const deadline = normalizeText(item.applicationDeadline_s);
    const description = [title, jobFunction].filter((part) => part.length > 0).join(' - ') || title;

    const topMetadata: CathayTopMetadata = {};
    if (jobFunction) topMetadata.jobFunction = jobFunction;
    if (location) topMetadata.country = location;
    if (contractType) topMetadata.employmentType = contractType;
    if (deadline) topMetadata.deadline = deadline;

    jobs.push({
      externalId,
      companyName,
      companyDomain: sourceDomain,
      locale,
      title,
      location,
      description,
      requirements: undefined,
      url: absoluteUrl,
      applyUrl: absoluteUrl,
      source: 'COMPANY_WEBSITE',
      tags: [contractType, jobFunction].filter((value): value is string => Boolean(value)),
      employmentType: contractType || undefined,
      publishedAt,
      salaryCurrency: 'HKD',
      ...(Object.keys(topMetadata).length > 0 ? { topMetadata } : {}),
      localizedContents: [
        {
          locale,
          title,
          location,
          description,
          url: absoluteUrl,
          applyUrl: absoluteUrl,
          ...(Object.keys(topMetadata).length > 0 ? { topMetadata } : {}),
        },
      ],
    });
  }

  logger.info('Cathay listing API returned candidates', {
    entryUrl: pageUrl,
    apiUrl: apiUrl.toString(),
    itemCount: items.length,
    totalItems: typeof totalItems === 'number' ? totalItems : undefined,
  });
  return jobs;
}

async function fetchCathayListingApiJobsWithPage(
  page: Page,
  pageUrl: string,
  companyName: string,
  sourceDomain: string | undefined,
  logger: ScrapeContext['logger'],
): Promise<RawJob[]> {
  if (isCssSearchPageUrl(pageUrl)) return [];

  const jobListing = page.locator('.job-listing').first();
  const exists = (await jobListing.count().catch(() => 0)) > 0;
  if (!exists) return [];

  const dataApi = (await jobListing.getAttribute('data-api').catch(() => null)) ?? '';
  if (!dataApi) return [];

  const dataItemPerPage = parsePositiveInt(
    (await jobListing.getAttribute('data-item-per-page').catch(() => null)) ?? undefined,
    20,
  );
  const dataPage = parsePositiveInt((await jobListing.getAttribute('data-page').catch(() => null)) ?? undefined, 1);

  let listingUrl: URL;
  try {
    listingUrl = new URL(pageUrl);
  } catch {
    return [];
  }

  const keyword = listingUrl.searchParams.get('keyword') ?? '';
  const sortBy = listingUrl.searchParams.get('sortby') ?? '';
  const locations = listingUrl.searchParams.get('locations') ?? '';
  const pageNumber = parsePositiveInt(listingUrl.searchParams.get('page') ?? undefined, dataPage);

  const apiUrl = new URL(dataApi, pageUrl);
  const params = new URLSearchParams(apiUrl.search);
  params.set('keyword', keyword);
  params.set('page', String(pageNumber));
  params.set('itemperpage', String(dataItemPerPage));
  if (sortBy) params.set('sortby', sortBy);
  params.set('functions', '');
  params.set('jobtype', '');
  if (locations) params.set('locations', locations);
  apiUrl.search = params.toString();

  const response = await page.request.get(apiUrl.toString(), {
    headers: {
      accept: 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
      referer: pageUrl,
      origin: listingUrl.origin,
    },
  });
  if (!response.ok()) {
    const text = (await response.text().catch(() => '')).slice(0, 120);
    throw new HttpStatusError(apiUrl.toString(), response.status(), text || response.statusText());
  }

  const body = (await response.json()) as CathaySearchApiResponse;
  const items = Array.isArray(body.items) ? body.items : [];
  const jobs: RawJob[] = [];
  const seen = new Set<string>();
  const locale = 'en';

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const title = normalizeText(item.title);
    const rawUrl = normalizeText(item.url);
    if (!title || !rawUrl) continue;

    const absoluteUrl = toAbsoluteUrl(rawUrl, pageUrl);
    if (!isCathayJobDetailUrl(absoluteUrl)) continue;

    const externalId = normalizeExternalId(absoluteUrl, title);
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const jobFunction = normalizeText(item.jobFunction);
    const location = normalizeText(item.location) || undefined;
    const contractType = normalizeText(item.contractType);
    const publishedAt = parseCssDate(item.applicationStartDate_s);
    const deadline = normalizeText(item.applicationDeadline_s);
    const description = [title, jobFunction].filter((part) => part.length > 0).join(' - ') || title;

    const topMetadata: CathayTopMetadata = {};
    if (jobFunction) topMetadata.jobFunction = jobFunction;
    if (location) topMetadata.country = location;
    if (contractType) topMetadata.employmentType = contractType;
    if (deadline) topMetadata.deadline = deadline;

    jobs.push({
      externalId,
      companyName,
      companyDomain: sourceDomain,
      locale,
      title,
      location,
      description,
      requirements: undefined,
      url: absoluteUrl,
      applyUrl: absoluteUrl,
      source: 'COMPANY_WEBSITE',
      tags: [contractType, jobFunction].filter((value): value is string => Boolean(value)),
      employmentType: contractType || undefined,
      publishedAt,
      salaryCurrency: 'HKD',
      ...(Object.keys(topMetadata).length > 0 ? { topMetadata } : {}),
      localizedContents: [
        {
          locale,
          title,
          location,
          description,
          url: absoluteUrl,
          applyUrl: absoluteUrl,
          ...(Object.keys(topMetadata).length > 0 ? { topMetadata } : {}),
        },
      ],
    });
  }

  logger.info('Cathay listing API (browser context) returned candidates', {
    entryUrl: pageUrl,
    apiUrl: apiUrl.toString(),
    itemCount: items.length,
    totalItems: typeof body.meta?.totalItems === 'number' ? body.meta.totalItems : undefined,
  });
  return jobs;
}

async function fetchCssSearchApiJobs(
  pageUrl: string,
  companyName: string,
  sourceDomain: string | undefined,
  logger: ScrapeContext['logger'],
): Promise<RawJob[]> {
  if (!isCssSearchPageUrl(pageUrl)) return [];

  const localeToken = parseCssLocaleTokenFromUrl(pageUrl);
  const pageNumber = parseCssPageNumberFromUrl(pageUrl);
  const endpoint = `${new URL(pageUrl).origin}/services/recruiting/v1/jobs`;

  const payload = {
    keywords: '',
    locale: localeToken,
    location: '',
    pageNumber,
    sortBy: 'recent',
  };

  const body = await withRetry(
    async () => {
      const response = await request(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/plain, */*',
          'user-agent': scraperUserAgent(),
          // Some SuccessFactors deployments are strict on same-origin hints.
          origin: new URL(pageUrl).origin,
          referer: pageUrl,
        },
        body: JSON.stringify(payload),
      });
      if (response.statusCode >= 400) {
        const retryAfterMs = parseRetryAfterMs(response.headers['retry-after']?.toString());
        const text = await response.body.text();
        throw new HttpStatusError(endpoint, response.statusCode, text.slice(0, 120) || 'API error', retryAfterMs);
      }
      return response.body.json() as Promise<CssSearchApiResponse>;
    },
    {
      retries: Math.max(1, Number.parseInt(process.env.CATHAY_REQUEST_MAX_RETRIES ?? '4', 10)),
      shouldRetry: (error) => {
        if (error instanceof HttpStatusError) return isRetriableStatus(error.statusCode);
        return String(error).toLowerCase().includes('timeout') || String(error).includes('429');
      },
      onRetry: (error, attempt, delayMs) => {
        logger.warn(`Cathay CSS search API retry ${attempt} in ${delayMs}ms`, {
          endpoint,
          error: String(error),
        });
      },
    },
  );

  const jobs: RawJob[] = [];
  const seen = new Set<string>();
  for (const item of body.jobSearchResult ?? []) {
    const record = isRecord(item.response) ? item.response : undefined;
    if (!record) continue;
    const id = pickString(record, ['id', 'jobReqId']);
    const title = pickString(record, ['unifiedStandardTitle', 'title', 'jobTitle']);
    const rawSlug = pickString(record, ['unifiedUrlTitle', 'urlTitle']) ?? title;
    if (!id || !title || !rawSlug) continue;

    const detailUrl = buildCssDetailUrl(pageUrl, rawSlug, id, localeToken);
    const externalId = normalizeExternalId(detailUrl, id);
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const locale = localeFromUrl(pageUrl);
    const location =
      pickStringFromArray(record.sfstd_jobLocation_obj) ??
      pickStringFromArray(record.jobLocationShort);
    const employmentType = pickStringFromArray(record.cust_JobReqFTPT);
    const department = pickStringFromArray(record.department_obj);
    const description = [title, department].filter(Boolean).join(' - ') || title;
    const publishedAt = parseCssDate(pickString(record, ['unifiedStandardStart', 'postingDate', 'datePosted']));

    jobs.push({
      externalId,
      companyName,
      companyDomain: sourceDomain,
      locale,
      title,
      location,
      description,
      url: detailUrl,
      applyUrl: detailUrl,
      source: 'COMPANY_WEBSITE',
      tags: [employmentType, department].filter((value): value is string => Boolean(value)),
      employmentType,
      publishedAt,
      salaryCurrency: 'HKD',
      localizedContents: [
        {
          locale,
          title,
          location,
          description,
          url: detailUrl,
          applyUrl: detailUrl,
        },
      ],
    });
  }

  return jobs;
}

function isRateLimitedError(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.statusCode === 429;
  const message = String(error).toLowerCase();
  return message.includes('429') || message.includes('too many requests') || message.includes('retry limit');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function pickNestedString(obj: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = obj;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current.trim() ? current.trim() : undefined;
}

function pickPublishedAt(obj: Record<string, unknown>): string {
  const raw = pickString(obj, ['publishedAt', 'postedAt', 'datePosted', 'createdAt', 'updatedAt', 'postingDate']);
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function pickEmploymentType(obj: Record<string, unknown>): string | undefined {
  return pickString(obj, ['employmentType', 'jobType', 'commitment', 'contractType', 'type']);
}

function buildIngestFromObject(
  obj: Record<string, unknown>,
  pageUrl: string,
  companyName: string,
  sourceDomain?: string,
): RawJob | null {
  const locale = localeFromUrl(pageUrl);
  const title = pickString(obj, ['title', 'jobTitle', 'positionTitle', 'name']) ?? pickNestedString(obj, ['job', 'title']);
  const rawUrl =
    pickString(obj, ['absolute_url', 'url', 'link', 'href', 'jobUrl', 'applyUrl']) ?? pickNestedString(obj, ['job', 'url']);
  if (!title || !rawUrl) return null;

  const absoluteUrl = toAbsoluteUrl(rawUrl, pageUrl);
  if (!isCathayJobDetailUrl(absoluteUrl)) return null;
  const location = pickString(obj, ['location', 'city', 'region']) ?? pickNestedString(obj, ['location', 'name']);
  const description =
    pickString(obj, ['description', 'content', 'summary', 'jobDescription', 'responsibilities']) ??
    pickNestedString(obj, ['job', 'description']) ??
    title;
  const externalId = pickString(obj, ['id', 'jobId', 'uuid', 'ref', 'slug']) ?? normalizeExternalId(absoluteUrl, title);

  return {
    externalId,
    companyName,
    companyDomain: sourceDomain,
    locale,
    title,
    location,
    description,
    url: absoluteUrl,
    applyUrl: absoluteUrl,
    source: 'COMPANY_WEBSITE',
    tags: [pickEmploymentType(obj)].filter((t): t is string => Boolean(t)),
    employmentType: pickEmploymentType(obj),
    publishedAt: pickPublishedAt(obj),
    salaryCurrency: 'HKD',
    localizedContents: [
      {
        locale,
        title,
        location,
        description,
        requirements: undefined,
        url: absoluteUrl,
        applyUrl: absoluteUrl,
      },
    ],
  };
}

function collectCandidates(
  value: unknown,
  pageUrl: string,
  companyName: string,
  sourceDomain: string | undefined,
  out: RawJob[],
  seen: Set<string>,
  depth = 0,
): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, pageUrl, companyName, sourceDomain, out, seen, depth + 1);
    return;
  }
  if (!isRecord(value)) return;

  const candidate = buildIngestFromObject(value, pageUrl, companyName, sourceDomain);
  if (candidate && !seen.has(candidate.externalId)) {
    seen.add(candidate.externalId);
    out.push(candidate);
  }

  for (const child of Object.values(value)) {
    collectCandidates(child, pageUrl, companyName, sourceDomain, out, seen, depth + 1);
  }
}

async function extractFromPage(
  page: Page,
  pageUrl: string,
  companyName: string,
  sourceDomain: string | undefined,
  logger: ScrapeContext['logger'],
): Promise<RawJob[]> {
  if (!isCssSearchPageUrl(pageUrl)) {
    try {
      const apiJobsFromPage = await fetchCathayListingApiJobsWithPage(page, pageUrl, companyName, sourceDomain, logger);
      if (apiJobsFromPage.length > 0) return apiJobsFromPage;
    } catch (error) {
      logger.warn('Cathay listing API (browser request) failed, trying server HTTP fallback', {
        url: pageUrl,
        error: String(error),
      });
    }

    try {
      const apiJobs = await fetchCathayListingApiJobs(pageUrl, companyName, sourceDomain, logger);
      if (apiJobs.length > 0) return apiJobs;
    } catch (error) {
      logger.warn('Cathay listing API fallback failed inside browser mode, continuing with DOM extraction', {
        url: pageUrl,
        error: String(error),
      });
    }
  }

  if (isCssSearchPageUrl(pageUrl)) {
    try {
      const apiJobs = await fetchCssSearchApiJobs(pageUrl, companyName, sourceDomain, logger);
      if (apiJobs.length > 0) return apiJobs;
    } catch (error) {
      logger.warn('CSS search API fallback failed inside browser mode, continuing with DOM extraction', {
        url: pageUrl,
        error: String(error),
      });
    }
  }

  const locale = localeFromUrl(pageUrl);
  const jobs: RawJob[] = [];
  const seen = new Set<string>();

  await page
    .waitForSelector('a[href*="/careers/jobs/"], a[href*="/CSS/job/"]', { timeout: 12_000 })
    .catch(() => {});
  await page.waitForTimeout(1500).catch(() => {});

  const scripts = await page
    .$$eval('script', (nodes) => nodes.map((n) => n.textContent ?? '').filter(Boolean))
    .catch(() => [] as string[]);

  for (const script of scripts) {
    const trimmed = script.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      collectCandidates(parsed, pageUrl, companyName, sourceDomain, jobs, seen);
    } catch {
      continue;
    }
  }

  const links = await page
    .$$eval('a[href]', (nodes) =>
      nodes.map((node) => ({
        href: node.getAttribute('href') ?? '',
        // Read the card's own title node. The anchor wraps the ENTIRE card, so
        // `node.textContent` is "TITLE DEPARTMENT LOCATION EMPLOYMENT TYPE" — using
        // it as the title is what produced 87-to-157-character "titles" and threw
        // away every prop. Props are read as a list rather than by index so a card
        // without a department does not shift location into the department slot.
        titleNode: node.querySelector('.search-listing__item__title')?.textContent ?? '',
        anchorText: node.textContent ?? '',
        props: Array.from(node.querySelectorAll('.search-listing__item__props__item'))
          .map((el) => el.textContent ?? '')
          .filter((value) => value.trim().length > 0),
      })),
    )
    .catch(
      () => [] as Array<{ href: string; titleNode: string; anchorText: string; props: string[] }>,
    );

  for (const link of links) {
    const href = link.href.trim();
    if (!href) continue;
    if (!/job|career|position|vacanc/i.test(href) && !/job|career|position|vacanc/i.test(link.anchorText)) continue;
    const absoluteUrl = toAbsoluteUrl(href, pageUrl);
    if (!isCathayJobDetailUrl(absoluteUrl)) continue;

    const card = parseCathayCard(link.titleNode, link.anchorText, link.props);
    if (!card.title) continue;

    const externalId = normalizeExternalId(absoluteUrl, card.title);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    // The listing card carries no description — the detail stage fills it. Passing
    // `pageText` here would attach the same 2,000-character blob of every card on
    // the page to every job, which is worse than having no description at all:
    // the enrichment layer would summarise the whole page instead of one posting.
    jobs.push({
      externalId,
      companyName,
      companyDomain: sourceDomain,
      locale,
      title: card.title,
      // The detail URL slug encodes the region (/careers/jobs/hong-kong/...) and is
      // more reliable than the card's location prop, so prefer it.
      location: locationFromCathayDetailUrl(absoluteUrl) ?? card.location,
      department: card.department,
      rawEmploymentType: card.employmentType,
      employmentType: card.employmentType,
      url: absoluteUrl,
      applyUrl: absoluteUrl,
      source: 'COMPANY_WEBSITE',
      tags: [],
      publishedAt: new Date().toISOString(),
      salaryCurrency: 'HKD',
      localizedContents: [
        {
          locale,
          title: card.title,
          location: card.location,
          url: absoluteUrl,
          applyUrl: absoluteUrl,
        },
      ],
    });
  }

  return jobs;
}

async function extractFromHtml(
  html: string,
  pageUrl: string,
  companyName: string,
  sourceDomain: string | undefined,
  logger: ScrapeContext['logger'],
): Promise<RawJob[]> {
  if (!isCssSearchPageUrl(pageUrl)) {
    try {
      const apiJobs = await fetchCathayListingApiJobs(pageUrl, companyName, sourceDomain, logger);
      if (apiJobs.length > 0) return apiJobs;
    } catch (error) {
      logger.warn('Cathay listing API fallback failed inside HTTP mode, continuing with HTML extraction', {
        url: pageUrl,
        error: String(error),
      });
    }
  }

  if (isCssSearchPageUrl(pageUrl)) {
    try {
      const apiJobs = await fetchCssSearchApiJobs(pageUrl, companyName, sourceDomain, logger);
      if (apiJobs.length > 0) return apiJobs;
    } catch (error) {
      logger.warn('CSS search API fallback failed inside HTTP mode, continuing with HTML extraction', {
        url: pageUrl,
        error: String(error),
      });
    }
  }

  const locale = localeFromUrl(pageUrl);
  const jobs: RawJob[] = [];
  const seen = new Set<string>();

  try {
    const parsed = JSON.parse(html) as unknown;
    collectCandidates(parsed, pageUrl, companyName, sourceDomain, jobs, seen);
  } catch {
    // normal HTML response, continue with pattern extraction below.
  }

  for (const absoluteUrl of extractDetailUrlsFromHtml(html, pageUrl)) {
    const externalId = normalizeExternalId(absoluteUrl, absoluteUrl);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    jobs.push(buildPlaceholderJobFromDetailUrl(absoluteUrl, companyName, sourceDomain));
  }

  return jobs;
}

function extractSitemapLocUrls(xml: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const locRegex = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  for (const match of xml.matchAll(locRegex)) {
    const raw = decodeHtmlEntities(match[1] ?? '').trim();
    if (!raw) continue;
    out.add(toAbsoluteUrl(raw, baseUrl));
  }
  return Array.from(out);
}

function extractSitemapHintsFromRobots(robotsText: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const lineRegex = /^\s*sitemap:\s*(\S+)\s*$/gim;
  for (const match of robotsText.matchAll(lineRegex)) {
    const raw = decodeHtmlEntities(match[1] ?? '').trim();
    if (!raw) continue;
    out.add(toAbsoluteUrl(raw, baseUrl));
  }
  return Array.from(out);
}

function isLikelySitemapUrl(absoluteUrl: string): boolean {
  const lower = absoluteUrl.toLowerCase();
  return lower.includes('sitemap') || lower.endsWith('.xml') || lower.endsWith('.xml.gz');
}

function jobsFromDetailUrls(detailUrls: string[], companyName: string, sourceDomain?: string): RawJob[] {
  const out: RawJob[] = [];
  const seen = new Set<string>();
  for (const absoluteUrl of detailUrls) {
    if (!isCathayJobDetailUrl(absoluteUrl)) continue;
    const externalId = normalizeExternalId(absoluteUrl, absoluteUrl);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    out.push(buildPlaceholderJobFromDetailUrl(absoluteUrl, companyName, sourceDomain));
  }
  return out;
}

async function discoverCathayDetailUrlsFromSitemaps(
  entryUrl: string,
  logger: ScrapeContext['logger'],
  sitemapMaxJobs: number,
): Promise<string[]> {
  let origin: string;
  try {
    origin = new URL(entryUrl).origin;
  } catch {
    return [];
  }

  const queue: string[] = [];
  const queued = new Set<string>();
  const enqueue = (url: string) => {
    if (!url || queued.has(url)) return;
    queued.add(url);
    queue.push(url);
  };

  enqueue(new URL('/sitemap.xml', origin).toString());
  enqueue(new URL('/sitemap_index.xml', origin).toString());
  enqueue(new URL('/sitemap-index.xml', origin).toString());

  try {
    const robotsUrl = new URL('/robots.txt', origin).toString();
    if (await isAllowedByRobots(robotsUrl)) {
      const robotsText = await fetchHtmlWithRetry(robotsUrl, logger, 'sitemap');
      for (const hinted of extractSitemapHintsFromRobots(robotsText, robotsUrl)) enqueue(hinted);
    }
  } catch (error) {
    logger.info('Cathay sitemap discovery skipped robots hints', {
      entryUrl,
      error: String(error),
    });
  }

  const visited = new Set<string>();
  const detailUrls = new Set<string>();
  const maxSitemaps = 20;

  while (queue.length > 0 && visited.size < maxSitemaps && detailUrls.size < sitemapMaxJobs) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    try {
      if (!(await isAllowedByRobots(sitemapUrl))) continue;
      const xml = await fetchHtmlWithRetry(sitemapUrl, logger, 'sitemap');
      const locUrls = extractSitemapLocUrls(xml, sitemapUrl);
      if (locUrls.length === 0) continue;

      for (const absoluteUrl of locUrls) {
        if (isCathayJobDetailUrl(absoluteUrl)) {
          detailUrls.add(absoluteUrl);
          if (detailUrls.size >= sitemapMaxJobs) break;
          continue;
        }
        if (isLikelySitemapUrl(absoluteUrl) && visited.size + queue.length < maxSitemaps) {
          enqueue(absoluteUrl);
        }
      }
    } catch (error) {
      logger.info('Cathay sitemap URL probe failed', {
        sitemapUrl,
        error: String(error),
      });
    }
  }

  const discovered = Array.from(detailUrls);
  logger.info('Cathay sitemap discovery finished', {
    entryUrl,
    sitemapCount: visited.size,
    detailUrlCount: discovered.length,
  });
  return discovered;
}

async function extractRetryAfterMs(response: PlaywrightResponse | null): Promise<number | undefined> {
  if (!response) return undefined;
  const retryAfterRaw = await response.headerValue('retry-after').catch(() => null);
  return parseRetryAfterMs(retryAfterRaw);
}

async function gotoWithRetry(
  page: Page,
  pageUrl: string,
  logger: ScrapeContext['logger'],
  stage: 'listing' | 'detail',
): Promise<void> {
  await withRetry(
    async () => {
      await throttledFetch(pageUrl, async () => {
        const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const status = response?.status() ?? 0;
        if (status >= 400) {
          throw new HttpStatusError(
            pageUrl,
            status,
            response?.statusText() ?? 'HTTP error',
            await extractRetryAfterMs(response),
          );
        }
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(2000).catch(() => {});
      });
    },
    {
      retries: Math.max(1, Number.parseInt(process.env.CATHAY_REQUEST_MAX_RETRIES ?? '4', 10)),
      shouldRetry: (error) => {
        if (error instanceof RobotsDisallowedError) return false;
        if (error instanceof HttpStatusError) return isRetriableStatus(error.statusCode);
        return String(error).toLowerCase().includes('timeout') || String(error).includes('429');
      },
      onRetry: (error, attempt, delayMs) => {
        logger.warn(`Cathay ${stage} retry ${attempt} in ${delayMs}ms`, {
          url: pageUrl,
          error: String(error),
        });
      },
    },
  );
}

function buildPageUrl(startUrl: string, pageNo: number, pageParam: string): string {
  if (startUrl.includes('{page}')) return startUrl.replace('{page}', String(pageNo));
  const lower = startUrl.toLowerCase();
  if (lower.includes('pagenumber=')) {
    try {
      const url = new URL(startUrl);
      // SuccessFactors uses zero-based pageNumber on CSS search pages.
      url.searchParams.set('pageNumber', String(Math.max(0, pageNo)));
      return url.toString();
    } catch {
      return startUrl;
    }
  }
  try {
    const url = new URL(startUrl);
    url.searchParams.set(pageParam, String(pageNo));
    return url.toString();
  } catch {
    return startUrl;
  }
}

function detectPageStart(entryUrl: string, configuredStart?: number): number {
  if (Number.isFinite(configuredStart)) return Math.max(0, Number(configuredStart));
  try {
    const u = new URL(entryUrl);
    if (u.searchParams.has('pageNumber')) return 0;
    return 1;
  } catch {
    return 1;
  }
}

function getEntryUrls(ctx: ScrapeContext, cfg: CathayConfig, fallbackStartUrl: string): string[] {
  if (Array.isArray(ctx.entryUrls) && ctx.entryUrls.length > 0) {
    const fromContext = ctx.entryUrls.map((value) => normalizeText(value)).filter((value) => value.length > 0);
    if (fromContext.length > 0) {
      return Array.from(new Set(fromContext));
    }
  }
  const raw = cfg.entryUrls;
  if (Array.isArray(raw)) {
    const normalized = raw.map((value) => normalizeText(value)).filter((value) => value.length > 0);
    if (normalized.length > 0) {
      return Array.from(new Set(normalized));
    }
  }
  const defaultUrl = cfg.startUrl ?? ctx.urlTemplate ?? fallbackStartUrl;
  return [defaultUrl];
}

function filterHongKongJobs(jobs: RawJob[]): RawJob[] {
  return jobs.filter(job => {
    // For SuccessFactors hosts (HAS/CSS), listing placeholders may not include reliable
    // location before detail enrichment. Keep them and let detail metadata determine region.
    if (isCssHost(job.url)) return true;

    // Check primary location
    if (isHongKongLocation(job.location)) return true;

    // Check topMetadata country
    if (job.topMetadata?.country && isHongKongLocation(job.topMetadata.country)) return true;

    return false;
  });
}

class RateLimitStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitStopError';
  }
}

export class CathayPacificAdapter implements ScraperAdapter {
  readonly name = 'cathaypacific';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const cfg = (ctx.config as CathayConfig) ?? {};
    const entryUrls = getEntryUrls(ctx, cfg, DEFAULT_START_URL);
    const companyName = cfg.companyName ?? 'Cathay Pacific';
    const fullCrawl = cfg.fullCrawl === true;
    const maxPages = fullCrawl
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(cfg.maxPages)
        ? Math.max(1, Number(cfg.maxPages))
        : DEFAULT_MAX_PAGES;
    const sitemapMaxJobs = fullCrawl
      ? Number.MAX_SAFE_INTEGER
      : Number.isFinite(cfg.sitemapMaxJobs)
      ? Math.max(20, Number(cfg.sitemapMaxJobs))
      : DEFAULT_SITEMAP_MAX_JOBS;
    const pageParam = cfg.pageParam ?? 'page';
    const forceHttp = cfg.forceHttp ?? isTruthy(process.env.CATHAY_FORCE_HTTP);

    const jobs: RawJob[] = [];
    const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let useBrowser = !forceHttp;

    try {
      if (forceHttp) {
        ctx.logger.info('Cathay adapter running in forced HTTP mode (CATHAY_FORCE_HTTP)');
      } else {
        try {
          const launched = await launchCathayBrowser(ctx.logger);
          browser = launched.browser;
          context = launched.context;
        } catch (err) {
          if (!isPlaywrightLaunchFailure(err)) throw err;
          useBrowser = false;
          errors.push({
            message: `Playwright unavailable, falling back to HTTP-only scraping: ${String(err)}`,
          });
          ctx.logger.warn('Playwright unavailable for Cathay adapter, using HTTP-only fallback', {
            error: String(err),
          });
        }
      }

      const seenExternalIds = new Set<string>();
      const sitemapCache = new Map<string, string[]>();
      let stopByRateLimit = false;
      let consecutiveEmptyPages = 0;
      const MAX_CONSECUTIVE_EMPTY = 2;

      for (const entryUrl of entryUrls) {
        if (stopByRateLimit) break;
        const sourceEntryDomain = cfg.companyDomain ?? inferCompanyDomain(entryUrl);
        const candidateEntryUrls = [entryUrl];
        let selectedEntryUrl: string | null = null;
        let selectedUrlHadErrors = false;
        const canUseEntryBrowserRequest = useBrowser && Boolean(context) && !isCssSearchPageUrl(entryUrl);
        const pageContext = context;

        if (canUseEntryBrowserRequest && pageContext) {
          try {
            const entryPage = await pageContext.newPage();
            try {
              await gotoWithRetry(entryPage, entryUrl, ctx.logger, 'listing');
              const directApiJobs = await fetchCathayListingApiJobsWithPage(
                entryPage,
                entryUrl,
                companyName,
                sourceEntryDomain,
                ctx.logger,
              );
              if (directApiJobs.length > 0) {
                let newJobsCount = 0;
                for (const job of directApiJobs) {
                  if (seenExternalIds.has(job.externalId)) continue;
                  seenExternalIds.add(job.externalId);
                  jobs.push(job);
                  newJobsCount += 1;
                }
                ctx.logger.info(`Cathay entry listing API produced ${directApiJobs.length} candidates (${newJobsCount} new)`, {
                  entryUrl,
                });
                if (newJobsCount > 0) {
                  selectedEntryUrl = entryUrl;
                  continue;
                }
              }
            } finally {
              await entryPage.close().catch(() => {});
            }
          } catch (entryApiErr) {
            ctx.logger.warn('Cathay entry listing API prefetch failed; falling back to pagination flow', {
              entryUrl,
              error: String(entryApiErr),
            });
          }
        }

        for (const candidateEntryUrl of candidateEntryUrls) {
          if (stopByRateLimit) break;
          let discoveredOnThisEntry = 0;
          let firstPageHadNoJobs = false;
          const pageStartAt = detectPageStart(candidateEntryUrl, cfg.pageStartAt);

          for (let pageNo = pageStartAt; pageNo < pageStartAt + maxPages; pageNo += 1) {
          if (stopByRateLimit) break;
          const pageUrl = buildPageUrl(candidateEntryUrl, pageNo, pageParam);
          if (!(await isAllowedByRobots(pageUrl))) {
            errors.push(robotsDisallowedScrapeError(pageUrl, { page: pageNo, entryUrl: candidateEntryUrl }));
            if (fullCrawl) break;
            continue;
          }

          try {
            const discovered = useBrowser && context
              ? await (async () => {
                  const page = await context.newPage();
                  try {
                    await gotoWithRetry(page, pageUrl, ctx.logger, 'listing');
                    return await extractFromPage(page, pageUrl, companyName, sourceEntryDomain, ctx.logger);
                  } finally {
                    await page.close().catch(() => {});
                  }
                })()
              : await extractFromHtml(
                  await fetchHtmlWithRetry(pageUrl, ctx.logger, 'listing'),
                  pageUrl,
                  companyName,
                  sourceEntryDomain,
                  ctx.logger,
                );

            let newJobsCount = 0;
            for (const job of discovered) {
              if (seenExternalIds.has(job.externalId)) continue;
              seenExternalIds.add(job.externalId);
              jobs.push(job);
              newJobsCount++;
            }
            discoveredOnThisEntry += newJobsCount;

            // Smart pagination: stop if no new jobs found
            if (newJobsCount === 0) {
              consecutiveEmptyPages++;
              ctx.logger.info(`Cathay Pacific page ${pageNo} had no new jobs (${consecutiveEmptyPages}/${MAX_CONSECUTIVE_EMPTY})`, { entryUrl });
              if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY) {
                ctx.logger.info('Stopping pagination: no new jobs in consecutive pages', { entryUrl });
                break;
              }
            } else {
              consecutiveEmptyPages = 0;
            }

            ctx.logger.info(`Cathay Pacific page ${pageNo} produced ${discovered.length} candidates (${newJobsCount} new)`, { entryUrl });
            if (discovered.length === 0) {
              // Empty results on later pages usually means "end of pagination", not a scraping error.
              if (pageNo === pageStartAt) {
                firstPageHadNoJobs = true;
              } else {
                ctx.logger.info('Cathay pagination reached last page (empty result)', {
                  page: pageNo,
                  pageUrl,
                  entryUrl: candidateEntryUrl,
                });
              }
              break;
            }
          } catch (pageErr) {
            const robotsError = robotsDisallowedScrapeErrorFromUnknown(pageErr, { page: pageNo, entryUrl: candidateEntryUrl });
            if (robotsError) {
              errors.push(robotsError);
            } else if (isRateLimitedError(pageErr)) {
              errors.push({
                message: `rate-limited on listing page ${pageNo}: ${String(pageErr)}`,
                context: { page: pageNo, entryUrl: candidateEntryUrl },
              });
              stopByRateLimit = true;
              selectedUrlHadErrors = true;
            } else {
              const isFirstPage404 =
                pageNo === pageStartAt &&
                pageErr instanceof HttpStatusError &&
                pageErr.statusCode === 404;
              if (isFirstPage404) {
                break;
              }
              errors.push({ message: `page ${pageNo}: ${String(pageErr)}`, context: { page: pageNo, entryUrl: candidateEntryUrl } });
              selectedUrlHadErrors = true;
              if (fullCrawl) break;
            }
          }
        }

          if (!stopByRateLimit && discoveredOnThisEntry === 0) {
            try {
              let cacheKey = candidateEntryUrl;
              try {
                cacheKey = new URL(candidateEntryUrl).origin;
              } catch {
                // ignore invalid URL, fallback to candidateEntryUrl as cache key
              }

              let discoveredDetailUrls = sitemapCache.get(cacheKey);
              if (!discoveredDetailUrls) {
                discoveredDetailUrls = await discoverCathayDetailUrlsFromSitemaps(
                  candidateEntryUrl,
                  ctx.logger,
                  sitemapMaxJobs,
                );
                sitemapCache.set(cacheKey, discoveredDetailUrls);
              }

              const discoveredFromSitemap = jobsFromDetailUrls(
                discoveredDetailUrls,
                companyName,
                sourceEntryDomain,
              );
              for (const job of discoveredFromSitemap) {
                if (seenExternalIds.has(job.externalId)) continue;
                seenExternalIds.add(job.externalId);
                jobs.push(job);
              }
              discoveredOnThisEntry += discoveredFromSitemap.length;

              ctx.logger.info(`Cathay sitemap fallback produced ${discoveredFromSitemap.length} candidates`, {
                entryUrl: candidateEntryUrl,
              });
            } catch (sitemapErr) {
              errors.push({
                message: `sitemap fallback failed: ${String(sitemapErr)}`,
                context: { entryUrl: candidateEntryUrl },
              });
            }
          }

          if (firstPageHadNoJobs && discoveredOnThisEntry === 0) {
            errors.push({ message: `no jobs discovered on ${candidateEntryUrl}`, context: { page: pageStartAt, entryUrl: candidateEntryUrl } });
          }

          if (discoveredOnThisEntry > 0) {
            selectedEntryUrl = candidateEntryUrl;
            break;
          }
        }

        if (!selectedEntryUrl && !selectedUrlHadErrors) {
          errors.push({
            message: `no valid Cathay listing entry URL worked`,
            context: { entryUrl, tried: candidateEntryUrls },
          });
        }
      }

      const preFilterCount = jobs.length;

      // Filter to Hong Kong jobs only
      const hongKongJobs = filterHongKongJobs(jobs);
      jobs.splice(0, jobs.length, ...hongKongJobs);

      ctx.logger.info(`Cathay Pacific adapter filtered to ${hongKongJobs.length} Hong Kong jobs (from ${preFilterCount} total)`);

      // Detail stage. The listing cards carry neither a description nor a deadline,
      // and Cathay only publishes both on the detail page, so this is what makes the
      // enrichment layer and the deadline column work at all for this source.
      if (cfg.includeDetailPages !== false && hongKongJobs.length > 0) {
        const maxDetailJobs = Number.isFinite(cfg.maxDetailJobs)
          ? Math.max(0, Number(cfg.maxDetailJobs))
          : DEFAULT_DETAIL_MAX_JOBS;
        const detailStats = await enrichCathayJobsFromDetailPages(hongKongJobs, ctx.logger, {
          concurrency: Math.max(1, parsePositiveInt(process.env.CATHAY_DETAIL_CONCURRENCY, 3)),
          maxJobs: maxDetailJobs,
        });
        ctx.logger.info('Cathay detail stage finished', { ...detailStats });
      }
    } catch (err) {
      if (err instanceof RateLimitStopError) {
        errors.push({ message: err.message });
      } else {
        errors.push({ message: String(err) });
      }
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }

    return { jobs, errors };
  }
}
