-- apply-ez — migration 0003
--
-- Adds three things, all of which are the database half of app features:
--
--   1. Relevance scoring columns on `jobs` (question 2).
--   2. A wider read policy so EXPIRED jobs are visible, not just ACTIVE (question 3).
--   3. `app_settings` + security-definer RPCs, which together give the app a
--      code-gated way to record and read applications without ever exposing the
--      `applications` table to the anon role (questions 1 and 4).
--
-- Run in the Supabase SQL editor, or `supabase db push`.

-- ─── 1. relevance scoring ─────────────────────────────────────────────────────
--
-- `relevance_score` is computed by the scraper (deterministic role-family rules,
-- optionally refined by the LLM layer). It is a 0-100 score, NOT a boolean, so the
-- display threshold can be tuned in the app without a re-scrape.
--
-- `filter_reason` records WHY a job scored low — useful for tuning the rules, and
-- for showing the user what was hidden rather than silently dropping rows.

alter table public.jobs
  add column if not exists relevance_score int not null default 50,
  add column if not exists role_family     text,
  add column if not exists filter_reason   text;

do $$
begin
  -- A CHECK constraint keeps a bad adapter or a bad model from writing 9000.
  if not exists (
    select 1 from pg_constraint where conname = 'jobs_relevance_score_range'
  ) then
    alter table public.jobs
      add constraint jobs_relevance_score_range
      check (relevance_score >= 0 and relevance_score <= 100);
  end if;
end $$;

create index if not exists jobs_relevance_seen_idx
  on public.jobs (relevance_score desc, first_seen_at desc);

-- ─── 2. let the app see expired jobs ──────────────────────────────────────────
--
-- Before this, the anon policy exposed only status = 'ACTIVE', so an expired job
-- simply vanished from the app with no way to tell "expired" from "never existed".
-- Job postings carry no personal data, so exposing the full table to the anon role
-- is fine; the app is what decides how to group them.

drop policy if exists "public can read active jobs" on public.jobs;
drop policy if exists "public can read jobs" on public.jobs;
create policy "public can read jobs"
  on public.jobs for select
  to anon, authenticated
  using (true);

-- ─── 3. application codes ─────────────────────────────────────────────────────
--
-- Two codes, both stored as bcrypt hashes so a database read does not reveal them:
--
--   unlock_code_hash       gates opening the application area and reading history
--   before_apply_code_hash gates the final submit of a single application
--
-- The second one is deliberate friction: it is the "are you sure" step that stops
-- an accidental tap from filing a real application.
--
-- This table has RLS enabled and NO policy, so anon can never read or write it.
-- The only way in is through the security-definer functions below.

create table if not exists public.app_settings (
  id                     boolean primary key default true,
  constraint app_settings_singleton check (id),
  unlock_code_hash       text,
  before_apply_code_hash text,
  updated_at             timestamptz not null default now()
);

insert into public.app_settings (id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;

-- ─── code verification ────────────────────────────────────────────────────────
--
-- bcrypt via pgcrypto. `gen_salt('bf', 12)` makes each verification ~0.3s, which is
-- what stops an attacker who has the anon key from brute-forcing a short numeric
-- code through the RPC — 10^6 candidates at 0.3s each is days of work, not seconds.
--
-- search_path is pinned (and pg_temp placed last) because this is SECURITY DEFINER:
-- without it a caller could shadow `crypt` with their own function.

create or replace function public.verify_app_code(p_kind text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
begin
  if p_code is null or length(p_code) = 0 then
    return false;
  end if;

  select case p_kind
           when 'unlock'       then unlock_code_hash
           when 'before_apply' then before_apply_code_hash
         end
    into v_hash
    from public.app_settings
   where id;

  -- A null hash means "no code configured". Fail closed: an unconfigured code must
  -- never be satisfiable, or a fresh deploy would have an open door.
  if v_hash is null then
    return false;
  end if;

  return v_hash = crypt(p_code, v_hash);
end;
$$;

-- ─── app-facing RPCs ──────────────────────────────────────────────────────────

/** Check the unlock code. Returns true/false rather than raising, so the app can
 *  show a friendly "wrong code" message instead of a red error. */
create or replace function public.app_unlock(p_code text)
returns boolean
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select public.verify_app_code('unlock', p_code);
$$;

/**
 * Record one application.
 *
 * Gated by the BEFORE_APPLICATION code. `applications.job_id` is unique, so
 * re-submitting the same job updates the existing row instead of duplicating it —
 * applying twice to one posting is a data error, not a new event.
 */
create or replace function public.record_application(
  p_code         text,
  p_job_id       uuid,
  p_resume_key   text default null,
  p_evidence_url text default null,
  p_notes        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_row public.applications;
begin
  if not public.verify_app_code('before_apply', p_code) then
    raise exception 'INVALID_APPLICATION_CODE' using errcode = '28000';
  end if;

  insert into public.applications (job_id, resume_key, evidence_url, notes)
  values (p_job_id, p_resume_key, p_evidence_url, p_notes)
  on conflict (job_id) do update
     set resume_key   = coalesce(excluded.resume_key,   public.applications.resume_key),
         evidence_url = coalesce(excluded.evidence_url, public.applications.evidence_url),
         notes        = coalesce(excluded.notes,        public.applications.notes)
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

/** Application history joined with the job it belongs to. Gated by the unlock code. */
create or replace function public.list_applications(p_code text)
returns table (
  job_id       uuid,
  status       text,
  resume_key   text,
  applied_at   timestamptz,
  evidence_url text,
  notes        text,
  title        text,
  company_name text,
  url          text,
  job_status   text
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public.verify_app_code('unlock', p_code) then
    raise exception 'INVALID_UNLOCK_CODE' using errcode = '28000';
  end if;

  return query
    select a.job_id, a.status, a.resume_key, a.applied_at, a.evidence_url, a.notes,
           j.title, c.name, j.url, j.status
      from public.applications a
      join public.jobs j      on j.id = a.job_id
      left join public.companies c on c.id = j.company_id
     order by a.applied_at desc;
end;
$$;

/**
 * Set (or rotate) the two codes. Service-role only — the plaintext codes never
 * reach the database, only their bcrypt hashes.
 *
 * Passing null/empty for a code leaves the existing one untouched, so you can
 * rotate one without having to re-supply the other.
 */
create or replace function public.set_app_codes(
  p_unlock       text default null,
  p_before_apply text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  insert into public.app_settings (id, unlock_code_hash, before_apply_code_hash, updated_at)
  values (
    true,
    case when p_unlock       is null or p_unlock       = '' then null else crypt(p_unlock,       gen_salt('bf', 12)) end,
    case when p_before_apply is null or p_before_apply = '' then null else crypt(p_before_apply, gen_salt('bf', 12)) end,
    now()
  )
  on conflict (id) do update
     set unlock_code_hash       = coalesce(excluded.unlock_code_hash,       public.app_settings.unlock_code_hash),
         before_apply_code_hash = coalesce(excluded.before_apply_code_hash, public.app_settings.before_apply_code_hash),
         updated_at             = now();
end;
$$;

-- ─── grants ───────────────────────────────────────────────────────────────────
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, so revoking from
-- anon/authenticated alone would NOT be enough — the PUBLIC grant has to go too.
-- Miss this and `set_app_codes` is callable by anyone holding the anon key.

revoke all on function public.verify_app_code(text, text) from public, anon, authenticated;
revoke all on function public.set_app_codes(text, text)  from public, anon, authenticated;
revoke all on function public.app_unlock(text)           from public, anon, authenticated;
revoke all on function public.record_application(text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.list_applications(text)    from public, anon, authenticated;

grant execute on function public.app_unlock(text) to anon, authenticated;
grant execute on function public.record_application(text, uuid, text, text, text) to anon, authenticated;
grant execute on function public.list_applications(text) to anon, authenticated;

-- service_role needs these too: `scripts/sync-codes.ts` verifies the code it just
-- set by calling app_unlock, which would otherwise fail on a missing grant.
grant execute on function public.app_unlock(text)           to service_role;
grant execute on function public.list_applications(text)    to service_role;
grant execute on function public.record_application(text, uuid, text, text, text) to service_role;
grant execute on function public.set_app_codes(text, text)  to service_role;

-- anon keeps a read-only view of jobs (widened above) and insert/update on
-- push_tokens (0002). It has no access at all to applications, apply_queue,
-- profile, scrape_runs or app_settings.
