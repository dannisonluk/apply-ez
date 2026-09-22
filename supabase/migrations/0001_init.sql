-- apply-ez — initial schema
--
-- Target: Supabase (Postgres 15+). Run via the Supabase SQL editor or
-- `supabase db push`.
--
-- Design notes:
--   * `jobs.first_seen_at` is the ONLY source of truth for "this is a new job".
--     It is set by the DB default on INSERT and is never sent in the scraper's
--     upsert payload, so a conflict-update cannot clobber it.
--   * `jobs.published_at` comes from the source page and is frequently wrong or
--     missing (many career sites omit it). Never use it to detect new jobs.
--   * `unique (source, external_id)` is required — the scraper upserts against it.

create extension if not exists "pgcrypto";

-- ─── companies ────────────────────────────────────────────────────────────────
create table if not exists public.companies (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  domain        text,
  careers_url   text,
  ats_platform  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─── jobs ─────────────────────────────────────────────────────────────────────
create table if not exists public.jobs (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies (id) on delete cascade,
  source                text not null,
  external_id           text not null,

  title                 text not null,
  location              text,
  url                   text not null,
  apply_url             text,

  employment_type       text,
  raw_employment_type   text,
  department            text,
  work_schedule         text,
  application_deadline  timestamptz,
  experience_min        int,

  salary_min            int,
  salary_max            int,
  salary_currency       text default 'HKD',
  remote                boolean not null default false,
  requires_visa         boolean not null default false,

  tags                  jsonb not null default '[]'::jsonb,
  classification        jsonb not null default '{}'::jsonb,
  top_metadata          jsonb not null default '{}'::jsonb,

  published_at          timestamptz not null,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),

  -- ACTIVE | EXPIRED. EXPIRED is set only by the full-crawl reconcile.
  status                text not null default 'ACTIVE',
  missing_count         int not null default 0,
  last_missing_at       timestamptz,

  -- LLM enrichment layer (OpenRouter). Populated only for newly seen jobs.
  summary               text,
  summary_lang          text,
  extracted             jsonb,
  enrich_status         text not null default 'PENDING',  -- PENDING | OK | FAILED | SKIPPED
  enrich_model          text,
  enriched_at           timestamptz,

  constraint jobs_source_external_id_key unique (source, external_id)
);

create index if not exists jobs_first_seen_at_idx   on public.jobs (first_seen_at desc);
create index if not exists jobs_company_seen_idx    on public.jobs (company_id, first_seen_at desc);
create index if not exists jobs_status_seen_idx     on public.jobs (status, first_seen_at desc);
create index if not exists jobs_company_source_idx  on public.jobs (company_id, source, status);
create index if not exists jobs_enrich_status_idx   on public.jobs (enrich_status);
create index if not exists jobs_deadline_idx        on public.jobs (application_deadline);

-- ─── scrape_runs (observability) ──────────────────────────────────────────────
create table if not exists public.scrape_runs (
  id            uuid primary key default gen_random_uuid(),
  target_id     text not null,
  adapter       text not null,
  started_at    timestamptz not null,
  finished_at   timestamptz,
  inserted      int not null default 0,
  updated       int not null default 0,
  total         int not null default 0,
  error_count   int not null default 0,
  errors        jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists scrape_runs_target_idx on public.scrape_runs (target_id, started_at desc);

-- ─── profile (single-user for now) ────────────────────────────────────────────
-- `resumes` holds the three CV variants: { tech, data, general } -> R2 object key.
-- `autofill` holds the answers used by the assisted-apply webview.
create table if not exists public.profile (
  id          uuid primary key default gen_random_uuid(),
  full_name   text,
  email       text,
  phone       text,
  autofill    jsonb not null default '{}'::jsonb,
  resumes     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ─── apply_queue ──────────────────────────────────────────────────────────────
-- Every application stops at NEEDS_HUMAN and waits for an explicit submit.
--   PENDING -> PREPARED -> NEEDS_HUMAN -> DONE | FAILED
create table if not exists public.apply_queue (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs (id) on delete cascade,
  status      text not null default 'PENDING',
  -- which CV variant to send: tech | data | general
  resume_key  text,
  method      text,               -- webview | email
  payload     jsonb not null default '{}'::jsonb,
  log         jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists apply_queue_status_idx on public.apply_queue (status, created_at);
create index if not exists apply_queue_job_idx    on public.apply_queue (job_id);

-- ─── applications ─────────────────────────────────────────────────────────────
create table if not exists public.applications (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs (id) on delete cascade,
  status        text not null default 'SUBMITTED',
  resume_key    text,
  applied_at    timestamptz not null default now(),
  -- screenshot / confirmation page captured just before the human clicked submit
  evidence_url  text,
  notes         text,
  constraint applications_job_key unique (job_id)
);

create index if not exists applications_applied_at_idx on public.applications (applied_at desc);

-- ─── RLS ──────────────────────────────────────────────────────────────────────
-- The scraper and the apply worker authenticate with the service-role key, which
-- bypasses RLS. The mobile app reads with the anon key, so jobs need a narrow
-- public read policy. Everything else stays service-role only.
alter table public.companies    enable row level security;
alter table public.jobs         enable row level security;
alter table public.scrape_runs  enable row level security;
alter table public.profile      enable row level security;
alter table public.apply_queue  enable row level security;
alter table public.applications enable row level security;

drop policy if exists "public can read active jobs" on public.jobs;
create policy "public can read active jobs"
  on public.jobs for select
  to anon, authenticated
  using (status = 'ACTIVE');

drop policy if exists "public can read companies" on public.companies;
create policy "public can read companies"
  on public.companies for select
  to anon, authenticated
  using (true);
