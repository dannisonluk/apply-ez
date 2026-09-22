import { normalizeJobEmploymentType, type JobIngest } from '../types/index.js';

/**
 * Deterministic enrichment for scraped jobs (LEAN — no LLM).
 *
 * The platform no longer scrapes or stores deep descriptions/requirements, so the
 * previous OpenAI-based section parser was removed entirely. This module derives
 * lightweight searchable metadata (employment type, work arrangement, seniority, job
 * function, experience, tags) from the job TITLE and brief topMetadata only — never a
 * description body. It makes zero external API calls, so it is free and instant.
 *
 * The exported signature is kept stable for the queue: `enrichJobsWithSummary` returns
 * `{ jobs, usedLlM, warnings }`. `usedLlM` is always false now.
 */

export interface JobEnrichmentLogger {
  info: (message: string, ctx?: Record<string, unknown>) => void;
  warn: (message: string, ctx?: Record<string, unknown>) => void;
}

export interface JobEnrichmentOptions {
  logger?: JobEnrichmentLogger;
  /** Retained for API compatibility with the queue; no longer affects behaviour. */
  skipLlm?: boolean;
}

export type EnrichedJob = JobIngest;

type WorkArrangement = NonNullable<NonNullable<JobIngest['classification']>['workArrangement']>;

function asTrimmed(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTag(tag: string): string {
  return tag.trim().toUpperCase().replace(/\s+/g, '_').slice(0, 50);
}

function normalizeSingleLine(value: string | undefined | null, maxLen: number): string | undefined {
  const normalized = asTrimmed(value)?.replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, maxLen) : undefined;
}

function hasVisibleString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ─── Title/metadata-based inference (no description body) ─────────────────────

function inferSeniority(title: string): string | undefined {
  const t = title.toLowerCase();
  if (/\bintern(ship)?\b/.test(t)) return 'Intern';
  if (/\b(entry[- ]level|junior|associate)\b/.test(t)) return 'Junior';
  if (/\b(mid|intermediate)\b/.test(t)) return 'Mid';
  if (/\b(senior|sr\.?)\b/.test(t)) return 'Senior';
  if (/\b(lead|principal|staff)\b/.test(t)) return 'Lead';
  if (/\b(manager|head|director|vp|vice president|chief)\b/.test(t)) return 'Management';
  return undefined;
}

function inferJobFunction(title: string, metadataJobFunction?: string | null): string | undefined {
  if (hasVisibleString(metadataJobFunction)) return metadataJobFunction.trim().slice(0, 120);
  const t = title.toLowerCase();
  if (/(software|backend|frontend|full[\s-]?stack|engineer|developer|devops|sre)/.test(t)) return 'Engineering';
  if (/(data scientist|data analyst|machine learning|ai engineer|analytics)/.test(t)) return 'Data';
  if (/(product manager|product owner|product management)/.test(t)) return 'Product';
  if (/(designer|ux|ui|graphic)/.test(t)) return 'Design';
  if (/(marketing|growth|seo|content)/.test(t)) return 'Marketing';
  if (/(sales|account executive|business development)/.test(t)) return 'Sales';
  if (/(finance|accounting|controller|fp&a)/.test(t)) return 'Finance';
  if (/(hr|human resources|talent acquisition|recruiter)/.test(t)) return 'Human Resources';
  if (/(operations|supply chain|logistics|procurement)/.test(t)) return 'Operations';
  if (/(legal|compliance|risk)/.test(t)) return 'Legal & Compliance';
  if (/(customer support|customer success|service desk)/.test(t)) return 'Customer Support';
  return undefined;
}

// Work arrangement is derived from the title + the explicit remote flag/metadata only.
function inferWorkArrangement(
  title: string,
  remote: boolean | undefined,
  remotePolicy: string | undefined,
): { remote?: boolean; workArrangement?: WorkArrangement } {
  const haystack = `${title} ${remotePolicy ?? ''}`.toLowerCase();
  if (/\bhybrid\b/.test(haystack)) return { remote: false, workArrangement: 'HYBRID' };
  if (/\b(remote|work from home|telecommute|wfh)\b/.test(haystack)) return { remote: true, workArrangement: 'REMOTE' };
  if (/\b(on[- ]?site|office[- ]based|onsite)\b/.test(haystack)) return { remote: false, workArrangement: 'ONSITE' };
  if (remote === true) return { remote: true, workArrangement: 'REMOTE' };
  if (remote === false) return { remote: false, workArrangement: 'ONSITE' };
  return {};
}

function inferContractType(employmentType: string | undefined, raw: string | undefined): string | undefined {
  const text = `${employmentType ?? ''} ${raw ?? ''}`.toLowerCase();
  if (/\bpermanent\b/.test(text)) return 'Permanent';
  if (/\b(contract|fixed[- ]term|temporary)\b/.test(text)) return 'Contract';
  return undefined;
}

function inferWorkSchedule(employmentType: string | undefined, raw: string | undefined): string | undefined {
  const text = `${employmentType ?? ''} ${raw ?? ''}`.toLowerCase();
  if (/\bpart[- ]?time\b/.test(text)) return 'Part-time';
  if (/\bfull[- ]?time\b/.test(text)) return 'Full-time';
  return undefined;
}

function buildTags(job: JobIngest, seniority?: string, jobFunction?: string, workArrangement?: string): string[] {
  const tags = new Set<string>();
  for (const t of job.tags ?? []) {
    const norm = normalizeTag(t);
    if (norm) tags.add(norm);
  }
  const employmentType = normalizeJobEmploymentType(job.employmentType);
  if (employmentType) tags.add(normalizeTag(employmentType));
  if (jobFunction) tags.add(normalizeTag(jobFunction));
  if (seniority) tags.add(normalizeTag(seniority));
  if (workArrangement) tags.add(normalizeTag(workArrangement));
  if (/intern/i.test(job.title)) tags.add('INTERNSHIP');
  if (/manager|lead|senior|principal/i.test(job.title)) tags.add('SENIOR');
  if (/engineer|developer|software|tech/i.test(job.title)) tags.add('ENGINEERING');
  if (/data|analytics/i.test(job.title)) tags.add('DATA');
  return Array.from(tags).slice(0, 12);
}

function enrichOne(job: JobIngest): EnrichedJob {
  const topMetadata = job.topMetadata ?? {};
  const seniority = inferSeniority(job.title);
  const jobFunction = inferJobFunction(job.title, topMetadata.jobFunction);
  const work = inferWorkArrangement(job.title, job.remote, asTrimmed(topMetadata.remotePolicy));
  const employmentType = normalizeJobEmploymentType(job.employmentType) ?? job.employmentType;

  const contractType =
    normalizeSingleLine(topMetadata.contractType, 80) ??
    inferContractType(employmentType, topMetadata.employmentType ?? undefined);
  const workSchedule =
    normalizeSingleLine(topMetadata.workSchedule, 80) ??
    inferWorkSchedule(employmentType, topMetadata.employmentType ?? undefined);
  const yearsOfExperience =
    normalizeSingleLine(topMetadata.yearsOfExperience, 80) ??
    (typeof job.experienceMin === 'number' ? `${job.experienceMin}+ years` : undefined);

  const classification: NonNullable<JobIngest['classification']> = {
    ...(seniority ? { seniority } : {}),
    ...(jobFunction ? { jobFunction } : {}),
    ...(work.workArrangement ? { workArrangement: work.workArrangement } : {}),
  };

  const mergedTopMetadata: NonNullable<JobIngest['topMetadata']> = {
    ...topMetadata,
    ...(employmentType ? { employmentType } : {}),
    ...(jobFunction ? { jobFunction } : {}),
    ...(contractType ? { contractType } : {}),
    ...(workSchedule ? { workSchedule } : {}),
    ...(yearsOfExperience ? { yearsOfExperience } : {}),
  };

  return {
    ...job,
    tags: buildTags(job, seniority, jobFunction, work.workArrangement),
    ...(employmentType ? { employmentType } : {}),
    ...(work.remote !== undefined ? { remote: work.remote } : {}),
    ...(Object.keys(classification).length > 0 ? { classification } : {}),
    topMetadata: mergedTopMetadata,
  };
}

/**
 * Lean deterministic enrichment. Kept async + same return shape so the queue is
 * unchanged. Never calls an external API; `usedLlM` is always false.
 */
export async function enrichJobsWithSummary(
  jobs: JobIngest[],
  _options: JobEnrichmentOptions = {},
): Promise<{ jobs: EnrichedJob[]; usedLlM: boolean; warnings: string[] }> {
  return { jobs: jobs.map(enrichOne), usedLlM: false, warnings: [] };
}
