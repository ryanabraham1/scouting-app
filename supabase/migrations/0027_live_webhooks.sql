-- 0027_live_webhooks.sql
-- Real-time field/result ingest via webhooks (TBA + Nexus).
--
-- Three things:
--   1. Relax the match.comp_level CHECK so playoff matches (ef/qf/sf/f) can land
--      alongside quals — the TBA match_score webhook and the results reconcile
--      need to write/track playoff matches, not just qm.
--   2. nexus_event_status: the latest LIVE field snapshot Nexus pushes per event
--      (via the nexus-webhook function). Guarded by data_as_of_time so an
--      out-of-order push can never roll the snapshot backwards.
--   3. Add `match` + `nexus_event_status` to the supabase_realtime publication so
--      the dashboard updates the instant a result is scored / the field advances.

-- 1. Allow all comp levels (was: check (comp_level = 'qm')).
alter table match drop constraint if exists match_comp_level_check;
alter table match add constraint match_comp_level_check
  check (comp_level in ('qm', 'ef', 'qf', 'sf', 'f'));

-- Helps the per-event reads the dashboard + realtime filters do.
create index if not exists idx_match_event on match (event_key);

-- 2. Latest Nexus live snapshot per event. No FK to event(event_key): a push may
--    arrive for an event a client hasn't imported yet, and we never want a
--    webhook to hard-fail (TBA/Nexus delete endpoints that error). Orphans are
--    harmless — the dashboard only reads the row for its active event.
create table if not exists nexus_event_status (
  event_key       text primary key,
  data_as_of_time bigint,
  now_queuing     text,
  payload         jsonb not null,
  received_at     timestamptz not null default now()
);

alter table nexus_event_status enable row level security;

-- Live field status is non-sensitive (it mirrors public frc.nexus data), and the
-- lead dashboard's anon session must always see it regardless of event membership.
drop policy if exists nexus_status_read_all on nexus_event_status;
create policy nexus_status_read_all on nexus_event_status
  for select using (true);
-- No INSERT/UPDATE/DELETE policy -> anon/authenticated are denied; only the
-- service-role webhook (which bypasses RLS) writes here.

-- Atomic, staleness-guarded upsert. The webhook calls this with the service-role
-- client; the WHERE makes an older (or equal-but-reordered) push a no-op so the
-- snapshot only ever moves forward in dataAsOfTime.
create or replace function nexus_upsert_status(
  p_event_key       text,
  p_data_as_of_time bigint,
  p_now_queuing     text,
  p_payload         jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_written boolean := false;
begin
  insert into nexus_event_status (event_key, data_as_of_time, now_queuing, payload, received_at)
  values (p_event_key, p_data_as_of_time, p_now_queuing, p_payload, now())
  on conflict (event_key) do update
    set data_as_of_time = excluded.data_as_of_time,
        now_queuing     = excluded.now_queuing,
        payload         = excluded.payload,
        received_at     = now()
    where excluded.data_as_of_time is null
       or nexus_event_status.data_as_of_time is null
       or excluded.data_as_of_time >= nexus_event_status.data_as_of_time;
  get diagnostics v_written = row_count;
  return v_written;
end $$;

-- Service-role only (it bypasses RLS anyway); never expose status writes to anon.
revoke all on function nexus_upsert_status(text, bigint, text, jsonb) from public;
grant execute on function nexus_upsert_status(text, bigint, text, jsonb) to service_role;

-- 3. Realtime: deliver row changes to subscribed dashboards. REPLICA IDENTITY FULL
--    so RLS-filtered realtime works on UPDATE/DELETE (Supabase recommendation).
alter table match replica identity full;
alter table nexus_event_status replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'match'
    ) then
      execute 'alter publication supabase_realtime add table match';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'nexus_event_status'
    ) then
      execute 'alter publication supabase_realtime add table nexus_event_status';
    end if;
  end if;
end $$;
