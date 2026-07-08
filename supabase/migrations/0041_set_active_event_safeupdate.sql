-- 0041_set_active_event_safeupdate.sql — make set_active_event survive safeupdate.
--
-- BUG: switching the active event in the Setup tab repeatedly failed with the
-- generic "Failed to set active event." Root cause: the `authenticator` role runs
-- with `session_preload_libraries = supautils, safeupdate` (Supabase default), and
-- the `safeupdate` extension REJECTS any WHERE-less UPDATE/DELETE — even inside a
-- SECURITY DEFINER function — with `ERROR: UPDATE requires a WHERE clause`.
-- Migration 0037's body was exactly that:
--   update event set is_active = (event_key = p_event_key);   -- no WHERE → blocked
-- so every call threw, and because Postgrest errors are plain objects (not Error
-- instances) the client's `err instanceof Error` check fell through to the generic
-- message, hiding the real cause.
--
-- FIX: add a WHERE clause that keeps the flip a SINGLE atomic statement (preserving
-- 0037's "a reader always sees exactly one active event" guarantee) while touching
-- only the rows whose value actually changes:
--   where is_active is distinct from (event_key = p_event_key)
-- Net effect is identical (target → true, all others → false), but safeupdate is
-- satisfied and no-op rows aren't rewritten. Re-apply safe (create or replace).

create or replace function set_active_event(p_event_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- One statement, WHERE-guarded for safeupdate: the target becomes active and all
  -- others inactive, atomically; rows already at the desired value are skipped.
  update event
     set is_active = (event_key = p_event_key)
   where is_active is distinct from (event_key = p_event_key);
end;
$$;

grant execute on function set_active_event(text) to anon, authenticated;
