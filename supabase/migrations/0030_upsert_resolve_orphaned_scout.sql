-- 0030_upsert_resolve_orphaned_scout.sql — stop dead-lettering a report whose
-- scout_id was deleted server-side (silent data loss).
--
-- BUG (data loss): the app always runs an anonymous session, so upsert_match_report
-- always takes the `auth.uid() is not null` branch (0025 lines 46-50), which RAISES
-- 23503 'invalid scout_id: no such scout' when the client's scout_id no longer
-- exists. select_scouter's name-consolidation (0015/0016) DELETES every other scout
-- row for a display name at an event. When the SAME scouter name is picked on a
-- second device, that delete removes the first device's canonical scout row while it
-- still holds locally-queued (unsynced) reports stamped with the now-deleted
-- scout_id. On sync, upsert raises 23503 → classifySyncError maps it to terminal →
-- the captured matches dead-letter permanently and never reach the dashboard.
-- (Reproduced live: two devices on the same name → one device ends at ⚠1 forever.)
--
-- FIX: in the authenticated branch, when the scout_id row is missing, re-resolve by
-- (event_key, lower(scout_name)) to the surviving canonical row for that name —
-- mirroring the anon/QR resolve block. The client now sends scout_name
-- (mapReport.ts). If no same-name row survives (rare), provision a caller-owned row
-- reusing the client id so the by-id revision guard stays coherent — no data loss
-- either way. The anon branch, the revision guard, the supersede UPDATE, the INSERT/
-- UPDATE column lists, and the grant are ALL preserved verbatim from 0025.

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
    elsif v_scout_name is not null then
      -- The scout_id was orphaned (select_scouter consolidation deleted it, e.g.
      -- the same name was picked on another device). Re-resolve to the surviving
      -- canonical row for this name+event instead of dead-lettering.
      select s.id into v_resolved_scout
      from scout s
      where s.event_key = v_event_key
        and lower(s.display_name) = lower(v_scout_name)
      order by s.created_at
      limit 1;
      if v_resolved_scout is null then
        -- No same-name row survives: provision one owned by the caller, reusing the
        -- client id so future by-id re-uploads stay coherent. (Composite key is
        -- (event_key, auth_uid); the legacy global auth_uid unique was dropped in 0029.)
        insert into scout (id, event_key, display_name, auth_uid)
        values (v_scout_id, v_event_key, v_scout_name, auth.uid())
        on conflict (id) do nothing;
        v_resolved_scout := v_scout_id;
      end if;
    else
      -- Legacy report with no scout_name and a missing scout_id: provision a
      -- caller-owned row rather than permanently dead-lettering the capture.
      insert into scout (id, event_key, display_name, auth_uid)
      values (v_scout_id, v_event_key, 'Scout', auth.uid())
      on conflict (id) do nothing;
      v_resolved_scout := v_scout_id;
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
    -- Supersede any OTHER active report for the same (match_key, scout_id):
    -- soft-delete it so this new report can take the single active slot without a
    -- 23505 on idx_msr_match_scout_active. (No-op in the common first-submit case.)
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
