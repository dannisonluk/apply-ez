/**
 * Throwaway diagnostic: dump raw Cathay adapter output so field-quality bugs can
 * be diagnosed from real data instead of guessed at from log summaries.
 *
 *   npx tsx scripts/probe-cathay.ts
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(candidate) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(candidate);
      break;
    } catch {
      /* ignore */
    }
  }
}

const { getAdapter } = await import('../src/adapters/registry.js');

const adapter = getAdapter('cathaypacific');
if (!adapter) throw new Error('cathaypacific adapter not registered');

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const result = await adapter.scrape({
  targetId: 'cathay-pacific',
  urlTemplate: 'https://careers.cathaypacific.com/en/careers/jobs?keyword=&sortby=date',
  entryUrls: ['https://careers.cathaypacific.com/en/careers/jobs?keyword=&sortby=date'],
  config: {},
  region: 'Hong Kong',
  logger: silent,
});

const jobs = result.jobs;
console.log(`\n=== ${jobs.length} raw jobs, ${result.errors.length} adapter errors ===\n`);

const INTERN_RE = /\b(intern|internship|trainee|placement|summer\s+analyst)\b/i;
const CONTRACT_RE = /\b(fixed[\s-]?term|contract(?:or)?|temporary|temp\b|locum|secondment)\b/i;
const PERM_RE = /\b(permanent|full[\s-]?time|regular\s+staff)\b/i;

let internHits = 0;
let titleHasIntern = 0;
let descHasIntern = 0;

for (const job of jobs.slice(0, 12)) {
  const title = String(job.title ?? '');
  const desc = String(job.description ?? '');
  console.log('─'.repeat(100));
  console.log('title       :', JSON.stringify(title));
  console.log('  title len :', title.length);
  console.log('  location  :', JSON.stringify(job.location));
  console.log('  dept      :', JSON.stringify(job.department));
  console.log('  rawEmpType:', JSON.stringify(job.rawEmploymentType));
  console.log('  empType   :', JSON.stringify(job.employmentType));
  console.log('  expMin    :', job.experienceMin);
  console.log('  deadline  :', JSON.stringify(job.applicationDeadline));
  console.log('  url       :', job.url);
  console.log('  desc len  :', desc.length);
  console.log('  desc head :', JSON.stringify(desc.slice(0, 260)));
  if (INTERN_RE.test(title)) console.log('  >> title matches INTERN');
  if (INTERN_RE.test(desc)) console.log('  >> DESC MATCHES INTERN');
}

console.log('\n=== aggregate over all jobs ===');
for (const job of jobs) {
  const title = String(job.title ?? '');
  const desc = String(job.description ?? '');
  if (INTERN_RE.test(`${title}\n${desc}`)) internHits += 1;
  if (INTERN_RE.test(title)) titleHasIntern += 1;
  if (INTERN_RE.test(desc)) descHasIntern += 1;
}
console.log({ total: jobs.length, internHits, titleHasIntern, descHasIntern });

// Where exactly does the intern word appear in a description?
const sample = jobs.find((job) => INTERN_RE.test(String(job.description ?? '')));
if (sample) {
  const desc = String(sample.description ?? '');
  const m = INTERN_RE.exec(desc);
  console.log('\n=== intern match context (first hit) ===');
  console.log(JSON.stringify(desc.slice(Math.max(0, (m?.index ?? 0) - 120), (m?.index ?? 0) + 160)));
}

// Does any description contain site navigation / footer chrome?
const chromeWords = ['Cookie', 'Privacy Policy', 'Sign in', 'Newsletter', 'Sitemap', 'Equal Opportunities'];
for (const word of chromeWords) {
  const hits = jobs.filter((job) => String(job.description ?? '').includes(word)).length;
  console.log(`chrome "${word}": ${hits}/${jobs.length}`);
}

// Title pollution check: does the title contain a location or employment-type word?
const POLLUTED = /(Hong Kong SAR|\(China\)|Permanent$|Contract$|Full[- ]?time$)/i;
const polluted = jobs.filter((job) => POLLUTED.test(String(job.title ?? '')));
console.log(`\npotentially polluted titles: ${polluted.length}/${jobs.length}`);
for (const job of polluted.slice(0, 6)) console.log('  -', JSON.stringify(job.title));

const longTitles = jobs.filter((job) => String(job.title ?? '').length > 70);
console.log(`titles longer than 70 chars: ${longTitles.length}/${jobs.length}`);
for (const job of longTitles.slice(0, 6)) console.log('  -', JSON.stringify(job.title));
