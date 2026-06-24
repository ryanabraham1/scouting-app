-- 0015_select_scouter_repoint_reports.sql
-- Bug: selecting a scouter on the "Who are you?" page failed with
--   update or delete on table "scout" violates foreign key constraint
--   "match_scouting_report_scout_id_fkey" on table "match_scouting_report"
--
-- Why: select_scouter (0014) consolidates duplicate scout rows for a name onto
-- this device's row, but only re-points `assignment`. The other two tables that
-- FK to scout(id) are left dangling:
--   - match_scouting_report.scout_id   (NOT NULL)
--   - pit_scouting_report.author_scout_id (nullable)
-- A login-less/open match report (upsert_open_scout, 0012) posted against a
-- roster-seeded duplicate row leaves that row referenced, so the subsequent
-- `delete from scout ... duplicates` is blocked by the FK and the whole RPC
-- aborts — the scouter can never be selected.
--
-- Fix: before deleting the duplicates, re-point their reports onto this device's
-- row too. match_scouting_report has a partial unique index on
-- (match_key, scout_id) where not deleted, so a naive re-point could collide if
-- both the duplicate and this device's row hold an ACTIVE report for the same
-- match. We therefore soft-delete the duplicate's report when the device's row
-- already owns an active one for that match, and re-point the rest.

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
  -- rows that own the published assignments / login-less reports) onto this
  -- device's row, then delete the now-empty duplicates.

  -- assignment: re-point.
  update assignment a
    set scout_id = v_scout.id
    from scout s
    where a.scout_id = s.id
      and s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name);

  -- match_scouting_report: soft-delete duplicate's report where this device's
  -- row already holds an ACTIVE report for the same match (avoids colliding with
  -- the partial unique index idx_msr_match_scout_active on re-point)...
  update match_scouting_report r
    set deleted = true
    from scout s
    where r.scout_id = s.id
      and s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name)
      and not r.deleted
      and exists (
        select 1 from match_scouting_report m
        where m.scout_id = v_scout.id
          and m.match_key = r.match_key
          and not m.deleted
      );

  -- ...then re-point the rest.
  update match_scouting_report r
    set scout_id = v_scout.id
    from scout s
    where r.scout_id = s.id
      and s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name);

  -- pit_scouting_report.author_scout_id is nullable but FK-constrained; re-point.
  update pit_scouting_report p
    set author_scout_id = v_scout.id
    from scout s
    where p.author_scout_id = s.id
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
