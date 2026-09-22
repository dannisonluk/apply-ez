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
 * ## Listing only — and what that costs
 *
 * CLP's listing carries a title, a posted date and a location, and nothing else:
 * `ShortDescriptionStr`, `ExternalQualificationsStr`, `ExternalResponsibilitiesStr`,
 * `Department`, `JobFamily` and `PostingEndDate` are empty on all 39 postings.
 *
 * There is a detail resource, but its finder is not reachable from this tenant —
 * `recruitingCEJobRequisitionDetails?finder=jobRequisitionDetails;requisitionId={id},siteNumber={site}`
 * answers `400 URL request parameter finder with value … is not valid`, with or
 * without `expand=all` and `languageCode`, and the single-resource form
 * (`recruitingCEJobRequisitions/{id}`) 404s. So these postings land with no
 * description. Consequences, stated so they are not mistaken for bugs later:
 *
 *   - the LLM enrichment layer skips them (`OPENROUTER_MIN_DESCRIPTION_CHARS`), so
 *     they show title / company / location only, with no summary;
 *   - relevance scoring is unaffected — it reads the title, never the description.
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
import { normalizeText } from '../lib/text.js';
import { parseHongKongDateTime } from '../lib/hk-time.js';
import { fetchJson } from '../lib/http-json.js';

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_JOBS = 300;
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
        topMetadata: {},
      });
    }

    // `languageCode` is accepted by Oracle but is not needed for the fields we
    // read. Referenced so the config key is documented and cannot rot silently.
    void languageCode;

    return { jobs, errors };
  }
}
