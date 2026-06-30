-- 0034_realtime_match_scouting_report.sql
-- Add match_scouting_report to supabase_realtime so the dashboard heartbeat
-- (dashboard-heartbeat feature) refreshes the instant a scout report lands.
-- 0027 only added `match` + `nexus_event_status`; no later migration adds
-- match_scouting_report, so without this the heartbeat's realtime branch in
-- useEventLiveSync delivers nothing and silently no-ops. RLS for the table is
-- already correct (existing SELECT policy gates anon to its event); realtime
-- respects RLS, so only publication membership + replica identity change here.
-- (matchup-intelligence took 0033 in this wave, so this is 0034.)
alter table match_scouting_report replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'match_scouting_report'
    ) then
      execute 'alter publication supabase_realtime add table match_scouting_report';
    end if;
  end if;
end $$;
