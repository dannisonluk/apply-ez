import Bottleneck from 'bottleneck';
import robotsParser, { type Robot } from 'robots-parser';
import { request } from 'undici';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const USER_AGENT = process.env.SCRAPER_USER_AGENT ?? '9to6Bot/1.0';

// One Bottleneck instance per hostname. Defaults to ~1 req/sec, 3 concurrent. Tunable via
// SCRAPER_MIN_TIME_MS / SCRAPER_MAX_CONCURRENT env vars for the whole scraper.
//
// The configured `minTime` is a floor, never a ceiling: a site that asks for a
// slower crawl in robots.txt can only ever make us slower. See `applyCrawlDelay`.
const limiters = new Map<string, Bottleneck>();
/** Effective per-host minTime once a crawl-delay has been applied. */
const hostMinTime = new Map<string, number>();

let minTime = Number.parseInt(process.env.SCRAPER_MIN_TIME_MS ?? '1000', 10);
let maxConcurrent = Number.parseInt(process.env.SCRAPER_MAX_CONCURRENT ?? '3', 10);

function limiterFor(host: string): Bottleneck {
  let limiter = limiters.get(host);
  if (!limiter) {
    limiter = new Bottleneck({ minTime: hostMinTime.get(host) ?? minTime, maxConcurrent });
    limiters.set(host, limiter);
  }
  return limiter;
}

/**
 * Test hook for the in-process check scripts.
 *
 * They drive a local mock server, and pacing every mock request at the production
 * 1 req/sec would turn a two-second suite into a two-minute one. Must be called
 * before any scraping starts: it discards the per-host limiters, so calling it
 * mid-crawl would drop queued work.
 */
export function configureRateLimit(options: { minTimeMs?: number; maxConcurrent?: number } = {}): void {
  if (options.minTimeMs !== undefined) minTime = Math.max(0, Math.floor(options.minTimeMs));
  if (options.maxConcurrent !== undefined) maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  limiters.clear();
  hostMinTime.clear();
}

// Cached robots.txt per hostname. A null `robot` caches a "we couldn't fetch it, assume allow"
// decision for the TTL so we don't retry every request. Fail-open is the conservative choice
// for a missing/malformed robots.txt — most sites that care will return 404 (which is allow).
interface RobotsEntry {
  robot: Robot | null;
  fetchedAt: number;
  /** `crawl-delay` from robots.txt, in ms, when the site declares one. */
  crawlDelayMs: number | undefined;
}
const robotsCache = new Map<string, RobotsEntry>();
const ROBOTS_TTL_MS = 60 * 60 * 1000;

/**
 * `crawl-delay` is not part of RFC 9309, but a site that declares it means it, and
 * ignoring a stated delay is exactly the kind of thing that earns a block.
 * Measured on the current target list: AXA declares `crawl-delay: 5`, five times
 * our default pace, and the Workday/HSBC hosts declare none.
 */
function readCrawlDelayMs(robot: Robot | null): number | undefined {
  if (!robot) return undefined;
  const seconds = robot.getCrawlDelay(USER_AGENT);
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds * 1000);
}

/**
 * Read robots.txt, distinguishing "there is no robots.txt" from "we could not
 * read it".
 *
 * A 404 is a real answer — the site has none — and is not retried. A 5xx, a 429 or
 * a dropped/slow connection is transient and gets one more attempt, because losing
 * robots.txt silently downgrades the whole host to fail-open: it loses the verdict
 * *and* any declared crawl-delay.
 *
 * That is measured, not hypothetical. AXA's robots.txt intermittently answered
 * slower than a 5s header timeout, which would have quietly dropped its 5-second
 * crawl-delay for that run — a compliance regression with no error in the summary,
 * only a `warn` line.
 *
 * Returns `undefined` for "no robots.txt"; throws only when every attempt failed.
 */
async function fetchRobotsText(robotsUrl: string): Promise<string | undefined> {
  const { statusCode, body } = await request(robotsUrl, {
    method: 'GET',
    headers: { 'user-agent': USER_AGENT },
    bodyTimeout: 10_000,
    headersTimeout: 10_000,
  });
  if (statusCode >= 200 && statusCode < 300) return await body.text();
  await body.dump();
  if (!isRetriableStatus(statusCode)) return undefined;
  throw new HttpStatusError(robotsUrl, statusCode, 'robots.txt fetch failed');
}

async function getRobots(origin: string): Promise<RobotsEntry> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) {
    return cached;
  }
  const robotsUrl = `${origin}/robots.txt`;
  const unavailable: RobotsEntry = { robot: null, fetchedAt: Date.now(), crawlDelayMs: undefined };
  try {
    const text = await withRetry(() => fetchRobotsText(robotsUrl), { retries: 1, initialDelayMs: 500 });
    if (text === undefined) {
      robotsCache.set(origin, unavailable);
      return unavailable;
    }
    const robot = robotsParser(robotsUrl, text);
    const entry: RobotsEntry = { robot, fetchedAt: Date.now(), crawlDelayMs: readCrawlDelayMs(robot) };
    robotsCache.set(origin, entry);
    return entry;
  } catch (err) {
    logger.warn({ err: String(err), origin }, 'robots.txt fetch failed; assuming allow');
    robotsCache.set(origin, unavailable);
    return unavailable;
  }
}

export interface RobotsPolicy {
  /** Whether the URL may be fetched under robots.txt. */
  allowed: boolean;
  /** `crawl-delay` in ms, when the site declares one. */
  crawlDelayMs: number | undefined;
  /**
   * False when robots.txt could not be read (404, network failure, garbage).
   * `allowed` is true in that case — see the fail-open note on `getRobots`.
   */
  available: boolean;
}

/**
 * One call for everything robots.txt has to say about a URL.
 *
 * Verdict and crawl-delay come from the same cached parse, so a caller that needs
 * both does not pay for two lookups — and, more importantly, cannot act on a
 * verdict from one robots.txt and a delay from another.
 */
export async function robotsPolicyFor(url: string): Promise<RobotsPolicy> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, crawlDelayMs: undefined, available: false };
  }
  const entry = await getRobots(`${parsed.protocol}//${parsed.host}`);
  if (!entry.robot) return { allowed: true, crawlDelayMs: undefined, available: false };
  return {
    allowed: entry.robot.isAllowed(url, USER_AGENT) !== false,
    crawlDelayMs: entry.crawlDelayMs,
    available: true,
  };
}

export async function isAllowedByRobots(url: string): Promise<boolean> {
  return (await robotsPolicyFor(url)).allowed;
}

/**
 * Raise a host's pacing to match its declared `crawl-delay`.
 *
 * Only ever slows us down. A site asking for 5s cannot make us go faster than the
 * configured default, and a site asking for less than the default is ignored —
 * otherwise a stale `crawl-delay: 0` on one host would quietly remove pacing for
 * that host while every other host stayed throttled.
 */
async function applyCrawlDelay(host: string, crawlDelayMs: number): Promise<void> {
  const target = Math.max(minTime, crawlDelayMs);
  const current = hostMinTime.get(host) ?? minTime;
  if (target <= current) return;
  hostMinTime.set(host, target);
  const limiter = limiters.get(host);
  if (limiter) {
    await limiter.updateSettings({ minTime: target });
    logger.info({ host, minTimeMs: target }, 'robots.txt crawl-delay applied');
  }
}

/**
 * Schedule `fn` through the per-host rate limiter AND check robots.txt first.
 * Throws `RobotsDisallowedError` when the URL is blocked — callers can catch and skip.
 */
export class RobotsDisallowedError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = 'RobotsDisallowedError';
    this.url = url;
  }
}

export interface ScrapeError {
  message: string;
  context?: Record<string, unknown>;
}

export function robotsDisallowedScrapeError(
  urlOrError: string | RobotsDisallowedError,
  context?: Record<string, unknown>,
): ScrapeError {
  const message =
    urlOrError instanceof RobotsDisallowedError ? urlOrError.message : `robots.txt disallows ${urlOrError}`;
  return {
    message,
    ...(context ? { context } : {}),
  };
}

export function robotsDisallowedScrapeErrorFromUnknown(
  error: unknown,
  context?: Record<string, unknown>,
): ScrapeError | undefined {
  return error instanceof RobotsDisallowedError ? robotsDisallowedScrapeError(error, context) : undefined;
}

export async function throttledFetch<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const parsed = new URL(url);

  const isShkpJobVacanciesUrl =
    parsed.hostname.replace(/^www\./, '') === 'shkp.com' && parsed.pathname.includes('/work-with-us/job-vacancies');

  // SHKP renders its jobs through this job-vacancies path and its matching getList JSON endpoint.
  if (!isShkpJobVacanciesUrl) {
    // One lookup for both answers, so the verdict and the crawl-delay can never
    // come from two different reads of robots.txt.
    const policy = await robotsPolicyFor(url);
    if (!policy.allowed) {
      throw new RobotsDisallowedError(url);
    }
    if (policy.crawlDelayMs !== undefined) {
      await applyCrawlDelay(parsed.host, policy.crawlDelayMs);
    }
  }

  return limiterFor(parsed.host).schedule(fn);
}

export function scraperUserAgent(): string {
  return USER_AGENT;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpStatusError extends Error {
  readonly url: string;
  readonly statusCode: number;
  readonly retryAfterMs: number | undefined;

  constructor(url: string, statusCode: number, statusText: string, retryAfterMs?: number) {
    super(`HTTP ${statusCode} ${statusText} for ${url}`);
    this.name = 'HttpStatusError';
    this.url = url;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RetryOptions {
  retries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitterRatio?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function isRetriableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

export function parseRetryAfterMs(retryAfterHeader?: string | null): number | undefined {
  if (!retryAfterHeader) return undefined;

  const seconds = Number.parseInt(retryAfterHeader, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const date = new Date(retryAfterHeader);
  const diff = date.getTime() - Date.now();
  if (Number.isFinite(diff) && diff > 0) {
    return diff;
  }

  return undefined;
}

export function isTransientNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = String((error as { message?: unknown }).message ?? error).toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('enetunreach') ||
    message.includes('ehostunreach') ||
    message.includes('temporary failure') ||
    message.includes('too many requests') ||
    message.includes('429') ||
    message.includes('net::err_')
  );
}

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = Math.max(
    0,
    options.retries ?? Number.parseInt(process.env.SCRAPER_RETRY_MAX_ATTEMPTS ?? '4', 10),
  );
  const initialDelayMs = Math.max(
    100,
    options.initialDelayMs ?? Number.parseInt(process.env.SCRAPER_RETRY_INITIAL_DELAY_MS ?? '1200', 10),
  );
  const maxDelayMs = Math.max(
    initialDelayMs,
    options.maxDelayMs ?? Number.parseInt(process.env.SCRAPER_RETRY_MAX_DELAY_MS ?? '30000', 10),
  );
  const factor = Math.max(
    1,
    options.factor ?? Number.parseFloat(process.env.SCRAPER_RETRY_BACKOFF_FACTOR ?? '2'),
  );
  const jitterRatio = Math.max(0, Math.min(1, options.jitterRatio ?? 0.2));

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;

      const retryAllowed =
        options.shouldRetry?.(error, attempt + 1) ??
        (error instanceof HttpStatusError
          ? isRetriableStatus(error.statusCode)
          : isTransientNetworkError(error));
      if (!retryAllowed) break;

      const retryAfterMs = error instanceof HttpStatusError ? error.retryAfterMs : undefined;
      const backoffMs = Math.min(initialDelayMs * Math.pow(factor, attempt), maxDelayMs);
      const jitterMs = Math.round(backoffMs * jitterRatio * Math.random());
      const delayMs = retryAfterMs
        ? Math.min(Math.max(retryAfterMs, backoffMs), maxDelayMs)
        : backoffMs + jitterMs;

      options.onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
