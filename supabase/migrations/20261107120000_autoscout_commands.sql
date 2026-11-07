-- 20261107120000_autoscout_commands.sql — everything a lead does to Auto-Scout besides match jobs.
--
-- autoscout_command is a small mailbox: capture a calibration frame, save a calibration, or
-- recompute saved matches. The computer collects these through autoscout-worker like jobs, so it
-- stays unreachable from the internet.
--
-- autoscout_calibration is the latest frame and landmarks per event, so a lead can calibrate from
-- a phone. The computer's event file stays the source of truth for processing.
--
-- Same model as autoscout_job: open reads, browser writes only through the RPC.

create table if not exists autoscout_command (
  id         uuid primary key default gen_random_uuid(),
  event_key  text not null references event(event_key) on delete cascade,
  kind       text not null check (kind in ('capture_frame', 'save_calibration', 'reanalyze', 'rescore', 'identify')),
  payload    jsonb not null default '{}',
  status     text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  result     jsonb not null default '{}',
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists autoscout_command_event_idx on autoscout_command (event_key, created_at desc);
create index if not exists autoscout_command_open_idx on autoscout_command (created_at) where status = 'queued';

create table if not exists autoscout_calibration (
  event_key  text primary key references event(event_key) on delete cascade,
  frame_jpeg text,
  frame_size integer[],
  frame_at   timestamptz,
  view       integer[],
  points     jsonb,
  error_m    numeric,
  saved_at   timestamptz
);

alter table autoscout_command enable row level security;
alter table autoscout_calibration enable row level security;

drop policy if exists autoscout_command_select on autoscout_command;
create policy autoscout_command_select on autoscout_command for select to anon, authenticated using (true);
drop policy if exists autoscout_calibration_select on autoscout_calibration;
create policy autoscout_calibration_select on autoscout_calibration for select to anon, authenticated using (true);

create or replace function autoscout_send_command(
  p_event_key text,
  p_kind text,
  p_payload jsonb default '{}'
) returns autoscout_command
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_command autoscout_command;
begin
  if octet_length(coalesce(p_payload, '{}')::text) > 32768 then
    raise exception 'that command is too large' using errcode = '22023';
  end if;
  if (select count(*) from autoscout_command where status in ('queued', 'running')) >= 20 then
    raise exception 'the Auto-Scout computer has too many commands waiting' using errcode = '53400';
  end if;
  insert into autoscout_command (event_key, kind, payload)
  values (p_event_key, p_kind, coalesce(p_payload, '{}'))
  returning * into v_command;
  return v_command;
end;
$$;

grant select on table autoscout_command, autoscout_calibration to anon, authenticated;
grant select, insert, update, delete on table autoscout_command, autoscout_calibration to service_role;

revoke all on function autoscout_send_command(text, text, jsonb) from public;
grant execute on function autoscout_send_command(text, text, jsonb) to anon, authenticated;
