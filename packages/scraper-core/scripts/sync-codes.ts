/**
 * Push `UNLOCK_APPLICATION_CODE` and `BEFORE_APPLICATION_CODE` into Supabase.
 *
 * The codes are stored as bcrypt hashes in `app_settings`, which has RLS on and no
 * policy — the plaintext never reaches the database, and the app never holds it.
 * The app verifies a candidate code by calling the `app_unlock` /
 * `record_application` RPCs, so a database dump or an APK teardown reveals nothing.
 *
 *   pnpm --filter @apply-ez/scraper-core sync:codes
 *
 * Run this once after applying migration 0003, and again whenever you rotate a code.
 * Leaving one of the env vars empty leaves that code unchanged.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';

function loadDotEnv(): void {
  if (typeof process.loadEnvFile !== 'function') return;
  for (const candidate of [
    fileURLToPath(new URL('../.env', import.meta.url)),
    fileURLToPath(new URL('../../../.env', import.meta.url)),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      /* try the next candidate */
    }
  }
}

loadDotEnv();

const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const unlock = process.env.UNLOCK_APPLICATION_CODE ?? '';
const beforeApply = process.env.BEFORE_APPLICATION_CODE ?? '';

if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (check .env)');
  process.exit(1);
}

if (!unlock && !beforeApply) {
  console.error(
    'Neither UNLOCK_APPLICATION_CODE nor BEFORE_APPLICATION_CODE is set — nothing to do.\n' +
      'Set at least one in .env, then re-run.',
  );
  process.exit(1);
}

async function rpc<T>(fn: string, body: unknown): Promise<T> {
  const response = await request(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey as string,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await response.body.text();
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${fn} failed with ${response.statusCode}: ${raw.slice(0, 400)}`);
  }
  return (raw ? JSON.parse(raw) : undefined) as T;
}

console.log(`Setting codes on ${url}`);
console.log(`  unlock       : ${unlock ? `${unlock.length} chars, will be set` : '(unchanged)'}`);
console.log(`  before_apply : ${beforeApply ? `${beforeApply.length} chars, will be set` : '(unchanged)'}`);

await rpc<void>('set_app_codes', {
  p_unlock: unlock || null,
  p_before_apply: beforeApply || null,
});

// Verify by round-tripping through the same function the app calls. A silent
// failure here is the difference between "the gate works" and "the gate is
// permanently shut", so this check is not optional.
if (unlock) {
  const ok = await rpc<boolean>('app_unlock', { p_code: unlock });
  if (ok !== true) {
    console.error('VERIFY FAILED: app_unlock rejected the code that was just set.');
    process.exit(1);
  }
  const wrong = await rpc<boolean>('app_unlock', { p_code: `${unlock}-definitely-wrong` });
  if (wrong !== false) {
    console.error('VERIFY FAILED: app_unlock accepted a wrong code.');
    process.exit(1);
  }
  console.log('  verified: correct code accepted, wrong code rejected');
}

console.log('Done.');
