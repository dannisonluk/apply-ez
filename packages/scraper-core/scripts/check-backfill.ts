/**
 * Regression check for the deterministic backfill layer.
 *
 * Run with:  pnpm --filter @apply-ez/scraper-core exec tsx scripts/check-backfill.ts
 *
 * These are the exact shapes real adapters emit: Workday-based targets give almost
 * nothing, so most fields must be recovered from the title and detail description.
 */
import assert from 'node:assert/strict';
import type { RawJob } from '../src/adapters/adapter.interface.js';
import {
  inferApplicationDeadline,
  inferDepartment,
  inferEmploymentTypeLabel,
  inferExperienceMin,
} from '../src/lib/job-backfill.js';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
  } catch {
    failed += 1;
    console.error(`FAIL  ${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  }
}

// ─── experienceMin ────────────────────────────────────────────────────────────
check('exp: "5+ years" in title', inferExperienceMin('Senior Analyst (5+ years)'), 5);
check('exp: "at least 3 years"', inferExperienceMin('Analyst', 'You need at least 3 years in banking.'), 3);
check('exp: "3-5 years" range takes low end', inferExperienceMin('Engineer', 'Requires 3-5 years experience.'), 3);
check('exp: "minimum of 8 years"', inferExperienceMin('Director', 'A minimum of 8 years relevant experience.'), 8);
check('exp: Chinese "5年經驗"', inferExperienceMin('會計主任', '需具備5年相關經驗。'), 5);
check('exp: "experience of 7 years"', inferExperienceMin('Manager', 'Experience of 7 years is preferred.'), 7);
check('exp: intern -> 0', inferExperienceMin('Summer Intern, Technology'), 0);
check('exp: senior title fallback -> 5', inferExperienceMin('Senior Software Engineer'), 5);
check('exp: director title fallback -> 8', inferExperienceMin('Director, Risk Management'), 8);
check('exp: nothing -> undefined', inferExperienceMin('Analyst, Equities'), undefined);
check('exp: absurd number rejected', inferExperienceMin('Engineer', 'Over 99 years of history.'), undefined);

// ─── applicationDeadline ──────────────────────────────────────────────────────
const Y = new Date().getUTCFullYear();
check(
  'deadline: ISO form',
  inferApplicationDeadline(`Application deadline: ${Y}-10-31`),
  new Date(Date.UTC(Y, 9, 31)).toISOString(),
);
check(
  'deadline: day-first form',
  inferApplicationDeadline(`Closing date: 31/10/${Y}`),
  new Date(Date.UTC(Y, 9, 31)).toISOString(),
);
check(
  'deadline: month-name form',
  inferApplicationDeadline(`Closing date: 31 October ${Y}`),
  new Date(Date.UTC(Y, 9, 31)).toISOString(),
);
check(
  'deadline: US month-first form',
  inferApplicationDeadline(`Apply before October 31, ${Y}`),
  new Date(Date.UTC(Y, 9, 31)).toISOString(),
);
check(
  'deadline: Chinese form',
  inferApplicationDeadline(`截止日期：${Y}年10月31日`),
  new Date(Date.UTC(Y, 9, 31)).toISOString(),
);
check('deadline: no cue -> undefined', inferApplicationDeadline('Posted on 2026-10-31'), undefined);
check('deadline: implausible year rejected', inferApplicationDeadline('Deadline: 1999-01-01'), undefined);

// ─── department ───────────────────────────────────────────────────────────────
check('dept: engineer', inferDepartment('Backend Engineer'), 'Engineering');
check('dept: data scientist', inferDepartment('Data Scientist'), 'Data & Analytics');
check('dept: business analyst', inferDepartment('Business Analyst, Wealth'), 'Data & Analytics');
check('dept: AML', inferDepartment('AML Compliance Officer'), 'Risk & Compliance');
check('dept: cabin crew', inferDepartment('Cabin Crew (Hong Kong)'), 'Flight Operations');
check('dept: accountant', inferDepartment('Senior Accountant'), 'Finance & Accounting');
check('dept: adapter value wins', inferDepartment('Backend Engineer', 'Platform Engineering'), 'Platform Engineering');

// ─── employmentType ───────────────────────────────────────────────────────────
check('emp: internship beats full-time', inferEmploymentTypeLabel('Summer Analyst', 'This is a full-time internship.'), 'Internship');
check('emp: contract beats full-time hours', inferEmploymentTypeLabel('Analyst', 'Full-time hours on a fixed-term contract.'), 'Contract');
check('emp: permanent', inferEmploymentTypeLabel('Analyst', 'This is a permanent, full-time role.'), 'Permanent');
check('emp: Chinese 合約', inferEmploymentTypeLabel('會計文員', '合約制，為期一年。'), 'Contract');
check('emp: Chinese 實習', inferEmploymentTypeLabel('市場推廣助理', '實習生計劃，為期三個月。'), 'Internship');
check('emp: nothing -> undefined', inferEmploymentTypeLabel('Analyst', 'Join our team in Hong Kong.'), undefined);

// ─── integration: a Workday-shaped job with nothing but title + URL ───────────
const { backfillRawJobs } = await import('../src/lib/job-backfill.js');

const sparseJob: RawJob = {
  source: 'COMPANY_WEBSITE',
  externalId: 'REQ-12345',
  title: 'Senior Business Analyst (5+ years)',
  url: 'https://example.com/jobs/12345',
  publishedAt: new Date().toISOString(),
  companyName: 'Example Bank',
  description: 'You will join the analytics team. At least 5 years of experience required. Closing date: 31 December ' + Y,
};

const { jobs, stats } = backfillRawJobs([sparseJob]);
const filledJob = jobs[0]!;

check('integration: location filled', filledJob.location, 'Hong Kong');
check('integration: experienceMin filled', filledJob.experienceMin, 5);
check('integration: department filled', filledJob.department, 'Data & Analytics');
check(
  'integration: deadline filled',
  filledJob.applicationDeadline,
  new Date(Date.UTC(Y, 11, 31)).toISOString(),
);
check('integration: filled counters', stats.filled.experienceMin, 1);
check('integration: nothing left missing for exp', stats.stillMissing.experienceMin, 0);

// Adapter-provided values must never be overwritten.
const explicit: RawJob = {
  ...sparseJob,
  location: 'Kowloon',
  experienceMin: 2,
  department: 'Finance & Accounting',
};
const { jobs: kept } = backfillRawJobs([explicit]);
check('integration: explicit location preserved', kept[0]!.location, 'Kowloon');
check('integration: explicit experienceMin preserved', kept[0]!.experienceMin, 2);
check('integration: explicit department preserved', kept[0]!.department, 'Finance & Accounting');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
