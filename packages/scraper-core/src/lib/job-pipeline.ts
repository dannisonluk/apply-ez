import { createHash } from 'node:crypto';
import {
  jobIngestSchema,
  jobSourceSchema,
  normalizeJobEmploymentType,
  type JobIngest,
} from '../types/index.js';
import { parseHongKongDateTime } from './hk-time.js';
import { isOutOfScopeLocation } from './location-scope.js';

/**
 * Normalizes raw adapter output before it reaches API validation.
 *
 * LEAN scope: only brief job info + dates are ingested. Adapters may still emit legacy
 * deep-content fields (description/sectionContent/localizedContents); those are stripped
 * here at the boundary so the ingest payload stays small regardless of adapter behaviour.
 */
export interface JobPipelineLogger {
  info?: (message: string, context?: Record<string, unknown>) => void;
  warn?: (message: string, context?: Record<string, unknown>) => void;
}

export interface PipelineDroppedJob {
  stage: 'normalize' | 'validate' | 'scope' | 'dedupe';
  reason: string;
  source?: string | undefined;
  externalId?: string | undefined;
  title?: string | undefined;
  url?: string | undefined;
  /** Set for `stage: 'scope'` — the location that put the job out of scope. */
  location?: string | undefined;
}

export interface PrepareJobsResult {
  jobs: JobIngest[];
  dropped: PipelineDroppedJob[];
  duplicateCount: number;
}

export interface PrepareJobsOptions {
  logger?: JobPipelineLogger;
  /**
   * Drop postings that are not in Hong Kong.
   *
   * Off by default, because this is a product decision rather than data hygiene:
   * the normalizer's job is to make rows valid, not to decide which of them the
   * board wants. `cli.ts` turns it on for every target. See `location-scope.ts`
   * for why the rule is a denylist.
   */
  hongKongOnly?: boolean | undefined;
}

const WORK_ARRANGEMENT_VALUES: ReadonlySet<
  NonNullable<NonNullable<JobIngest['classification']>['workArrangement']>
> = new Set(['ONSITE', 'HYBRID', 'REMOTE', 'UNKNOWN']);

function asTrimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength).trim();
}

function maxTags(): number {
  return Math.max(1, Math.min(24, Number.parseInt(process.env.SCRAPER_PIPELINE_MAX_TAGS ?? '12', 10) || 12));
}

function normalizeUrl(value: unknown): string | undefined {
  const text = asTrimmed(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (!/^https?:$/i.test(url.protocol)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeDomain(value: unknown, jobUrl: string): string | undefined {
  const candidate = asTrimmed(value)?.toLowerCase();
  if (!candidate) return undefined;
  const normalized = candidate.replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!normalized || normalized.length > 255) return undefined;

  // Prevent poisoning company domain with unrelated domains that can cause DB unique conflicts.
  try {
    const jobHost = new URL(jobUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (jobHost === normalized) return normalized;
    if (jobHost.endsWith(`.${normalized}`)) return normalized;
    if (normalized.endsWith(`.${jobHost}`)) return normalized;
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeDateTime(value: unknown): string {
  const text = asTrimmed(value);
  if (!text) return new Date().toISOString();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function normalizeOptionalDateTime(value: unknown): string | undefined {
  // Deadlines are parsed against Hong Kong time, not the runtime's timezone.
  // Using `new Date(text)` here made the stored instant depend on where the
  // scraper ran — a UTC CI runner and a UTC+8 laptop disagreed by eight hours,
  // which is enough to shift a deadline onto the wrong day in the app.
  return parseHongKongDateTime(value);
}

function normalizeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  return undefined;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(1, parsed));
}

function sanitizeClassification(value: unknown): JobIngest['classification'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const seniority = truncate(asTrimmed(candidate.seniority), 80);
  const jobFunction = truncate(asTrimmed(candidate.jobFunction), 120);
  const workArrangementRaw = asTrimmed(candidate.workArrangement)?.toUpperCase();
  const workArrangement =
    workArrangementRaw &&
    WORK_ARRANGEMENT_VALUES.has(
      workArrangementRaw as NonNullable<NonNullable<JobIngest['classification']>['workArrangement']>,
    )
      ? (workArrangementRaw as NonNullable<NonNullable<JobIngest['classification']>['workArrangement']>)
      : undefined;
  const confidence = normalizeConfidence(candidate.confidence);

  if (!seniority && !jobFunction && !workArrangement && confidence === undefined) return undefined;

  return {
    ...(seniority ? { seniority } : {}),
    ...(jobFunction ? { jobFunction } : {}),
    ...(workArrangement ? { workArrangement } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawTag of value) {
    const tag = truncate(asTrimmed(rawTag), 50);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= maxTags()) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Brief source metadata worth keeping on the Job row (single-line strings only). */
function sanitizeTopMetadata(value: unknown): JobIngest['topMetadata'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const maxLength = 300;
  const keys = [
    'jobFunction',
    'department',
    'employmentType',
    'country',
    'deadline',
    'applicationDeadline',
    'workSchedule',
    'contractType',
    'yearsOfExperience',
    'remotePolicy',
  ] as const;
  const entries = keys
    .map((key) => [key, truncate(asTrimmed(candidate[key]), maxLength)] as const)
    .filter((entry): entry is [(typeof keys)[number], string] => Boolean(entry[1]));

  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as NonNullable<JobIngest['topMetadata']>;
}

function fallbackExternalId(source: string, url: string, title: string): string {
  const digest = createHash('sha1').update(`${source}|${url}|${title}`).digest('hex').slice(0, 24);
  return `auto-${digest}`;
}

/** Narrow a raw string to the JobSource union; adapters emit these literal values. */
function toJobSource(value: string): JobIngest['source'] | undefined {
  return (
    jobSourceSchema.safeParse(value).success ? (value as JobIngest['source']) : undefined
  );
}

/**
 * Canonicalizes one raw job while preserving important source wording.
 *
 * `employmentType` becomes the small product taxonomy, while
 * `rawEmploymentType` keeps labels like "Fixed Term Contract" for admin review.
 */
function normalizeSingleJob(input: Record<string, unknown>): JobIngest | null {
  const source = toJobSource(typeof input.source === 'string' ? input.source : '');
  const url = normalizeUrl(input.url);
  if (!source || !url) return null;

  const title = truncate(asTrimmed(input.title), 500) ?? 'Untitled Job';
  const companyName = truncate(asTrimmed(input.companyName), 255) ?? 'Unknown Company';
  const location = truncate(asTrimmed(input.location), 300);
  const applyUrl = normalizeUrl(input.applyUrl);
  const companyDomain = normalizeDomain(input.companyDomain, url);
  const tags = normalizeTags(input.tags);
  const classification = sanitizeClassification(input.classification);
  const topMetadata = sanitizeTopMetadata(input.topMetadata);
  const rawEmploymentType =
    truncate(asTrimmed(input.rawEmploymentType), 120) ??
    truncate(asTrimmed(input.employmentType), 120) ??
    truncate(asTrimmed(topMetadata?.employmentType), 120) ??
    truncate(asTrimmed(topMetadata?.contractType), 120);
  const employmentType = normalizeJobEmploymentType(rawEmploymentType);
  const department = truncate(asTrimmed(input.department), 180) ?? truncate(asTrimmed(topMetadata?.department), 180);
  const applicationDeadline =
    normalizeOptionalDateTime(input.applicationDeadline) ??
    normalizeOptionalDateTime(topMetadata?.applicationDeadline) ??
    normalizeOptionalDateTime(topMetadata?.deadline);
  const workSchedule =
    truncate(asTrimmed(input.workSchedule), 120) ?? truncate(asTrimmed(topMetadata?.workSchedule), 120);

  const salaryMin = normalizeInteger(input.salaryMin);
  const salaryMax = normalizeInteger(input.salaryMax);
  const safeSalaryMin =
    salaryMin !== undefined && salaryMax !== undefined && salaryMin > salaryMax ? salaryMax : salaryMin;
  const safeSalaryMax =
    salaryMin !== undefined && salaryMax !== undefined && salaryMin > salaryMax ? salaryMin : salaryMax;
  const experienceMin = normalizeInteger(input.experienceMin);
  const safeExperienceMin =
    experienceMin !== undefined && experienceMin >= 0 ? Math.min(60, experienceMin) : undefined;
  const requiresVisa = normalizeBoolean(input.requiresVisa);

  const externalId = truncate(asTrimmed(input.externalId), 500) ?? fallbackExternalId(source, url, title);

  return {
    source,
    externalId,
    companyName,
    ...(companyDomain ? { companyDomain } : {}),
    title,
    ...(location ? { location } : {}),
    url,
    ...(applyUrl ? { applyUrl } : {}),
    ...(tags ? { tags } : {}),
    ...(safeSalaryMin !== undefined ? { salaryMin: safeSalaryMin } : {}),
    ...(safeSalaryMax !== undefined ? { salaryMax: safeSalaryMax } : {}),
    ...(typeof input.salaryCurrency === 'string' ? { salaryCurrency: input.salaryCurrency } : {}),
    ...(input.remote !== undefined ? { remote: Boolean(input.remote) } : {}),
    ...(employmentType ? { employmentType } : {}),
    ...(rawEmploymentType ? { rawEmploymentType } : {}),
    ...(department ? { department } : {}),
    ...(applicationDeadline ? { applicationDeadline } : {}),
    ...(workSchedule ? { workSchedule } : {}),
    ...(requiresVisa !== undefined ? { requiresVisa } : {}),
    ...(safeExperienceMin !== undefined ? { experienceMin: safeExperienceMin } : {}),
    ...(classification ? { classification } : {}),
    publishedAt: normalizeDateTime(input.publishedAt),
    ...(topMetadata ? { topMetadata } : {}),
  };
}

export function prepareJobsForIngest(
  jobs: unknown[],
  options: PrepareJobsOptions = {},
): PrepareJobsResult {
  const dropped: PipelineDroppedJob[] = [];
  const valid: JobIngest[] = [];
  let duplicateCount = 0;
  const dedupeSet = new Set<string>();

  for (const input of jobs) {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const normalized = normalizeSingleJob(record);
    if (!normalized) {
      dropped.push({
        stage: 'normalize',
        reason: 'missing source or invalid url',
        source: typeof record.source === 'string' ? record.source : undefined,
        externalId: typeof record.externalId === 'string' ? record.externalId : undefined,
        title: typeof record.title === 'string' ? record.title : undefined,
        url: typeof record.url === 'string' ? record.url : undefined,
      });
      continue;
    }

    const parseResult = jobIngestSchema.safeParse(normalized);
    if (!parseResult.success) {
      dropped.push({
        stage: 'validate',
        reason: parseResult.error.issues[0]?.message ?? 'schema validation failed',
        source: normalized.source,
        externalId: normalized.externalId,
        title: normalized.title,
        url: normalized.url,
      });
      continue;
    }

    // Scope, not hygiene: the listing APIs filter by location themselves and
    // still return the odd overseas posting. Checked after validation so it reads
    // the normalized `location` rather than the adapter's raw string.
    if (options.hongKongOnly && isOutOfScopeLocation(parseResult.data.location)) {
      dropped.push({
        stage: 'scope',
        reason: 'location is outside Hong Kong',
        source: parseResult.data.source,
        externalId: parseResult.data.externalId,
        title: parseResult.data.title,
        url: parseResult.data.url,
        location: parseResult.data.location,
      });
      continue;
    }

    const dedupeKey = `${parseResult.data.source}|${parseResult.data.externalId}`;
    if (dedupeSet.has(dedupeKey)) {
      duplicateCount += 1;
      continue;
    }
    dedupeSet.add(dedupeKey);
    valid.push(parseResult.data);
  }

  if (dropped.length > 0) {
    options.logger?.warn?.('pipeline dropped invalid jobs', {
      count: dropped.length,
      samples: dropped.slice(0, 5),
    });
  }

  return { jobs: valid, dropped, duplicateCount };
}
