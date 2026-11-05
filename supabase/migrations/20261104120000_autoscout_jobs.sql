-- 20261104120000_autoscout_jobs.sql — run the Auto-Scout video computer from the lead dashboard.
--
-- The computer is never reachable from the internet. It calls the autoscout-worker Edge Function
-- to collect jobs and push status/results, so jobs wait here while it is off and results land
-- with every browser closed.
--
-- Kinds: 'matches' = TBA's per-match videos; 'vod' = clip each match out of an ended livestream;
-- 'live' = record an ongoing livestream and clip each match as TBA posts it, then scout the clip
-- unless `scout` is off. No source_url means the event's own stream: the computer finds the right
-- day's webcast on TBA, as the dashboard does.
--
-- Automated estimates are deliberately kept out of match_report: that path recomputes from raw
-- human inputs, and an estimate must never count as a second independent observation.
--
-- RLS mirrors board_record: reads are open (the dashboard runs on a silent anon session), browsers
-- write only through the SECURITY DEFINER RPCs below, and the worker writes with the service role
-- inside its Edge Function. FKs cascade so delete_event needs no change.

create table if not exists autoscout_job (
  id                uuid primary key default gen_random_uuid(),
  event_key         text not null references event(event_key) on delete cascade,
  kind              text not null check (kind in ('matches', 'vod', 'live')),
  match_keys        text[] not null default '{}',
  source_url        text check (source_url is null or char_length(source_url) <= 300),
  -- Manual webcast_sync calibrations, video id -> start; these beat the platform's start time.
  stream_starts     jsonb not null default '{}',
  force             boolean not null default false,
  scout             boolean not null default true,
  status            text not null default 'queued'
                    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- Set once the computer has been handed the job: from then on only it can confirm a stop.
  claimed_at        timestamptz,
  cancel_requested  boolean not null default false,
  completed_matches text[] not null default '{}',
  match_errors      jsonb not null default '{}',
  progress          jsonb not null default '{}',
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists autoscout_job_event_created_idx on autoscout_job (event_key, created_at desc);
create index if not exists autoscout_job_open_idx on autoscout_job (created_at) where status in ('queued', 'running');
-- Two recorders of one event would process every match twice.
create unique index if not exists autoscout_job_one_live_per_event
  on autoscout_job (event_key) where kind = 'live' and status in ('queued', 'running');

create table if not exists autoscout_result (
  match_key      text primary key,
  event_key      text not null references event(event_key) on delete cascade,
  job_id         uuid references autoscout_job(id) on delete set null,
  job_created_at timestamptz not null,
  envelope       jsonb not null,
  imported_at    timestamptz not null default now()
);

create index if not exists autoscout_result_event_idx on autoscout_result (event_key);

-- One computer, one row.
create table if not exists autoscout_worker (
  id                boolean primary key default true check (id),
  last_seen_at      timestamptz not null default now(),
  calibrated_events text[] not null default '{}',
  free_gb           numeric,
  busy              boolean not null default false
);

-- SHA-256 of the computer's worker token, so the database never holds a usable credential.
-- Private: no browser grants, no policies. To rotate, update this row and the computer's .env.
create table if not exists autoscout_worker_secret (
  id           boolean primary key default true check (id),
  token_sha256 text not null check (token_sha256 ~ '^[0-9a-f]{64}$')
);

alter table autoscout_worker_secret enable row level security;
alter table autoscout_job enable row level security;
alter table autoscout_result enable row level security;
alter table autoscout_worker enable row level security;

drop policy if exists autoscout_job_select on autoscout_job;
create policy autoscout_job_select on autoscout_job for select to anon, authenticated using (true);
drop policy if exists autoscout_result_select on autoscout_result;
create policy autoscout_result_select on autoscout_result for select to anon, authenticated using (true);
drop policy if exists autoscout_worker_select on autoscout_worker;
create policy autoscout_worker_select on autoscout_worker for select to anon, authenticated using (true);

create or replace function autoscout_enqueue(
  p_event_key text,
  p_kind text,
  p_match_keys text[] default '{}',
  p_source_url text default null,
  p_stream_starts jsonb default '{}',
  p_force boolean default false,
  p_scout boolean default true
) returns autoscout_job
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keys text[] := coalesce(p_match_keys, '{}');
  v_job autoscout_job;
begin
  if p_kind not in ('matches', 'vod', 'live') then
    raise exception 'unknown job kind' using errcode = '22023';
  end if;
  if p_kind = 'live' and cardinality(v_keys) > 0 then
    raise exception 'a live job follows the event, it takes no match list' using errcode = '22023';
  end if;
  if p_kind <> 'live' and (cardinality(v_keys) = 0 or cardinality(v_keys) > 100) then
    raise exception 'pick between 1 and 100 matches' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_keys) k where k not like p_event_key || '\_%') then
    raise exception 'matches must belong to the event' using errcode = '22023';
  end if;
  if p_source_url is not null and p_source_url !~ '^https://' then
    raise exception 'a stream link must be https' using errcode = '22023';
  end if;
  if (select count(*) from autoscout_job where status in ('queued', 'running')) >= 20 then
    raise exception 'the Auto-Scout queue is full' using errcode = '53400';
  end if;

  insert into autoscout_job (event_key, kind, match_keys, source_url, stream_starts, force, scout)
  values (p_event_key, p_kind, v_keys,
          case when p_kind = 'matches' then null else p_source_url end,
          case when p_kind = 'vod' then coalesce(p_stream_starts, '{}') else '{}' end,
          coalesce(p_force, false), coalesce(p_scout, true))
  returning * into v_job;
  return v_job;
exception when unique_violation then
  raise exception 'this event already has a live stream job' using errcode = '23505';
end;
$$;

create or replace function autoscout_cancel(p_id uuid) returns autoscout_job
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job autoscout_job;
begin
  update autoscout_job
     set status = case when claimed_at is null and status = 'queued' then 'cancelled' else status end,
         cancel_requested = claimed_at is not null,
         updated_at = now()
   where id = p_id and status in ('queued', 'running')
  returning * into v_job;
  return v_job;
end;
$$;

-- A delayed upload from an older job must not replace a newer run of the same match.
create or replace function autoscout_store_result(
  p_job_id uuid,
  p_match_key text,
  p_envelope jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job autoscout_job;
  v_rows integer;
begin
  select * into v_job from autoscout_job where id = p_job_id;
  if not found then
    return false;
  end if;
  insert into autoscout_result (match_key, event_key, job_id, job_created_at, envelope)
  values (p_match_key, v_job.event_key, v_job.id, v_job.created_at, p_envelope)
  on conflict (match_key) do update
     set event_key = excluded.event_key, job_id = excluded.job_id,
         job_created_at = excluded.job_created_at, envelope = excluded.envelope, imported_at = now()
   where excluded.job_created_at >= autoscout_result.job_created_at;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- This project does not auto-grant new objects (20260722181527_explicit_browser_data_api_grants).
grant select on table autoscout_job, autoscout_result, autoscout_worker to anon, authenticated;
grant select, insert, update, delete on table autoscout_job, autoscout_result, autoscout_worker to service_role;
revoke all on table public.autoscout_worker_secret from anon, authenticated;
grant select on table autoscout_worker_secret to service_role;

revoke all on function autoscout_enqueue(text, text, text[], text, jsonb, boolean, boolean) from public;
revoke all on function autoscout_cancel(uuid) from public;
revoke all on function autoscout_store_result(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function autoscout_enqueue(text, text, text[], text, jsonb, boolean, boolean) to anon, authenticated;
grant execute on function autoscout_cancel(uuid) to anon, authenticated;
grant execute on function autoscout_store_result(uuid, text, jsonb) to service_role;
