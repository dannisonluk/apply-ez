/**
 * Relevance-scoring assertions.
 *
 * Fixtures are REAL Cathay Pacific Hong Kong titles, taken from the live board via
 * `scripts/probe-cathay.ts`. That matters: the whole point of this layer is how it
 * behaves on the actual mix a careers site publishes, and hand-picked examples
 * would quietly avoid the awkward cases.
 *
 *   npx tsx scripts/check-relevance.ts
 */
import {
  DEFAULT_MIN_RELEVANCE,
  TARGET_FAMILIES,
  TARGET_YOE_MAX,
  TARGET_YOE_MIN,
  blocklistHit,
  relevanceBand,
  roleFamilyOf,
  scoreRelevance,
} from '../src/lib/relevance.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** Titles that should survive the filter. */
const SHOULD_KEEP: Array<[title: string, department: string]> = [
  // The three role targets, stated explicitly.
  ['Data Analyst', 'Digital & Information Technology'],
  ['Business Analyst, Digital Transformation', 'Digital & Information Technology'],
  ['Software Engineer (Backend)', 'Digital & Information Technology'],
  ['Senior Systems Analyst', 'Digital & Information Technology'],
  ['Analyst Programmer', 'Digital & Information Technology'],
  // An analytical role inside an operational division is still an analytical role:
  // DATA must outrank AVIATION_OPS or "Cargo Data Analyst" is written off as cargo.
  ['Data Analyst – Cargo Performance', 'Airport & Cargo Operations'],
  // The original Cathay fixtures.
  ['IT Security Assurance Lead (Assessment and Penetration Test) (36-month Contract)', 'Digital & Information Technology'],
  ['Senior Solution Lead – Subsidiaries (Cathay Cargo Terminal)', 'Digital & Information Technology'],
  ['Assistant Manager, Innovation', 'Digital & Information Technology'],
  ['Enterprise Agile Transformation Lead (24-month contract)', 'Digital & Information Technology'],
  ['2027 Digital & IT Graduate Trainee Programme (HK & GBA)', 'Digital & Information Technology'],
  ['Web Developer', 'Digital & Information Technology'],
  ['Data Scientist', 'Digital & Information Technology'],
  ['Business Analyst', 'Digital & Information Technology'],
  ['Project Executive (9-month contract)', 'Project Management'],
  ['Procurement Centre of Excellence Lead - Procure-to-Pay Global Process Owner', 'Procurement'],
  ['Financial Analyst', 'Finance'],
  // Kept, but it must rank well below the three targets — see section 8.
  ['IT Support Officer', 'Information Technology'],
];

/** Titles that should be filtered out — service, manual and operations roles. */
const SHOULD_FILTER: Array<[title: string, department: string]> = [
  ['Flight Attendant', 'Cabin Crew'],
  ['Cabin Crew (Hong Kong Base)', 'Inflight Services'],
  ['Bartender', 'Dining & Hospitality'],
  ['Lounge Ambassador', 'Customer Services'],
  ['Cargo Supervisor', 'Airport & Cargo Operations'],
  ['Senior Airport Lead', 'Airport & Cargo Operations'],
  // A commercial logistics role, not an analytical one. Worth keeping as a fixture
  // because "Assistant Manager" reads senior-but-relevant at a glance.
  ['Assistant Manager Cargo Distribution (Project) (18-month contract)', 'Airport & Cargo Operations'],
  // "Analyst" in the title, but it is a support-desk role.
  ['Service Desk Analyst', 'Information Technology'],
  ['Cleaner', 'Facilities'],
  ['Driver', 'Transport'],
  ['Security Guard', 'Corporate Security'],
  ['Cashier', 'Retail'],
  ['Barista', 'Dining & Hospitality'],
  ['Housekeeping Attendant', 'Housekeeping'],
  ['Beauty Advisor', 'Retail'],
];

// ─── 1. blocklist ────────────────────────────────────────────────────────────

check('blocklist: flight attendant', blocklistHit('Flight Attendant') === 'cabin-crew');
check('blocklist: cabin crew', blocklistHit('Cabin Crew (Hong Kong Base)') === 'cabin-crew');
check('blocklist: bartender', blocklistHit('Bartender') === 'bar');
check('blocklist: barista', blocklistHit('Barista') === 'bar');
check('blocklist: cleaner', blocklistHit('Cleaner') === 'cleaning');
check('blocklist: driver', blocklistHit('Driver') === 'driving');
check('blocklist: security guard', blocklistHit('Security Guard') === 'security-guard');
check('blocklist: cashier', blocklistHit('Cashier') === 'retail');
check('blocklist: Chinese 空姐', blocklistHit('空姐 (香港基地)') === 'service-zh');
check('blocklist: Chinese 調酒師', blocklistHit('調酒師') === 'service-zh');

// The two traps. A bare `server` or `host` pattern would kill these.
check('blocklist: "Server Engineer" is NOT blocked', blocklistHit('Server Engineer') === null, blocklistHit('Server Engineer'));
check('blocklist: "Hosting Platform Lead" is NOT blocked', blocklistHit('Hosting Platform Lead') === null, blocklistHit('Hosting Platform Lead'));
check('blocklist: "Compliance Officer" is NOT blocked', blocklistHit('Compliance Officer') === null, blocklistHit('Compliance Officer'));
check('blocklist: "Driver Developer" is blocked (documented false positive)', blocklistHit('Driver Developer') !== null);
check('blocklist: empty title is safe', blocklistHit('') === null);

// ─── 2. role family ──────────────────────────────────────────────────────────

check('family: software engineer', roleFamilyOf('Software Engineer') === 'TECH');
check('family: IT security assurance is tech', roleFamilyOf('IT Security Assurance Lead') === 'TECH');
check('family: data scientist', roleFamilyOf('Data Scientist') === 'DATA');
check('family: data analyst', roleFamilyOf('Data Analyst') === 'DATA');
check('family: business analyst has its own family', roleFamilyOf('Business Analyst') === 'BUSINESS_ANALYST');
check('family: systems analyst is a business analyst', roleFamilyOf('Senior Systems Analyst') === 'BUSINESS_ANALYST');
check('family: finance', roleFamilyOf('Financial Analyst') === 'FINANCE');
check('family: compliance', roleFamilyOf('Compliance Manager') === 'RISK_COMPLIANCE');
check('family: project manager', roleFamilyOf('Project Executive') === 'PRODUCT');
check('family: cargo supervisor is aviation', roleFamilyOf('Cargo Supervisor') === 'AVIATION_OPS');
check('family: cabin crew is aviation', roleFamilyOf('Cabin Crew') === 'AVIATION_OPS');
check('family: IT support is infra, not software', roleFamilyOf('IT Support Officer') === 'IT_INFRA');
check('family: unknown title', roleFamilyOf('Chief of Staff') === 'OTHER');

// AVIATION_OPS must win over TECH, or "Licensed Aircraft Engineer" reads as a
// software role purely because of the word "engineer".
check(
  'family: aircraft engineer is aviation, not tech',
  roleFamilyOf('Licensed Aircraft Engineer') === 'AVIATION_OPS',
  roleFamilyOf('Licensed Aircraft Engineer'),
);
// The title must outrank the department: a cargo role sitting in an IT department
// is still a cargo role.
check(
  'family: title outranks department',
  roleFamilyOf('Cargo Supervisor', 'Digital & Information Technology') === 'AVIATION_OPS',
  roleFamilyOf('Cargo Supervisor', 'Digital & Information Technology'),
);
// The converse, and the reason DATA precedes AVIATION_OPS: an explicit analytical
// title inside an operational division must stay analytical.
check(
  'family: "Data Analyst" in cargo is still DATA',
  roleFamilyOf('Data Analyst – Cargo Performance', 'Airport & Cargo Operations') === 'DATA',
  roleFamilyOf('Data Analyst – Cargo Performance', 'Airport & Cargo Operations'),
);

// ─── 3. scores ───────────────────────────────────────────────────────────────

for (const [title, department] of SHOULD_KEEP) {
  const result = scoreRelevance({ title, department });
  check(
    `keep: "${title.slice(0, 48)}" scores >= ${DEFAULT_MIN_RELEVANCE}`,
    result.score >= DEFAULT_MIN_RELEVANCE,
    result,
  );
}

for (const [title, department] of SHOULD_FILTER) {
  const result = scoreRelevance({ title, department });
  check(
    `filter: "${title.slice(0, 48)}" scores < ${DEFAULT_MIN_RELEVANCE}`,
    result.score < DEFAULT_MIN_RELEVANCE,
    result,
  );
}

// Blocklisted jobs short-circuit to exactly 0, not merely "low".
for (const [title] of SHOULD_FILTER.filter(([t]) => blocklistHit(t) !== null)) {
  check(`blocklisted: "${title}" is exactly 0`, scoreRelevance({ title }).score === 0);
}

// ─── 4. the three targets outrank everything else ────────────────────────────

check('targets: exactly three families are named', TARGET_FAMILIES.length === 3, TARGET_FAMILIES);

const targetScores = [
  scoreRelevance({ title: 'Data Analyst' }).score,
  scoreRelevance({ title: 'Business Analyst' }).score,
  scoreRelevance({ title: 'Software Engineer' }).score,
];
for (const [index, score] of targetScores.entries()) {
  check(`targets: #${index + 1} is in the "high" band`, relevanceBand(score) === 'high', score);
}

// Adjacent-but-not-target families must rank strictly below every target. This is
// the assertion that catches a family weight being nudged above a target by
// accident — the ranking is the whole product.
const adjacentScores: Array<[string, number]> = [
  ['Product Manager', scoreRelevance({ title: 'Product Manager' }).score],
  ['Financial Analyst', scoreRelevance({ title: 'Financial Analyst' }).score],
  ['Compliance Manager', scoreRelevance({ title: 'Compliance Manager' }).score],
  ['IT Support Officer', scoreRelevance({ title: 'IT Support Officer' }).score],
  ['Project Executive', scoreRelevance({ title: 'Project Executive' }).score],
];
const lowestTarget = Math.min(...targetScores);
for (const [label, score] of adjacentScores) {
  check(`targets: "${label}" ranks below every target`, score < lowestTarget, { score, lowestTarget });
}

// ─── 5. seniority, tuned for a 2-3 year candidate ────────────────────────────

const baseTech = scoreRelevance({ title: 'Software Engineer' }).score;
const baseData = scoreRelevance({ title: 'Data Analyst' }).score;

check('seniority: DIRECTOR lowers a tech score', scoreRelevance({ title: 'Software Engineer', seniority: 'DIRECTOR' }).score < baseTech);
check('seniority: EXECUTIVE lowers it further', scoreRelevance({ title: 'Software Engineer', seniority: 'EXECUTIVE' }).score < scoreRelevance({ title: 'Software Engineer', seniority: 'DIRECTOR' }).score);
check('seniority: LEAD is a stretch', scoreRelevance({ title: 'Software Engineer', seniority: 'LEAD' }).score < baseTech);
check('seniority: MID is a better target than unlabelled', scoreRelevance({ title: 'Data Analyst', seniority: 'MID' }).score > baseData);
check('seniority: JUNIOR is still in range', scoreRelevance({ title: 'Data Analyst', seniority: 'JUNIOR' }).score >= DEFAULT_MIN_RELEVANCE);
// INTERN is the wrong career stage, so it is penalised rather than rewarded.
check('seniority: INTERN is penalised', scoreRelevance({ title: 'Data Analyst', seniority: 'INTERN' }).score < baseData);
check('seniority: LEAD costs more than MANAGER', scoreRelevance({ title: 'Software Engineer', seniority: 'LEAD' }).score < scoreRelevance({ title: 'Software Engineer', seniority: 'MANAGER' }).score);
check('seniority: an unknown code is ignored', scoreRelevance({ title: 'Software Engineer', seniority: 'WIZARD' }).score === baseTech);

// ─── 6. years of experience, around the 2-3 year band ────────────────────────

check('yoe: target band is 2-3', TARGET_YOE_MIN === 2 && TARGET_YOE_MAX === 3);

const at = (yoeMin: number): number => scoreRelevance({ title: 'Software Engineer', yoeMin }).score;

check('yoe: both band values score identically', at(TARGET_YOE_MIN) === at(TARGET_YOE_MAX));
check('yoe: the band beats a 1-year requirement', at(TARGET_YOE_MIN) > at(1));
check('yoe: the band beats a 4-year requirement', at(TARGET_YOE_MAX) > at(4));
check('yoe: null is ignored', scoreRelevance({ title: 'Software Engineer', yoeMin: null }).score === baseTech);
check('yoe: undefined is ignored', scoreRelevance({ title: 'Software Engineer' }).score === baseTech);

// Strictly decreasing above the band, so a more demanding posting never ranks
// higher than a less demanding one.
check('yoe: 4 > 6 > 9 > 13 in strict order', at(4) > at(6) && at(6) > at(9) && at(9) > at(13), {
  y4: at(4),
  y6: at(6),
  y9: at(9),
  y13: at(13),
});
// A perfect family match that wants 13+ years must still fall below the threshold.
check('yoe: 13+ years hides even a software role', at(13) < DEFAULT_MIN_RELEVANCE, at(13));

// ─── 7. invariants ───────────────────────────────────────────────────────────

const everything = [...SHOULD_KEEP, ...SHOULD_FILTER];
for (const [title, department] of everything) {
  const result = scoreRelevance({ title, department });
  check(`invariant: "${title.slice(0, 32)}" score in range`, result.score >= 0 && result.score <= 100, result.score);
  check(`invariant: "${title.slice(0, 32)}" family is set`, result.family.length > 0);
  // A reason must be attached whenever the score is not the neutral 50, so a
  // filtered job can always explain itself in the UI.
  if (result.score !== 50) {
    check(`invariant: "${title.slice(0, 32)}" non-neutral score has a reason`, result.reason !== null, result);
  }
}

check('empty title scores 0 with a reason', scoreRelevance({ title: '' }).reason === 'empty-title');

// ─── 8. bands ────────────────────────────────────────────────────────────────

check('band: 0 is filtered', relevanceBand(0) === 'filtered');
check('band: 10 is low', relevanceBand(10) === 'low');
check('band: 35 is medium', relevanceBand(35) === 'medium');
check('band: 70 is high', relevanceBand(70) === 'high');
check('band: 100 is high', relevanceBand(100) === 'high');

// ─── 9. determinism ──────────────────────────────────────────────────────────

const first = scoreRelevance({ title: 'IT Security Assurance Lead', department: 'Digital & Information Technology' });
const second = scoreRelevance({ title: 'IT Security Assurance Lead', department: 'Digital & Information Technology' });
check('deterministic: same input, same output', JSON.stringify(first) === JSON.stringify(second));

// ─── report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}

console.log(`relevance: ${passed} assertions passed`);
