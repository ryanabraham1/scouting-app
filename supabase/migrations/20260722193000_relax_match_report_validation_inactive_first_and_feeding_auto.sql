-- 20260722193000_relax_match_report_validation_inactive_first_and_feeding_auto.sql
--
-- Two legitimate, scout-produced match reports were being TERMINAL-rejected by
-- validate_match_report_payload (added in 20260710192440) and dead-lettered so
-- they never reached the server:
--
--   1. "inactive_first must be a JSON boolean"
--      inactive_first is tri-state on the client: true/false once the inactive-
--      first shift is known, or JSON null while it is still unresolved (the scout
--      never confirmed and no official schedule is available yet — see
--      inactive_first_source 'derived'|'scout'|'official'). The report column is
--      NULLABLE and the aggregate recompute already coalesces null -> false
--      (msr_is_inactive(i, coalesce(r.inactive_first, false))), so the server was
--      built to accept null; only the strict boolean validation rejected it.
--
--   2. "feeding burst is malformed"
--      Feeding bursts mirror the fuel-burst persistence pattern and are tagged by
--      the SAME windowForBurst() helper, which returns 'auto' for the auto phase
--      (and for the pre-GO 'pause' fallback). fuel_bursts already accept the
--      'auto' window; feeding_bursts did not, so a scout who fed fuel during auto
--      produced an unsyncable report. Feeding bursts are stored-only (never fed
--      into the scoring recompute), so accepting 'auto' just preserves the
--      captured evidence.
--
-- This migration ONLY relaxes those two checks. The scoring recompute,
-- superseding/scouter-identity logic, and upsert_match_report itself are
-- untouched. validate_match_report_payload is a standalone helper, so we redefine
-- just it.
--
-- Existing dead-lettered reports remain terminal (validation-class failures are
-- deliberately not auto-requeued); recover them via the "Edit -> re-save" path in
-- My Data, which re-queues them so they upload cleanly against this validation.

create or replace function public.validate_match_report_payload(p jsonb)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  b jsonb;
  v_schema int;
  v_number numeric;
  v_start numeric;
  v_end numeric;
  v_phase text;
  v_field text;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'match report payload must be an object' using errcode = '22023';
  end if;
  if pg_column_size(p) > 262144 then
    raise exception 'match report payload exceeds 256 KiB' using errcode = '22023';
  end if;

  if nullif(p->>'id', '') is null
     or nullif(p->>'event_key', '') is null
     or nullif(p->>'match_key', '') is null
     or nullif(p->>'scout_id', '') is null
     or jsonb_typeof(p->'schema_version') is distinct from 'number'
     or jsonb_typeof(p->'target_team_number') is distinct from 'number'
     or jsonb_typeof(p->'station') is distinct from 'number'
     or jsonb_typeof(p->'alliance_color') is distinct from 'string'
  then
    raise exception 'match report identity fields are required' using errcode = '22023';
  end if;
  perform (p->>'id')::uuid;
  perform (p->>'scout_id')::uuid;

  v_schema := (p->>'schema_version')::int;
  if (p->>'schema_version')::numeric <>
       trunc((p->>'schema_version')::numeric)
     or v_schema not between 1 and 2
  then
    raise exception 'unsupported match report schema_version: %', v_schema
      using errcode = '22023';
  end if;
  if length(p->>'event_key') > 64
     or length(p->>'match_key') > 128
     or length(coalesce(p->>'app_version', '')) > 64
     or length(coalesce(p->>'device_id', '')) > 128
     or length(coalesce(p->>'scout_name', '')) > 128
     or length(coalesce(p->>'notes', '')) > 10000
  then
    raise exception 'match report string field exceeds its limit'
      using errcode = '22023';
  end if;

  foreach v_field in array array[
    'row_revision', 'climb_level', 'max_fuel_capacity_observed',
    'defense_rating', 'driver_skill', 'agility', 'pins', 'fouls_minor',
    'fouls_major', 'defense_duration_ms', 'defended_duration_ms'
  ]
  loop
    if p ? v_field and jsonb_typeof(p->v_field) is distinct from 'number' then
      raise exception '% must be a JSON number', v_field using errcode = '22023';
    end if;
  end loop;
  -- inactive_first is intentionally excluded from the strict-boolean loop below:
  -- it is tri-state and may legitimately arrive as JSON null (unresolved shift).
  foreach v_field in array array[
    'deleted', 'teleop_clock_unconfirmed', 'climb_attempted',
    'climb_success', 'auto_left_starting_line', 'auto_climb_level1',
    'no_show', 'died', 'tipped', 'dropped_fuel', 'fed_corral'
  ]
  loop
    if p ? v_field and jsonb_typeof(p->v_field) is distinct from 'boolean' then
      raise exception '% must be a JSON boolean', v_field using errcode = '22023';
    end if;
  end loop;
  -- Accept boolean OR null for inactive_first (see header note 1). The column is
  -- nullable and the recompute coalesces null -> false.
  if p ? 'inactive_first'
     and jsonb_typeof(p->'inactive_first') not in ('boolean', 'null')
  then
    raise exception 'inactive_first must be a JSON boolean or null'
      using errcode = '22023';
  end if;

  if coalesce((p->>'row_revision')::numeric, 1) <>
       trunc(coalesce((p->>'row_revision')::numeric, 1))
     or coalesce((p->>'row_revision')::numeric, 1)
        not between 1 and 9007199254740991
  then
    raise exception 'row_revision is outside the supported integer range'
      using errcode = '22023';
  end if;

  if (p->>'target_team_number')::numeric <> trunc((p->>'target_team_number')::numeric)
     or (p->>'target_team_number')::numeric not between 1 and 999999
     or (p->>'station')::numeric <> trunc((p->>'station')::numeric)
     or (p->>'station')::int not between 1 and 3
     or p->>'alliance_color' not in ('red', 'blue')
  then
    raise exception 'match report seat is invalid' using errcode = '22023';
  end if;
  if nullif(p->>'inactive_first_source', '') is not null
     and p->>'inactive_first_source' not in ('derived', 'scout', 'official')
  then
    raise exception 'inactive_first_source is invalid' using errcode = '22023';
  end if;

  foreach v_number in array array[
    coalesce((p->>'climb_level')::numeric, 0),
    coalesce((p->>'max_fuel_capacity_observed')::numeric, 0),
    coalesce((p->>'defense_rating')::numeric, 0),
    coalesce((p->>'driver_skill')::numeric, 0),
    coalesce((p->>'agility')::numeric, 0),
    coalesce((p->>'pins')::numeric, 0),
    coalesce((p->>'fouls_minor')::numeric, 0),
    coalesce((p->>'fouls_major')::numeric, 0),
    coalesce((p->>'defense_duration_ms')::numeric, 0),
    coalesce((p->>'defended_duration_ms')::numeric, 0)
  ]
  loop
    if v_number <> trunc(v_number) then
      raise exception 'integer-valued match report field is fractional'
        using errcode = '22023';
    end if;
  end loop;

  if coalesce((p->>'climb_level')::int, 0) not between 0 and 3
     or coalesce((p->>'max_fuel_capacity_observed')::int, 0) not between 0 and 10000
     or coalesce((p->>'defense_rating')::int, 0) not between 0 and 10
     or coalesce((p->>'driver_skill')::int, 0) not between 0 and 10
     or coalesce((p->>'agility')::int, 0) not between 0 and 10
     or coalesce((p->>'pins')::int, 0) not between 0 and 1000
     or coalesce((p->>'fouls_minor')::int, 0) not between 0 and 1000
     or coalesce((p->>'fouls_major')::int, 0) not between 0 and 1000
     or coalesce((p->>'defense_duration_ms')::int, 0) not between 0 and 140000
     or coalesce((p->>'defended_duration_ms')::int, 0) not between 0 and 140000
  then
    raise exception 'bounded match report field is outside its range'
      using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p->'fuel_bursts', '[]'::jsonb))
       is distinct from 'array'
     or jsonb_array_length(coalesce(p->'fuel_bursts', '[]'::jsonb)) > 512
  then
    raise exception 'fuel_bursts must be an array of at most 512 items'
      using errcode = '22023';
  end if;
  for b in select value from jsonb_array_elements(coalesce(p->'fuel_bursts', '[]'::jsonb))
  loop
    if jsonb_typeof(b) is distinct from 'object'
       or jsonb_typeof(b->'rate') is distinct from 'number'
       or jsonb_typeof(b->'startMs') is distinct from 'number'
       or jsonb_typeof(b->'endMs') is distinct from 'number'
       or b->>'window' not in (
         'auto', 'transition', 'shift1', 'shift2', 'shift3', 'shift4', 'endgame'
       )
    then
      raise exception 'fuel burst is malformed' using errcode = '22023';
    end if;
    v_number := (b->>'rate')::numeric;
    v_start := (b->>'startMs')::numeric;
    v_end := (b->>'endMs')::numeric;
    if v_number not between 0 and 30
       or v_start <> trunc(v_start)
       or v_end <> trunc(v_end)
       or v_start < 0
       or v_end < v_start
       or v_end > (
         case when b->>'window' = 'auto' then 20000 else 140000 end
       )
    then
      raise exception 'fuel burst value is outside its range' using errcode = '22023';
    end if;
  end loop;

  if jsonb_typeof(coalesce(p->'feeding_bursts', '[]'::jsonb))
       is distinct from 'array'
     or jsonb_array_length(coalesce(p->'feeding_bursts', '[]'::jsonb)) > 256
  then
    raise exception 'feeding_bursts must be an array of at most 256 items'
      using errcode = '22023';
  end if;
  for b in select value from jsonb_array_elements(coalesce(p->'feeding_bursts', '[]'::jsonb))
  loop
    -- 'auto' is accepted here (see header note 2): feeding bursts share the fuel
    -- windowForBurst() tagging, which emits 'auto' during the auto/pre-GO phases.
    if jsonb_typeof(b) is distinct from 'object'
       or jsonb_typeof(b->'rate') is distinct from 'number'
       or jsonb_typeof(b->'startMs') is distinct from 'number'
       or jsonb_typeof(b->'endMs') is distinct from 'number'
       or b->>'window' not in (
         'auto', 'transition', 'shift1', 'shift2', 'shift3', 'shift4', 'endgame'
       )
    then
      raise exception 'feeding burst is malformed' using errcode = '22023';
    end if;
    v_number := (b->>'rate')::numeric;
    v_start := (b->>'startMs')::numeric;
    v_end := (b->>'endMs')::numeric;
    if v_number not between 0 and 30
       or v_start <> trunc(v_start)
       or v_end <> trunc(v_end)
       or v_start < 0
       or v_end < v_start
       or v_end > 140000
    then
      raise exception 'feeding burst value is outside its range' using errcode = '22023';
    end if;
  end loop;

  if jsonb_typeof(coalesce(p->'intake_sources', '[]'::jsonb))
       is distinct from 'array'
     or jsonb_array_length(coalesce(p->'intake_sources', '[]'::jsonb)) > 16
     or exists (
       select 1
       from jsonb_array_elements(coalesce(p->'intake_sources', '[]'::jsonb)) x
       where jsonb_typeof(x.value) is distinct from 'string'
          or length(x.value #>> '{}') > 64
     )
  then
    raise exception 'intake_sources is malformed' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p->'foul_reasons', '[]'::jsonb))
       is distinct from 'array'
     or jsonb_array_length(coalesce(p->'foul_reasons', '[]'::jsonb)) > 32
     or exists (
       select 1
       from jsonb_array_elements(coalesce(p->'foul_reasons', '[]'::jsonb)) x
       where jsonb_typeof(x.value) is distinct from 'string'
          or length(x.value #>> '{}') > 64
     )
  then
    raise exception 'foul_reasons is malformed' using errcode = '22023';
  end if;

  if p ? 'auto_start_position'
     and jsonb_typeof(p->'auto_start_position') <> 'null'
     and (
       jsonb_typeof(p->'auto_start_position') is distinct from 'object'
       or jsonb_typeof(p->'auto_start_position'->'x') is distinct from 'number'
       or jsonb_typeof(p->'auto_start_position'->'y') is distinct from 'number'
       or (p->'auto_start_position'->>'x')::numeric not between -10 and 10
       or (p->'auto_start_position'->>'y')::numeric not between -10 and 10
     )
  then
    raise exception 'auto_start_position is malformed' using errcode = '22023';
  end if;
  if p ? 'auto_path'
     and jsonb_typeof(p->'auto_path') <> 'null'
     and (
       jsonb_typeof(p->'auto_path') is distinct from 'array'
       or jsonb_array_length(p->'auto_path') > 256
       or exists (
         select 1
         from jsonb_array_elements(p->'auto_path') point
         where jsonb_typeof(point.value) is distinct from 'object'
            or jsonb_typeof(point.value->'x') is distinct from 'number'
            or jsonb_typeof(point.value->'y') is distinct from 'number'
            or (point.value->>'x')::numeric not between -10 and 10
            or (point.value->>'y')::numeric not between -10 and 10
       )
     )
  then
    raise exception 'auto_path is malformed' using errcode = '22023';
  end if;

  foreach v_phase in array array['defense_intervals', 'defended_intervals']
  loop
    if jsonb_typeof(coalesce(p->v_phase, '[]'::jsonb))
         is distinct from 'array'
       or jsonb_array_length(coalesce(p->v_phase, '[]'::jsonb)) > 64
    then
      raise exception '% must be an array of at most 64 items', v_phase
        using errcode = '22023';
    end if;
    for b in select value from jsonb_array_elements(coalesce(p->v_phase, '[]'::jsonb))
    loop
      if jsonb_typeof(b) is distinct from 'object'
         or jsonb_typeof(b->'startMs') is distinct from 'number'
         or jsonb_typeof(b->'endMs') is distinct from 'number'
         or b->>'phase' not in ('auto', 'teleop')
      then
        raise exception '% contains a malformed interval', v_phase
          using errcode = '22023';
      end if;
      v_start := (b->>'startMs')::numeric;
      v_end := (b->>'endMs')::numeric;
      if v_start <> trunc(v_start)
         or v_end <> trunc(v_end)
         or v_start < 0
         or v_end < v_start
         or v_end > (
           case when b->>'phase' = 'auto' then 20000 else 140000 end
         )
      then
        raise exception '% interval is outside its range', v_phase
          using errcode = '22023';
      end if;
    end loop;
  end loop;
end;
$$;

revoke all on function public.validate_match_report_payload(jsonb) from public;
