-- 0036_select_scouter_identity_per_name.sql
--
-- BUG: scouting a few matches as "Test 5", then switching to "Test 2" on the SAME
-- device, retroactively reassigned every "Test 5" report to "Test 2".
--
-- WHY: 0009..0016 keyed the device's identity by (event_key, auth_uid) — ONE row
-- per device per event — and select_scouter resolved it with
--   insert ... on conflict (event_key, auth_uid) do update set display_name = ...
-- So picking a new name UPDATED THE SAME ROW's display_name in place. Because every
-- report references that row by id, renaming the row relabels all of its prior
-- reports. A device is allowed to scout under different names over an event (shared
-- device, hand-offs, testing), and each name must keep its own reports.
--
-- FIX: resolve identity by NAME, not by device. A name switch now:
--   (0) RELEASES any row this device owns under a DIFFERENT name — it keeps its
--       display_name + every report, only losing this device's ownership claim.
--       auth_uid is NOT NULL, so "release" = reassign a fresh synthesized uuid
--       (exactly what roster-seeding / QR-ingest rows carry). The composite
--       (event_key, auth_uid) unique index then leaves auth_uid=v_uid free.
--   (1) Resolves THIS name's canonical row (prefer one we already owned, else any
--       existing same-name row, else create) and claims it for this device.
-- The same-name consolidation (A/B/C re-point + delete) is verbatim from 0016, so
-- roster-seeded / login-less / QR duplicates of the SAME name still merge onto the
-- device's row without colliding on idx_msr_match_scout_active.
--
-- Old reports are untouched: upsert_match_report (0032) uses a report's OWN scout_id
-- whenever that row still exists (it does — we never delete the released row), so
-- a different-name report never re-points to the newly selected identity.

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

  -- (0) Release rows this device owns under a DIFFERENT name (keep their reports).
  update scout
    set auth_uid = gen_random_uuid()
    where event_key = p_event_key
      and auth_uid = v_uid
      and lower(display_name) <> lower(p_name);

  -- (1) Resolve THIS name's canonical row, claiming it for the device. Prefer a
  -- row we already own, else the oldest existing same-name row, else create one.
  select * into v_scout
    from scout
    where event_key = p_event_key
      and lower(display_name) = lower(p_name)
    order by (auth_uid is not distinct from v_uid) desc, created_at asc
    limit 1;

  if v_scout.id is null then
    insert into scout (event_key, display_name, auth_uid)
    values (p_event_key, p_name, v_uid)
    returning * into v_scout;
  else
    update scout
      set auth_uid = v_uid, display_name = p_name
      where id = v_scout.id
      returning * into v_scout;
  end if;

  -- Consolidate any OTHER rows for THIS name at this event (roster-seeded rows that
  -- own published assignments / login-less reports) onto the device's row, then
  -- delete the now-empty duplicates. (Verbatim from 0016.)

  -- assignment: re-point (no unique constraint on assignment, so always safe).
  update assignment a
    set scout_id = v_scout.id
    from scout s
    where a.scout_id = s.id
      and s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name);

  -- (A) match_scouting_report: soft-delete a duplicate's active report where this
  -- device's row already holds an active report for the same match.
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

  -- (B) among the REMAINING duplicate active reports, keep only the most-recent
  -- per match and soft-delete the rest (else two duplicates that scouted the same
  -- match both re-point below and collide on idx_msr_match_scout_active).
  with ranked as (
    select r.id,
           row_number() over (
             partition by r.match_key
             order by r.row_revision desc, r.updated_at desc, r.id desc
           ) as rn
    from match_scouting_report r
    join scout s on s.id = r.scout_id
    where s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name)
      and not r.deleted
  )
  update match_scouting_report r
    set deleted = true
    from ranked
    where r.id = ranked.id
      and ranked.rn > 1;

  -- (C) re-point the survivors (now <= 1 active per match) onto the device's row.
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
