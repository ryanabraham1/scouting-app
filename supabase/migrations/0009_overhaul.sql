-- 0009_overhaul.sql — Mobile-first overhaul: persistent scouter roster, login-less
-- scouter selection, and exact defense/being-defended durations. ADDITIVE ONLY:
-- existing columns, the aggregate recompute, and the QR/sync wire shape are unchanged.

-- ── A2. Persistent, TEAM-SCOPED scouter roster (NOT event-scoped) ───────────────
create table if not exists scouter_roster (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists scouter_roster_name_unique on scouter_roster (lower(name));

alter table scouter_roster enable row level security;
-- Single-team app with no login: the roster is openly readable/editable by any
-- session (anon or authenticated). No event scoping — names persist across events.
drop policy if exists scouter_roster_all on scouter_roster;
create policy scouter_roster_all on scouter_roster
  for all to anon, authenticated using (true) with check (true);

-- ── A3. Login-less scouter selection ────────────────────────────────────────────
-- One scout row per (event_key, auth.uid()); a device's chosen roster name maps to
-- that row. Requires a unique key on (event_key, auth_uid) for the upsert below.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'scout_event_uid_unique'
  ) then
    alter table scout add constraint scout_event_uid_unique unique (event_key, auth_uid);
  end if;
end $$;

-- select_scouter: create-or-rename the scout bound to (event, auth.uid()) for a
-- chosen roster name. Replaces the join-code join_event flow (no code required).
create or replace function select_scouter(p_event_key text, p_name text)
returns scout
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_scout scout;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  insert into scout (event_key, display_name, auth_uid)
  values (p_event_key, p_name, v_uid)
  on conflict (event_key, auth_uid)
    do update set display_name = excluded.display_name
  returning * into v_scout;

  insert into profile (auth_uid) values (v_uid)
  on conflict (auth_uid) do nothing;

  return v_scout;
end;
$$;

grant execute on function select_scouter(text, text) to anon, authenticated;

-- ── A4. Exact defense / being-defended durations (no buckets) ────────────────────
alter table match_scouting_report
  add column if not exists defense_duration_ms int not null default 0;
alter table match_scouting_report
  add column if not exists defended_duration_ms int not null default 0;

-- Extend upsert_match_report to read/write the two duration columns. This is a
-- verbatim copy of the 0004 body with ONLY the two new columns added to the INSERT
-- and UPDATE lists; every existing param/column/coalesce is preserved.
create or replace function upsert_match_report(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_incoming_rev bigint := coalesce((p->>'row_revision')::bigint, 1);
  v_existing_rev bigint;
begin
  perform set_config('app.skip_msr_bump', 'on', true);

  if auth.uid() is not null then
    if not exists (
      select 1 from scout s
      where s.id = (p->>'scout_id')::uuid
        and s.auth_uid = auth.uid()
    ) then
      raise exception 'not authorized: scout_id not owned by caller' using errcode = '42501';
    end if;
  end if;

  select row_revision into v_existing_rev
  from match_scouting_report where id = v_id;

  if v_existing_rev is null then
    insert into match_scouting_report (
      id, schema_version, app_version, device_id, event_key, match_key, scout_id,
      target_team_number, alliance_color, station, inactive_first, inactive_first_source,
      teleop_clock_unconfirmed, fuel_bursts, climb_level, climb_attempted, climb_success,
      auto_start_position, auto_path, auto_left_starting_line, auto_climb_level1,
      intake_sources, max_fuel_capacity_observed, defense_rating, pins, fouls_minor,
      fouls_major, no_show, died, tipped, dropped_fuel, fed_corral, notes,
      defense_duration_ms, defended_duration_ms,
      row_revision, deleted
    ) values (
      v_id,
      (p->>'schema_version')::int,
      p->>'app_version',
      p->>'device_id',
      p->>'event_key',
      p->>'match_key',
      (p->>'scout_id')::uuid,
      (p->>'target_team_number')::int,
      p->>'alliance_color',
      (p->>'station')::int,
      (p->>'inactive_first')::boolean,
      p->>'inactive_first_source',
      coalesce((p->>'teleop_clock_unconfirmed')::boolean, false),
      coalesce(p->'fuel_bursts', '[]'::jsonb),
      coalesce((p->>'climb_level')::int, 0),
      coalesce((p->>'climb_attempted')::boolean, false),
      coalesce((p->>'climb_success')::boolean, false),
      p->'auto_start_position',
      p->'auto_path',
      coalesce((p->>'auto_left_starting_line')::boolean, false),
      coalesce((p->>'auto_climb_level1')::boolean, false),
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(coalesce(p->'intake_sources','[]'::jsonb)) as value),
        '{}'::text[]),
      coalesce((p->>'max_fuel_capacity_observed')::int, 0),
      coalesce((p->>'defense_rating')::int, 0),
      coalesce((p->>'pins')::int, 0),
      coalesce((p->>'fouls_minor')::int, 0),
      coalesce((p->>'fouls_major')::int, 0),
      coalesce((p->>'no_show')::boolean, false),
      coalesce((p->>'died')::boolean, false),
      coalesce((p->>'tipped')::boolean, false),
      coalesce((p->>'dropped_fuel')::boolean, false),
      coalesce((p->>'fed_corral')::boolean, false),
      p->>'notes',
      coalesce((p->>'defense_duration_ms')::int, 0),
      coalesce((p->>'defended_duration_ms')::int, 0),
      v_incoming_rev,
      coalesce((p->>'deleted')::boolean, false)
    );
  elsif v_incoming_rev > v_existing_rev then
    update match_scouting_report set
      schema_version = (p->>'schema_version')::int,
      app_version = p->>'app_version',
      device_id = p->>'device_id',
      target_team_number = (p->>'target_team_number')::int,
      alliance_color = p->>'alliance_color',
      station = (p->>'station')::int,
      inactive_first = (p->>'inactive_first')::boolean,
      inactive_first_source = p->>'inactive_first_source',
      teleop_clock_unconfirmed = coalesce((p->>'teleop_clock_unconfirmed')::boolean, false),
      fuel_bursts = coalesce(p->'fuel_bursts', '[]'::jsonb),
      climb_level = coalesce((p->>'climb_level')::int, 0),
      climb_attempted = coalesce((p->>'climb_attempted')::boolean, false),
      climb_success = coalesce((p->>'climb_success')::boolean, false),
      auto_start_position = p->'auto_start_position',
      auto_path = p->'auto_path',
      auto_left_starting_line = coalesce((p->>'auto_left_starting_line')::boolean, false),
      auto_climb_level1 = coalesce((p->>'auto_climb_level1')::boolean, false),
      intake_sources = coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(coalesce(p->'intake_sources','[]'::jsonb)) as value),
        '{}'::text[]),
      max_fuel_capacity_observed = coalesce((p->>'max_fuel_capacity_observed')::int, 0),
      defense_rating = coalesce((p->>'defense_rating')::int, 0),
      pins = coalesce((p->>'pins')::int, 0),
      fouls_minor = coalesce((p->>'fouls_minor')::int, 0),
      fouls_major = coalesce((p->>'fouls_major')::int, 0),
      no_show = coalesce((p->>'no_show')::boolean, false),
      died = coalesce((p->>'died')::boolean, false),
      tipped = coalesce((p->>'tipped')::boolean, false),
      dropped_fuel = coalesce((p->>'dropped_fuel')::boolean, false),
      fed_corral = coalesce((p->>'fed_corral')::boolean, false),
      notes = p->>'notes',
      defense_duration_ms = coalesce((p->>'defense_duration_ms')::int, 0),
      defended_duration_ms = coalesce((p->>'defended_duration_ms')::int, 0),
      deleted = coalesce((p->>'deleted')::boolean, false),
      row_revision = v_incoming_rev
    where id = v_id;
  else
    perform set_config('app.skip_msr_bump', 'off', true);
    return;
  end if;

  perform recompute_match_report_aggregates(v_id);
  perform set_config('app.skip_msr_bump', 'off', true);
end;
$$;

grant execute on function upsert_match_report(jsonb) to authenticated;
