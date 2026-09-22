import { config } from './config';
import type { AppliedJob, JobRow } from '../types';

/**
 * Minimal PostgREST client.
 *
 * Deliberately not `@supabase/supabase-js`: the app makes a handful of requests
 * (list jobs, read one job, register/disable a push token, call three RPCs), and
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

  /**
   * True when the server rejected a code.
   *
   * The RPCs raise with SQLSTATE 28000 and a message of INVALID_UNLOCK_CODE or
   * INVALID_APPLICATION_CODE, which PostgREST surfaces as a 403/400 with the
   * message in the body. Matched on the message rather than the status alone so a
   * genuine permissions problem is not silently reported as "wrong code".
   */
  get isCodeRejection(): boolean {
    return (
      this.body.includes('INVALID_UNLOCK_CODE') || this.body.includes('INVALID_APPLICATION_CODE')
    );
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

/** Call a Postgres function exposed through PostgREST. */
async function rpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  return rest<T>(`/rpc/${fn}`, { method: 'POST', body });
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
  'relevance_score',
  'role_family',
  'filter_reason',
  'summary',
  'summary_lang',
  'extracted',
  'enrich_status',
  'enrich_model',
  'enriched_at',
  'companies(name,slug,domain)',
].join(',');

/**
 * Fetch the job list.
 *
 * EXPIRED rows are included on purpose — the app groups them into a separate tab
 * rather than making them vanish, which is the only way to tell "this posting
 * closed" apart from "this posting was never scraped".
 *
 * Two queries, one per status, rather than one query ordered by status. A single
 * `order=status.asc&limit=N` request looks equivalent and is not: ACTIVE sorts
 * first, so as soon as the active board exceeds N the limit is consumed entirely
 * by active rows and the Closed tab is *permanently* empty. That is already the
 * case — the board passed 400 active rows on 2026-09-22 (746 rows), and the
 * response was 400 ACTIVE / 0 EXPIRED — so the first posting the reconcile
 * retires would have been invisible, which is the exact outcome this tab exists
 * to prevent. Giving each status its own budget removes the coupling.
 *
 * Within each status the order is newest-first, so the active list leads with the
 * postings that just appeared.
 */
export async function fetchJobs(limit = 400): Promise<JobRow[]> {
  const [active, expired] = await Promise.all([
    rest<JobRow[]>('/jobs', {
      query: `select=${JOB_SELECT}&status=eq.ACTIVE&order=first_seen_at.desc&limit=${limit}`,
    }),
    rest<JobRow[]>('/jobs', {
      query: `select=${JOB_SELECT}&status=eq.EXPIRED&order=first_seen_at.desc&limit=${limit}`,
    }),
  ]);
  // Active first, preserving the previous ordering, so the list still opens on
  // live postings.
  return [...(active ?? []), ...(expired ?? [])];
}

export async function fetchJob(id: string): Promise<JobRow | null> {
  const rows = await rest<JobRow[]>('/jobs', {
    query: `select=${JOB_SELECT}&id=eq.${encodeURIComponent(id)}&limit=1`,
  });
  return rows?.[0] ?? null;
}

// ─── application codes + history ─────────────────────────────────────────────

/**
 * Check a candidate unlock code.
 *
 * The code never reaches the device: it is stored as a bcrypt hash in
 * `app_settings` (RLS on, no policy) and only ever compared inside a
 * SECURITY DEFINER function. So this returns a boolean rather than raising, and a
 * wrong code is an ordinary `false`.
 */
export async function verifyUnlockCode(code: string): Promise<boolean> {
  const result = await rpc<boolean>('app_unlock', { p_code: code });
  return result === true;
}

/**
 * Application history, newest first.
 *
 * Gated by the unlock code because `applications` has no anon read policy — the
 * only way to read it is through this function.
 */
export async function fetchApplications(code: string): Promise<AppliedJob[]> {
  const rows = await rpc<AppliedJob[]>('list_applications', { p_code: code });
  return rows ?? [];
}

export interface RecordApplicationInput {
  /** The BEFORE_APPLICATION code. Verified server-side. */
  code: string;
  jobId: string;
  resumeKey?: string | undefined;
  evidenceUrl?: string | undefined;
  notes?: string | undefined;
}

/**
 * Record one application.
 *
 * `job_id` is unique on `applications`, so re-recording the same job updates the
 * existing row instead of creating a duplicate — applying twice to one posting is
 * a data error, not a second event.
 */
export async function recordApplication(input: RecordApplicationInput): Promise<void> {
  await rpc('record_application', {
    p_code: input.code,
    p_job_id: input.jobId,
    p_resume_key: input.resumeKey ?? null,
    p_evidence_url: input.evidenceUrl ?? null,
    p_notes: input.notes ?? null,
  });
}

// ─── push ────────────────────────────────────────────────────────────────────

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

/** Resume slots stored on the single-user `profile` row. Service-role only, so
 *  this currently returns null for the app — kept for when the app gets a way in. */
export async function fetchProfile(): Promise<{ resumes: Record<string, string> } | null> {
  const rows = await rest<Array<{ resumes: Record<string, string> | null }>>('/profile', {
    query: 'select=resumes&limit=1',
  });
  const row = rows?.[0];
  return row ? { resumes: row.resumes ?? {} } : null;
}
