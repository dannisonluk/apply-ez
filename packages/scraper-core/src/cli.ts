import pino from 'pino';
import { getAdapter } from './adapters/registry.js';
import type { ScrapeContext } from './adapters/adapter.interface.js';
import { backfillRawJobs } from './lib/job-backfill.js';
import { enrichJobsWithSummary } from './lib/job-enrichment.js';
import { prepareJobsForIngest } from './lib/job-pipeline.js';
import { standardizeJobs } from './lib/job-standardizer.js';
import { defaultEnrichOptions, enrichJobs } from './lib/llm/enrich.js';
import type { StoredInsight } from './lib/llm/schema.js';
import { notifyNewJobs } from './notify.js';
import { JobStore } from './store.js';
import { enabledTargets, getTarget, SCRAPE_TARGETS, type ScrapeTarget } from './targets.js';

/** Every target here is the company's own careers site. */
const JOB_SOURCE = 'COMPANY_WEBSITE';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: null,
});

interface CliOptions {
  targets: ScrapeTarget[];
  dryRun: boolean;
  full: boolean;
  list: boolean;
  /** Run the OpenRouter summariser. Disabled with `--no-enrich`. */
  enrich: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const targetIds: string[] = [];
  let dryRun = false;
  let full = false;
  let list = false;
  let enrich = true;

  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '--verify') dryRun = true;
    else if (arg === '--full') full = true;
    else if (arg === '--list') list = true;
    else if (arg === '--no-enrich') enrich = false;
    else if (arg.startsWith('--target=')) targetIds.push(arg.slice('--target='.length));
    else if (arg === '--all') targetIds.length = 0;
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
  }

  let targets: ScrapeTarget[];
  if (targetIds.length === 0) {
    targets = enabledTargets();
  } else {
    targets = targetIds.map((id) => {
      const target = getTarget(id);
      if (!target) {
        throw new Error(
          `Unknown target "${id}". Known targets: ${SCRAPE_TARGETS.map((t) => t.id).join(', ')}`,
        );
      }
      return target;
    });
  }

  return { targets, dryRun, full, list, enrich };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

interface TargetRunResult {
  targetId: string;
  adapter: string;
  scraped: number;
  dropped: number;
  duplicates: number;
  inserted: number;
  updated: number;
  errors: number;
  filled: Record<string, number>;
  stillMissing: Record<string, number>;
  enriched: number;
  enrichFailed: number;
  enrichSkipped: number;
  pushed: number;
}

async function runTarget(
  target: ScrapeTarget,
  options: { dryRun: boolean; full: boolean; store: JobStore | null; enrich: boolean },
): Promise<TargetRunResult> {
  const adapter = getAdapter(target.adapter);
  if (!adapter) {
    throw new Error(`No adapter registered for "${target.adapter}" (target ${target.id})`);
  }

  const startedAt = new Date().toISOString();
  const targetLogger = logger.child({ target: target.id, adapter: target.adapter });

  const config: Record<string, unknown> = {
    ...target.config,
    ...(options.full ? { fullCrawl: true } : {}),
  };

  const ctx: ScrapeContext = {
    targetId: target.id,
    urlTemplate: target.entryUrls[0],
    entryUrls: target.entryUrls,
    config,
    region: target.region,
    logger: {
      info: (message, context) => targetLogger.info(context ?? {}, message),
      warn: (message, context) => targetLogger.warn(context ?? {}, message),
      error: (message, context) => targetLogger.error(context ?? {}, message),
    },
  };

  targetLogger.info({ entryUrls: target.entryUrls, full: options.full }, 'scrape started');
  const scraped = await adapter.scrape(ctx);

  // 1. Backfill gaps BEFORE the pipeline strips description text.
  const backfilled = backfillRawJobs(scraped.jobs, { locationFallback: 'Hong Kong' });

  // 2. Normalize + validate + de-duplicate.
  const prepared = prepareJobsForIngest(backfilled.jobs, {
    logger: {
      warn: (message, context) => targetLogger.warn(context ?? {}, message),
    },
  });

  // 3. Deterministic enrichment (classification, tags, contract/schedule hints).
  const enriched = await enrichJobsWithSummary(prepared.jobs);

  // 4. Final tidy of topMetadata (deadline formatting).
  const jobs = standardizeJobs(enriched.jobs);

  targetLogger.info(
    {
      scraped: scraped.jobs.length,
      dropped: prepared.dropped.length,
      duplicates: prepared.duplicateCount,
      ready: jobs.length,
      adapterErrors: scraped.errors.length,
      backfillFilled: backfilled.stats.filled,
      backfillStillMissing: backfilled.stats.stillMissing,
    },
    'pipeline completed',
  );

  if (scraped.errors.length > 0) {
    targetLogger.warn({ errors: scraped.errors.slice(0, 5) }, 'adapter reported errors');
  }
  if (backfilled.stats.stillMissing.experienceMin > 0 || backfilled.stats.stillMissing.applicationDeadline > 0) {
    targetLogger.warn({ samples: backfilled.stats.samples }, 'fields still missing after backfill');
  }

  const result: TargetRunResult = {
    targetId: target.id,
    adapter: target.adapter,
    scraped: scraped.jobs.length,
    dropped: prepared.dropped.length,
    duplicates: prepared.duplicateCount,
    inserted: 0,
    updated: 0,
    errors: scraped.errors.length,
    filled: backfilled.stats.filled,
    stillMissing: backfilled.stats.stillMissing,
    enriched: 0,
    enrichFailed: 0,
    enrichSkipped: 0,
    pushed: 0,
  };

  if (!options.store) {
    // Dry run: show what would be written so adapter quality is inspectable.
    const sample = jobs.slice(0, 8).map((job) => ({
      title: job.title.slice(0, 60),
      location: job.location ?? null,
      employmentType: job.employmentType ?? null,
      department: job.department ?? null,
      experienceMin: job.experienceMin ?? null,
      deadline: job.applicationDeadline ?? null,
    }));
    logger.info({ target: target.id, sample }, 'dry run sample');

    // Enrichment also runs in dry-run mode so the prompt and the chosen model can
    // be evaluated without writing anything.
    if (options.enrich) {
      const enrichOptions = defaultEnrichOptions(targetLogger);
      if (!enrichOptions) {
        targetLogger.warn('OPENROUTER_API_KEY is not set — skipping LLM enrichment');
      } else {
        const { insights, stats } = await enrichJobs(backfilled.jobs, new Set(), enrichOptions);
        result.enriched = stats.succeeded;
        result.enrichFailed = stats.failed;
        result.enrichSkipped =
          stats.skippedKnown + stats.skippedNoDescription + stats.skippedOverCap;
        const preview = [...insights.entries()].slice(0, 3).map(([externalId, insight]) => ({
          externalId,
          summary: insight.summary,
          yoe: `${insight.yoeMin ?? '?'}-${insight.yoeMax ?? '?'}`,
          deadline: insight.deadline ?? null,
          skills: insight.skills.slice(0, 8),
          flags: insight.flags,
        }));
        logger.info({ target: target.id, preview }, 'dry run enrichment sample');
      }
    }
    return result;
  }

  const store = options.store;

  const companyId = await store.upsertCompany({
    slug: target.companySlug,
    name: target.companyName,
    domain: target.companyDomain,
    careersUrl: target.entryUrls[0] ?? '',
  });

  // Enrichment must read the RAW jobs: `prepareJobsForIngest` has already stripped
  // `description` by this point, and the JD text is the whole input to the prompt.
  const existingExternalIds = await store.listExistingExternalIds(companyId, JOB_SOURCE);
  let insights: Map<string, StoredInsight> | undefined;

  if (options.enrich) {
    const enrichOptions = defaultEnrichOptions(targetLogger);
    if (!enrichOptions) {
      targetLogger.warn('OPENROUTER_API_KEY is not set — skipping LLM enrichment');
    } else {
      const pending = await store.listEnrichmentPendingIds(companyId, JOB_SOURCE);
      // Summarise what is new, and retry what previously failed. Everything else
      // is left untouched so the daily quota is spent only on unseen postings.
      const alreadySummarised = new Set(
        [...existingExternalIds].filter((externalId) => !pending.has(externalId)),
      );
      const { insights: produced, stats } = await enrichJobs(
        backfilled.jobs,
        alreadySummarised,
        enrichOptions,
      );
      insights = produced;
      result.enriched = stats.succeeded;
      result.enrichFailed = stats.failed;
      result.enrichSkipped =
        stats.skippedKnown + stats.skippedNoDescription + stats.skippedOverCap;
    }
  }

  const upserted = await store.upsertJobs(companyId, JOB_SOURCE, jobs, {
    existingExternalIds,
    ...(insights ? { insights } : {}),
  });
  result.inserted = upserted.inserted;
  result.updated = upserted.updated;

  if (upserted.newExternalIds.length > 0) {
    targetLogger.info({ newJobs: upserted.newExternalIds.length }, 'new jobs found');

    // Notify after the write succeeds, so a device is never told about a job that
    // failed to persist.
    const notified = await notifyNewJobs({
      store,
      jobs,
      newExternalIds: upserted.newExternalIds,
      logger: targetLogger,
    });
    if (notified) result.pushed = notified.accepted;
  }

  if (options.full && config.reconcileMissingJobs === true) {
    const reconciled = await store.reconcileMissing({
      companyId,
      source: JOB_SOURCE,
      seenExternalIds: jobs.map((job) => job.externalId),
      runStartedAt: startedAt,
      expireAfterMissingRuns: Number(process.env.SCRAPER_EXPIRE_AFTER_MISSING_RUNS ?? 2),
    });
    targetLogger.info(reconciled, 'reconcile completed');
  }

  await store.recordRun({
    targetId: target.id,
    adapter: target.adapter,
    startedAt,
    finishedAt: new Date().toISOString(),
    inserted: result.inserted,
    updated: result.updated,
    total: jobs.length,
    errorCount: scraped.errors.length,
    errors: scraped.errors.map((error) => error.message),
  });

  return result;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    for (const target of SCRAPE_TARGETS) {
      process.stdout.write(
        `${target.id.padEnd(18)} ${target.adapter.padEnd(20)} ${target.enabled ? 'enabled' : 'disabled'}\n`,
      );
    }
    return;
  }

  const store = options.dryRun
    ? null
    : new JobStore({
        url: requireEnv('SUPABASE_URL'),
        serviceKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
      });

  if (options.dryRun) {
    logger.warn('dry run — nothing will be written to Supabase');
  }

  const results: TargetRunResult[] = [];
  const failures: Array<{ targetId: string; error: string }> = [];

  for (const target of options.targets) {
    try {
      results.push(
        await runTarget(target, {
          dryRun: options.dryRun,
          full: options.full,
          store,
          enrich: options.enrich,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ target: target.id, err: message }, 'target failed');
      failures.push({ targetId: target.id, error: message });
      // Keep going: one broken careers site must not abort the whole run.
    }
  }

  const summary = {
    targets: options.targets.length,
    ok: results.length,
    failed: failures.length,
    scraped: results.reduce((sum, r) => sum + r.scraped, 0),
    ready: results.reduce((sum, r) => sum + r.inserted + r.updated, 0),
    inserted: results.reduce((sum, r) => sum + r.inserted, 0),
    updated: results.reduce((sum, r) => sum + r.updated, 0),
    dropped: results.reduce((sum, r) => sum + r.dropped, 0),
    adapterErrors: results.reduce((sum, r) => sum + r.errors, 0),
    enriched: results.reduce((sum, r) => sum + r.enriched, 0),
    enrichFailed: results.reduce((sum, r) => sum + r.enrichFailed, 0),
    pushed: results.reduce((sum, r) => sum + r.pushed, 0),
  };
  logger.info(summary, 'run complete');
  if (failures.length > 0) logger.warn({ failures }, 'targets that failed');

  process.exitCode = failures.length === options.targets.length ? 1 : 0;
}

main().catch((error) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, 'fatal');
  process.exit(1);
});
