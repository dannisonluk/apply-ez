/**
 * Runtime configuration.
 *
 * `EXPO_PUBLIC_*` variables are inlined into the bundle at build time, which is
 * fine here because the Supabase **anon** key is public by design — it is the
 * key the RLS policies are written against. The service-role key must never
 * appear in this app; it lives only in the scraper's GitHub Actions secrets.
 */

const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const config = {
  supabaseUrl,
  supabaseAnonKey,
  /** False until `.env` is filled in; screens show a setup hint instead of an error. */
  isConfigured: supabaseUrl.length > 0 && supabaseAnonKey.length > 0,
  requestTimeoutMs: 15_000,
} as const;

export const MISSING_CONFIG_HINT =
  'Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in apps/mobile/.env, then restart the dev server.';
