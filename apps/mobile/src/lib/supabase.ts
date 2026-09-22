import { config } from './config';
import type { JobRow } from '../types';

/**
 * Minimal PostgREST client.
 *
 * Deliberately not `@supabase/supabase-js`: the app makes four kinds of request
 * (list jobs, read one job, register a push token, disable a push token), and
 * hand-writing those against the REST API keeps the bundle small and the failure
 * modes obvious. No auth session, no realtime, no storage client needed.
 */

export class RestError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, path: string) {
    super(`Supabase ${path} failed with ${status}: ${body.slice(0, 300)}`);
    this.name = 'RestError';
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: string;
  body?: unknown;
  prefer?: string;
}

async function rest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!config.isConfigured) {
    throw new Error('Supabase is not configured');
  }

  const url = `${config.supabaseUrl}/rest/v1${path}${options.query ? `?${options.query}` : ''}`;
  const controller = new AbortController();
  // Without a timeout a flaky connection leaves the list spinning forever with no
  // way to recover except killing the app.
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        apikey: config.supabaseAnonKey,
        authorization: `Bearer ${config.supabaseAnonKey}`,
        'content-type': 'application/json',
        ...(options.prefer ? { prefer: options.prefer } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) throw new RestError(response.status, raw, path);
    if (!raw) return undefined as T;
    return JSON.parse(raw) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every column the app reads. `companies(...)` is PostgREST resource embedding —
 * it resolves through the `jobs.company_id` foreign key, so the list screen does
 * not need a second round trip per row.
 */
const JOB_SELECT = [
  'id',
  'title',
  'location',
  'url',
  'apply_url',
  'employment_type',
  'raw_employment_type',
  'department',
  'work_schedule',
  'application_deadline',
  'experience_min',
  'salary_min',
  'salary_max',
  'salary_currency',
  'remote',
  'requires_visa',
  'tags',
  'classification',
  'top_metadata',
  'published_at',
  'first_seen_at',
  'last_seen_at',
  'status',
  'summary',
  'summary_lang',
  'extracted',
  'enrich_status',
  'enrich_model',
  'enriched_at',
  'companies(name,slug,domain)',
].join(',');

export async function fetchJobs(limit = 200): Promise<JobRow[]> {
  // The RLS policy already restricts anon reads to status = ACTIVE, but stating it
  // here keeps the intent visible and avoids relying on a policy staying correct.
  const rows = await rest<JobRow[]>('/jobs', {
    query:
      `select=${JOB_SELECT}` +
      `&status=eq.ACTIVE` +
      `&order=first_seen_at.desc` +
      `&limit=${limit}`,
  });
  return rows ?? [];
}

export async function fetchJob(id: string): Promise<JobRow | null> {
  const rows = await rest<JobRow[]>('/jobs', {
    query: `select=${JOB_SELECT}&id=eq.${encodeURIComponent(id)}&limit=1`,
  });
  return rows?.[0] ?? null;
}

export interface PushTokenInput {
  token: string;
  deviceId: string;
  platform: string;
  deviceName?: string | undefined;
}

/**
 * Register (or refresh) this device's Expo push token.
 *
 * Upserts on `token` so re-launching the app does not accumulate rows. The RLS
 * policy on `push_tokens` allows anon insert/update for exactly this call — see
 * the note in `0002_push_tokens.sql` about the trade-off.
 */
export async function registerPushToken(input: PushTokenInput): Promise<void> {
  await rest('/push_tokens', {
    method: 'POST',
    body: [
      {
        token: input.token,
        device_id: input.deviceId,
        platform: input.platform,
        device_name: input.deviceName ?? null,
        enabled: true,
        last_seen_at: new Date().toISOString(),
      },
    ],
    prefer: 'resolution=merge-duplicates,return=minimal',
    query: 'on_conflict=token',
  });
}

/** Called when the user turns notifications off, or when Expo reports the token
 *  as no longer registered. */
export async function disablePushToken(token: string): Promise<void> {
  await rest('/push_tokens', {
    method: 'PATCH',
    body: { enabled: false, last_seen_at: new Date().toISOString() },
    prefer: 'return=minimal',
    query: `token=eq.${encodeURIComponent(token)}`,
  });
}

/** Resume slots stored on the single-user `profile` row. */
export async function fetchProfile(): Promise<{ resumes: Record<string, string> } | null> {
  const rows = await rest<Array<{ resumes: Record<string, string> | null }>>('/profile', {
    query: 'select=resumes&limit=1',
  });
  const row = rows?.[0];
  return row ? { resumes: row.resumes ?? {} } : null;
}
