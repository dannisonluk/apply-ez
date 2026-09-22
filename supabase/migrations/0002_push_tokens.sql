-- apply-ez — push notification tokens
--
-- Run after 0001_init.sql.
--
-- Design notes:
--
--   * The app has no authentication (single user, personal app), so the anon key
--     must be able to register a device. That is why anon is granted INSERT and
--     UPDATE here.
--
--   * anon is deliberately NOT granted SELECT. A push token is effectively a
--     capability: anyone holding one can send a notification to that device via
--     the public Expo push API. Blocking reads means tokens cannot be enumerated
--     or harvested from the client. The scraper reads them with the service-role
--     key, which bypasses RLS entirely.
--
--   * No DELETE for anon either. Turning notifications off flips `enabled` to
--     false rather than removing the row, so a re-enable is a cheap update.
--
--   * `token` is unique so re-registering the same device is an upsert instead of
--     accumulating a new row on every app launch.

create table if not exists public.push_tokens (
  id            uuid primary key default gen_random_uuid(),
  token         text not null unique,
  device_id     text,
  platform      text,
  device_name   text,
  enabled       boolean not null default true,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- The scraper's only query is "enabled tokens", so index on that.
create index if not exists push_tokens_enabled_idx on public.push_tokens (enabled)
  where enabled = true;

alter table public.push_tokens enable row level security;

drop policy if exists "anon can register a device" on public.push_tokens;
create policy "anon can register a device"
  on public.push_tokens for insert
  to anon, authenticated
  with check (true);

drop policy if exists "anon can update a device" on public.push_tokens;
create policy "anon can update a device"
  on public.push_tokens for update
  to anon, authenticated
  using (true)
  with check (true);

-- Intentionally no SELECT policy: without one, RLS denies all reads for anon.
-- The service role bypasses RLS, so the scraper can still list tokens.
