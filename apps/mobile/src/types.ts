/**
 * Row shapes as they arrive from Supabase PostgREST.
 *
 * These mirror `supabase/migrations/0001_init.sql`. They are hand-written rather
 * than generated because the app is a separate npm project from the scraper and
 * pulling in a codegen step for six tables would cost more than it saves.
 *
 * If you change the migration, change this file. The field names are the ones the
 * app actually reads, so a rename shows up as a type error at the read site.
 */

export type EmploymentType = 'PERMANENT' | 'CONTRACT' | 'INTERNSHIP';
export type WorkArrangement = 'ONSITE' | 'HYBRID' | 'REMOTE' | 'UNKNOWN';
export type SeniorityCode =
  | 'INTERN'
  | 'ENTRY'
  | 'JUNIOR'
  | 'MID'
  | 'SENIOR'
  | 'LEAD'
  | 'MANAGER'
  | 'DIRECTOR'
  | 'EXECUTIVE';

/** The `jobs.extracted` JSON blob written by the LLM enrichment layer. */
export interface JobExtracted {
  seniority?: SeniorityCode | null;
  yoeMin?: number | null;
  yoeMax?: number | null;
  /** `YYYY-MM-DD`. Lives here, NOT in `application_deadline`. */
  deadline?: string | null;
  employmentType?: EmploymentType | null;
  workArrangement?: WorkArrangement | null;
  skills?: string[];
  responsibilities?: string[];
  flags?: string[];
  /** True when the secondary model produced this result. */
  usedFallback?: boolean;
}

export interface JobClassification {
  seniority?: string;
  jobFunction?: string;
  workArrangement?: WorkArrangement;
  confidence?: number;
  signals?: string[];
}

export interface CompanyRef {
  name: string;
  slug: string;
  domain: string | null;
}

export interface JobRow {
  id: string;
  title: string;
  location: string | null;
  url: string;
  apply_url: string | null;

  employment_type: string | null;
  raw_employment_type: string | null;
  department: string | null;
  work_schedule: string | null;
  application_deadline: string | null;
  experience_min: number | null;

  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  remote: boolean;
  requires_visa: boolean;

  tags: string[] | null;
  classification: JobClassification | null;
  top_metadata: Record<string, unknown> | null;

  published_at: string;
  /** The ONLY signal for "this job is new". Set by the DB default on INSERT. */
  first_seen_at: string;
  last_seen_at: string;
  status: string;

  summary: string | null;
  summary_lang: string | null;
  extracted: JobExtracted | null;
  enrich_status: 'PENDING' | 'OK' | 'FAILED' | 'SKIPPED';
  enrich_model: string | null;
  enriched_at: string | null;

  /** Embedded via PostgREST resource embedding. */
  companies: CompanyRef | CompanyRef[] | null;
}

/** PostgREST can return an embedded to-one relation as an object or a 1-element
 *  array depending on how the FK is inferred. Normalise it at the boundary so no
 *  screen has to care. */
export function companyOf(row: JobRow): CompanyRef | null {
  const value = row.companies;
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

// ─── derived view model ──────────────────────────────────────────────────────

export interface JobView {
  id: string;
  title: string;
  companyName: string;
  companySlug: string;
  location: string | null;
  department: string | null;
  url: string;
  applyUrl: string | null;
  employmentType: string | null;
  workArrangement: WorkArrangement | null;
  seniority: SeniorityCode | null;
  yoeMin: number | null;
  yoeMax: number | null;
  experienceMin: number | null;
  /** The trustworthy deadline, from the deterministic scraper path. */
  deadline: string | null;
  /** The LLM's deadline — shown separately and labelled as inferred. */
  inferredDeadline: string | null;
  salary: { min: number | null; max: number | null; currency: string } | null;
  remote: boolean;
  workSchedule: string | null;
  summary: string | null;
  summaryLang: string | null;
  skills: string[];
  responsibilities: string[];
  flags: string[];
  tags: string[];
  firstSeenAt: string;
  publishedAt: string;
  enrichStatus: JobRow['enrich_status'];
  isNew: boolean;
}

export function toJobView(row: JobRow, newSince: number | null): JobView {
  const company = companyOf(row);
  const extracted = row.extracted ?? {};
  const firstSeenMs = Date.parse(row.first_seen_at);

  const salary =
    row.salary_min !== null || row.salary_max !== null
      ? {
          min: row.salary_min,
          max: row.salary_max,
          currency: row.salary_currency ?? 'HKD',
        }
      : null;

  return {
    id: row.id,
    title: row.title,
    companyName: company?.name ?? 'Unknown company',
    companySlug: company?.slug ?? '',
    location: row.location,
    department: row.department,
    url: row.url,
    applyUrl: row.apply_url,
    employmentType: row.employment_type,
    workArrangement: extracted.workArrangement ?? row.classification?.workArrangement ?? null,
    seniority: extracted.seniority ?? null,
    yoeMin: extracted.yoeMin ?? null,
    yoeMax: extracted.yoeMax ?? null,
    experienceMin: row.experience_min,
    deadline: row.application_deadline,
    inferredDeadline: extracted.deadline ?? null,
    salary,
    remote: row.remote,
    workSchedule: row.work_schedule,
    summary: row.summary,
    summaryLang: row.summary_lang,
    skills: extracted.skills ?? [],
    responsibilities: extracted.responsibilities ?? [],
    flags: extracted.flags ?? [],
    tags: row.tags ?? [],
    firstSeenAt: row.first_seen_at,
    publishedAt: row.published_at,
    enrichStatus: row.enrich_status,
    // A job is "new" relative to when the user last opened the list. When there
    // is no baseline yet (first launch) nothing is flagged, so the badge starts
    // honest at zero instead of claiming the whole backlog is new.
    isNew: newSince !== null && Number.isFinite(firstSeenMs) && firstSeenMs > newSince,
  };
}
