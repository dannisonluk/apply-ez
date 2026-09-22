/**
 * Workday adapter — reads the public CXS JSON API instead of scraping the DOM.
 *
 * Why this exists: AIA and Manulife both run Workday, and the previous adapters
 * drove a headless browser through the job list. That is the most expensive and
 * most fragile way to read a Workday site, because the same data is served as
 * JSON by an endpoint the SPA itself calls:
 *
 *   POST {origin}/wday/cxs/{tenant}/{site}/jobs          -> listing page
 *   GET  {origin}/wday/cxs/{tenant}/{site}{externalPath} -> full posting
 *
 * Two concrete wins beyond speed and stability:
 *
 *   - `endDate` is the real application deadline. The DOM never exposes it, which
 *     is why the Cathay adapter needed a whole detail stage to recover 41/45 and
 *     the Workday sites could only ever infer it from the description text.
 *   - `jobDescription` arrives as the posting body alone. Scraping the rendered
 *     page returns the whole chrome around it, which is what polluted every
 *     Cathay job with the same 2,155-character blob.
 *
 * No browser is launched, so this adapter works even when `playwright install`
 * has not run — it is the cheapest target in the fleet by a wide margin.
 */
import type { RawJob, ScrapeContext, ScrapeResult, ScraperAdapter } from './adapter.interface.js';
import { normalizeText, stripHtmlToText } from '../lib/text.js';
import { parseHongKongDateTime } from '../lib/hk-time.js';

/** Workday rejects `limit` above 20. */
const PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_JOBS = 400;
const DEFAULT_DETAIL_MAX_JOBS = 200;
const DEFAULT_DETAIL_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 30_000;

/** Shapes seen in the wild: "Permanent", "Fixed Term", "Intern", "Full time". */
const EMPLOYMENT_TYPE_BULLET =
  /^(?:permanent|contract|contractor|temporary|fixed[\s-]?term|regular|intern(?:ship)?|part[\s-]?time|full[\s-]?time|casual|freelance|secondment|trainee)$/i;
/** Requisition ids: "JR-70285", "JR26070668", "R-12345". */
const REQ_ID_BULLET = /^[A-Z]{1,4}-?\d{3,}[A-Za-z0-9-]*$/;

export interface WorkdayEndpoint {
  origin: string;
  tenant: string;
  site: string;
  /** Fully-qualified CXS root: `{origin}/wday/cxs/{tenant}/{site}`. */
  cxs: string;
}

/**
 * Derive the CXS endpoint from a public Workday careers URL.
 *
 * Handles `https://{tenant}.wd{N}.myworkdayjobs.com/{locale}/{site}` — the shape
 * every target in this repo uses.
 *
 * A bare `https://wd{N}.myworkdayjobs.com/...` host is REJECTED rather than
 * guessed at. It would put the tenant somewhere in the path, and picking the
 * wrong segment yields a CXS root that either 404s or resolves to a different
 * tenant's job board. Silently scraping the wrong company is worse than failing
 * loudly, so that shape stays unsupported until there is a real URL to verify it
 * against.
 */
export function parseWorkdayUrl(rawUrl: string): WorkdayEndpoint | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  const subdomain = url.hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i);
  const tenant = subdomain?.[1];
  if (!tenant) return undefined;

  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  // Drop a leading locale such as `en-US` / `zh-HK`.
  const meaningful = segments.filter((part, index) => !(index === 0 && /^[a-z]{2}-[A-Z]{2}$/.test(part)));
  const site = meaningful[meaningful.length - 1];
  if (!site) return undefined;

  const origin = url.origin;
  return {
    origin,
    tenant,
    site,
    cxs: `${origin}/wday/cxs/${tenant}/${site}`,
  };
}

/**
 * Pull the employment type and requisition id out of `bulletFields`.
 *
 * Deliberately by SHAPE, not by index. AIA returns
 * `["Permanent", "JR-70285"]` but Manulife returns `["JR26070668", "Toronto"]`,
 * so `bulletFields[0]` is the employment type for one tenant and the req id for
 * the other. Index-based reads silently swap the two.
 */
export function parseWorkdayBullets(bullets: unknown): {
  employmentType?: string;
  externalId?: string;
} {
  if (!Array.isArray(bullets)) return {};
  let employmentType: string | undefined;
  let externalId: string | undefined;
  for (const raw of bullets) {
    if (typeof raw !== 'string') continue;
    const value = normalizeText(raw);
    if (!value) continue;
    if (!employmentType && EMPLOYMENT_TYPE_BULLET.test(value)) {
      employmentType = value;
      continue;
    }
    if (!externalId && REQ_ID_BULLET.test(value)) externalId = value;
  }
  return {
    ...(employmentType ? { employmentType } : {}),
    ...(externalId ? { externalId } : {}),
  };
}

interface WorkdayListPosting {
  title?: string;
  externalPath?: string;
  timeType?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: unknown;
}

interface WorkdayDetailInfo {
  title?: string;
  jobDescription?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  timeType?: string;
  jobReqId?: string;
  jobPostingId?: string;
  externalUrl?: string;
  country?: string;
  jobRequisitionLocation?: { descriptor?: string } | string;
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** "Posted Today" / "Posted 3 Days Ago" → now; anything else is left to the caller. */
function isRelativePostedOn(value: string | undefined): boolean {
  return !!value && /posted\s+\d+\s+days?\s+ago|posted\s+today|posted\s+yesterday/i.test(value);
}

/**
 * Fetch and parse JSON, reporting WHY on failure.
 *
 * The optional `onFailure` matters: the first Manulife run failed with nothing
 * but "listing page failed", because a wrong facet key makes Workday answer 400
 * and a bare `undefined` return throws the explanation away. A silent failure on
 * a listing endpoint looks identical to an empty careers site.
 */
async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  onFailure?: (detail: string) => void,
): Promise<T | undefined> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (compatible; apply-ez/0.1)',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      onFailure?.(`HTTP ${response.status} ${body.slice(0, 240)}`);
      return undefined;
    }
    return (await response.json()) as T;
  } catch (error) {
    onFailure?.(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** Bounded-concurrency map — sequential would make 200 detail fetches feel dead. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export class WorkdayAdapter implements ScraperAdapter {
  readonly name = 'workday';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const entryUrls = ctx.entryUrls ?? [];
    if (entryUrls.length === 0) {
      return { jobs: [], errors: [{ message: 'workday adapter needs at least one entryUrl' }] };
    }

    const endpoint = parseWorkdayUrl(entryUrls[0] ?? '');
    if (!endpoint) {
      return {
        jobs: [],
        errors: [{ message: `not a recognised Workday URL: ${entryUrls[0] ?? ''}` }],
      };
    }

    // Escape hatch for `check-workday.ts`, which points the adapter at a local
    // mock so the pagination and wrap-around behaviour can be asserted without
    // hitting a live tenant. Also usable in production for a tenant on a custom
    // domain. The URL is still parsed above, so a malformed entry URL is caught
    // regardless of this override.
    if (typeof ctx.config.cxsBaseUrl === 'string' && ctx.config.cxsBaseUrl.length > 0) {
      endpoint.cxs = ctx.config.cxsBaseUrl.replace(/\/+$/, '');
    }

    const maxPages = readPositiveInt(ctx.config.maxPages, DEFAULT_MAX_PAGES);
    const maxJobs = readPositiveInt(ctx.config.maxJobs, DEFAULT_MAX_JOBS);
    const searchText = typeof ctx.config.searchText === 'string' ? ctx.config.searchText : '';
    const locale = typeof ctx.config.locale === 'string' ? ctx.config.locale : 'en';
    const locationCountry = typeof ctx.config.locationCountry === 'string' ? ctx.config.locationCountry : undefined;

    // The facet PARAMETER NAME differs per tenant: AIA uses `locationCountry`,
    // Manulife uses `Location_Country`. Sending the wrong key is not ignored —
    // Workday answers 400 and the whole listing silently comes back empty, which
    // is how the first Manulife run returned 0 jobs.
    const locationCountryFacet =
      typeof ctx.config.locationCountryFacet === 'string' && ctx.config.locationCountryFacet.length > 0
        ? ctx.config.locationCountryFacet
        : 'locationCountry';

    // The facet VALUE is a Workday-wide UUID, so Hong Kong is the same string on
    // every tenant — but it stays config-driven because a wrong UUID would quietly
    // return the global job list instead of the Hong Kong subset.
    const appliedFacets: Record<string, string[]> = locationCountry
      ? { [locationCountryFacet]: [locationCountry] }
      : {};

    ctx.logger.info('workday: listing', {
      tenant: endpoint.tenant,
      site: endpoint.site,
      locale,
      maxPages,
      maxJobs,
      facet: locationCountry ? `${locationCountryFacet}=${locationCountry}` : '(none)',
    });

    const listed: WorkdayListPosting[] = [];
    const seenPaths = new Set<string>();
    let total = 0;

    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * PAGE_SIZE;

      const payload = await fetchJson<{ total?: number; jobPostings?: WorkdayListPosting[] }>(
        `${endpoint.cxs}/jobs`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appliedFacets, limit: PAGE_SIZE, offset, searchText }),
        },
        (detail) => {
          errors.push({
            message: `workday: listing page failed at offset ${offset}`,
            context: { detail, appliedFacets },
          });
        },
      );

      if (!payload) break;

      // Only page 0 carries a real total; every later page reports `total: 0`.
      // Assigning unconditionally would clobber the good value with a zero and
      // stop the crawl after two pages — which is exactly what happened on the
      // first run against AIA (40 jobs collected out of 116).
      if (typeof payload.total === 'number' && payload.total > 0) total = payload.total;

      const batch = payload.jobPostings ?? [];
      if (batch.length === 0) break;

      const before = listed.length;
      for (const posting of batch) {
        const path = posting.externalPath;
        if (!path || seenPaths.has(path)) continue;
        seenPaths.add(path);
        listed.push(posting);
      }

      ctx.logger.info('workday: page done', {
        page: page + 1,
        collected: listed.length,
        reportedTotal: total,
      });

      // Past the last page Workday WRAPS AROUND and re-serves page 1 instead of
      // returning an empty batch, so "empty batch" is not a usable stop signal.
      // A page that contributed nothing new means we have either wrapped or run
      // out; that check holds even if `total` is wrong or missing.
      if (listed.length === before) break;
      if (total > 0 && offset + PAGE_SIZE >= total) break;
      if (listed.length >= maxJobs) break;
    }

    ctx.logger.info('workday: listed', { collected: listed.length, reportedTotal: total });

    const capped = listed.slice(0, maxJobs);

    // ── detail stage ──────────────────────────────────────────────────────────
    // This is where `endDate` (the real deadline) and the clean posting body come
    // from; the listing alone only has a relative "Posted 3 Days Ago".
    const includeDetail = ctx.config.includeDetailPages !== false;
    const detailMaxJobs = readPositiveInt(ctx.config.maxDetailJobs, DEFAULT_DETAIL_MAX_JOBS);
    const detailConcurrency = readPositiveInt(
      ctx.config.detailConcurrency ?? process.env.WORKDAY_DETAIL_CONCURRENCY,
      DEFAULT_DETAIL_CONCURRENCY,
    );

    const details = new Map<string, WorkdayDetailInfo>();
    if (includeDetail && capped.length > 0) {
      const targets = capped.slice(0, detailMaxJobs);
      let failed = 0;
      await mapWithConcurrency(targets, detailConcurrency, async (posting) => {
        const path = posting.externalPath;
        if (!path) return;
        const payload = await fetchJson<{ jobPostingInfo?: WorkdayDetailInfo | null }>(
          `${endpoint.cxs}${path}`,
        );
        const info = payload?.jobPostingInfo;
        if (!info) {
          failed += 1;
          return;
        }
        details.set(path, info);
      });
      ctx.logger.info('workday: detail stage', {
        attempted: targets.length,
        enriched: details.size,
        failed,
        skipped: capped.length - targets.length,
      });
    }

    // ── map to RawJob ─────────────────────────────────────────────────────────
    const nowIso = new Date().toISOString();
    const jobs: RawJob[] = [];

    for (const posting of capped) {
      const path = posting.externalPath;
      if (!path) continue;
      const detail = details.get(path);
      const bullets = parseWorkdayBullets(posting.bulletFields);

      const location = normalizeText(detail?.location ?? posting.locationsText) || undefined;
      const url = normalizeText(detail?.externalUrl) || `${endpoint.origin}${path}`;

      // `startDate` is a plain `YYYY-MM-DD`; parseHongKongDateTime anchors it to
      // HK midnight rather than the runtime zone. A relative "Posted Today" has no
      // date to parse, so it falls back to the run time.
      const publishedAt =
        parseHongKongDateTime(detail?.startDate, new Date()) ??
        (isRelativePostedOn(posting.postedOn) ? nowIso : undefined) ??
        nowIso;

      const deadline = parseHongKongDateTime(detail?.endDate, new Date());

      const descriptionHtml = detail?.jobDescription ?? '';
      const description = descriptionHtml ? stripHtmlToText(descriptionHtml) : '';

      const timeType = normalizeText(detail?.timeType ?? posting.timeType) || undefined;

      jobs.push({
        source: 'COMPANY_WEBSITE',
        externalId: normalizeText(detail?.jobReqId) || bullets.externalId || path.split('/').pop() || path,
        title: normalizeText(detail?.title ?? posting.title),
        url,
        applyUrl: url,
        publishedAt,
        ...(location ? { location } : {}),
        ...(ctx.config.companyName ? { companyName: String(ctx.config.companyName) } : {}),
        ...(ctx.config.companyDomain ? { companyDomain: String(ctx.config.companyDomain) } : {}),
        ...(timeType ? { workSchedule: timeType, rawEmploymentType: timeType } : {}),
        ...(bullets.employmentType ? { employmentType: bullets.employmentType } : {}),
        // The real deadline. Nothing in the DOM exposes this.
        ...(deadline ? { applicationDeadline: deadline } : {}),
        ...(description ? { description } : {}),
        // `topMetadata` has a fixed key set (`jobTopMetadataSchema`), so the
        // Workday-specific identifiers deliberately stay out of it: the tenant and
        // site are already recoverable from `url`, and the posting path is on
        // `classification`-adjacent metadata we do not need to persist. Only keys
        // the schema knows about go here.
        topMetadata: {
          ...(detail?.country ? { country: detail.country } : {}),
          ...(timeType ? { workSchedule: timeType } : {}),
          ...(bullets.employmentType ? { employmentType: bullets.employmentType } : {}),
        },
      });
    }

    return { jobs, errors };
  }
}
