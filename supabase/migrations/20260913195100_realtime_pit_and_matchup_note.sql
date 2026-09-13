-- Add pit_scouting_report + matchup_note to the supabase_realtime publication.
--
-- The dashboard's useEventLiveSync subscribes to SIX tables on ONE Realtime
-- channel. Supabase Realtime rejects the whole channel's Postgres subscription
-- when ANY binding targets a table outside the publication ("Unable to subscribe
-- to changes with given parameters"), while the channel still reports joined.
-- These two tables were bound client-side without ever being published, so
-- every live push (match results, Nexus field status, scout reports, canvas)
-- was silently dropped and the dashboard fell back to the 60s reconcile.
-- Observed live at 2026mifli2 on 2026-09-13.
--
-- Mirrors the idempotent pattern from 0027 / 0034 / 0042.

alter table pit_scouting_report replica identity full;
alter table matchup_note replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pit_scouting_report'
    ) then
      execute 'alter publication supabase_realtime add table pit_scouting_report';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matchup_note'
    ) then
      execute 'alter publication supabase_realtime add table matchup_note';
    end if;
  end if;
end $$;
