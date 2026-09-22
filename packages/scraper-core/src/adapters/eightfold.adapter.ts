/**
 * Eightfold adapter — reads the public `/api/apply/v2/jobs` JSON API.
 *
 * Built for HSBC, but Eightfold powers a lot of large-company career sites, so it
 * is keyed by platform rather than by company: point a target at it with the right
 * `domain` and it works.
 *
 *   GET {origin}/api/apply/v2/jobs?domain={domain}&location={loc}&hl={hl}&start=N&num=M
 *   GET {origin}/api/apply/v2/jobs/{id}?domain={domain}&hl={hl}
 *
 * The listing and detail responses carry DIFFERENT fields, which is the thing to
 * know about this API:
 *
 *   - the listing returns `job_description: ""` — the description is genuinely
 *     absent, not empty-by-accident, so a detail fetch is mandatory;
 *   - the detail returns `apply_redirect_url`, which points at the ATS behind the
 *     careers site (SuccessFactors for HSBC). That is the URL the apply flow will
 *     eventually need, and the listing never exposes it.
 *
 * Pagination is well-behaved here: past the last page it returns an empty
 * `positions` array, so — unlike Workday — an empty batch is a usable stop signal.
 */
import type { RawJob, ScrapeContext, ScrapeResult, ScraperAdapter } from './adapter.interface.js';
import { FailureCircuit } from '../lib/circuit.js';
import { mapWithConcurrency, readPositiveInt } from '../lib/concurrency.js';
import { normalizeText, stripHtmlToText } from '../lib/text.js';
import { parseHongKongDateTime } from '../lib/hk-time.js';
import { fetchJson } from '../lib/http-json.js';

const DEFAULT_NUM = 20;
const DEFAULT_MAX_JOBS = 500;
const DEFAULT_DETAIL_MAX_JOBS = 400;
const DEFAULT_DETAIL_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 30_000;
/** Safety net: `count` could in principle be wrong, so cap the page loop too. */
const MAX_PAGES = 60;

interface EightfoldPosition {
  id?: number | string;
  name?: string;
  posting_name?: string;
  location?: string;
  locations?: string[];
  department?: string;
  business_unit?: string;
  t_create?: number;
  t_update?: number;
  ats_job_id?: string;
  display_job_id?: string;
  type?: string;
  job_description?: string;
  canonicalPositionUrl?: string;
  apply_redirect_url?: string;
  work_location_option?: string | null;
  location_flexibility?: string | null;
}

interface EightfoldListResponse {
  count?: number;
  positions?: EightfoldPosition[];
}

/** `t_create` / `t_update` are Unix SECONDS, not milliseconds. */
export function fromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  // Guard against a tenant that one day sends milliseconds: anything past ~year
  // 5138 in seconds is implausible for a posting date, so treat it as millis.
  const millis = value > 1e12 ? value : value * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export interface EightfoldEndpoint {
  /** Base of the jobs API, without a trailing slash. */
  apiBase: string;
  domain: string;
  location?: string;
  hl: string;
}

/**
 * Derive the API endpoint from the careers URL the target already carries.
 *
 * The filter lives in that URL's query string, so `?location=Hong+Kong&hl=en`
 * becomes the API filter without being repeated in config — one place to change.
 */
export function parseEightfoldUrl(rawUrl: string, fallbackDomain?: string): EightfoldEndpoint | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  const domain = url.searchParams.get('domain') ?? fallbackDomain;
  if (!domain) return undefined;

  const location = url.searchParams.get('location') ?? undefined;
  const hl = url.searchParams.get('hl') ?? 'en';

  return {
    apiBase: `${url.origin}/api/apply/v2/jobs`,
    domain,
    ...(location ? { location } : {}),
    hl,
  };
}

// HTTP for this adapter goes through `lib/http-json.ts`, which wraps every request
// in `throttledFetch` (robots.txt verdict + declared crawl-delay + per-host pacing)
// and `withRetry`. The local `fetchJson` that used to sit here called bare `fetch`
// and bypassed all of it — measured: 247 listing + 247 detail requests in about
// two minutes got this host to answer 403 to everything, including robots.txt.

export class EightfoldAdapter implements ScraperAdapter {
  readonly name = 'eightfold';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const entryUrls = ctx.entryUrls ?? [];
    if (entryUrls.length === 0) {
      return { jobs: [], errors: [{ message: 'eightfold adapter needs at least one entryUrl' }] };
    }

    const fallbackDomain =
      typeof ctx.config.companyDomain === 'string' ? ctx.config.companyDomain : undefined;
    const endpoint = parseEightfoldUrl(entryUrls[0] ?? '', fallbackDomain);
    if (!endpoint) {
      return {
        jobs: [],
        errors: [{ message: `not a recognised Eightfold URL: ${entryUrls[0] ?? ''}` }],
      };
    }

    // Override hook, also used by `check-eightfold.ts` to point at a local mock.
    const apiBase =
      typeof ctx.config.apiBase === 'string' && ctx.config.apiBase.length > 0
        ? ctx.config.apiBase.replace(/\/+$/, '')
        : endpoint.apiBase;

    const num = readPositiveInt(ctx.config.num, DEFAULT_NUM);
    const maxJobs = readPositiveInt(ctx.config.maxJobs, DEFAULT_MAX_JOBS);

    const listQuery = (start: number): string => {
      const params = new URLSearchParams({
        domain: endpoint.domain,
        hl: endpoint.hl,
        start: String(start),
        num: String(num),
      });
      if (endpoint.location) params.set('location', endpoint.location);
      return `${apiBase}?${params.toString()}`;
    };

    ctx.logger.info('eightfold: listing', {
      domain: endpoint.domain,
      location: endpoint.location ?? '(none)',
      hl: endpoint.hl,
      num,
      maxJobs,
    });

    const positions: EightfoldPosition[] = [];
    const seenIds = new Set<string>();
    let count = 0;
    let start = 0;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const payload = await fetchJson<EightfoldListResponse>(listQuery(start), {
        timeoutMs: REQUEST_TIMEOUT_MS,
        onFailure: (detail) => {
          errors.push({
            message: `eightfold: listing page failed at start=${start}`,
            context: { detail, domain: endpoint.domain, location: endpoint.location },
          });
        },
      });

      if (!payload) break;

      if (typeof payload.count === 'number' && payload.count > 0) count = payload.count;
      const batch = payload.positions ?? [];
      // Unlike Workday, an empty batch here genuinely means "past the end".
      if (batch.length === 0) break;

      let added = 0;
      for (const position of batch) {
        const id = String(position.id ?? position.display_job_id ?? position.ats_job_id ?? '');
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        positions.push(position);
        added += 1;
      }

      ctx.logger.info('eightfold: page done', {
        page: page + 1,
        collected: positions.length,
        reportedCount: count,
      });

      if (added === 0) break;
      if (positions.length >= maxJobs) break;

      // Advance by what actually came back, not by the requested `num`: the
      // server is free to cap the page size, and assuming otherwise would skip
      // postings silently.
      start += batch.length;
      if (count > 0 && start >= count) break;
    }

    ctx.logger.info('eightfold: listed', { collected: positions.length, reportedCount: count });

    const capped = positions.slice(0, maxJobs);

    // ── detail stage ──────────────────────────────────────────────────────────
    // Mandatory for this API: the listing has no description and no apply URL.
    const includeDetail = ctx.config.includeDetailPages !== false;
    const detailMaxJobs = readPositiveInt(ctx.config.maxDetailJobs, DEFAULT_DETAIL_MAX_JOBS);
    const detailConcurrency = readPositiveInt(
      ctx.config.detailConcurrency ?? process.env.EIGHTFOLD_DETAIL_CONCURRENCY,
      DEFAULT_DETAIL_CONCURRENCY,
    );

    const details = new Map<string, EightfoldPosition>();
    if (includeDetail && capped.length > 0) {
      const targets = capped.slice(0, detailMaxJobs);
      // Once the host starts refusing detail requests, the rest of the batch is
      // pure waste and every extra request extends the refusal. This is the exact
      // shape of the measured HSBC failure: a 403 that turned into a block. See
      // `lib/circuit.ts`.
      const circuit = new FailureCircuit();

      const fetchDetail = async (position: EightfoldPosition): Promise<boolean> => {
        const id = String(position.id ?? '');
        if (!id) return true;
        const params = new URLSearchParams({ domain: endpoint.domain, hl: endpoint.hl });
        const payload = await fetchJson<EightfoldPosition>(`${apiBase}/${id}?${params.toString()}`, {
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (!payload) return false;
        details.set(id, payload);
        return true;
      };

      const failedIds = new Set<string>();
      await mapWithConcurrency(
        targets,
        detailConcurrency,
        async (position) => {
          if (await fetchDetail(position)) {
            circuit.recordSuccess();
            return;
          }
          circuit.recordFailure();
          failedIds.add(String(position.id ?? ''));
        },
        () => circuit.isOpen,
      );

      // One retry pass over just the failures. HSBC's API intermittently drops
      // roughly 4% of detail requests under concurrency — measured, not assumed:
      // one run came back 237/247 descriptions and the next 247/247. A posting
      // with no description loses its LLM summary and scores neutral relevance,
      // so it is worth one cheap second attempt before reporting a partial run.
      //
      // Skipped entirely once the circuit is open: a host refusing everything is
      // not having a bad moment, and the retry pass would double the load against
      // the thing that just decided to refuse us.
      if (failedIds.size > 0 && !circuit.isOpen) {
        const retryTargets = targets.filter((position) => failedIds.has(String(position.id ?? '')));
        ctx.logger.info('eightfold: retrying failed details', { count: retryTargets.length });
        await mapWithConcurrency(retryTargets, Math.max(1, Math.floor(detailConcurrency / 2)), async (position) => {
          if (!(await fetchDetail(position))) return;
          failedIds.delete(String(position.id ?? ''));
        });
      }

      ctx.logger.info('eightfold: detail stage', {
        attempted: targets.length,
        enriched: details.size,
        failed: failedIds.size,
        skipped: capped.length - targets.length,
        aborted: circuit.isOpen,
      });

      // Surface what is still missing after the retry. A silent 10/247 miss
      // quietly degrades the whole downstream pipeline while the run still
      // reports success.
      if (failedIds.size > 0) {
        errors.push({
          // When the circuit tripped, `failedIds.size` is NOT the whole story —
          // most postings were never attempted at all. Reporting "8/247 failed"
          // there would read like a near-complete crawl.
          message: circuit.isOpen
            ? `eightfold: detail stage aborted after ${circuit.describe()} — the host is refusing detail requests`
            : `eightfold: detail stage incomplete — ${failedIds.size}/${targets.length} postings failed`,
          context: {
            failed: failedIds.size,
            attempted: targets.length,
            aborted: circuit.isOpen,
            domain: endpoint.domain,
          },
        });
      }
    }

    // ── map to RawJob ─────────────────────────────────────────────────────────
    const nowIso = new Date().toISOString();
    const jobs: RawJob[] = [];

    for (const position of capped) {
      const id = String(position.id ?? position.display_job_id ?? position.ats_job_id ?? '');
      if (!id) continue;
      const detail = details.get(id) ?? position;

      const title = normalizeText(detail.name ?? detail.posting_name ?? position.name);
      if (!title) continue;

      const url =
        normalizeText(position.canonicalPositionUrl) || `https://${endpoint.domain}/careers/job/${id}`;
      const applyUrl = normalizeText(detail.apply_redirect_url) || url;

      const location = normalizeText(detail.location ?? position.location) || undefined;
      const department = normalizeText(detail.department ?? position.department) || undefined;
      const businessUnit = normalizeText(detail.business_unit ?? position.business_unit) || undefined;

      const publishedAt =
        fromUnixSeconds(position.t_create) ??
        parseHongKongDateTime(position.t_create, new Date()) ??
        nowIso;

      const descriptionHtml = detail.job_description ?? '';
      const description = descriptionHtml ? stripHtmlToText(descriptionHtml) : '';

      // `work_location_option` is the only remote signal this API exposes; it is
      // null on most HSBC postings, so it stays conditional.
      const workLocation = normalizeText(detail.work_location_option) || undefined;
      const remote = workLocation ? /remote/i.test(workLocation) : undefined;

      jobs.push({
        source: 'COMPANY_WEBSITE',
        externalId: id,
        title,
        url,
        applyUrl,
        publishedAt,
        ...(location ? { location } : {}),
        ...(ctx.config.companyName ? { companyName: String(ctx.config.companyName) } : {}),
        ...(ctx.config.companyDomain ? { companyDomain: String(ctx.config.companyDomain) } : {}),
        ...(department ? { department } : {}),
        ...(workLocation ? { workSchedule: workLocation } : {}),
        ...(remote === undefined ? {} : { remote }),
        ...(description ? { description } : {}),
        topMetadata: {
          ...(department ? { department } : {}),
          ...(businessUnit ? { jobFunction: businessUnit } : {}),
          ...(workLocation ? { workSchedule: workLocation } : {}),
        },
      });
    }

    return { jobs, errors };
  }
}
