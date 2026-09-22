/**
 * JSON-over-HTTP helper shared by the platform adapters.
 *
 * Why this is shared rather than three copies: the Workday, Eightfold and Phenom
 * adapters each grew their own `fetchJson`, and all three called bare `fetch`.
 * That silently bypassed the per-host rate limiter and the robots.txt check that
 * every DOM adapter goes through. The consequence was measured, not theoretical —
 * a full HSBC crawl (247 listing + 247 detail requests in roughly two minutes)
 * got the run blocked by CloudFront, and the block then rejected even
 * `robots.txt` with a 403 for a while.
 *
 * So this helper is deliberately the ONLY way the platform adapters do HTTP:
 *
 *   - `throttledFetch` — robots.txt verdict first (plus its declared
 *     `crawl-delay`), then the per-host limiter, so the whole run paces itself at
 *     ~1 req/s per host instead of bursting;
 *   - `scraperUserAgent()` — the project's declared bot identity, so a site owner
 *     reading their logs sees one consistent, contactable agent rather than a
 *     string that pretends to be a browser;
 *   - `withRetry` — bounded exponential backoff for the statuses worth retrying
 *     (408/429/5xx and transient socket errors), honouring `Retry-After`.
 *
 * 403 is deliberately NOT retried. A 403 from a CDN edge is a block, not a blip:
 * retrying it multiplies load against the thing that just decided to refuse us,
 * which is how a two-minute block becomes an hourly one. The fix for a 403 is to
 * not earn it — pacing — and to surface it so the run reports a failure instead
 * of quietly returning an empty job list.
 *
 * On failure this returns `undefined` and reports the reason through `onFailure`,
 * matching what the callers already expect. The reason string is what makes a
 * failed run diagnosable, so it carries the response body when there is one.
 */
import {
  HttpStatusError,
  RobotsDisallowedError,
  isRetriableStatus,
  isTransientNetworkError,
  parseRetryAfterMs,
  scraperUserAgent,
  throttledFetch,
  withRetry,
} from './rate-limit.js';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Enough of an error body to identify the failure, not enough to flood the log. */
const BODY_SNIPPET_CHARS = 240;

export interface JsonFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Sent verbatim; `content-type: application/json` is added automatically. */
  body?: string;
  timeoutMs?: number;
  /** Overrides `SCRAPER_RETRY_MAX_ATTEMPTS` for this request. */
  retries?: number;
  /** Extra statuses to retry, beyond the standard 408/429/5xx set. */
  retryStatuses?: number[];
  /** Called before each backoff wait, with the reason and the attempt number. */
  onRetry?: (detail: string, attempt: number) => void;
  /** Called once with the final reason, after retries are exhausted. */
  onFailure?: (detail: string) => void;
}

export async function fetchJson<T>(url: string, options: JsonFetchOptions = {}): Promise<T | undefined> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries,
    retryStatuses = [],
    onRetry,
    onFailure,
  } = options;

  const send = async (): Promise<T> =>
    throttledFetch(url, async () => {
      const response = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          'user-agent': scraperUserAgent(),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const snippet = await response.text().catch(() => '');
        // `statusText` carries the body snippet rather than the HTTP reason
        // phrase. That is the established convention in this codebase (see the
        // Cathay adapter) and it is what makes the resulting message actionable:
        // "HTTP 400 invalid facet parameter" names the bug, "HTTP 400" does not.
        throw new HttpStatusError(
          url,
          response.status,
          snippet.slice(0, BODY_SNIPPET_CHARS).replace(/\s+/g, ' ').trim() || response.statusText,
          parseRetryAfterMs(response.headers.get('retry-after')),
        );
      }

      return (await response.json()) as T;
    });

  try {
    return await withRetry(send, {
      ...(retries === undefined ? {} : { retries }),
      shouldRetry: (error) =>
        error instanceof HttpStatusError
          ? isRetriableStatus(error.statusCode) || retryStatuses.includes(error.statusCode)
          : isTransientNetworkError(error),
      ...(onRetry
        ? {
            onRetry: (error: unknown, attempt: number) => {
              onRetry(describeFailure(error), attempt);
            },
          }
        : {}),
    });
  } catch (error) {
    onFailure?.(describeFailure(error));
    return undefined;
  }
}

/**
 * A robots.txt refusal must not be described as a network error: the two call for
 * opposite responses. One is "back off and stop", the other is "try again".
 */
export function describeFailure(error: unknown): string {
  if (error instanceof RobotsDisallowedError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
