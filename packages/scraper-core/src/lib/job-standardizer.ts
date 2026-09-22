import type { JobIngest } from '../types/index.js';

function asTrimmed(value: string | undefined | null): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeDeadline(raw: string | undefined | null): string | undefined {
  const text = asTrimmed(raw);
  if (!text) return undefined;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  const ymd = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymd) {
    const yyyy = ymd[1];
    const mm = ymd[2]?.padStart(2, '0');
    const dd = ymd[3]?.padStart(2, '0');
    if (yyyy && mm && dd) return `${yyyy}-${mm}-${dd}`;
  }
  const dmy = text.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) {
    const dd = dmy[1]?.padStart(2, '0');
    const mm = dmy[2]?.padStart(2, '0');
    const yyyy = dmy[3];
    if (yyyy && mm && dd) return `${yyyy}-${mm}-${dd}`;
  }
  return text.slice(0, 40);
}

/**
 * Final normalization before ingest. Lean scope: tidy the brief metadata (deadline,
 * contract type, schedule, experience) carried on topMetadata. No description parsing.
 */
export function standardizeJob(job: JobIngest): JobIngest {
  const topMetadata = job.topMetadata ?? {};
  const deadline =
    normalizeDeadline(topMetadata.applicationDeadline) ??
    normalizeDeadline(topMetadata.deadline);

  const mergedTopMetadata: NonNullable<JobIngest['topMetadata']> = {
    ...topMetadata,
    ...(deadline ? { applicationDeadline: deadline, deadline } : {}),
  };

  return {
    ...job,
    topMetadata: mergedTopMetadata,
  };
}

export function standardizeJobs(jobs: JobIngest[]): JobIngest[] {
  return jobs.map((job) => standardizeJob(job));
}

