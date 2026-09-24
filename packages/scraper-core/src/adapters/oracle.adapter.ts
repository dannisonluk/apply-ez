/**
 * Oracle Recruiting Cloud (Oracle HCM) adapter.
 *
 * Built for CLP, but Oracle Recruiting Cloud powers a lot of large employers, so
 * it is keyed by platform: point a target at it with the right `siteNumber` and it
 * works.
 *
 *   GET {origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *        ?onlyData=true
 *        &expand=requisitionList.secondaryLocations
 *        &finder=findReqs;siteNumber={site},facetsList={facets},limit={n},offset={o},sortBy=POSTING_DATES_DESC
 *
 * ## The two silent failures this adapter is written around
 *
 * 1. **`expand=requisitionList.secondaryLocations` is mandatory.** Without it the
 *    response is HTTP 200 with a complete-looking envelope — `count`, `limit`,
 *    `TotalJobsCount` — and no `requisitionList` key at all. Measured on CLP:
 *    `TotalJobsCount: 39` with zero rows returned. A reader that only checks the
 *    status code sees an empty board and reports a successful crawl. `assertRows`
 *    below turns that into a reported error.
 *
 * 2. **The response's `limit` field is not an echo of the request.** It reads 200
 *    whatever was asked for, so it must never be used to decide whether another
 *    page exists. `TotalJobsCount` and the length of `requisitionList` are the
 *    honest signals, and they are what this adapter uses.
 *
 * ## The listing carries no description; the detail resource does
 *
 * CLP's listing carries a title, a posted date and a location, and nothing else:
 * `ShortDescriptionStr`, `ExternalQualificationsStr`, `ExternalResponsibilitiesStr`,
 * `Department`, `JobFamily` and `PostingEndDate` are empty on every posting. So the
 * body has to come from the detail resource.
 *
 * **The finder name is `ById`, not `jobRequisitionDetails`.** This adapter previously
 * tried `finder=jobRequisitionDetails;requisitionId={id}` — which answers
 * `400 URL request parameter finder with value … is not valid` — and concluded, in
 * this comment, that the resource was unreachable from this tenant. It is reachable;
 * the name was wrong. A Candidate Experience job page fetches its own body with:
 *
 *   recruitingCEJobRequisitionDetails?expand=all&onlyData=true
 *     &finder=ById;Id="230",siteNumber=CX_1
 *
 * That name appears in no documentation and in no static HTML — the page is a 4 KB
 * shell and the request only exists at runtime — so it was found by loading a job
 * page in a browser and reading what it asks for. The cost of the wrong conclusion
 * was 43 postings stored with no description.
 *
 * ## `siteNumber` must be configured, never guessed
 *
 * It is not in the careers URL (CLP's URL says `CLP-Recruitment-System`, the API
 * wants `CX_1`) — it is only discoverable in the page's own JavaScript. A wrong
 * value returns a DIFFERENT site's postings with a 200, so this adapter refuses to
 * run without one rather than picking a default.
 */
import type { RawJob, ScrapeContext, ScrapeResult, ScraperAdapter } from './adapter.interface.js';
import { readPositiveInt } from '../lib/concurrency.js';
import { normalizeText, stripHtmlToText } from '../lib/text.js';
import { parseHongKongDateTime } from '../lib/hk-time.js';
import { fetchJson } from '../lib/http-json.js';
import { FailureCircuit } from '../lib/circuit.js';
import { canSkipDetail } from './adapter.interface.js';

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_JOBS = 300;
const DEFAULT_DETAIL_MAX_JOBS = 400;
const DETAIL_CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 30_000;
/** Safety net: a `TotalJobsCount` that never converges must not loop forever. */
const MAX_PAGES = 20;

/** One entry of `items[0].requisitionList`. Everything but these is empty on CLP. */
interface OracleRequisition {
  Id?: string | number;
  Title?: string;
  PostedDate?: string;
  PostingEndDate?: string | null;
  PrimaryLocation?: string;
  PrimaryLocationCountry?: string;
  ShortDescriptionStr?: string | null;
  ExternalQualificationsStr?: string | null;
  ExternalResponsibilitiesStr?: string | null;
  Department?: string | null;
  JobFamily?: string | null;
  JobFunction?: string | null;
  WorkerType?: string | null;
  WorkplaceType?: string | null;
}

/** `items[0]` of the detail resource. Only the body fields are read. */
interface OracleDetail {
  Id?: string | number;
  ExternalDescriptionStr?: string | null;
  ExternalQualificationsStr?: string | null;
  ExternalResponsibilitiesStr?: string | null;
}

interface OracleSearchItem {
  TotalJobsCount?: number;
  requisitionList?: OracleRequisition[];
  SiteNumber?: string;
}

interface OracleSearchResponse {
  items?: OracleSearchItem[];
  count?: number;
  hasMore?: boolean;
}

export interface OracleEndpoint {
  /** Base of the requisitions resource, without a trailing slash. */
  apiBase: string;
  origin: string;
  /** `en`, `zh-HK`, … — taken from the CandidateExperience path segment. */
  locale: string;
  /** The site slug from the URL, used to build a human-facing job link. */
  siteSlug?: string;
}

/**
 * Derive the API base and the job-link shape from the careers URL.
 *
 * CLP's is
 * `https://iabhtj.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CLP-Recruitment-System/jobs`.
 */
export function parseOracleUrl(rawUrl: string): OracleEndpoint | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  if (!/\/hcmUI\/CandidateExperience\//i.test(url.pathname)) return undefined;

  const locale = /\/CandidateExperience\/([^/]+)/i.exec(url.pathname)?.[1];
  const siteSlug = /\/sites\/([^/]+)/i.exec(url.pathname)?.[1];

  return {
    apiBase: `${url.origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`,
    origin: url.origin,
    locale: locale ?? 'en',
    ...(siteSlug ? { siteSlug } : {}),
  };
}

/**
 * A `siteNumber` is interpolated into the `finder` query value, where the
 * delimiters are `;` and `,`. Restricting it to word characters means it cannot
 * inject an extra finder parameter — e.g. a second `siteNumber`, which Oracle
 * resolves by taking one of them.
 */
export function isValidSiteNumber(value: string): boolean {
  return /^[A-Za-z0-9_]{1,40}$/.test(value);
}

/** Build the human-facing job page URL. */
/**
 * The single-requisition endpoint that carries the posting body.
 *
 * `expand=all` is mandatory here too: without it the body fields come back absent
 * rather than empty. The finder value keeps its literal `;` and `,` — they are that
 * grammar's own delimiters — while the id is percent-quoted, which is what the
 * Candidate Experience page sends.
 */
export function buildDetailUrl(apiBase: string, siteNumber: string, id: string): string {
  // Swapped off the LISTING base rather than built from `endpoint.origin`, and after
  // `ctx.config.apiBase` has been applied. Building it from the origin meant the
  // checks reached the live tenant while the listing reached the mock server — real
  // network calls inside a unit test, which is how this was noticed.
  const base = apiBase.replace(
    /\/recruitingCEJobRequisitions$/,
    '/recruitingCEJobRequisitionDetails',
  );
  const finder = `ById;Id=%22${encodeURIComponent(id)}%22,siteNumber=${encodeURIComponent(siteNumber)}`;
  return `${base}?expand=all&onlyData=true&finder=${finder}`;
}

export function buildJobUrl(endpoint: OracleEndpoint, id: string): string {
  if (!endpoint.siteSlug) return `${endpoint.origin}/hcmUI/CandidateExperience/${endpoint.locale}/jobs`;
  return `${endpoint.origin}/hcmUI/CandidateExperience/${endpoint.locale}/sites/${endpoint.siteSlug}/job/${id}`;
}

// HTTP for this adapter goes through `lib/http-json.ts`, which wraps every request
// in `throttledFetch` (robots.txt verdict + declared crawl-delay + per-host pacing)
// and `withRetry`. Nothing here may call bare `fetch`: that is what got the HSBC
// run blocked.

export class OracleAdapter implements ScraperAdapter {
  readonly name = 'oracle';

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const entryUrls = ctx.entryUrls ?? [];
    if (entryUrls.length === 0) {
      return { jobs: [], errors: [{ message: 'oracle adapter needs at least one entryUrl' }] };
    }

    const endpoint = parseOracleUrl(entryUrls[0] ?? '');
    if (!endpoint) {
      return {
        jobs: [],
        errors: [{ message: `not a recognised Oracle CandidateExperience URL: ${entryUrls[0] ?? ''}` }],
      };
    }

    const siteNumber = typeof ctx.config.siteNumber === 'string' ? ctx.config.siteNumber.trim() : '';
    if (!siteNumber) {
      return {
        jobs: [],
        errors: [
          {
            message:
              'oracle adapter needs config.siteNumber (e.g. "CX_1"). It is not in the careers URL — ' +
              'find it in the site page source, as `siteNumber=…`. A wrong value returns another ' +
              "site's postings with a 200, so it is never guessed.",
          },
        ],
      };
    }
    if (!isValidSiteNumber(siteNumber)) {
      return {
        jobs: [],
        errors: [{ message: `oracle: refusing a siteNumber with unexpected characters: ${siteNumber}` }],
      };
    }

    const override = (value: unknown, fallback: string): string =>
      typeof value === 'string' && value.length > 0 ? value.replace(/\/+$/, '') : fallback;

    const apiBase = override(ctx.config.apiBase, endpoint.apiBase);
    const pageLimit = readPositiveInt(ctx.config.pageLimit, DEFAULT_PAGE_LIMIT);
    const maxJobs = readPositiveInt(ctx.config.maxJobs, DEFAULT_MAX_JOBS);
    const facets = typeof ctx.config.facetsList === 'string' ? ctx.config.facetsList : 'LOCATIONS';
    const languageCode =
      typeof ctx.config.languageCode === 'string' ? ctx.config.languageCode : 'US';

    // Built as a literal rather than with URLSearchParams: the finder VALUE uses
    // `;` and `,` as its own delimiters, and URLSearchParams would percent-encode
    // them into something that is no longer that grammar. Every interpolated part
    // is validated above or comes from typed config.
    //
    // Note on the evidence: probes that looked like "Oracle rejects encoded
    // delimiters" were all also missing `expand`, so the encoding is the likely
    // but unproven cause. Keeping the delimiters literal is correct either way and
    // makes the request shape readable; it is not a claim that encoding breaks it.
    const buildUrl = (offset: number): string =>
      `${apiBase}?onlyData=true` +
      `&expand=requisitionList.secondaryLocations` +
      `&finder=findReqs;siteNumber=${siteNumber},facetsList=${facets}` +
      `,limit=${pageLimit},offset=${offset},sortBy=POSTING_DATES_DESC`;

    ctx.logger.info('oracle: listing', {
      origin: endpoint.origin,
      siteNumber,
      pageLimit,
      maxJobs,
      facets,
    });

    const collected: OracleRequisition[] = [];
    const seenIds = new Set<string>();
    let total = 0;
    let offset = 0;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      let detail = '';
      const payload = await fetchJson<OracleSearchResponse>(buildUrl(offset), {
        timeoutMs: REQUEST_TIMEOUT_MS,
        onFailure: (reason) => {
          detail = reason;
        },
      });

      if (!payload) {
        errors.push({
          message: `oracle: listing page failed at offset=${offset}`,
          context: { detail: detail || 'no response', siteNumber, origin: endpoint.origin },
        });
        break;
      }

      const item = payload.items?.[0];
      const rows = item?.requisitionList ?? [];
      if (typeof item?.TotalJobsCount === 'number' && item.TotalJobsCount > 0) {
        total = item.TotalJobsCount;
      }

      if (rows.length === 0) {
        // The expand trap, and the only case where an empty page is NOT the end of
        // the board. Reporting it as "done" is exactly the silent failure this
        // adapter exists to prevent.
        if (total > 0) {
          errors.push({
            message:
              `oracle: the API reports ${total} postings but returned no rows — ` +
              'the `expand=requisitionList.secondaryLocations` parameter is missing or no longer honoured',
            context: { siteNumber, offset, total },
          });
        }
        break;
      }

      let added = 0;
      for (const row of rows) {
        const id = row.Id === undefined ? '' : String(row.Id);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        collected.push(row);
        added += 1;
      }

      ctx.logger.info('oracle: page done', {
        page: page + 1,
        offset,
        returned: rows.length,
        collected: collected.length,
        reportedTotal: total,
      });

      if (added === 0) break;
      offset += rows.length;
      if (total > 0 && offset >= total) break;
      if (collected.length >= maxJobs) break;
    }

    ctx.logger.info('oracle: listed', { collected: collected.length, reportedTotal: total });

    // ── detail stage ──────────────────────────────────────────────────────────
    // The listing has no body at all, so this is the only source of the description.
    // It is also the only place `ExternalQualificationsStr` and
    // `ExternalResponsibilitiesStr` are populated, which is where the section
    // headings come from.
    const includeDetail = ctx.config.includeDetailPages !== false;
    const detailMaxJobs = readPositiveInt(ctx.config.maxDetailJobs, DEFAULT_DETAIL_MAX_JOBS);
    const details = new Map<string, OracleDetail>();

    if (includeDetail) {
      // Same reasoning as the other adapters: once the host starts refusing detail
      // requests, the rest of the batch is waste and every extra request extends the
      // refusal.
      const circuit = new FailureCircuit();

      const pending = collected
        .slice(0, maxJobs)
        .map((row) => (row.Id === undefined ? '' : String(row.Id)))
        // A posting already stored already carries its body, and `cli.ts` drops known
        // postings from the upsert anyway — so its detail page is pure waste.
        .filter((id) => id && !canSkipDetail(ctx, id))
        .slice(0, detailMaxJobs);

      const queue = [...pending];
      const workers = Array.from({ length: Math.min(DETAIL_CONCURRENCY, queue.length) }, async () => {
        for (;;) {
          const id = queue.shift();
          if (!id || circuit.isOpen) return;

          let reason = '';
          const payload = await fetchJson<{ items?: OracleDetail[] }>(
            buildDetailUrl(apiBase, siteNumber, id),
            { timeoutMs: REQUEST_TIMEOUT_MS, onFailure: (why) => { reason = why; } },
          );

          const item = payload?.items?.[0];
          if (item) {
            details.set(id, item);
            circuit.recordSuccess();
          } else {
            circuit.recordFailure();
            errors.push({
              message: `oracle: detail failed for id=${id}`,
              context: { detail: reason || 'no item in response', siteNumber },
            });
          }
        }
      });

      await Promise.all(workers);

      ctx.logger.info('oracle: detail stage', {
        requested: pending.length,
        fetched: details.size,
        ...(circuit.isOpen ? { aborted: circuit.describe() } : {}),
      });
    }

    // ── map to RawJob ─────────────────────────────────────────────────────────
    const nowIso = new Date().toISOString();
    const jobs: RawJob[] = [];

    for (const row of collected.slice(0, maxJobs)) {
      const id = row.Id === undefined ? '' : String(row.Id);
      const title = normalizeText(row.Title);
      if (!id || !title) continue;

      const url = buildJobUrl(endpoint, id);
      const location =
        normalizeText(row.PrimaryLocation) || normalizeText(row.PrimaryLocationCountry) || undefined;

      // `PostedDate` is `YYYY-MM-DD`, a posting date — NOT a deadline. Oracle
      // returns it in `PostingEndDate` when the tenant sets one, and CLP does not,
      // so nothing here is promoted to `applicationDeadline`.
      const publishedAt = parseHongKongDateTime(row.PostedDate, new Date()) ?? nowIso;

      // Assembled in the order a reader expects, and joined with newlines so the
      // section parser can tell where one block ends and the next begins. The
      // listing's own fields are empty, so this is the only content there is.
      const detailRow = details.get(id);
      // The detail body is HTML (`<p>`, `<ul><li>`, `&nbsp;`). It has to be
      // converted here rather than downstream: the section parser works on text, and
      // without this the detail page renders the markup verbatim — which is exactly
      // what it did the first time these fields were wired up.
      const description = [
        detailRow?.ExternalDescriptionStr,
        detailRow?.ExternalResponsibilitiesStr,
        detailRow?.ExternalQualificationsStr,
      ]
        .map((part) => (typeof part === 'string' ? stripHtmlToText(part) : ''))
        .filter((part) => part.length > 0)
        .join('\n');

      jobs.push({
        source: 'COMPANY_WEBSITE',
        externalId: id,
        title,
        url,
        applyUrl: url,
        publishedAt,
        ...(location ? { location } : {}),
        ...(ctx.config.companyName ? { companyName: String(ctx.config.companyName) } : {}),
        ...(ctx.config.companyDomain ? { companyDomain: String(ctx.config.companyDomain) } : {}),
        ...(row.Department ? { department: normalizeText(row.Department) } : {}),
        ...(row.WorkerType ? { rawEmploymentType: normalizeText(row.WorkerType) } : {}),
        ...(description ? { description } : {}),
        topMetadata: {},
      });
    }

    // `languageCode` is accepted by Oracle but is not needed for the fields we
    // read. Referenced so the config key is documented and cannot rot silently.
    void languageCode;

    return { jobs, errors };
  }
}
