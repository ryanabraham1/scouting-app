-- 0016_select_scouter_dedupe_active_reports.sql
-- Bug: switching scouter names quickly fails with
--   duplicate key value violates unique constraint "idx_msr_match_scout_active"
--
-- Why: select_scouter (0015) consolidates duplicate scout rows for a name onto
-- this device's row and re-points their match_scouting_reports. It soft-deletes a
-- duplicate's active report ONLY when THIS DEVICE'S row already holds an active
-- report for that match. It does NOT handle the case where TWO OR MORE duplicate
-- rows each hold an active report for the SAME match (and this device's row holds
-- none). Re-pointing all of them onto v_scout.id then produces two active rows
-- for (match_key, v_scout.id), violating the partial unique index
-- idx_msr_match_scout_active (one ACTIVE report per match per scout). Rapidly
-- re-selecting names is what leaves several same-name duplicate rows (roster
-- seeds + login-less/QR-ingested reports) owning overlapping match reports.
--
-- Fix: before the blanket re-point, reduce the duplicates to AT MOST ONE active
-- report per match:
--   (A) soft-delete a duplicate's active report when this device's row already
--       holds an active report for that match (unchanged from 0015), then
--   (B) among the REMAINING duplicate active reports, keep only the most-recent
--       per match (row_revision, then updated_at) and soft-delete the rest.
-- After A+B every match has <= 1 active report across the device row + its
-- duplicates, so the re-point in (C) can never collide on the unique index.

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

  -- Consolidate any OTHER rows for this name at this event (roster-seeded rows
  -- that own published assignments / login-less reports) onto this device's row,
  -- then delete the now-empty duplicates.

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
  -- per match and soft-delete the rest. Without this, two duplicate rows that
  -- each scouted the same match (and where the device row has no active report
  -- for it) would both be re-pointed below and collide on
  -- idx_msr_match_scout_active. row_revision/updated_at pick the freshest survivor.
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

  -- (C) re-point the survivors (now <= 1 active per match) onto this device's row.
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
