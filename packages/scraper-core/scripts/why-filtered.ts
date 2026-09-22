/**
 * Show what the relevance filter hides, and why.
 *
 *   npx tsx scripts/why-filtered.ts <targetId>
 *   pnpm --filter @apply-ez/scraper-core why:filtered axa
 *
 * Exists because "filtered: 24" in a run summary tells you nothing about whether
 * the right 24 were dropped. This scrapes a live target, scores every posting, and
 * prints the hidden ones with their family and the exact reason string, so the
 * rules in `lib/relevance.ts` can be judged against real titles rather than
 * hand-picked ones.
 *
 * Reads only. Writes nothing to the database and sends no notifications.
 */
import { getAdapter } from '../src/adapters/registry.js';
import type { ScrapeContext } from '../src/adapters/adapter.interface.js';
import { backfillRawJobs } from '../src/lib/job-backfill.js';
import { prepareJobsForIngest } from '../src/lib/job-pipeline.js';
import { standardizeJobs } from '../src/lib/job-standardizer.js';
import { enrichJobsWithSummary } from '../src/lib/job-enrichment.js';
import { DEFAULT_MIN_RELEVANCE, scoreRelevance } from '../src/lib/relevance.js';
import { getTarget } from '../src/targets.js';

const targetId = process.argv[2];
if (!targetId) {
  console.error('usage: tsx scripts/why-filtered.ts <targetId>   (see src/targets.ts)');
  process.exit(1);
}

const target = getTarget(targetId);
if (!target) throw new Error(`unknown target "${targetId}"`);

const adapter = getAdapter(target.adapter);
if (!adapter) throw new Error(`no adapter registered as "${target.adapter}"`);

const noop = (): void => {};
const ctx: ScrapeContext = {
  targetId: target.id,
  urlTemplate: target.entryUrls[0],
  entryUrls: target.entryUrls,
  config: target.config,
  region: target.region,
  logger: { info: noop, warn: noop, error: noop },
};

const scraped = await adapter.scrape(ctx);
const backfilled = backfillRawJobs(scraped.jobs, { locationFallback: 'Hong Kong' });
const prepared = prepareJobsForIngest(backfilled.jobs, { logger: { warn: noop } });
const enriched = await enrichJobsWithSummary(prepared.jobs);
const jobs = standardizeJobs(enriched.jobs);

interface Row {
  score: number;
  family: string;
  reason: string | null;
  title: string;
}

const rows: Row[] = jobs.map((job) => {
  const result = scoreRelevance({
    title: job.title,
    department: job.department ?? null,
    seniority: job.classification?.seniority ?? null,
    yoeMin: job.experienceMin ?? null,
  });
  return { score: result.score, family: result.family, reason: result.reason, title: job.title };
});

rows.sort((a, b) => a.score - b.score);
const hidden = rows.filter((row) => row.score < DEFAULT_MIN_RELEVANCE);
const shown = rows.filter((row) => row.score >= DEFAULT_MIN_RELEVANCE);

console.log(
  `\n${target.id}: ${rows.length} postings, ${shown.length} shown, ${hidden.length} hidden ` +
    `(threshold ${DEFAULT_MIN_RELEVANCE})\n`,
);

console.log('── HIDDEN ───────────────────────────────────────────────────────────────');
for (const row of hidden) {
  console.log(`${String(row.score).padStart(3)}  ${row.family.padEnd(17)} ${row.title.slice(0, 60)}`);
  if (row.reason) console.log(`     ${row.reason}`);
}

console.log('\n── SHOWN, lowest 15 ─────────────────────────────────────────────────────');
for (const row of shown.slice(0, 15)) {
  console.log(`${String(row.score).padStart(3)}  ${row.family.padEnd(17)} ${row.title.slice(0, 60)}`);
}

console.log('\n── family histogram ─────────────────────────────────────────────────────');
const histogram = new Map<string, number>();
for (const row of rows) histogram.set(row.family, (histogram.get(row.family) ?? 0) + 1);
for (const [family, count] of [...histogram].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(3)}  ${family}`);
}
console.log();
