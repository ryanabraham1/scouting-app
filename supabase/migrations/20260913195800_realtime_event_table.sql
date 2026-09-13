-- Add `event` to the supabase_realtime publication.
--
-- useActiveEvent subscribes to `event` changes so a Setup-tab active-event flip
-- on one device pushes to every open dashboard. The table was never published,
-- so the server rejected that channel's subscription ("Unable to subscribe to
-- changes with given parameters … table: event") on every dashboard load — the
-- flip only propagated via the focus/interval refetch. Same class of bug as
-- 20260913195100 (pit_scouting_report / matchup_note).

alter table event replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'event'
    ) then
      execute 'alter publication supabase_realtime add table event';
    end if;
  end if;
end $$;
