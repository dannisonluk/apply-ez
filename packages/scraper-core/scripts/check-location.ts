/**
 * Regression checks for the Hong Kong scope rule.
 *
 * The fixtures are the actual `jobs.location` values from the live board, not
 * invented ones — the whole point of the rule is how it handles the spellings the
 * adapters really produce, and those are messier than anything you would write
 * from scratch ("Hong Kong, HK-AIA Hong Kong & Macau", "HK-AIA Blue Care MC5").
 *
 * The two cases that pin the design:
 *   - "Hong Kong, HK-AIA Hong Kong & Macau" must be KEPT. It names Macau, but it
 *     names Hong Kong first, and a naive denylist drops it.
 *   - "Manulife Tower" must be KEPT. It names no city at all, and an allowlist
 *     ("must contain Hong Kong") drops it even though it is a Kwun Tong address.
 */
import { isHongKongLocation, isOutOfScopeLocation, partitionByLocationScope } from '../src/lib/location-scope.js';

let passed = 0;
const failures: string[] = [];

function eq(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failures.push(`${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── in scope: every HK spelling the board actually contains ─────────────────
const IN_SCOPE = [
  'Hong Kong',
  'Central, Hong Kong Island, Hong Kong',
  'Mongkok, Kowloon, Hong Kong',
  'Hong Kong, HK-AIA Hong Kong & Macau',
  'HONG KONG, Hong Kong',
  'Hong Kong, Hong Kong',
  'Kowloon City, Kowloon, Hong Kong',
  'Hong Kong SAR',
  'Hong Kong, HK-AIA Group Office',
  'Hong Kong, HK-AIA Blue Cross',
  'Hong Kong, HK-AIA Blue Care',
  'Hong Kong, HK-Amplify Health',
  'Kowloon Bay, Kowloon, Hong Kong',
  'Hong Kong, Manulife Financial Centre',
  'Tsim Sha Tsui, Hong Kong Island, Hong Kong',
  'HK-AIA Blue Care MC5',
  // Office name with no city: the allowlist trap.
  'Manulife Tower',
  // Blank is in scope; backfillRawJobs fills it before this runs.
  '',
  '   ',
];

for (const location of IN_SCOPE) {
  eq(`kept: ${JSON.stringify(location)}`, isOutOfScopeLocation(location), false);
}

// ─── out of scope: the six leaks the live crawl produced ─────────────────────
const OUT_OF_SCOPE = [
  'Singapore',
  'Manulife Tower, Manulife (Singapore) Pte Ltd',
  '华东',
  '上海',
  'Kuala Lumpur, Malaysia',
  'Shenzhen, China',
  '台北',
];

for (const location of OUT_OF_SCOPE) {
  eq(`dropped: ${JSON.stringify(location)}`, isOutOfScopeLocation(location), true);
}

// ─── null/undefined are treated as blank, not as a crash ─────────────────────
eq('undefined is in scope', isOutOfScopeLocation(undefined), false);
eq('null is in scope', isOutOfScopeLocation(null), false);
eq('isHongKongLocation is the inverse', isHongKongLocation('Singapore'), false);
eq('isHongKongLocation on HK', isHongKongLocation('Hong Kong'), true);

// ─── word boundaries: no substring false positives ───────────────────────────
// "Indiana" contains "india" but is not India; a naive /india/ would drop it.
eq('Indiana is not India', isOutOfScopeLocation('Indianapolis, Indiana'), false);
// "Chinatown" must not be read as China.
eq('Chinatown is not China', isOutOfScopeLocation('Chinatown, Hong Kong'), false);

// ─── partition keeps order and reports what it dropped ───────────────────────
const partition = partitionByLocationScope([
  { id: 'a', location: 'Hong Kong' },
  { id: 'b', location: 'Singapore' },
  { id: 'c', location: 'Kowloon, Hong Kong' },
  { id: 'd', location: '华东' },
  { id: 'e', location: undefined },
]);

eq('partition keeps the in-scope jobs', partition.kept.map((job) => job.id).join(','), 'a,c,e');
eq('partition reports the out-of-scope jobs', partition.outOfScope.map((entry) => entry.job.id).join(','), 'b,d');
eq('partition reports the offending location', partition.outOfScope[0]?.location, 'Singapore');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exit(1);
}
