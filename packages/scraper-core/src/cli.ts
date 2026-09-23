import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import { getAdapter } from './adapters/registry.js';
import type { ScrapeContext } from './adapters/adapter.interface.js';
import { backfillRawJobs } from './lib/job-backfill.js';
import { enrichJobsWithSummary } from './lib/job-enrichment.js';
import { prepareJobsForIngest } from './lib/job-pipeline.js';
import { standardizeJobs } from './lib/job-standardizer.js';
import { defaultEnrichOptions, enrichJobs } from './lib/llm/enrich.js';
import type { StoredInsight } from './lib/llm/schema.js';
import { DEFAULT_MIN_RELEVANCE, scoreRelevance } from './lib/relevance.js';
import { notifyNewJobs } from './notify.js';
import { JobStore } from './store.js';
import type { JobIngest } from './types/index.js';
import { enabledTargets, getTarget, SCRAPE_TARGETS, type ScrapeTarget } from './targets.js';

/**
 * Load `.env` before anything reads `process.env`.
 *
 * Must run before the logger below, which captures LOG_LEVEL at module scope.
 * In CI there is no `.env` and the real environment variables are used instead, so
 * a missing file is not an error.
 */
function loadDotEnv(): void {
  if (typeof process.loadEnvFile !== 'function') return;
  // Depends on the working directory: the package root when run via pnpm, the
  // repository root when run from there.
  for (const candidate of [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      // Unreadable or malformed: fall through and rely on the real environment.
    }
  }
}

loadDotEnv();

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
  relevance: RelevanceStats;
}

export interface RelevanceStats {
  scored: number;
  /** Jobs at or above the display threshold. */
  relevant: number;
  /** Jobs below it — still written, just hidden by default in the app. */
  filtered: number;
  /** Jobs that hit the hard blocklist (score 0). */
  blocklisted: number;
  byFamily: Record<string, number>;
  minRelevance: number;
}

/**
 * Score every job's relevance and write the result onto the ingest payload.
 *
 * Deliberately a pure annotation step: nothing is dropped, and a low score is
 * recorded alongside the reason that produced it. Deleting rows here would make a
 * mis-tuned rule silently lose a job you wanted, with nothing left to debug.
 *
 * When `insights` is supplied the LLM's seniority / years-of-experience take
 * precedence over the deterministic guesses, because the model has read the JD.
 */
function applyRelevance(
  jobs: JobIngest[],
  insights?: Map<string, StoredInsight> | undefined,
): RelevanceStats {
  const byFamily: Record<string, number> = {};
  const minRelevance = Number.parseInt(process.env.JOB_MIN_RELEVANCE ?? '', 10);
  const threshold = Number.isFinite(minRelevance) ? minRelevance : DEFAULT_MIN_RELEVANCE;

  let relevant = 0;
  let filtered = 0;
  let blocklisted = 0;

  for (const job of jobs) {
    const insight = insights?.get(job.externalId);

    const result = scoreRelevance({
      title: job.title,
      department: job.department ?? null,
      seniority: insight?.seniority ?? job.classification?.seniority ?? null,
      yoeMin: insight?.yoeMin ?? job.experienceMin ?? null,
    });

    job.relevanceScore = result.score;
    job.roleFamily = result.family;
    // `exactOptionalPropertyTypes` is on, so never assign an explicit undefined.
    if (result.reason !== null) job.filterReason = result.reason;

    byFamily[result.family] = (byFamily[result.family] ?? 0) + 1;
    if (result.score >= threshold) relevant += 1;
    else filtered += 1;
    if (result.score === 0) blocklisted += 1;
  }

  return { scored: jobs.length, relevant, filtered, blocklisted, byFamily, minRelevance: threshold };
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

  // The enrich logger takes (message, context); pino takes (context, message).
  // Passing pino straight through is accepted and silently drops every structured
  // field, which is how enrichment failures became unreadable — the log said
  // "leaving PENDING" and nothing else, with no model, no external id and no
  // reason. The adapter loggers above are swapped the same way.
  const enrichLogger = {
    info: (message: string, context?: Record<string, unknown>) =>
      targetLogger.info(context ?? {}, message),
    warn: (message: string, context?: Record<string, unknown>) =>
      targetLogger.warn(context ?? {}, message),
  };

  const config: Record<string, unknown> = {
    ...target.config,
    ...(options.full ? { fullCrawl: true } : {}),
  };

  // Resolve the company and what is already stored BEFORE the crawl, not after.
  // An incremental run has to hand the adapter the known-id set so it can skip the
  // detail pages for postings it already has; doing this after `adapter.scrape` —
  // which is where it used to live — makes that impossible. `upsertCompany` is
  // idempotent, so moving it earlier costs nothing.
  //
  // A dry run has no store and therefore no known-id set, which keeps `--dry-run` a
  // full crawl: the point of a dry run is to see what the site actually has.
  let companyId: string | null = null;
  let existingExternalIds = new Set<string>();
  if (options.store) {
    companyId = await options.store.upsertCompany({
      slug: target.companySlug,
      name: target.companyName,
      domain: target.companyDomain,
      careersUrl: target.entryUrls[0] ?? '',
    });
    existingExternalIds = await options.store.listExistingExternalIds(companyId, JOB_SOURCE);
  }

  // `--full` is the only mode that gets a complete crawl. `reconcileMissing` infers
  // "absent from the listing ⇒ missing ⇒ eventually EXPIRED", so handing it a
  // truncated listing would retire live postings — the incremental set is withheld
  // there on purpose.
  const incremental = options.store !== null && !options.full;

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
    ...(incremental ? { knownExternalIds: existingExternalIds } : {}),
  };

  targetLogger.info(
    {
      entryUrls: target.entryUrls,
      full: options.full,
      incremental,
      known: incremental ? existingExternalIds.size : 0,
    },
    'scrape started',
  );
  const scraped = await adapter.scrape(ctx);

  // An incremental run returns the newest-first window, including postings we
  // already have. Drop those before anything downstream sees them.
  //
  // This is the load-bearing part of the incremental mode, and it lives here rather
  // than inside each adapter on purpose. The upsert writes `application_deadline`,
  // `apply_url` and `work_schedule` as `?? null`, so a posting written from a
  // listing-only view — no detail page fetched — would have its stored deadline and
  // apply URL erased. Filtering once here means an adapter cannot get that wrong
  // twelve times over; and because known postings never reach the upsert, skipping
  // their detail fetches is safe rather than destructive.
  const fresh = incremental
    ? scraped.jobs.filter((job) => !existingExternalIds.has(job.externalId))
    : scraped.jobs;

  if (incremental) {
    targetLogger.info(
      {
        listed: scraped.jobs.length,
        alreadyStored: scraped.jobs.length - fresh.length,
        fresh: fresh.length,
      },
      'incremental run: already-stored postings filtered out',
    );
  }

  // 1. Backfill gaps BEFORE the pipeline strips description text.
  const backfilled = backfillRawJobs(fresh, { locationFallback: 'Hong Kong' });

  // 2. Normalize + validate + scope + de-duplicate.
  //
  // `hongKongOnly` is on for every target: this board is a Hong Kong job board, and
  // the per-target location filters the adapters rely on are not airtight. See
  // `lib/location-scope.ts` for the leak that motivated it and why the rule is a
  // denylist rather than an allowlist.
  const prepared = prepareJobsForIngest(backfilled.jobs, {
    hongKongOnly: true,
    logger: {
      warn: (message, context) => targetLogger.warn(context ?? {}, message),
    },
  });

  // 3. Deterministic enrichment (classification, tags, contract/schedule hints).
  const enriched = await enrichJobsWithSummary(prepared.jobs);

  // 4. Final tidy of topMetadata (deadline formatting).
  const jobs = standardizeJobs(enriched.jobs);

  // 5. Relevance scoring. Runs on the finalized rows so it sees the department and
  //    employment type the backfill recovered. Re-scored after LLM enrichment once
  //    the model's seniority / YOE reading is available.
  const relevance = applyRelevance(jobs);

  // Reported with their locations, because the only way to know the denylist is
  // still adequate is to see what it rejected. A silent drop here would be
  // indistinguishable from an adapter that found nothing.
  const outOfScope = prepared.dropped.filter((entry) => entry.stage === 'scope');

  targetLogger.info(
    {
      scraped: fresh.length,
      dropped: prepared.dropped.length,
      outOfScope: outOfScope.length,
      duplicates: prepared.duplicateCount,
      ready: jobs.length,
      adapterErrors: scraped.errors.length,
      backfillFilled: backfilled.stats.filled,
      backfillStillMissing: backfilled.stats.stillMissing,
      relevance: {
        relevant: relevance.relevant,
        filtered: relevance.filtered,
        blocklisted: relevance.blocklisted,
      },
    },
    'pipeline completed',
  );

  if (outOfScope.length > 0) {
    targetLogger.warn(
      {
        count: outOfScope.length,
        samples: outOfScope.slice(0, 10).map((entry) => ({
          title: entry.title,
          location: entry.location,
        })),
      },
      'dropped postings outside Hong Kong',
    );
  }

  if (scraped.errors.length > 0) {
    targetLogger.warn({ errors: scraped.errors.slice(0, 5) }, 'adapter reported errors');
  }
  if (backfilled.stats.stillMissing.experienceMin > 0 || backfilled.stats.stillMissing.applicationDeadline > 0) {
    targetLogger.warn({ samples: backfilled.stats.samples }, 'fields still missing after backfill');
  }

  const result: TargetRunResult = {
    targetId: target.id,
    adapter: target.adapter,
    scraped: fresh.length,
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
    relevance,
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
      const enrichOptions = defaultEnrichOptions(enrichLogger);
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

  // `companyId` and `existingExternalIds` were resolved before the crawl — see the
  // note above `adapter.scrape`. Nothing to re-resolve here.
  if (!companyId) throw new Error('internal: companyId was not resolved before the crawl');

  // ── Write first, enrich second ──────────────────────────────────────────────
  // The database write deliberately happens BEFORE the LLM stage. Enrichment is
  // the slowest and least reliable step of a run — a free-tier model can be rate
  // limited, geo-blocked or simply absent — and a 6-hourly ingest must never be
  // held up by it. Rows land with `enrich_status = 'PENDING'` and are patched in
  // below; anything the model did not reach stays PENDING and is retried on the
  // next run, which is already how the retry mechanism works.
  const upserted = await store.upsertJobs(companyId, JOB_SOURCE, jobs, { existingExternalIds });
  result.inserted = upserted.inserted;
  result.updated = upserted.updated;

  // Logged explicitly, and before the LLM stage starts, so the log alone proves the
  // ingest is not waiting on a model. Worth having: this is the invariant that a
  // future reorder would silently break.
  targetLogger.info(
    { inserted: upserted.inserted, updated: upserted.updated, total: jobs.length },
    'jobs written',
  );

  if (upserted.newExternalIds.length > 0) {
    targetLogger.info({ newJobs: upserted.newExternalIds.length }, 'new jobs found');

    // Notify as soon as the write succeeds. The notice carries only titles and the
    // company name, so there is nothing to gain by waiting for a summary — and a
    // device is still never told about a job that failed to persist.
    const notified = await notifyNewJobs({
      store,
      jobs,
      newExternalIds: upserted.newExternalIds,
      logger: targetLogger,
    });
    if (notified) result.pushed = notified.accepted;
  }

  if (options.enrich) {
    const enrichOptions = defaultEnrichOptions(enrichLogger);
    if (!enrichOptions) {
      targetLogger.warn('OPENROUTER_API_KEY is not set — skipping LLM enrichment');
    } else {
      // Enrichment reads the RAW jobs: `prepareJobsForIngest` has already stripped
      // `description`, and the JD text is the whole input to the prompt.
      const pending = await store.listEnrichmentPendingIds(companyId, JOB_SOURCE);
      // Summarise what is new, and retry what previously failed. Everything else
      // is left untouched so the daily quota is spent only on unseen postings.
      const alreadySummarised = new Set(
        [...existingExternalIds].filter((externalId) => !pending.has(externalId)),
      );
      const { insights, stats } = await enrichJobs(
        backfilled.jobs,
        alreadySummarised,
        enrichOptions,
      );
      result.enriched = stats.succeeded;
      result.enrichFailed = stats.failed;
      result.enrichSkipped =
        stats.skippedKnown + stats.skippedNoDescription + stats.skippedOverCap;

      // Re-score using the model's seniority / years-of-experience, which beat the
      // deterministic title heuristics because the model actually read the JD.
      if (insights.size > 0) {
        const refined = applyRelevance(jobs, insights);
        result.relevance = refined;
        targetLogger.info(
          {
            relevant: refined.relevant,
            filtered: refined.filtered,
            blocklisted: refined.blocklisted,
            byFamily: refined.byFamily,
          },
          'relevance re-scored with LLM signals',
        );

        const patched = await store.applyEnrichment({
          companyId,
          source: JOB_SOURCE,
          insights,
          jobs,
        });
        targetLogger.info({ patched, failed: stats.failed }, 'enrichment written');
      }
    }
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
    relevanceFiltered: results.reduce((sum, r) => sum + r.relevance.filtered, 0),
    relevanceBlocklisted: results.reduce((sum, r) => sum + r.relevance.blocklisted, 0),
  };
  logger.info(summary, 'run complete');
  if (failures.length > 0) logger.warn({ failures }, 'targets that failed');

  process.exitCode = failures.length === options.targets.length ? 1 : 0;
}

main().catch((error) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, 'fatal');
  process.exit(1);
});
