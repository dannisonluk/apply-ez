/**
 * Dump what the Workday adapter actually returns for a real tenant.
 *
 *   tsx scripts/probe-workday.ts aia
 *   tsx scripts/probe-workday.ts manulife
 *
 * Kept in the repo on purpose. The lesson from the Cathay adapter was that a
 * filled field is not a correct field — the old run reported 45/45 employment
 * types and every one was wrong, which no amount of reading the code revealed.
 * Dumping the real output is what catches that, so every adapter gets a probe.
 */
import { SCRAPE_TARGETS } from '../src/targets.js';
import { getAdapter } from '../src/adapters/registry.js';
import type { ScrapeContext } from '../src/adapters/adapter.interface.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function main() {
  const wanted = process.argv[2] ?? 'aia';
  const target = SCRAPE_TARGETS.find((candidate) => candidate.id === wanted);
  if (!target) {
    console.error(`No target "${wanted}". Available: ${SCRAPE_TARGETS.map((t) => t.id).join(', ')}`);
    process.exit(1);
  }

  const adapter = getAdapter(target.adapter);
  if (!adapter) {
    console.error(`No adapter "${target.adapter}"`);
    process.exit(1);
  }

  const ctx: ScrapeContext = {
    targetId: target.id,
    urlTemplate: undefined,
    entryUrls: target.entryUrls,
    config: target.config,
    region: target.region,
    logger: silentLogger,
  };

  const started = Date.now();
  const result = await adapter.scrape(ctx);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`adapter=${adapter.name} target=${target.id}`);
  console.log(`jobs=${result.jobs.length} errors=${result.errors.length} in ${elapsed}s`);
  if (result.errors.length > 0) {
    console.log('errors:');
    for (const error of result.errors.slice(0, 10)) console.log('  ' + error.message);
  }

  // Field coverage — the thing that would have caught the Cathay bug.
  const fields = [
    'location',
    'department',
    'employmentType',
    'workSchedule',
    'applicationDeadline',
    'experienceMin',
    'description',
  ] as const;
  const coverage: Record<string, number> = {};
  for (const field of fields) {
    coverage[field] = result.jobs.filter((job) => {
      const value = (job as Record<string, unknown>)[field];
      return value !== undefined && value !== null && value !== '';
    }).length;
  }
  console.log(`coverage of ${result.jobs.length}:`);
  for (const [field, count] of Object.entries(coverage)) {
    console.log(`  ${field.padEnd(20)} ${count}/${result.jobs.length}`);
  }

  console.log('\nfirst 3 rows:');
  for (const job of result.jobs.slice(0, 3)) {
    console.log(
      JSON.stringify(
        {
          externalId: job.externalId,
          title: job.title,
          location: job.location,
          employmentType: job.employmentType,
          workSchedule: job.workSchedule,
          deadline: job.applicationDeadline,
          publishedAt: job.publishedAt,
          descChars: job.description?.length ?? 0,
          url: job.url,
        },
        null,
        1,
      ),
    );
  }

  const deadlineHistogram: Record<string, number> = {};
  for (const job of result.jobs) {
    const key = job.applicationDeadline?.slice(0, 10) ?? '(none)';
    deadlineHistogram[key] = (deadlineHistogram[key] ?? 0) + 1;
  }
  console.log('\ndeadline distribution:', JSON.stringify(deadlineHistogram));
}

main();
