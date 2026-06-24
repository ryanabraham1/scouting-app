-- 0014_select_scouter_consolidate.sql
-- Bug: scouts saw NO assignments in the mobile scouting area.
--
-- Why: the lead's "Auto-generate" flow seeds a `scout` row per roster name via
-- seed_event_scouts_from_roster (0013), each with a *synthesized* random auth_uid,
-- and publishes assignments against those seeded rows (assignment.scout_id ->
-- seeded scout.id). But when a real device picks the same name, select_scouter
-- (0009) upserts on (event_key, auth_uid) and — since the device's real auth.uid()
-- differs from the seeded row's synthesized one — INSERTS a brand-new scout row
-- with a different id. The device then queries `assignment where scout_id = <its
-- new id>` and matches nothing, because every published assignment still points at
-- the seeded row. Result: two scout rows per person, assignments orphaned on the
-- seeded one, an empty list on the device.
--
-- Fix: when a device selects a name, consolidate any duplicate rows for that name
-- at the event onto the device's own (stable) scout row — re-point their
-- assignments, then delete the now-empty duplicates. The device's id is preserved
-- (so useSession's cached row, capture targets, etc. stay valid) and the published
-- assignments follow the scout to the row the device actually queries.

create or replace function select_scouter(p_event_key text, p_name text)
returns scout
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_scout scout;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- This device's canonical scout row for the event (stable id across reloads).
  insert into scout (event_key, display_name, auth_uid)
  values (p_event_key, p_name, v_uid)
  on conflict (event_key, auth_uid)
    do update set display_name = excluded.display_name
  returning * into v_scout;

  -- Consolidate any OTHER rows for this name at this event (e.g. roster-seeded
  -- rows that own the published assignments) onto this device's row.
  update assignment a
    set scout_id = v_scout.id
    from scout s
    where a.scout_id = s.id
      and s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name);

  delete from scout s
    where s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name);

  insert into profile (auth_uid) values (v_uid)
  on conflict (auth_uid) do nothing;

  return v_scout;
end;
$$;

grant execute on function select_scouter(text, text) to anon, authenticated;
