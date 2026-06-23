-- 0004_rpcs.sql — all SECURITY DEFINER. search_path pinned to public.

-- join_event: validate code, create-or-return the scout bound to auth.uid().
create or replace function join_event(p_code text, p_display_name text)
returns scout
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text;
  v_uid uuid := auth.uid();
  v_scout scout;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- rate-limit note: production should throttle by uid; omitted in Phase 0.
  select event_key into v_event_key
  from event_secret where join_code = p_code;
  if v_event_key is null then
    raise exception 'invalid join code' using errcode = 'P0001';
  end if;

  -- idempotent per auth.uid()+event.
  select * into v_scout
  from scout where auth_uid = v_uid and event_key = v_event_key;
  if found then
    return v_scout;
  end if;

  insert into scout (event_key, display_name, auth_uid)
  values (v_event_key, p_display_name, v_uid)
  returning * into v_scout;

  insert into profile (auth_uid) values (v_uid)
  on conflict (auth_uid) do nothing;

  return v_scout;
end;
$$;

-- recover_identity: rebind auth.uid() to an EXISTING scout matched by code+name.
create or replace function recover_identity(p_code text, p_display_name text)
returns scout
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text;
  v_uid uuid := auth.uid();
  v_scout scout;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select event_key into v_event_key
  from event_secret where join_code = p_code;
  if v_event_key is null then
    raise exception 'invalid join code' using errcode = 'P0001';
  end if;

  select * into v_scout
  from scout
  where event_key = v_event_key and display_name = p_display_name;
  if not found then
    raise exception 'no scout to recover for that code + name' using errcode = 'P0002';
  end if;

  update scout set auth_uid = v_uid where id = v_scout.id
  returning * into v_scout;

  insert into profile (auth_uid) values (v_uid)
  on conflict (auth_uid) do nothing;

  return v_scout;
end;
$$;

grant execute on function join_event(text, text) to authenticated;
grant execute on function recover_identity(text, text) to authenticated;

-- rotate_join_code: admin only. Returns the new code.
create or replace function rotate_join_code(p_event_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_code text;
begin
  select role into v_role from profile where auth_uid = v_uid;
  if v_role is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;

  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  update event_secret set join_code = v_code where event_key = p_event_key;
  if not found then
    raise exception 'no such event' using errcode = 'P0001';
  end if;
  return v_code;
end;
$$;

-- upsert_match_report: revision-guarded insert/update + recompute.
-- The BEFORE UPDATE trigger (msr_bump_meta) would increment row_revision on its
-- own; to make the client-supplied revision authoritative we disable that trigger
-- for the duration of this function via a session GUC the trigger checks.
create or replace function msr_bump_meta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- When inside upsert_match_report, the function manages revision explicitly.
  if current_setting('app.skip_msr_bump', true) = 'on' then
    new.updated_at := now();
    new.server_received_at := now();
    return new;
  end if;
  new.row_revision := old.row_revision + 1;
  new.updated_at := now();
  new.server_received_at := now();
  return new;
end;
$$;

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

  -- Ownership gate: when called by a real JWT user (anon or regular),
  -- verify the scout_id belongs to auth.uid(). The ingest-reports edge function
  -- uses service-role (auth.uid() is NULL) and is exempt.
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
    -- INSERT new report.
    insert into match_scouting_report (
      id, schema_version, app_version, device_id, event_key, match_key, scout_id,
      target_team_number, alliance_color, station, inactive_first, inactive_first_source,
      teleop_clock_unconfirmed, fuel_bursts, climb_level, climb_attempted, climb_success,
      auto_start_position, auto_path, auto_left_starting_line, auto_climb_level1,
      intake_sources, max_fuel_capacity_observed, defense_rating, pins, fouls_minor,
      fouls_major, no_show, died, tipped, dropped_fuel, fed_corral, notes,
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
      v_incoming_rev,
      coalesce((p->>'deleted')::boolean, false)
    );
  elsif v_incoming_rev > v_existing_rev then
    -- UPDATE only when strictly newer (revision guard).
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
      deleted = coalesce((p->>'deleted')::boolean, false),
      row_revision = v_incoming_rev
    where id = v_id;
  else
    -- stale or equal revision: ignore.
    perform set_config('app.skip_msr_bump', 'off', true);
    return;
  end if;

  -- Keep skip flag on during recompute so the aggregate UPDATE doesn't bump revision.
  perform recompute_match_report_aggregates(v_id);
  perform set_config('app.skip_msr_bump', 'off', true);
end;
$$;

grant execute on function rotate_join_code(text) to authenticated;
grant execute on function upsert_match_report(jsonb) to authenticated;
