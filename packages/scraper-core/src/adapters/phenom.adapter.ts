/**
 * Phenom adapter — reads the public `/api/jobs` JSON API.
 *
 * Built for AXA, but Phenom People powers many large-company career sites, so it
 * is keyed by platform: point a target at it with the right `location` filter.
 *
 *   GET {origin}/api/jobs?page=N&limit=M&internal=false&location={location}
 *     -> { totalCount, count, jobs: [ { data: { ...posting } } ] }
 *
 * Two things make this the cheapest adapter in the fleet:
 *
 *   - The full `description` is already in the LISTING response, so there is no
 *     detail stage at all — one request per 25 postings rather than one per
 *     posting.
 *   - It carries structured fields no other target exposes: `employment_type`,
 *     `tags1`/`tags2` (work pattern and contract type), `categories`, `latitude`
 *     /`longitude`, and an explicit-offset `posted_date`.
 *
 * The filter lives in the entry URL's query string, so `?location=Hong+Kong`
 * drives the API filter from one place. Note that the filter parameter is
 * `location` and NOT `city`/`locations`/`country_code` — those are accepted and
 * silently ignored, returning the global board (1,515 postings instead of 68),
 * which looks like a working crawl of the wrong data.
 */
import type { RawJob, ScrapeContext, ScrapeResult, ScraperAdapter } from './adapter.interface.js';
import { readPositiveInt } from '../lib/concurrency.js';
import { normalizeText, stripHtmlToText } from '../lib/text.js';
import { fetchJson } from '../lib/http-json.js';

const DEFAULT_LIMIT = 25;
const DEFAULT_MAX_JOBS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
/** `totalCount` could be wrong, so the page loop gets its own ceiling. */
const MAX_PAGES = 40;

interface PhenomJobData {
  slug?: string;
  req_id?: string;
  title?: string;
  description?: string;
  location_name?: string;
  street_address?: string;
  city?: string;
  country?: string;
  country_code?: string;
  employment_type?: string;
  posted_date?: string;
  update_date?: string;
  create_date?: string;
  apply_url?: string;
  full_location?: string;
  short_location?: string;
  categories?: Array<{ name?: string }>;
  category?: string[];
  tags1?: string[];
  tags2?: string[];
  tags3?: string[];
  ats_code?: string;
  multipleLocations?: boolean;
}

interface PhenomListResponse {
  totalCount?: number;
  count?: number;
  jobs?: Array<{ data?: PhenomJobData }>;
}

export interface PhenomEndpoint {
  origin: string;
  location?: string;
  /** Locale segment for the public posting URL, e.g. `en-us`. */
  lang?: string;
}

/**
 * Derive the API endpoint from the careers URL the target carries.
 *
 * The target URL is a filtered search (`?woe=7&lat=…&searchType=commute`), and
 * those commute-search parameters are NOT what the API filters on. Only
 * `location` is read here; everything else is intentionally dropped, because
 * forwarding the commute params produces a global crawl.
 */
export function parsePhenomUrl(rawUrl: string): PhenomEndpoint | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!url.hostname) return undefined;

  const location = url.searchParams.get('location') ?? undefined;
  const lang = url.searchParams.get('lang') ?? undefined;

  return {
    origin: url.origin,
    ...(location ? { location } : {}),
    ...(lang ? { lang } : {}),
  };
}

/**
 * `posted_date` arrives as `2026-08-14T09:10:00+0000` — an explicit UTC offset,
 * so it is parsed directly rather than anchored to Hong Kong. Anchoring a
 * timestamp that already states its zone would shift it by 8 hours.
 */
export function fromOffsetIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// HTTP for this adapter goes through `lib/http-json.ts`, which wraps every request
// in `throttledFetch` (robots.txt verdict + declared crawl-delay + per-host pacing)
// and `withRetry`. The local `fetchJson` that used to sit here called bare `fetch`
// and bypassed all of it — and this is the host that most needs the pacing, since
// its robots.txt declares `crawl-delay: 5`.

/** First non-empty string in a `string[]` tag field. */
function firstTag(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    if (typeof entry === 'string' && normalizeText(entry).length > 0) return normalizeText(entry);
  }
  return undefined;
}

export class PhenomAdapter implements ScraperAdapter {
  readonly name = 'phenom';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const entryUrls = ctx.entryUrls ?? [];
    if (entryUrls.length === 0) {
      return { jobs: [], errors: [{ message: 'phenom adapter needs at least one entryUrl' }] };
    }

    const endpoint = parsePhenomUrl(entryUrls[0] ?? '');
    if (!endpoint) {
      return { jobs: [], errors: [{ message: `not a recognised Phenom URL: ${entryUrls[0] ?? ''}` }] };
    }

    const location =
      typeof ctx.config.location === 'string' && ctx.config.location.length > 0
        ? ctx.config.location
        : endpoint.location;
    if (!location) {
      // Without a filter this crawls the global board. Refusing is the point:
      // 1,515 postings would otherwise be stored as if they were Hong Kong jobs.
      return {
        jobs: [],
        errors: [
          {
            message:
              'phenom adapter needs a `location` filter (config.location or ?location= in the entryUrl); ' +
              'without one the API returns the global job board',
          },
        ],
      };
    }

    const apiBase =
      typeof ctx.config.apiBase === 'string' && ctx.config.apiBase.length > 0
        ? ctx.config.apiBase.replace(/\/+$/, '')
        : `${endpoint.origin}/api/jobs`;
    const limit = readPositiveInt(ctx.config.limit, DEFAULT_LIMIT);
    const maxJobs = readPositiveInt(ctx.config.maxJobs, DEFAULT_MAX_JOBS);
    const lang = typeof ctx.config.lang === 'string' ? ctx.config.lang : endpoint.lang;

    ctx.logger.info('phenom: listing', { location, limit, maxJobs });

    const rows: PhenomJobData[] = [];
    const seen = new Set<string>();
    let totalCount = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        internal: 'false',
        location,
      });
      const payload = await fetchJson<PhenomListResponse>(`${apiBase}?${params.toString()}`, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        onFailure: (detail) => {
          errors.push({
            message: `phenom: listing page ${page} failed`,
            context: { detail, location },
          });
        },
      });

      if (!payload) break;

      if (typeof payload.totalCount === 'number' && payload.totalCount > 0) {
        totalCount = payload.totalCount;
      }

      const batch = payload.jobs ?? [];
      if (batch.length === 0) break;

      let added = 0;
      for (const wrapper of batch) {
        const data = wrapper.data;
        if (!data) continue;
        const id = normalizeText(data.slug ?? data.req_id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rows.push(data);
        added += 1;
      }

      ctx.logger.info('phenom: page done', {
        page,
        collected: rows.length,
        reportedTotal: totalCount,
      });

      if (added === 0) break;
      if (rows.length >= maxJobs) break;
      if (totalCount > 0 && page * limit >= totalCount) break;
    }

    ctx.logger.info('phenom: listed', { collected: rows.length, reportedTotal: totalCount });

    const nowIso = new Date().toISOString();
    const jobs: RawJob[] = [];

    for (const row of rows.slice(0, maxJobs)) {
      const id = normalizeText(row.slug ?? row.req_id);
      const title = normalizeText(row.title);
      if (!id || !title) continue;

      const category = row.categories?.find((entry) => normalizeText(entry.name).length > 0)?.name;
      const department = normalizeText(category ?? row.category?.[0]) || undefined;
      const workSchedule = firstTag(row.tags1);
      // `tags2` carries the contract type ("Permanent contract"); `employment_type`
      // is the coarse enum ("FULL_TIME"). Prefer the human-readable one.
      const employmentType = firstTag(row.tags2);
      const businessUnit = firstTag(row.tags3);

      const locationText =
        normalizeText(row.short_location) || normalizeText(row.city) || normalizeText(row.country) || undefined;

      const url = lang
        ? `${endpoint.origin}/careers-home/jobs/${id}?lang=${lang}`
        : `${endpoint.origin}/careers-home/jobs/${id}`;

      const description = row.description ? stripHtmlToText(row.description) : '';
      const publishedAt = fromOffsetIso(row.posted_date) ?? fromOffsetIso(row.create_date) ?? nowIso;

      jobs.push({
        source: 'COMPANY_WEBSITE',
        externalId: id,
        title,
        url,
        applyUrl: normalizeText(row.apply_url) || url,
        publishedAt,
        ...(locationText ? { location: locationText } : {}),
        ...(ctx.config.companyName ? { companyName: String(ctx.config.companyName) } : {}),
        ...(ctx.config.companyDomain ? { companyDomain: String(ctx.config.companyDomain) } : {}),
        ...(department ? { department } : {}),
        ...(workSchedule ? { workSchedule } : {}),
        ...(employmentType ? { employmentType } : {}),
        ...(description ? { description } : {}),
        topMetadata: {
          ...(department ? { department } : {}),
          ...(workSchedule ? { workSchedule } : {}),
          ...(employmentType ? { employmentType } : {}),
          ...(businessUnit ? { jobFunction: businessUnit } : {}),
          ...(normalizeText(row.country) ? { country: normalizeText(row.country) } : {}),
        },
      });
    }

    return { jobs, errors };
  }
}
