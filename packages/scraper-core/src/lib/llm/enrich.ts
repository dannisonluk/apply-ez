import Bottleneck from 'bottleneck';
import type { RawJob } from '../../adapters/adapter.interface.js';
import {
  OpenRouterClient,
  OpenRouterError,
  type RateLimitSnapshot,
  type ToolDefinition,
} from './openrouter.js';
import {
  buildInsightPrompt,
  estimateTokens,
  INSIGHT_SYSTEM_PROMPT,
  INSIGHT_TOOL_NAME,
  INSIGHT_TOOL_SCHEMA,
  jobInsightSchema,
  normalizeEmploymentType,
  normalizeSeniority,
  normalizeStringList,
  normalizeSummaryLang,
  normalizeWorkArrangement,
  sanitizeDeadline,
  type StoredInsight,
} from './schema.js';

/**
 * LLM enrichment orchestrator.
 *
 * Contract:
 *   - Runs on RAW jobs, before `prepareJobsForIngest` strips `description`.
 *   - Only touches jobs the caller did not put in `skipExternalIds`, so a job is
 *     normally summarised exactly once in its lifetime. The caller passes the
 *     "already enriched" set, which is why a job whose earlier attempt failed
 *     can still be retried.
 *   - Fail-soft: any error leaves the job at `enrich_status = PENDING` and the
 *     scrape run continues. Enrichment must never be able to fail a scrape.
 *   - Stops early when the free-tier daily quota is exhausted, rather than
 *     burning the remaining jobs on 429s.
 */

export interface EnrichLogger {
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface EnrichOptions {
  apiKey: string;
  primaryModel: string;
  fallbackModel: string;
  /** Hard ceiling per run — protects the free-tier daily quota. */
  maxJobs: number;
  concurrency: number;
  /** Requests per minute ceiling across all workers. */
  minTimeMs: number;
  timeoutMs: number;
  /** Postings shorter than this are not worth an LLM call. */
  minDescriptionChars: number;
  logger: EnrichLogger;
}

export interface EnrichStats {
  /** Jobs handed in (post-backfill, pre-dedupe). */
  considered: number;
  skippedKnown: number;
  skippedNoDescription: number;
  skippedOverCap: number;
  attempted: number;
  succeeded: number;
  usedFallback: number;
  failed: number;
  /** True when we bailed out because the daily free-tier quota ran out. */
  stoppedOnRateLimit: boolean;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export interface EnrichResult {
  /** Keyed by `externalId`. Absent means "leave at PENDING". */
  insights: Map<string, StoredInsight>;
  stats: EnrichStats;
}

const INSIGHT_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: INSIGHT_TOOL_NAME,
    description:
      'Record the structured facts extracted from one job posting. ' +
      'Call this exactly once. Omit any field the posting does not state.',
    parameters: INSIGHT_TOOL_SCHEMA,
  },
};

export function defaultEnrichOptions(
  logger: EnrichLogger,
  overrides: Partial<EnrichOptions> = {},
): EnrichOptions | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  return {
    apiKey,
    primaryModel: process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.8-27b:free',
    fallbackModel: process.env.OPENROUTER_FALLBACK_MODEL ?? 'nvidia/nemotron-3.5-lightning:free',
    maxJobs: Number(process.env.OPENROUTER_MAX_JOBS_PER_RUN ?? 40),
    concurrency: Number(process.env.OPENROUTER_CONCURRENCY ?? 2),
    minTimeMs: Number(process.env.OPENROUTER_MIN_TIME_MS ?? 1200),
    timeoutMs: Number(process.env.OPENROUTER_TIMEOUT_MS ?? 90_000),
    minDescriptionChars: Number(process.env.OPENROUTER_MIN_DESCRIPTION_CHARS ?? 200),
    logger,
    ...overrides,
  };
}

function buildMessages(job: RawJob): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: INSIGHT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildInsightPrompt({
        title: job.title,
        companyName: job.companyName,
        location: job.location,
        department: job.department,
        employmentType: job.employmentType ?? job.rawEmploymentType,
        workSchedule: job.workSchedule,
        description: job.description,
        requirements: job.requirements,
        knownExperienceMin: job.experienceMin,
        knownDeadline: job.applicationDeadline,
      }),
    },
  ];
}

/**
 * Turn validated tool arguments into the shape we persist.
 *
 * Policy: validate the object's shape with Zod, then normalise each field
 * independently. A single bad field is dropped, never allowed to discard the
 * summary. Exported for testing.
 */
export function toStoredInsight(
  args: unknown,
  model: string,
  usedFallback: boolean,
): StoredInsight | null {
  if (typeof args !== 'object' || args === null) return null;
  const candidate = args as Record<string, unknown>;

  // Normalise the summary BEFORE validating, so the minimum-length gate applies to
  // the text we would actually store. Checking the raw string instead lets a
  // whitespace-padded stub through and then stores something shorter than the gate.
  const summary =
    typeof candidate.summary === 'string' ? candidate.summary.replace(/\s+/g, ' ').trim() : '';
  // The summary is the whole point of the call — a stub is not worth storing.
  if (summary.length < 30) return null;

  const parsed = jobInsightSchema.safeParse({ ...candidate, summary });
  if (!parsed.success) return null;

  const data = parsed.data;

  const skills = normalizeStringList(data.skills, 12);
  const flags = normalizeStringList(data.flags, 6);
  const responsibilities = normalizeStringList(data.responsibilities, 6);
  const deadline = sanitizeDeadline(data.deadline);
  const seniority = normalizeSeniority(data.seniority);
  const employmentType = normalizeEmploymentType(data.employmentType);
  const workArrangement = normalizeWorkArrangement(data.workArrangement);

  // A yoeMin above yoeMax is a model slip, not a fact. Drop both rather than
  // publish a range that reads as "8-3 years".
  let yoeMin = typeof data.yoeMin === 'number' ? data.yoeMin : undefined;
  let yoeMax = typeof data.yoeMax === 'number' ? data.yoeMax : undefined;
  if (yoeMin !== undefined && yoeMax !== undefined && yoeMin > yoeMax) {
    yoeMin = undefined;
    yoeMax = undefined;
  }
  if (yoeMin !== undefined && yoeMin > 40) yoeMin = undefined;
  if (yoeMax !== undefined && yoeMax > 40) yoeMax = undefined;

  return {
    summary,
    summaryLang: normalizeSummaryLang(data.summaryLang),
    skills,
    flags,
    ...(seniority ? { seniority } : {}),
    ...(yoeMin === undefined ? {} : { yoeMin }),
    ...(yoeMax === undefined ? {} : { yoeMax }),
    ...(deadline ? { deadline } : {}),
    ...(employmentType ? { employmentType } : {}),
    ...(workArrangement ? { workArrangement } : {}),
    ...(responsibilities.length > 0 ? { responsibilities } : {}),
    model,
    usedFallback,
  };
}

export async function enrichJobs(
  jobs: RawJob[],
  /** External ids to leave alone — jobs already summarised. */
  skipExternalIds: Set<string>,
  options: EnrichOptions,
): Promise<EnrichResult> {
  const stats: EnrichStats = {
    considered: jobs.length,
    skippedKnown: 0,
    skippedNoDescription: 0,
    skippedOverCap: 0,
    attempted: 0,
    succeeded: 0,
    usedFallback: 0,
    failed: 0,
    stoppedOnRateLimit: false,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
  };
  const insights = new Map<string, StoredInsight>();

  // New jobs with enough text to be worth a call.
  const candidates: RawJob[] = [];
  const seenInBatch = new Set<string>();

  for (const job of jobs) {
    if (skipExternalIds.has(job.externalId)) {
      stats.skippedKnown += 1;
      continue;
    }
    // The same posting can appear twice within one scrape (e.g. listed on two
    // regional pages). Enrich once.
    if (seenInBatch.has(job.externalId)) continue;
    seenInBatch.add(job.externalId);

    const text = [job.description, job.requirements].filter(Boolean).join('\n');
    if (text.length < options.minDescriptionChars) {
      stats.skippedNoDescription += 1;
      continue;
    }
    candidates.push(job);
  }

  if (candidates.length > options.maxJobs) {
    stats.skippedOverCap = candidates.length - options.maxJobs;
    options.logger.warn('enrichment cap reached; remaining jobs stay PENDING', {
      candidates: candidates.length,
      cap: options.maxJobs,
      skipped: stats.skippedOverCap,
    });
    candidates.length = options.maxJobs;
  }

  if (candidates.length === 0) {
    options.logger.info('nothing new to enrich', {
      considered: stats.considered,
      skippedKnown: stats.skippedKnown,
      skippedNoDescription: stats.skippedNoDescription,
    });
    return { insights, stats };
  }

  const client = new OpenRouterClient({
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
    maxRetries: 1,
    referer: 'https://github.com/apply-ez',
    title: 'apply-ez scraper',
  });

  // Shared across workers so the whole run respects one request-rate budget.
  const limiter = new Bottleneck({
    maxConcurrent: options.concurrency,
    minTime: options.minTimeMs,
  });

  // Collected rather than assigned to a `let`: the value is only ever written from
  // inside the worker closures, and TypeScript's control-flow analysis would keep
  // narrowing a `let` to `null` at the read site.
  const rateLimits: RateLimitSnapshot[] = [];
  let quotaExhausted = false;

  options.logger.info('enrichment started', {
    candidates: candidates.length,
    primary: options.primaryModel,
    fallback: options.fallbackModel,
  });

  const tasks = candidates.map((job) =>
    limiter.schedule(async (): Promise<void> => {
      if (quotaExhausted) return;

      stats.attempted += 1;
      const messages = buildMessages(job);
      const approxTokens = estimateTokens(messages.map((m) => m.content).join('\n'));

      // Primary, then fallback. A Zod failure on the primary counts as a failure
      // and triggers the fallback — a well-formed tool call carrying nonsense is
      // still a bad result.
      for (const [index, model] of [options.primaryModel, options.fallbackModel].entries()) {
        const isFallback = index === 1;
        try {
          const result = await client.callTool({
            model,
            messages,
            tool: INSIGHT_TOOL,
          });

          rateLimits.push(result.rateLimit);
          stats.totalPromptTokens += result.promptTokens ?? 0;
          stats.totalCompletionTokens += result.completionTokens ?? 0;

          const stored = toStoredInsight(result.args, result.model, isFallback);
          if (!stored) {
            options.logger.warn('model returned arguments that failed validation', {
              externalId: job.externalId,
              model: result.model,
            });
            continue; // try the fallback
          }

          insights.set(job.externalId, stored);
          stats.succeeded += 1;
          if (isFallback) stats.usedFallback += 1;
          options.logger.info('enriched', {
            externalId: job.externalId,
            model: result.model,
            approxPromptTokens: approxTokens,
            skills: stored.skills.length,
            flags: stored.flags.length,
          });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isRateLimit = error instanceof OpenRouterError && error.statusCode === 429;

          if (isRateLimit && !isFallback) {
            // Primary is rate limited; the fallback has its own quota, so try it.
            options.logger.warn('primary model rate limited, trying fallback', { externalId: job.externalId });
            continue;
          }
          if (isRateLimit) {
            quotaExhausted = true;
            stats.stoppedOnRateLimit = true;
            options.logger.warn('both models rate limited; stopping enrichment for this run', {
              externalId: job.externalId,
            });
            return;
          }
          if (!isFallback) {
            options.logger.warn('primary model failed, trying fallback', {
              externalId: job.externalId,
              err: message.slice(0, 200),
            });
            continue;
          }
          options.logger.warn('enrichment failed for job; leaving PENDING', {
            externalId: job.externalId,
            err: message.slice(0, 200),
          });
        }
      }

      stats.failed += 1;
    }),
  );

  await Promise.allSettled(tasks);

  const lastRateLimit = rateLimits.length > 0 ? rateLimits[rateLimits.length - 1] : undefined;
  if (lastRateLimit) {
    options.logger.info('enrichment finished', {
      ...stats,
      quotaLimit: lastRateLimit.limit,
      quotaRemaining: lastRateLimit.remaining,
      quotaResetsAt: lastRateLimit.resetAt
        ? new Date(lastRateLimit.resetAt * 1000).toISOString()
        : null,
    });
  } else {
    options.logger.info('enrichment finished', { ...stats });
  }

  return { insights, stats };
}
