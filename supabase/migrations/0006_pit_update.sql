-- 0006_pit_update.sql
-- Re-scouting a team is an UPDATE: pit_scouting_report's PK is
-- (event_key, team_number), so submitPit's upsert resolves to
-- ON CONFLICT DO UPDATE. The only existing write policy is pit_insert_self
-- (INSERT), so a correction/re-submit is blocked by RLS. Add an UPDATE policy
-- that MIRRORS pit_insert_self's scoping (own event + own scout id).

drop policy if exists pit_update_self on pit_scouting_report;
create policy pit_update_self on pit_scouting_report
  for update to authenticated
  using (
    pit_scouting_report.event_key in (select get_my_event_keys())
  )
  with check (
    pit_scouting_report.event_key in (select get_my_event_keys())
    and pit_scouting_report.author_scout_id in (select get_my_scout_ids())
  );
