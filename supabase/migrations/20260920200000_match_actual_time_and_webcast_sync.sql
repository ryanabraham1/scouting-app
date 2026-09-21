-- Livestream match-jump: persist the FMS-reported match start and a per-stream
-- calibration so the dashboard can seek the event's YouTube livestream / VOD to
-- the moment a match started when TBA has no match video yet.
--
-- 1. match.actual_time — TBA's `actual_time` (FMS start of the match). Written by
--    tba-webhook (match_score) and sync-event-results alongside predicted_time.
-- 2. webcast_sync — when each livestream (one YouTube video id per event day)
--    actually started, keyed by (event_key, video_id). `auto` rows are derived
--    on a dashboard while the stream is live (now - elapsed); `manual` rows come
--    from a lead pressing "Sync to match start" on a match with an actual_time
--    and must never be overwritten by an auto derivation. Shared-trust model:
--    anon writes are intentional (see CLAUDE.md "Authorization model").
alter table public.match
  add column if not exists actual_time timestamptz;

comment on column public.match.actual_time is
  'TBA/FMS actual match start time; nullable until the match is played.';

create table if not exists public.webcast_sync (
  event_key       text not null references public.event(event_key) on delete cascade,
  video_id        text not null,
  stream_start_at timestamptz not null,
  source          text not null check (source in ('auto', 'manual')),
  updated_at      timestamptz not null default now(),
  primary key (event_key, video_id)
);

alter table public.webcast_sync enable row level security;

drop policy if exists webcast_sync_select on public.webcast_sync;
create policy webcast_sync_select on public.webcast_sync
  for select to anon, authenticated using (true);

drop policy if exists webcast_sync_insert on public.webcast_sync;
create policy webcast_sync_insert on public.webcast_sync
  for insert to anon, authenticated with check (true);

drop policy if exists webcast_sync_update on public.webcast_sync;
create policy webcast_sync_update on public.webcast_sync
  for update to anon, authenticated using (true) with check (true);

-- Explicit Data API grants (fresh projects grant nothing by default; see
-- 20260722181527_explicit_browser_data_api_grants.sql — the grants contract test
-- reads that manifest plus this addendum). The browser reads the map and upserts
-- calibrations directly; no service-role access is needed.
revoke all privileges on table public.webcast_sync from anon, authenticated, service_role;
grant select, insert, update on table public.webcast_sync to anon, authenticated;
