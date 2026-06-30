-- 0032_upsert_resolve_caller_scout.sql — harden 0030's orphaned-scout re-resolve.
--
-- BUG in 0030: when an authenticated caller's scout_id was missing AND there was no
-- same-name row to resolve to, 0030 PROVISIONED a new scout row owned by auth.uid().
-- But the caller almost always ALREADY HAS a scout row for the event (they picked a
-- name) — inserting a second row for the same (event_key, auth_uid) violates the
-- composite unique scout_event_uid_unique → 23505 → a NEW dead-letter. (Caught by
-- tests/db/rpcs.test.ts: a forged scout_id from an anon caller that already joined.)
--
-- FIX: insert an intermediate fallback in the authenticated branch — before
-- provisioning, resolve to the CALLER'S OWN scout row for the event (auth_uid =
-- auth.uid()). Order: (1) surviving same-name row, (2) caller's own row, (3) provision
-- (only now safe — the caller has no row for this event). A non-existent scout_id is
-- therefore never rejected and never 23505s; the report is always attributed and
-- lands. Anon branch, revision guard, supersede, and column lists are verbatim from 0030.

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
  v_scout_id uuid := (p->>'scout_id')::uuid;
  v_event_key text := p->>'event_key';
  v_scout_name text := nullif(btrim(p->>'scout_name'), '');
  v_resolved_scout uuid;
begin
  perform set_config('app.skip_msr_bump', 'on', true);

  if auth.uid() is not null then
    if exists (select 1 from scout s where s.id = v_scout_id) then
      -- Normal path: the client's scout row still exists.
      v_resolved_scout := v_scout_id;
    else
      -- scout_id orphaned (select_scouter consolidation deleted it, e.g. the same
      -- name was picked on another device). Re-resolve instead of dead-lettering.
      -- (1) the surviving canonical row for this name+event,
      if v_scout_name is not null then
        select s.id into v_resolved_scout
        from scout s
        where s.event_key = v_event_key
          and lower(s.display_name) = lower(v_scout_name)
        order by s.created_at
        limit 1;
      end if;
      -- (2) else the CALLER'S OWN row for this event (they are authenticated);
      if v_resolved_scout is null then
        select s.id into v_resolved_scout
        from scout s
        where s.event_key = v_event_key
          and s.auth_uid = auth.uid()
        limit 1;
      end if;
      -- (3) else provision a caller-owned row (safe: the caller has none for this
      -- event, so the composite (event_key, auth_uid) cannot collide).
      if v_resolved_scout is null then
        insert into scout (id, event_key, display_name, auth_uid)
        values (v_scout_id, v_event_key, coalesce(v_scout_name, 'Scout'), auth.uid())
        on conflict (id) do nothing;
        v_resolved_scout := v_scout_id;
      end if;
    end if;
  else
    if exists (select 1 from scout s where s.id = v_scout_id) then
      v_resolved_scout := v_scout_id;
    else
      if v_scout_name is not null then
        select s.id into v_resolved_scout
        from scout s
        where s.event_key = v_event_key
          and lower(s.display_name) = lower(v_scout_name)
        order by s.created_at
        limit 1;
      end if;
      if v_resolved_scout is null then
        insert into scout (id, event_key, display_name, auth_uid)
        values (
          v_scout_id,
          v_event_key,
          coalesce(v_scout_name, 'Imported scout'),
          gen_random_uuid()
        )
        on conflict (id) do nothing;
        v_resolved_scout := v_scout_id;
      end if;
    end if;
  end if;

  select row_revision into v_existing_rev
  from match_scouting_report where id = v_id;

  if v_existing_rev is null then
    update match_scouting_report
      set deleted = true,
          row_revision = row_revision + 1
      where match_key = (p->>'match_key')
        and scout_id = v_resolved_scout
        and not deleted
        and id <> v_id;

    insert into match_scouting_report (
      id, schema_version, app_version, device_id, event_key, match_key, scout_id,
      target_team_number, alliance_color, station, inactive_first, inactive_first_source,
      teleop_clock_unconfirmed, fuel_bursts, feeding_bursts, climb_level, climb_attempted, climb_success,
      auto_start_position, auto_path, auto_left_starting_line, auto_climb_level1,
      intake_sources, max_fuel_capacity_observed, defense_rating, pins, fouls_minor,
      fouls_major, foul_reasons, no_show, died, tipped, dropped_fuel, fed_corral, notes,
      defense_duration_ms, defended_duration_ms, defense_intervals, defended_intervals,
      row_revision, deleted
    ) values (
      v_id,
      (p->>'schema_version')::int,
      p->>'app_version',
      p->>'device_id',
      p->>'event_key',
      p->>'match_key',
      v_resolved_scout,
      (p->>'target_team_number')::int,
      p->>'alliance_color',
      (p->>'station')::int,
      (p->>'inactive_first')::boolean,
      p->>'inactive_first_source',
      coalesce((p->>'teleop_clock_unconfirmed')::boolean, false),
      coalesce(p->'fuel_bursts', '[]'::jsonb),
      coalesce(p->'feeding_bursts', '[]'::jsonb),
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
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(coalesce(p->'foul_reasons','[]'::jsonb)) as value),
        '{}'::text[]),
      coalesce((p->>'no_show')::boolean, false),
      coalesce((p->>'died')::boolean, false),
      coalesce((p->>'tipped')::boolean, false),
      coalesce((p->>'dropped_fuel')::boolean, false),
      coalesce((p->>'fed_corral')::boolean, false),
      p->>'notes',
      coalesce((p->>'defense_duration_ms')::int, 0),
      coalesce((p->>'defended_duration_ms')::int, 0),
      coalesce(p->'defense_intervals', '[]'::jsonb),
      coalesce(p->'defended_intervals', '[]'::jsonb),
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
      feeding_bursts = coalesce(p->'feeding_bursts', '[]'::jsonb),
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
      foul_reasons = coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(coalesce(p->'foul_reasons','[]'::jsonb)) as value),
        '{}'::text[]),
      no_show = coalesce((p->>'no_show')::boolean, false),
      died = coalesce((p->>'died')::boolean, false),
      tipped = coalesce((p->>'tipped')::boolean, false),
      dropped_fuel = coalesce((p->>'dropped_fuel')::boolean, false),
      fed_corral = coalesce((p->>'fed_corral')::boolean, false),
      notes = p->>'notes',
      defense_duration_ms = coalesce((p->>'defense_duration_ms')::int, 0),
      defended_duration_ms = coalesce((p->>'defended_duration_ms')::int, 0),
      defense_intervals = coalesce(p->'defense_intervals', '[]'::jsonb),
      defended_intervals = coalesce(p->'defended_intervals', '[]'::jsonb),
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

grant execute on function upsert_match_report(jsonb) to anon, authenticated;
