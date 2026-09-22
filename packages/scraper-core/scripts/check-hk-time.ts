/**
 * Regression checks for Hong Kong deadline parsing.
 *
 * The bug being guarded: `new Date(text)` resolves a zone-less datetime string in
 * the runtime's local timezone. The scraper runs on a UTC CI runner and a UTC+8
 * development laptop, so the same posting produced instants eight hours apart —
 * enough to render a deadline on the wrong calendar day.
 *
 * Every expectation below is an exact ISO string, which is only achievable if the
 * parser ignores the ambient timezone. Run this file under two different `TZ`
 * values to confirm that empirically:
 *
 *   TZ=UTC      npx tsx scripts/check-hk-time.ts
 *   TZ=Asia/Hong_Kong npx tsx scripts/check-hk-time.ts
 *
 * Both must report the same pass count.
 */
import {
  daysUntilInHongKong,
  hongKongDateOf,
  parseHongKongDateTime,
} from '../src/lib/hk-time.js';

let passed = 0;
const failures: string[] = [];

function eq(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failures.push(`${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const NOW = new Date('2026-09-22T00:00:00Z');

// ─── explicit zones are respected verbatim ───────────────────────────────────
eq('explicit Z is untouched', parseHongKongDateTime('2026-10-31T00:00:00Z', NOW), '2026-10-31T00:00:00.000Z');
eq('explicit +08:00 is untouched', parseHongKongDateTime('2026-10-31T23:59:59+08:00', NOW), '2026-10-31T15:59:59.000Z');
eq('explicit +0800 is untouched', parseHongKongDateTime('2026-10-31T23:59:59+0800', NOW), '2026-10-31T15:59:59.000Z');
eq('explicit UTC suffix is untouched', parseHongKongDateTime('2026-10-31 12:00 UTC', NOW), '2026-10-31T12:00:00.000Z');

// ─── date-only input becomes the END of that day in Hong Kong ────────────────
// 23:59:59 HKT == 15:59:59Z. A deadline must cover its whole final day rather
// than expiring at midnight before it.
eq('ISO date only', parseHongKongDateTime('2026-10-31', NOW), '2026-10-31T15:59:59.000Z');
eq('ISO date with slashes', parseHongKongDateTime('2026/10/31', NOW), '2026-10-31T15:59:59.000Z');
eq('day-first numeric', parseHongKongDateTime('31/10/2026', NOW), '2026-10-31T15:59:59.000Z');
eq('day-first numeric with dots', parseHongKongDateTime('31.10.2026', NOW), '2026-10-31T15:59:59.000Z');
eq('month-first numeric falls back', parseHongKongDateTime('10/31/2026', NOW), '2026-10-31T15:59:59.000Z');
eq('day + abbreviated month', parseHongKongDateTime('31 Oct 2026', NOW), '2026-10-31T15:59:59.000Z');
eq('day + full month', parseHongKongDateTime('31 October 2026', NOW), '2026-10-31T15:59:59.000Z');
eq('month + day, comma', parseHongKongDateTime('October 31, 2026', NOW), '2026-10-31T15:59:59.000Z');
eq('month + day, no comma', parseHongKongDateTime('Oct 31 2026', NOW), '2026-10-31T15:59:59.000Z');
eq('month abbreviation with dot', parseHongKongDateTime('31 Oct. 2026', NOW), '2026-10-31T15:59:59.000Z');

// ─── the day-first default is the Hong Kong convention ───────────────────────
// 01/02/2026 must be 1 February, not 2 January.
eq('ambiguous numeric is day-first', parseHongKongDateTime('01/02/2026', NOW), '2026-02-01T15:59:59.000Z');

// ─── explicit times are interpreted as Hong Kong wall-clock ──────────────────
eq('24-hour time', parseHongKongDateTime('2026-10-31 18:30', NOW), '2026-10-31T10:30:00.000Z');
eq('24-hour time with seconds', parseHongKongDateTime('2026-10-31 18:30:45', NOW), '2026-10-31T10:30:45.000Z');
eq('midnight is the start of the day', parseHongKongDateTime('2026-10-31 00:00', NOW), '2026-10-30T16:00:00.000Z');
eq('12-hour pm', parseHongKongDateTime('31 Oct 2026 6:30 pm', NOW), '2026-10-31T10:30:00.000Z');
eq('12-hour am', parseHongKongDateTime('31 Oct 2026 6:30 am', NOW), '2026-10-30T22:30:00.000Z');
eq('12 pm is noon', parseHongKongDateTime('2026-10-31 12:00 pm', NOW), '2026-10-31T04:00:00.000Z');
eq('12 am is midnight', parseHongKongDateTime('2026-10-31 12:00 am', NOW), '2026-10-30T16:00:00.000Z');
// "pm" attached to a value that can only be a 24-hour hour must fall through to
// the 24-hour pattern rather than being rejected outright.
eq('24-hour time with a stray pm', parseHongKongDateTime('2026-10-31 18:30 pm', NOW), '2026-10-31T10:30:00.000Z');
eq('pm without minutes', parseHongKongDateTime('31 Oct 2026 5 pm', NOW), '2026-10-31T09:00:00.000Z');

// ─── the regression itself ───────────────────────────────────────────────────
// What the old code did: JS read "2026-10-31" as UTC midnight, which is 08:00 on
// the 31st in Hong Kong — a deadline that appears to expire first thing in the
// morning. The new parser lands on the end of the day instead.
{
  const old = new Date('2026-10-31').toISOString();
  const parsed = parseHongKongDateTime('2026-10-31', NOW);
  eq('old behaviour was UTC midnight', old, '2026-10-31T00:00:00.000Z');
  eq('new behaviour is end of the HK day', parsed, '2026-10-31T15:59:59.000Z');
  if (parsed === old) failures.push('parser still matches the old timezone-dependent result');
}

// ─── rejection ───────────────────────────────────────────────────────────────
eq('rejects a rollover date', parseHongKongDateTime('2026-02-31', NOW), undefined);
eq('rejects month 13', parseHongKongDateTime('2026-13-01', NOW), undefined);
eq('rejects day 32', parseHongKongDateTime('2026-10-32', NOW), undefined);
eq('rejects a year before 2000', parseHongKongDateTime('1999-01-01', NOW), undefined);
eq('rejects a far-future year', parseHongKongDateTime('2099-01-01', NOW), undefined);
eq('rejects prose with no date', parseHongKongDateTime('until filled', NOW), undefined);
eq('rejects an empty string', parseHongKongDateTime('', NOW), undefined);
eq('rejects whitespace', parseHongKongDateTime('   ', NOW), undefined);
eq('rejects a number', parseHongKongDateTime(20261031, NOW), undefined);
eq('rejects null', parseHongKongDateTime(null, NOW), undefined);
eq('rejects undefined', parseHongKongDateTime(undefined, NOW), undefined);
eq('rejects an object', parseHongKongDateTime({ date: '2026-10-31' }, NOW), undefined);
eq('rejects a bare time', parseHongKongDateTime('18:30', NOW), undefined);

// ─── surrounding text is tolerated ───────────────────────────────────────────
eq(
  'extracts from a sentence',
  parseHongKongDateTime('Application deadline: 31 October 2026.', NOW),
  '2026-10-31T15:59:59.000Z',
);
eq(
  'extracts from a CJK sentence',
  parseHongKongDateTime('截止日期：2026-10-31', NOW),
  '2026-10-31T15:59:59.000Z',
);

// ─── hongKongDateOf ──────────────────────────────────────────────────────────
eq('HK date of an end-of-day deadline', hongKongDateOf('2026-10-31T15:59:59.000Z'), '2026-10-31');
eq('HK date of UTC midnight rolls back a day', hongKongDateOf('2026-10-31T00:00:00.000Z'), '2026-10-31');
eq('HK date just before HK midnight', hongKongDateOf('2026-10-31T15:59:00.000Z'), '2026-10-31');
eq('HK date just after HK midnight', hongKongDateOf('2026-10-31T16:00:00.000Z'), '2026-11-01');
eq('HK date of garbage', hongKongDateOf('not a date'), undefined);

// ─── daysUntilInHongKong ─────────────────────────────────────────────────────
eq('deadline today', daysUntilInHongKong('2026-09-22T15:59:59.000Z', NOW), 0);
eq('deadline tomorrow', daysUntilInHongKong('2026-09-23T15:59:59.000Z', NOW), 1);
eq('deadline in a week', daysUntilInHongKong('2026-09-29T15:59:59.000Z', NOW), 7);
eq('deadline yesterday', daysUntilInHongKong('2026-09-21T15:59:59.000Z', NOW), -1);
eq('garbage deadline', daysUntilInHongKong('nope', NOW), null);

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} FAILED:\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
}
process.stdout.write(`\n${passed} passed, ${failures.length} failed  (TZ=${process.env.TZ ?? 'system'})\n`);
if (failures.length > 0) process.exitCode = 1;
