-- 0035_delete_roster_scouter_pit_reports.sql
--
-- delete_roster_scouter now DELETES each scouter's pit reports instead of merely
-- nulling author_scout_id (which orphaned them and left them undeletable). This
-- is the only path that removes a pit report, so a team-wide scouter delete now
-- cleans up every report they authored — match AND pit — across all events.
--
-- Mirrors 0020's body otherwise (match_scouting_report + assignment + scout row,
-- per matching `scout` row by name, then the roster entry).

create or replace function delete_roster_scouter(p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scout_id uuid;
begin
  for v_scout_id in
    select id from scout where lower(display_name) = lower(p_name)
  loop
    delete from match_scouting_report where scout_id = v_scout_id;
    delete from assignment where scout_id = v_scout_id;
    delete from pit_scouting_report where author_scout_id = v_scout_id;
    delete from scout where id = v_scout_id;
  end loop;
  delete from scouter_roster where lower(name) = lower(p_name);
end;
$$;

grant execute on function delete_roster_scouter(text) to anon, authenticated;
