import Bottleneck from 'bottleneck';
import robotsParser, { type Robot } from 'robots-parser';
import { request } from 'undici';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const USER_AGENT = process.env.SCRAPER_USER_AGENT ?? '9to6Bot/1.0';

// One Bottleneck instance per hostname. Defaults to ~1 req/sec, 3 concurrent. Tunable via
// SCRAPER_MIN_TIME_MS / SCRAPER_MAX_CONCURRENT env vars for the whole scraper.
const limiters = new Map<string, Bottleneck>();

const minTime = Number.parseInt(process.env.SCRAPER_MIN_TIME_MS ?? '1000', 10);
const maxConcurrent = Number.parseInt(process.env.SCRAPER_MAX_CONCURRENT ?? '3', 10);

function limiterFor(host: string): Bottleneck {
  let limiter = limiters.get(host);
  if (!limiter) {
    limiter = new Bottleneck({ minTime, maxConcurrent });
    limiters.set(host, limiter);
  }
  return limiter;
}

// Cached robots.txt per hostname. A null value caches a "we couldn't fetch it, assume allow"
// decision for the TTL so we don't retry every request. Fail-open is the conservative choice
// for a missing/malformed robots.txt — most sites that care will return 404 (which is allow).
interface RobotsEntry {
  robot: Robot | null;
  fetchedAt: number;
}
const robotsCache = new Map<string, RobotsEntry>();
const ROBOTS_TTL_MS = 60 * 60 * 1000;

async function getRobots(origin: string): Promise<Robot | null> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) {
    return cached.robot;
  }
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const { statusCode, body } = await request(robotsUrl, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT },
      bodyTimeout: 5_000,
      headersTimeout: 5_000,
    });
    if (statusCode >= 200 && statusCode < 300) {
      const text = await body.text();
      const robot = robotsParser(robotsUrl, text);
      robotsCache.set(origin, { robot, fetchedAt: Date.now() });
      return robot;
    }
    await body.dump();
    robotsCache.set(origin, { robot: null, fetchedAt: Date.now() });
    return null;
  } catch (err) {
    logger.warn({ err: String(err), origin }, 'robots.txt fetch failed; assuming allow');
    robotsCache.set(origin, { robot: null, fetchedAt: Date.now() });
    return null;
  }
}

export async function isAllowedByRobots(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const robot = await getRobots(`${parsed.protocol}//${parsed.host}`);
  if (!robot) return true;
  const allowed = robot.isAllowed(url, USER_AGENT);
  return allowed !== false;
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
    if (!(await isAllowedByRobots(url))) {
      throw new RobotsDisallowedError(url);
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
