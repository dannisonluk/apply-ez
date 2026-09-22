/**
 * Eightfold adapter — reads a tenant's public job API.
 *
 * Built for HSBC, but Eightfold powers a lot of large-company career sites, so it
 * is keyed by platform rather than by company: point a target at it with the right
 * `domain` and it works.
 *
 * ## Two listing APIs, one detail API
 *
 * Eightfold tenants are migrating from the original listing endpoint to a newer
 * one, and a tenant runs one or the other:
 *
 *   apply-v2   GET {origin}/api/apply/v2/jobs?domain={d}&location={loc}&hl={hl}&start=N&num=M
 *   pcsx       GET {origin}/api/pcsx/search?domain={d}&start=N&filter_country={c}&...
 *
 * The difference is not cosmetic. Measured on Morgan Stanley, which has migrated:
 * the apply-v2 listing answers `403 {"message":"Not authorized for PCSX"}` while
 * `/api/pcsx/search` answers 200 — and that 403 is a perfectly healthy answer from
 * the tenant's point of view, not a block. `listingApi: 'auto'` (the default) tries
 * apply-v2 first and switches on exactly that signal, so a tenant can migrate
 * without anyone editing config. Note the two APIs disagree about page size as
 * well: PCSX ignores `num` and returns a fixed page of 10, which is why pagination
 * below advances by what actually came back rather than by what was asked for.
 *
 * The DETAIL endpoint is shared and unchanged — `GET {origin}/api/apply/v2/jobs/{id}`
 * — and even on a PCSX tenant that is where `job_description` and
 * `apply_redirect_url` live.
 *
 * ## Listing and detail carry different fields
 *
 *   - the listing has no description at all (`job_description: ""` on apply-v2,
 *     absent entirely on PCSX), so a detail fetch is mandatory;
 *   - the detail returns `apply_redirect_url`, which points at the ATS behind the
 *     careers site (SuccessFactors for HSBC, Workday for Morgan Stanley). That is
 *     the URL the apply flow will eventually need, and the listing never exposes it.
 *
 * Pagination is well-behaved on both: past the last page the listing returns an
 * empty array, so — unlike Workday — an empty batch is a usable stop signal.
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

/** Normalised across both listing APIs, so everything downstream has one shape. */
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

/** The apply-v2 listing shape. */
interface EightfoldListResponse {
  count?: number;
  positions?: EightfoldPosition[];
}

/** The PCSX listing shape. Note the `data` wrapper and the camelCase fields. */
interface PcsxPosition {
  id?: number | string;
  displayJobId?: string;
  name?: string;
  locations?: string[];
  standardizedLocations?: string[];
  postedTs?: number;
  creationTs?: number;
  department?: string;
  workLocationOption?: string | null;
  atsJobId?: string;
  positionUrl?: string;
}

interface PcsxListResponse {
  status?: number;
  error?: { message?: string; body?: string };
  data?: {
    positions?: PcsxPosition[];
    count?: number;
    appliedFilters?: Record<string, unknown>;
  };
}

export type EightfoldListingApi = 'apply-v2' | 'pcsx';

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
  /** Base of the apply-v2 listing API, and of the shared detail API. */
  apiBase: string;
  /** Base of the PCSX search API. */
  pcsxBase: string;
  /** Scheme + host, used to make PCSX's relative `positionUrl` absolute. */
  origin: string;
  domain: string;
  location?: string;
  hl: string;
  /** `filter_*` params from the entry URL, forwarded verbatim to PCSX. */
  filters: Record<string, string>;
}

/**
 * Derive the API endpoints from the careers URL the target already carries.
 *
 * The filter lives in that URL's query string, so `?location=Hong+Kong&hl=en`
 * becomes the API filter without being repeated in config — one place to change.
 * For a PCSX tenant the same idea applies to `filter_*`: Morgan Stanley's careers
 * URL carries `filter_country=Hong+Kong`, which is exactly the parameter
 * `/api/pcsx/search` wants, so it is forwarded rather than re-declared.
 *
 * Deliberately forwards ONLY `filter_*`. Those URLs also carry `start`, `pid` and
 * `source`; forwarding them would pin pagination to whatever page the human was
 * looking at and re-request a single position id.
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

  const filters: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key.startsWith('filter_')) filters[key] = value;
  }

  return {
    apiBase: `${url.origin}/api/apply/v2/jobs`,
    pcsxBase: `${url.origin}/api/pcsx/search`,
    origin: url.origin,
    domain,
    ...(location ? { location } : {}),
    hl,
    filters,
  };
}

/**
 * Map a PCSX listing item onto the normalised shape.
 *
 * The two listing APIs disagree on nearly every key name (`displayJobId` vs
 * `display_job_id`, `postedTs` vs `t_create`, `locations[]` vs `location`), so
 * they are reconciled here, at the boundary. Every branch below that reads a
 * listing item therefore has exactly one shape to handle. Exported for testing.
 */
export function fromPcsxPosition(raw: PcsxPosition, origin: string): EightfoldPosition {
  const location = raw.locations?.find((value) => typeof value === 'string' && value.trim().length > 0);
  const relative = typeof raw.positionUrl === 'string' ? raw.positionUrl.trim() : '';
  const canonical = relative
    ? relative.startsWith('http')
      ? relative
      : `${origin}${relative.startsWith('/') ? '' : '/'}${relative}`
    : undefined;

  return {
    ...(raw.id === undefined ? {} : { id: raw.id }),
    ...(raw.name ? { name: raw.name } : {}),
    ...(raw.displayJobId ? { display_job_id: raw.displayJobId } : {}),
    ...(raw.atsJobId ? { ats_job_id: raw.atsJobId } : {}),
    ...(location ? { location } : {}),
    ...(raw.locations ? { locations: raw.locations } : {}),
    ...(raw.department ? { department: raw.department } : {}),
    ...(typeof raw.postedTs === 'number' ? { t_create: raw.postedTs } : {}),
    ...(typeof raw.creationTs === 'number' ? { t_update: raw.creationTs } : {}),
    ...(canonical ? { canonicalPositionUrl: canonical } : {}),
    ...(raw.workLocationOption ? { work_location_option: raw.workLocationOption } : {}),
  };
}

/** One page of listings, normalised. */
interface ListingPage {
  positions: EightfoldPosition[];
  /** Items the server actually returned. Pagination must advance by THIS. */
  rawCount: number;
  /** The server's total, when it reports one. */
  count: number;
}

type ListingAttempt = { ok: true; page: ListingPage } | { ok: false; detail: string };

function resolveListingApi(value: unknown): EightfoldListingApi | 'auto' {
  return value === 'pcsx' || value === 'apply-v2' || value === 'auto' ? value : 'auto';
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

    // Override hooks, also used by `check-platform-adapters.ts` to point at a local
    // mock. `apiBase` covers the apply-v2 listing and the detail endpoint; the PCSX
    // listing needs its own base because it is a different path.
    const override = (value: unknown, fallback: string): string =>
      typeof value === 'string' && value.length > 0 ? value.replace(/\/+$/, '') : fallback;

    const apiBase = override(ctx.config.apiBase, endpoint.apiBase);
    const pcsxBase = override(ctx.config.pcsxBase, endpoint.pcsxBase);

    const num = readPositiveInt(ctx.config.num, DEFAULT_NUM);
    const maxJobs = readPositiveInt(ctx.config.maxJobs, DEFAULT_MAX_JOBS);
    const configuredApi = resolveListingApi(ctx.config.listingApi);
    let listingApi: EightfoldListingApi = configuredApi === 'pcsx' ? 'pcsx' : 'apply-v2';

    const fetchListingPage = async (start: number): Promise<ListingAttempt> => {
      if (listingApi === 'pcsx') {
        const params = new URLSearchParams({ domain: endpoint.domain, start: String(start) });
        for (const [key, value] of Object.entries(endpoint.filters)) params.set(key, value);
        let detail = '';
        const payload = await fetchJson<PcsxListResponse>(`${pcsxBase}?${params.toString()}`, {
          timeoutMs: REQUEST_TIMEOUT_MS,
          onFailure: (reason) => {
            detail = reason;
          },
        });
        if (!payload) return { ok: false, detail: detail || 'no response' };

        const raw = payload.data?.positions ?? [];
        return {
          ok: true,
          page: {
            positions: raw.map((item) => fromPcsxPosition(item, endpoint.origin)),
            rawCount: raw.length,
            count: typeof payload.data?.count === 'number' ? payload.data.count : 0,
          },
        };
      }

      const params = new URLSearchParams({
        domain: endpoint.domain,
        hl: endpoint.hl,
        start: String(start),
        num: String(num),
      });
      if (endpoint.location) params.set('location', endpoint.location);

      let detail = '';
      const payload = await fetchJson<EightfoldListResponse>(`${apiBase}?${params.toString()}`, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        onFailure: (reason) => {
          detail = reason;
        },
      });
      if (!payload) return { ok: false, detail: detail || 'no response' };

      const raw = payload.positions ?? [];
      return {
        ok: true,
        page: {
          positions: raw,
          rawCount: raw.length,
          count: typeof payload.count === 'number' ? payload.count : 0,
        },
      };
    };

    ctx.logger.info('eightfold: listing', {
      domain: endpoint.domain,
      api: listingApi,
      filters: Object.keys(endpoint.filters),
      location: endpoint.location ?? '(none)',
      hl: endpoint.hl,
      num,
      maxJobs,
    });

    // First page, and the one place the PCSX switch can happen. A migrated tenant
    // answers apply-v2 with `403 {"message":"Not authorized for PCSX"}` — that is a
    // routing answer, not a refusal, so it must not be reported as a failed crawl.
    let first = await fetchListingPage(0);
    if (!first.ok && configuredApi === 'auto' && /not authorized for pcsx/i.test(first.detail)) {
      ctx.logger.info('eightfold: tenant has migrated to the PCSX listing API, switching', {
        from: listingApi,
        domain: endpoint.domain,
      });
      listingApi = 'pcsx';
      first = await fetchListingPage(0);
    }

    const positions: EightfoldPosition[] = [];
    const seenIds = new Set<string>();
    let count = 0;
    let start = 0;

    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const attempt = pageNumber === 0 ? first : await fetchListingPage(start);
      if (!attempt.ok) {
        errors.push({
          message: `eightfold: listing page failed at start=${start}`,
          context: { detail: attempt.detail, domain: endpoint.domain, api: listingApi },
        });
        break;
      }

      const { positions: batch, rawCount } = attempt.page;
      if (attempt.page.count > 0) count = attempt.page.count;
      // Unlike Workday, an empty batch here genuinely means "past the end".
      if (rawCount === 0) break;

      let added = 0;
      for (const position of batch) {
        const id = String(position.id ?? position.display_job_id ?? position.ats_job_id ?? '');
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        positions.push(position);
        added += 1;
      }

      ctx.logger.info('eightfold: page done', {
        page: pageNumber + 1,
        api: listingApi,
        collected: positions.length,
        reportedCount: count,
      });

      if (added === 0) break;
      if (positions.length >= maxJobs) break;

      // Advance by what actually came back, not by the requested `num`: the
      // server is free to cap the page size (PCSX caps it at 10 and ignores `num`
      // entirely), and assuming otherwise would skip postings silently.
      start += rawCount;
      if (count > 0 && start >= count) break;
    }

    ctx.logger.info('eightfold: listed', {
      collected: positions.length,
      reportedCount: count,
      api: listingApi,
    });

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

      // Fall back to the careers HOST, not the corporate domain: `origin` is the
      // site that actually serves the posting.
      const url = normalizeText(position.canonicalPositionUrl) || `${endpoint.origin}/careers/job/${id}`;
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
      // null on most postings, so it stays conditional.
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
