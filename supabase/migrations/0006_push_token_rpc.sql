-- apply-ez — register and disable a push token through an RPC
--
-- Run after 0005_jd_sections.sql.
--
-- ## Why this exists
--
-- 0002 grants anon INSERT and UPDATE on `push_tokens`, and deliberately grants no
-- SELECT so a token cannot be enumerated from a client. That is sound for a plain
-- INSERT and a plain UPDATE, but it cannot express the upsert the app needs:
--
--   * `INSERT ... ON CONFLICT (token) DO UPDATE` has to see the conflicting row to
--     decide whether to insert or update. With no SELECT policy that row is invisible,
--     so the statement fails with 42501 "new row violates row-level security policy
--     for table push_tokens". The message names the INSERT policy — which exists and
--     is correct — so it points at the wrong place entirely.
--   * `PATCH /push_tokens?token=eq.…` matches zero rows for the same reason, and
--     answers 204. Turning notifications off therefore looked like it worked while the
--     row kept `enabled = true` and the scraper kept sending.
--
-- ## Why not just add a SELECT policy
--
-- That fixes both and hands every client the ability to read every device's push
-- token. A token is a capability: anyone holding one can send that device a
-- notification through the public Expo push API. So the writes move behind
-- SECURITY DEFINER functions instead — they run as the owner, RLS does not apply
-- inside them, and anon keeps no read access at all.
--
-- search_path is pinned with pg_temp last because these are SECURITY DEFINER.

create or replace function public.register_push_token(
  p_token       text,
  p_device_id   text default null,
  p_platform    text default null,
  p_device_name text default null
)
returns void
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  insert into public.push_tokens (token, device_id, platform, device_name, enabled, last_seen_at)
  values (p_token, p_device_id, p_platform, p_device_name, true, now())
  on conflict (token) do update
    set device_id    = excluded.device_id,
        platform     = excluded.platform,
        device_name  = excluded.device_name,
        -- Re-enabling on registration is deliberate: the app only calls this while the
        -- user has notifications switched on, so a device that comes back comes back on.
        enabled      = true,
        last_seen_at = now();
$$;

create or replace function public.disable_push_token(p_token text)
returns void
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  update public.push_tokens
     set enabled = false
   where token = p_token;
$$;

-- `revoke ... from public` first. Postgres grants EXECUTE on a new function to PUBLIC
-- by default, so revoking from anon alone would leave the door open to every role.
revoke all on function public.register_push_token(text, text, text, text) from public;
revoke all on function public.disable_push_token(text) from public;
grant execute on function public.register_push_token(text, text, text, text) to anon, authenticated;
grant execute on function public.disable_push_token(text) to anon, authenticated;

-- The direct table grants from 0002 are withdrawn. The RPCs are now the only writer,
-- and leaving INSERT and UPDATE reachable would let a client plant arbitrary rows for
-- no benefit — nothing calls the table directly any more. SELECT was already denied,
-- so the net effect for anon is: two functions, no table access.
revoke insert, update on public.push_tokens from anon, authenticated;
