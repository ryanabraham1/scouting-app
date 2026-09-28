-- Add assignment + pit_assignment to the supabase_realtime publication.
--
-- Three client channels bind postgres_changes on these tables:
--   * ScoutHome        — assignment + match_scouting_report (scout_id filter)
--   * PitScoutFlow     — pit_assignment
--   * useOfflinePreload — assignment + pit_assignment
-- Neither table was ever published. Realtime rejects a channel's whole Postgres
-- subscription when ANY binding targets an unpublished table while the channel
-- still reports joined (same failure as 20260913195100), so a lead's assignment
-- edits and a scout's own reports filed from another device never pushed to
-- scout phones — they only appeared on the 30s poll or a reload.
--
-- Mirrors the idempotent pattern from 0027 / 0034 / 20260913195100.

alter table assignment replica identity full;
alter table pit_assignment replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'assignment'
    ) then
      execute 'alter publication supabase_realtime add table assignment';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pit_assignment'
    ) then
      execute 'alter publication supabase_realtime add table pit_assignment';
    end if;
  end if;
end $$;
