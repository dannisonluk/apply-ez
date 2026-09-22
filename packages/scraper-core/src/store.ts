import { request } from 'undici';
import type { StoredInsight } from './lib/llm/schema.js';
import type { JobIngest } from './types/index.js';

/**
 * Supabase (PostgREST) writer.
 *
 * Deliberately uses the REST API over plain HTTP rather than @supabase/supabase-js:
 * the scraper only needs upserts and a couple of reads, and staying dependency-light
 * keeps the GitHub Actions install fast.
 *
 * New-job detection contract:
 *   - `first_seen_at` is set by the DB default on INSERT and is NEVER sent in the
 *     upsert payload, so a conflict-update cannot clobber it.
 *   - `last_seen_at` is refreshed on every run.
 *   - "New" is therefore `first_seen_at > <the app's last_opened_at>`, computed
 *     client-side. We also return the explicit new-vs-updated split per run.
 */

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

export interface JobRow extends JobIngest {
  companyId: string;
}

export interface UpsertJobsResult {
  inserted: number;
  updated: number;
  newExternalIds: string[];
}

export interface UpsertJobsOptions {
  /**
   * LLM enrichment results keyed by `externalId`. Jobs with no entry are written
   * with `enrich_status = 'PENDING'` so a later run can pick them up.
   */
  insights?: Map<string, StoredInsight> | undefined;
  /**
   * Pre-computed existing-id set. The caller usually needs this anyway (to decide
   * which jobs to enrich), so passing it in avoids a second round trip.
   */
  existingExternalIds?: Set<string> | undefined;
}

export interface ReconcileInput {
  companyId: string;
  source: string;
  seenExternalIds: string[];
  /** ISO timestamp of when this run started; anything with an older last_seen_at is missing. */
  runStartedAt: string;
  /** How many consecutive missing full-crawls before a job is marked EXPIRED. */
  expireAfterMissingRuns: number;
}

export interface ReconcileResult {
  markedMissing: number;
  expired: number;
  resetSeen: number;
}

export interface ScrapeRunInput {
  targetId: string;
  adapter: string;
  startedAt: string;
  finishedAt: string;
  inserted: number;
  updated: number;
  total: number;
  errorCount: number;
  errors: string[];
}

const BATCH_SIZE = 200;

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Turn PostgREST's schema-cache errors into something actionable.
 *
 * The common failure in practice is running the scraper against a database that
 * is behind the code — a migration was written but never applied. PostgREST
 * answers with `PGRST204` / `42703` and a message that names the column, which
 * reads like a typo in the client rather than a missing migration. Saying so
 * explicitly saves a debugging detour.
 *
 * Exported so `scripts/check-store.ts` can pin the classification: a false
 * positive here would send someone chasing a migration that is already applied.
 */
export function describeSchemaError(status: number, raw: string): string {
  // Only 400/404 can be a missing object; a 401/429/5xx has other causes.
  if (status !== 400 && status !== 404) return '';
  // PGRST202-205 = PostgREST's "not in the schema cache" family (function, table,
  // column). 42P01 / 42703 / 42883 = Postgres's own undefined_table /
  // undefined_column / undefined_function.
  if (!/PGRST20[2-5]|42P01|42703|42883/.test(raw)) return '';
  return (
    '\n  → This looks like a schema/code mismatch, not a bug in the request.' +
    '\n    The database is probably missing a migration. Apply the files in' +
    '\n    supabase/migrations/ in order in the Supabase SQL editor, then retry.' +
    '\n    (`pnpm check:sql` validates them without touching the database.)'
  );
}

export class JobStore {
  private readonly restUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: SupabaseConfig) {
    if (!config.url || !config.serviceKey) {
      throw new Error('Supabase url and serviceKey are required');
    }
    this.restUrl = `${normalizeBaseUrl(config.url)}/rest/v1`;
    this.headers = {
      apikey: config.serviceKey,
      authorization: `Bearer ${config.serviceKey}`,
      'content-type': 'application/json',
    };
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { body?: unknown; prefer?: string; query?: string } = {},
  ): Promise<T> {
    const url = `${this.restUrl}${path}${options.query ? `?${options.query}` : ''}`;
    const response = await request(url, {
      method,
      headers: {
        ...this.headers,
        ...(options.prefer ? { prefer: options.prefer } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    const raw = await response.body.text();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Supabase ${method} ${path} failed with ${response.statusCode}: ${raw.slice(0, 500)}` +
          describeSchemaError(response.statusCode, raw),
      );
    }
    if (!raw) return undefined as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined as T;
    }
  }

  /** Upsert a company by slug and return its id. */
  async upsertCompany(input: {
    slug: string;
    name: string;
    domain: string;
    careersUrl?: string;
    atsPlatform?: string;
  }): Promise<string> {
    const rows = await this.send<Array<{ id: string }>>('POST', '/companies', {
      body: [
        {
          slug: input.slug,
          name: input.name,
          domain: input.domain,
          ...(input.careersUrl ? { careers_url: input.careersUrl } : {}),
          ...(input.atsPlatform ? { ats_platform: input.atsPlatform } : {}),
        },
      ],
      prefer: 'resolution=merge-duplicates,return=representation',
      query: 'on_conflict=slug&select=id',
    });
    const id = rows?.[0]?.id;
    if (!id) throw new Error(`upsertCompany returned no id for slug=${input.slug}`);
    return id;
  }

  /** Existing external ids for a (company, source) pair — used to compute the new-job set. */
  async listExistingExternalIds(companyId: string, source: string): Promise<Set<string>> {
    const rows = await this.send<Array<{ external_id: string }>>('GET', '/jobs', {
      query: `select=external_id&company_id=eq.${companyId}&source=eq.${source}`,
    });
    return new Set((rows ?? []).map((row) => row.external_id));
  }

  /**
   * External ids that still need an LLM summary.
   *
   * Why this exists: `description` is deliberately NOT persisted (the ingest
   * contract stays lean), so a job whose enrichment failed can only be retried on
   * a run where the adapter scrapes it again. Without this, such a job would be
   * skipped forever because it is already in `existingExternalIds`.
   *
   * FAILED is included alongside PENDING so a transient outage self-heals on the
   * next run instead of requiring manual intervention.
   */
  async listEnrichmentPendingIds(companyId: string, source: string): Promise<Set<string>> {
    const rows = await this.send<Array<{ external_id: string }>>('GET', '/jobs', {
      query:
        `select=external_id&company_id=eq.${companyId}&source=eq.${source}` +
        `&enrich_status=in.(PENDING,FAILED)`,
    });
    return new Set((rows ?? []).map((row) => row.external_id));
  }

  /**
   * Upsert jobs and report how many were genuinely new.
   *
   * `first_seen_at` is intentionally absent from the payload so conflict updates
   * preserve it.
   */
  async upsertJobs(
    companyId: string,
    source: string,
    jobs: JobIngest[],
    options: UpsertJobsOptions = {},
  ): Promise<UpsertJobsResult> {
    if (jobs.length === 0) return { inserted: 0, updated: 0, newExternalIds: [] };

    const existing =
      options.existingExternalIds ?? (await this.listExistingExternalIds(companyId, source));
    const insights = options.insights;
    const newExternalIds: string[] = [];
    const rows: Array<Record<string, unknown>> = [];

    for (const job of jobs) {
      const isNew = !existing.has(job.externalId);
      if (isNew) newExternalIds.push(job.externalId);

      const insight = insights?.get(job.externalId);

      rows.push({
        company_id: companyId,
        source,
        external_id: job.externalId,
        title: job.title,
        location: job.location ?? null,
        url: job.url,
        apply_url: job.applyUrl ?? null,
        employment_type: job.employmentType ?? null,
        raw_employment_type: job.rawEmploymentType ?? null,
        department: job.department ?? null,
        application_deadline: job.applicationDeadline ?? null,
        work_schedule: job.workSchedule ?? null,
        experience_min: job.experienceMin ?? null,
        salary_min: job.salaryMin ?? null,
        salary_max: job.salaryMax ?? null,
        salary_currency: job.salaryCurrency ?? null,
        remote: job.remote ?? false,
        requires_visa: job.requiresVisa ?? false,
        tags: job.tags ?? [],
        classification: job.classification ?? {},
        top_metadata: job.topMetadata ?? {},
        // Relevance scoring. Written on every upsert so a re-scrape after a rules
        // change updates existing rows too. 50 is the neutral default in the
        // migration, used when the scorer never ran (e.g. `--no-relevance`).
        relevance_score: job.relevanceScore ?? 50,
        role_family: job.roleFamily ?? null,
        filter_reason: job.filterReason ?? null,
        published_at: job.publishedAt,
        last_seen_at: new Date().toISOString(),
        // Reappearing jobs come back to ACTIVE; EXPIRED is only set by reconcile.
        status: 'ACTIVE',
        // ── LLM enrichment ──────────────────────────────────────────────────
        // Omitted entirely when there is no insight, so the DB default
        // ('PENDING') survives and a later run can still enrich this job.
        ...(insight
          ? {
              summary: insight.summary,
              summary_lang: insight.summaryLang,
              extracted: {
                seniority: insight.seniority ?? null,
                yoeMin: insight.yoeMin ?? null,
                yoeMax: insight.yoeMax ?? null,
                deadline: insight.deadline ?? null,
                employmentType: insight.employmentType ?? null,
                workArrangement: insight.workArrangement ?? null,
                skills: insight.skills,
                responsibilities: insight.responsibilities ?? [],
                flags: insight.flags,
                usedFallback: insight.usedFallback,
              },
              enrich_status: 'OK',
              enrich_model: insight.model,
              enriched_at: new Date().toISOString(),
            }
          : {}),
      });
    }

    for (let index = 0; index < rows.length; index += BATCH_SIZE) {
      const chunk = rows.slice(index, index + BATCH_SIZE);
      await this.send('POST', '/jobs', {
        body: chunk,
        prefer: 'resolution=merge-duplicates,return=minimal',
        query: 'on_conflict=source,external_id',
      });
    }

    return {
      inserted: newExternalIds.length,
      updated: jobs.length - newExternalIds.length,
      newExternalIds,
    };
  }

  /**
   * Mark jobs that were absent from a FULL crawl.
   *
   * Two-strike policy carried over from the original scraper: the first full crawl
   * that misses a job only increments `missing_count`; the second marks it EXPIRED.
   * Only call this after a full crawl — shallow paginated runs would falsely expire
   * older-but-live postings.
   */
  async reconcileMissing(input: ReconcileInput): Promise<ReconcileResult> {
    const active = await this.send<Array<{ external_id: string; missing_count: number }>>('GET', '/jobs', {
      query:
        `select=external_id,missing_count&company_id=eq.${input.companyId}` +
        `&source=eq.${input.source}&status=eq.ACTIVE`,
    });
    if (!active || active.length === 0) return { markedMissing: 0, expired: 0, resetSeen: 0 };

    const seen = new Set(input.seenExternalIds);
    const missing = active.filter((row) => !seen.has(row.external_id));
    if (missing.length === 0) return { markedMissing: 0, expired: 0, resetSeen: 0 };

    const now = new Date().toISOString();
    const toExpire: string[] = [];
    const toMarkMissing: string[] = [];

    for (const row of missing) {
      if (row.missing_count + 1 >= input.expireAfterMissingRuns) toExpire.push(row.external_id);
      else toMarkMissing.push(row.external_id);
    }

    if (toMarkMissing.length > 0) {
      await this.patchJobsByExternalIds(input.source, toMarkMissing, (row) => ({
        missing_count: row.missing_count + 1,
        last_missing_at: now,
      }), input.companyId);
    }

    if (toExpire.length > 0) {
      await this.patchJobsByExternalIds(input.source, toExpire, () => ({
        status: 'EXPIRED',
        missing_count: input.expireAfterMissingRuns,
        last_missing_at: now,
      }), input.companyId);
    }

    // Any job that was previously missing but is present again gets its counter reset.
    const recovered = active.filter((row) => seen.has(row.external_id) && row.missing_count > 0);
    if (recovered.length > 0) {
      await this.patchJobsByExternalIds(input.source, recovered.map((row) => row.external_id), () => ({
        missing_count: 0,
        last_missing_at: null,
      }), input.companyId);
    }

    return {
      markedMissing: toMarkMissing.length,
      expired: toExpire.length,
      resetSeen: recovered.length,
    };
  }

  private async patchJobsByExternalIds(
    source: string,
    externalIds: string[],
    build: (row: { external_id: string; missing_count: number }) => Record<string, unknown>,
    companyId: string,
  ): Promise<void> {
    for (const externalId of externalIds) {
      await this.send('PATCH', '/jobs', {
        body: build({ external_id: externalId, missing_count: 0 }),
        prefer: 'return=minimal',
        query:
          `source=eq.${source}&external_id=eq.${encodeURIComponent(externalId)}` +
          `&company_id=eq.${companyId}`,
      });
    }
  }

  /**
   * Enabled push tokens.
   *
   * Only the service role can read this table — the anon policy grants insert and
   * update but deliberately not select, so tokens cannot be harvested from the
   * app. See `supabase/migrations/0002_push_tokens.sql`.
   */
  async listPushTokens(): Promise<Array<{ token: string; device_id: string | null; platform: string | null }>> {
    const rows = await this.send<
      Array<{ token: string; device_id: string | null; platform: string | null }>
    >('GET', '/push_tokens', {
      query: 'select=token,device_id,platform&enabled=is.true',
    });
    return rows ?? [];
  }

  /** Disable tokens Expo reported as `DeviceNotRegistered`. */
  async disablePushTokens(tokens: string[]): Promise<void> {
    for (const token of tokens) {
      await this.send('PATCH', '/push_tokens', {
        body: { enabled: false, last_seen_at: new Date().toISOString() },
        prefer: 'return=minimal',
        query: `token=eq.${encodeURIComponent(token)}`,
      });
    }
  }

  /** Append a row to scrape_runs for observability. */
  async recordRun(input: ScrapeRunInput): Promise<void> {
    await this.send('POST', '/scrape_runs', {
      body: [
        {
          target_id: input.targetId,
          adapter: input.adapter,
          started_at: input.startedAt,
          finished_at: input.finishedAt,
          inserted: input.inserted,
          updated: input.updated,
          total: input.total,
          error_count: input.errorCount,
          errors: input.errors.slice(0, 50),
        },
      ],
      prefer: 'return=minimal',
    });
  }
}
