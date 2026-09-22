/**
 * Regression check for the Supabase writer's error classification.
 *
 * Run with:  pnpm --filter @apply-ez/scraper-core exec tsx scripts/check-store.ts
 *
 * Only the schema-mismatch hint is covered here; the HTTP calls themselves are
 * exercised by the dry run against the real project.
 *
 * The reason this deserves a test at all: the hint tells the operator to go apply
 * a migration. Getting that wrong in either direction is costly — a false positive
 * sends someone to re-run a migration that is already applied, and a false negative
 * leaves them reading `PGRST204` as a bug in the client code.
 */
import assert from 'node:assert/strict';
import { describeSchemaError } from '../src/store.js';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
  } catch {
    failed += 1;
    console.error(
      `FAIL  ${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`,
    );
  }
}

const HINT = describeSchemaError(400, '{"code":"42703"}');
const NO_HINT = '';

// ─── the real bodies we have actually seen from this project ──────────────────
// Verbatim from the live probes: relevance_score and app_settings were missing
// before migration 0003 was applied.
check(
  'hint: PGRST204 missing column (the 0003 case)',
  describeSchemaError(
    400,
    '{"code":"PGRST204","details":null,"hint":null,"message":"Could not find the \'relevance_score\' column of \'jobs\' in the schema cache"}',
  ) !== NO_HINT,
  true,
);
check(
  'hint: PGRST205 missing table (app_settings)',
  describeSchemaError(
    404,
    '{"code":"PGRST205","details":null,"hint":"Perhaps you meant the table \'public.applications\'","message":"Could not find the table \'public.app_settings\' in the schema cache"}',
  ) !== NO_HINT,
  true,
);
check(
  'hint: PGRST202 missing function (app_unlock)',
  describeSchemaError(
    404,
    '{"code":"PGRST202","details":"Searched for the function public.app_unlock","message":"Could not find the function"}',
  ) !== NO_HINT,
  true,
);
check('hint: raw Postgres 42703 undefined_column', describeSchemaError(400, '{"code":"42703","message":"column jobs.relevance_score does not exist"}') !== NO_HINT, true);
check('hint: raw Postgres 42P01 undefined_table', describeSchemaError(404, '{"code":"42P01"}') !== NO_HINT, true);
check('hint: raw Postgres 42883 undefined_function', describeSchemaError(404, '{"code":"42883"}') !== NO_HINT, true);

// ─── must NOT fire on unrelated failures ─────────────────────────────────────
check('no hint: 409 unique violation', describeSchemaError(409, '{"code":"23505","message":"duplicate key value violates unique constraint"}'), NO_HINT);
check('no hint: 401 bad key', describeSchemaError(401, '{"message":"Invalid API key"}'), NO_HINT);
check('no hint: 403 RLS denial', describeSchemaError(403, '{"code":"42501","message":"new row violates row-level security policy"}'), NO_HINT);
check('no hint: 429 rate limited', describeSchemaError(429, '{"message":"Too Many Requests"}'), NO_HINT);
check('no hint: 500 server error', describeSchemaError(500, '{"code":"XX000","message":"internal error"}'), NO_HINT);
check('no hint: 502 gateway', describeSchemaError(502, '<html>Bad Gateway</html>'), NO_HINT);
// A CHECK-constraint violation on the relevance range is a code problem, not a
// missing migration — it must not be blamed on the schema.
check('no hint: 400 check constraint on relevance range', describeSchemaError(400, '{"code":"23514","message":"new row for relation \\"jobs\\" violates check constraint \\"jobs_relevance_score_range\\""}'), NO_HINT);
// 400/404 guards: the same body must not trigger the hint on a status where a
// missing object is not the plausible cause.
check('no hint: schema body but status 200', describeSchemaError(200, '{"code":"PGRST204"}'), NO_HINT);
check('no hint: schema body but status 503', describeSchemaError(503, '{"code":"PGRST204"}'), NO_HINT);

// ─── the hint must be additive, never replace the original error ─────────────
const message =
  `Supabase POST /jobs failed with 400: ${'{"code":"PGRST204"}'}` +
  describeSchemaError(400, '{"code":"PGRST204"}');
check('hint: mentions migrations', message.includes('supabase/migrations/'), true);
check('hint: mentions the validator', message.includes('pnpm check:sql'), true);
check('hint: keeps the original status and code', message.includes('failed with 400') && message.includes('PGRST204'), true);
check('hint: is multi-line and indented', HINT.startsWith('\n  →'), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
