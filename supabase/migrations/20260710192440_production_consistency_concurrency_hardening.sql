-- Production consistency/concurrency hardening.
--
-- AUTHORIZATION POLICY (intentional, accepted risk):
-- This installation remains a login-less, single-team application. The RPCs
-- explicitly granted to anon/authenticated below therefore remain an open
-- control plane. This migration does NOT claim to solve BOLA/IDOR; it makes
-- open writes internally consistent, bounded, atomic, and conflict-aware.

-- ---------------------------------------------------------------------------
-- Integrity repair, relationship constraints, and hot-path indexes.
-- ---------------------------------------------------------------------------

-- Consolidate historical same-name identities before making the canonical
-- event/name identity stable. Keep the oldest identity, the strongest report
-- revision per match, and one assignment/crew membership per logical slot.
do $$
declare
  g record;
begin
  for g in
    select
      s.event_key,
      lower(btrim(s.display_name)) as normalized_name,
      (array_agg(s.id order by s.created_at nulls last, s.id))[1] as canonical_id
    from public.scout s
    group by s.event_key, lower(btrim(s.display_name))
    having count(*) > 1
  loop
    with ranked as (
      select
        a.id,
        row_number() over (
          partition by a.match_key
          order by (a.scout_id = g.canonical_id) desc, a.id
        ) as rn
      from public.assignment a
      join public.scout s on s.id = a.scout_id
      where s.event_key = g.event_key
        and lower(btrim(s.display_name)) = g.normalized_name
    )
    delete from public.assignment a
    using ranked r
    where a.id = r.id and r.rn > 1;

    update public.assignment a
    set scout_id = g.canonical_id
    from public.scout s
    where a.scout_id = s.id
      and s.event_key = g.event_key
      and s.id <> g.canonical_id
      and lower(btrim(s.display_name)) = g.normalized_name;

    with ranked as (
      select
        pa.event_key,
        pa.team_number,
        pa.scout_id,
        row_number() over (
          partition by pa.event_key, pa.team_number
          order by (pa.scout_id = g.canonical_id) desc, pa.created_at, pa.scout_id
        ) as rn
      from public.pit_assignment pa
      join public.scout s on s.id = pa.scout_id
      where s.event_key = g.event_key
        and lower(btrim(s.display_name)) = g.normalized_name
    )
    delete from public.pit_assignment pa
    using ranked r
    where pa.event_key = r.event_key
      and pa.team_number = r.team_number
      and pa.scout_id = r.scout_id
      and r.rn > 1;

    update public.pit_assignment pa
    set scout_id = g.canonical_id
    from public.scout s
    where pa.scout_id = s.id
      and s.event_key = g.event_key
      and s.id <> g.canonical_id
      and lower(btrim(s.display_name)) = g.normalized_name;

    with ranked as (
      select
        r.id,
        row_number() over (
          partition by r.match_key
          order by
            (r.scout_id = g.canonical_id) desc,
            r.row_revision desc,
            r.updated_at desc,
            r.id
        ) as rn
      from public.match_scouting_report r
      join public.scout s on s.id = r.scout_id
      where s.event_key = g.event_key
        and lower(btrim(s.display_name)) = g.normalized_name
        and not r.deleted
    )
    update public.match_scouting_report r
    set deleted = true
    from ranked x
    where r.id = x.id and x.rn > 1;

    update public.match_scouting_report r
    set scout_id = g.canonical_id
    from public.scout s
    where r.scout_id = s.id
      and s.event_key = g.event_key
      and s.id <> g.canonical_id
      and lower(btrim(s.display_name)) = g.normalized_name;

    update public.pit_scouting_report p
    set author_scout_id = g.canonical_id
    from public.scout s
    where p.author_scout_id = s.id
      and s.event_key = g.event_key
      and s.id <> g.canonical_id
      and lower(btrim(s.display_name)) = g.normalized_name;

    delete from public.scout s
    where s.event_key = g.event_key
      and s.id <> g.canonical_id
      and lower(btrim(s.display_name)) = g.normalized_name;
  end loop;
end;
$$;

-- Assignment data is replaceable operational state. Remove only rows that
-- cannot be represented by the current event schedule/identity relationships.
delete from public.assignment a
where not exists (
        select 1 from public.match m
        where m.match_key = a.match_key and m.event_key = a.event_key
      )
   or not exists (
        select 1 from public.scout s
        where s.id = a.scout_id and s.event_key = a.event_key
      )
   or not exists (
        select 1 from public.event_team et
        where et.event_key = a.event_key
          and et.team_number = a.target_team_number
      )
   or a.target_team_number is distinct from (
        select case a.alliance_color
          when 'red' then case a.station
            when 1 then m.red1 when 2 then m.red2 when 3 then m.red3 end
          when 'blue' then case a.station
            when 1 then m.blue1 when 2 then m.blue2 when 3 then m.blue3 end
        end
        from public.match m
        where m.match_key = a.match_key
      );

with ranked as (
  select
    a.id,
    row_number() over (
      partition by a.match_key, a.alliance_color, a.station
      order by (a.source = 'manual') desc, a.id
    ) as rn
  from public.assignment a
)
delete from public.assignment a
using ranked r
where a.id = r.id and r.rn > 1;

with ranked as (
  select
    a.id,
    row_number() over (
      partition by a.match_key, a.scout_id
      order by (a.source = 'manual') desc, a.id
    ) as rn
  from public.assignment a
)
delete from public.assignment a
using ranked r
where a.id = r.id and r.rn > 1;

create unique index if not exists match_event_match_uidx
  on public.match (event_key, match_key);
create unique index if not exists scout_event_id_uidx
  on public.scout (event_key, id);
create unique index if not exists scout_event_normalized_name_uidx
  on public.scout (event_key, lower(btrim(display_name)));
create index if not exists scout_auth_uid_idx
  on public.scout (auth_uid);
create unique index if not exists assignment_match_seat_uidx
  on public.assignment (match_key, alliance_color, station);
create unique index if not exists assignment_match_scout_uidx
  on public.assignment (match_key, scout_id);
create index if not exists assignment_event_idx
  on public.assignment (event_key);
create index if not exists pit_report_history_lookup_idx
  on public.pit_report_history (event_key, team_number, created_at desc);
create index if not exists matchup_note_history_lookup_idx
  on public.matchup_note_history
    (event_key, our_team, opp_team, archived_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'assignment_event_match_fkey'
  ) then
    alter table public.assignment
      add constraint assignment_event_match_fkey
      foreign key (event_key, match_key)
      references public.match(event_key, match_key) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'assignment_event_scout_fkey'
  ) then
    alter table public.assignment
      add constraint assignment_event_scout_fkey
      foreign key (event_key, scout_id)
      references public.scout(event_key, id) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'assignment_event_team_fkey'
  ) then
    alter table public.assignment
      add constraint assignment_event_team_fkey
      foreign key (event_key, target_team_number)
      references public.event_team(event_key, team_number) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'msr_event_match_fkey'
  ) then
    alter table public.match_scouting_report
      add constraint msr_event_match_fkey
      foreign key (event_key, match_key)
      references public.match(event_key, match_key) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'msr_event_scout_fkey'
  ) then
    alter table public.match_scouting_report
      add constraint msr_event_scout_fkey
      foreign key (event_key, scout_id)
      references public.scout(event_key, id) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'msr_event_team_fkey'
  ) then
    alter table public.match_scouting_report
      add constraint msr_event_team_fkey
      foreign key (event_key, target_team_number)
      references public.event_team(event_key, team_number) not valid;
  end if;
end;
$$;

alter table public.assignment validate constraint assignment_event_match_fkey;
alter table public.assignment validate constraint assignment_event_scout_fkey;
alter table public.assignment validate constraint assignment_event_team_fkey;

alter table public.match_scouting_report
  add constraint msr_aggregate_bounds_check
  check (
    auto_fuel between 0 and 2500000
    and teleop_fuel_active between 0 and 2500000
    and teleop_fuel_inactive between 0 and 2500000
    and endgame_fuel between 0 and 2500000
    and fuel_points between 0 and 2500000
    and coalesce(array_length(fuel_by_shift, 1), 0) = 4
  ) not valid;

-- Direct pit DML bypassed revision/history checks. Keep open reads and route all
-- writes through the intentionally anonymous RPC.
drop policy if exists pit_insert_open on public.pit_scouting_report;
drop policy if exists pit_update_open on public.pit_scouting_report;
revoke insert, update, delete on table public.pit_scouting_report
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Bounded match-report validation and deterministic fixed-point aggregation.
-- ---------------------------------------------------------------------------

create or replace function public.normalized_qualitative_rating(
  p_schema_version int,
  p_value int
)
returns int
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_schema_version < 2 then
      case p_value when 1 then 3 when 2 then 7 when 3 then 10 else p_value end
    else p_value
  end
$$;

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
  foreach v_field in array array[
    'deleted', 'inactive_first', 'teleop_clock_unconfirmed', 'climb_attempted',
    'climb_success', 'auto_left_starting_line', 'auto_climb_level1',
    'no_show', 'died', 'tipped', 'dropped_fuel', 'fed_corral'
  ]
  loop
    if p ? v_field and jsonb_typeof(p->v_field) is distinct from 'boolean' then
      raise exception '% must be a JSON boolean', v_field using errcode = '22023';
    end if;
  end loop;

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
    if jsonb_typeof(b) is distinct from 'object'
       or jsonb_typeof(b->'rate') is distinct from 'number'
       or jsonb_typeof(b->'startMs') is distinct from 'number'
       or jsonb_typeof(b->'endMs') is distinct from 'number'
       or b->>'window' not in (
         'transition', 'shift1', 'shift2', 'shift3', 'shift4', 'endgame'
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
revoke all on function public.normalized_qualitative_rating(int, int) from public;

-- A rate is quantized to nano-balls/second before integration. Existing JSON
-- payloads remain valid; clients must mirror this exact quantization to retain
-- the documented byte-equivalence contract.
create or replace function public.recompute_match_report_aggregates(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r public.match_scouting_report%rowtype;
  b jsonb;
  v_window text;
  v_numerator numeric;
  n_auto numeric := 0;
  n_transition numeric := 0;
  n_endgame numeric := 0;
  n_shift numeric[] := array[0, 0, 0, 0]::numeric[];
  r_auto int := 0;
  r_transition int := 0;
  r_endgame int := 0;
  r_shift int[] := array[0, 0, 0, 0];
  v_active int := 0;
  v_inactive int := 0;
  v_points int := 0;
  i int;
begin
  select * into r
  from public.match_scouting_report
  where id = p_report_id;
  if not found then return; end if;

  if not r.no_show then
    for b in
      select value from jsonb_array_elements(r.fuel_bursts)
    loop
      v_numerator :=
        floor((b->>'rate')::numeric * 1000000000 + 0.5)
        * ((b->>'endMs')::bigint - (b->>'startMs')::bigint);
      v_window := b->>'window';
      if v_window = 'auto' then n_auto := n_auto + v_numerator;
      elsif v_window = 'transition' then n_transition := n_transition + v_numerator;
      elsif v_window = 'endgame' then n_endgame := n_endgame + v_numerator;
      elsif v_window = 'shift1' then n_shift[1] := n_shift[1] + v_numerator;
      elsif v_window = 'shift2' then n_shift[2] := n_shift[2] + v_numerator;
      elsif v_window = 'shift3' then n_shift[3] := n_shift[3] + v_numerator;
      elsif v_window = 'shift4' then n_shift[4] := n_shift[4] + v_numerator;
      end if;
    end loop;

    r_auto := floor((n_auto + 500000000000) / 1000000000000)::int;
    r_transition := floor((n_transition + 500000000000) / 1000000000000)::int;
    r_endgame := floor((n_endgame + 500000000000) / 1000000000000)::int;
    for i in 1..4 loop
      r_shift[i] :=
        floor((n_shift[i] + 500000000000) / 1000000000000)::int;
    end loop;
  end if;

  v_active := r_transition;
  for i in 1..4 loop
    if public.msr_is_inactive(i, coalesce(r.inactive_first, false)) then
      v_inactive := v_inactive + r_shift[i];
    else
      v_active := v_active + r_shift[i];
    end if;
  end loop;
  v_points := r_auto + r_transition + r_endgame;
  for i in 1..4 loop
    if not public.msr_is_inactive(i, coalesce(r.inactive_first, false)) then
      v_points := v_points + r_shift[i];
    end if;
  end loop;
  if greatest(r_auto, v_active, v_inactive, r_endgame, v_points) > 2500000 then
    raise exception 'computed match aggregate exceeds supported range'
      using errcode = '22003';
  end if;

  update public.match_scouting_report
  set auto_fuel = r_auto,
      teleop_fuel_active = v_active,
      teleop_fuel_inactive = v_inactive,
      endgame_fuel = r_endgame,
      fuel_by_shift = r_shift,
      fuel_points = v_points
  where id = p_report_id;
end;
$$;

revoke all on function public.recompute_match_report_aggregates(uuid) from public;
grant execute on function public.recompute_match_report_aggregates(uuid)
  to service_role;

-- The old trigger normalized v1 ratings after the RPC had compared payloads.
-- Normalization now occurs exactly once inside the canonical RPC.
drop trigger if exists trg_normalize_qualitative_ratings
  on public.match_scouting_report;

-- ---------------------------------------------------------------------------
-- Match-report CAS: lock report id + active slot, never regress revision.
-- ---------------------------------------------------------------------------

drop function public.upsert_match_report(jsonb);

create function public.upsert_match_report(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_input_scout_id uuid;
  v_resolved_scout uuid;
  v_event_key text;
  v_match_key text;
  v_scout_name text;
  v_schema int;
  v_incoming_rev bigint;
  v_existing public.match_scouting_report%rowtype;
  v_slot_existing public.match_scouting_report%rowtype;
  v_candidate public.match_scouting_report%rowtype;
  v_existing_canonical jsonb;
  v_candidate_canonical jsonb;
  v_id_lock bigint;
  v_slot_lock bigint;
  v_rating int;
  v_expected_team int;
begin
  perform public.validate_match_report_payload(p);

  v_id := (p->>'id')::uuid;
  v_input_scout_id := (p->>'scout_id')::uuid;
  v_event_key := p->>'event_key';
  v_match_key := p->>'match_key';
  v_scout_name := nullif(btrim(p->>'scout_name'), '');
  v_schema := (p->>'schema_version')::int;
  v_incoming_rev := coalesce((p->>'row_revision')::bigint, 1);
  perform pg_advisory_xact_lock_shared(
    hashtextextended('event_write:' || v_event_key, 0)
  );

  select case p->>'alliance_color'
    when 'red' then case (p->>'station')::int
      when 1 then m.red1 when 2 then m.red2 when 3 then m.red3 end
    when 'blue' then case (p->>'station')::int
      when 1 then m.blue1 when 2 then m.blue2 when 3 then m.blue3 end
  end
  into v_expected_team
  from public.match m
  where m.match_key = v_match_key and m.event_key = v_event_key;

  if not found then
    raise exception 'match does not belong to event' using errcode = '23503';
  end if;
  if v_expected_team is null
     or v_expected_team <> (p->>'target_team_number')::int
     or not exists (
       select 1 from public.event_team et
       where et.event_key = v_event_key
         and et.team_number = (p->>'target_team_number')::int
     )
  then
    raise exception 'target team does not occupy the reported station'
      using errcode = '23503';
  end if;

  -- Serialize provisioning/re-resolution of the caller-supplied identity.
  perform pg_advisory_xact_lock(
    hashtextextended('match_report_input_scout:' || v_input_scout_id::text, 0)
  );

  select s.id into v_resolved_scout
  from public.scout s
  where s.id = v_input_scout_id and s.event_key = v_event_key;

  if v_resolved_scout is null and v_scout_name is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(
        'scout_name:' || v_event_key || ':' || lower(btrim(v_scout_name)),
        0
      )
    );
    select s.id into v_resolved_scout
    from public.scout s
    where s.event_key = v_event_key
      and lower(btrim(s.display_name)) = lower(btrim(v_scout_name))
    order by s.created_at nulls last, s.id
    limit 1;
  end if;

  if v_resolved_scout is null and auth.uid() is not null then
    select s.id into v_resolved_scout
    from public.scout s
    where s.event_key = v_event_key and s.auth_uid = auth.uid()
    limit 1;
  end if;

  if v_resolved_scout is null then
    insert into public.scout (id, event_key, display_name, auth_uid)
    values (
      v_input_scout_id,
      v_event_key,
      coalesce(v_scout_name, case
        when auth.uid() is null then 'Imported scout' else 'Scout' end),
      coalesce(auth.uid(), gen_random_uuid())
    )
    on conflict do nothing;

    select s.id into v_resolved_scout
    from public.scout s
    where s.id = v_input_scout_id and s.event_key = v_event_key;
  end if;
  if v_resolved_scout is null then
    raise exception 'scout identity could not be resolved in event'
      using errcode = '23503';
  end if;

  -- Acquire both namespace locks in numeric order to avoid lock-order cycles.
  v_id_lock := hashtextextended('match_report_id:' || v_id::text, 0);
  v_slot_lock := hashtextextended(
    'match_report_slot:' || v_match_key || ':' || v_resolved_scout::text,
    0
  );
  perform pg_advisory_xact_lock(least(v_id_lock, v_slot_lock));
  if v_id_lock <> v_slot_lock then
    perform pg_advisory_xact_lock(greatest(v_id_lock, v_slot_lock));
  end if;

  select * into v_existing
  from public.match_scouting_report r
  where r.id = v_id
  for update;

  select * into v_slot_existing
  from public.match_scouting_report r
  where r.match_key = v_match_key
    and r.scout_id = v_resolved_scout
    and not r.deleted
  for update;

  v_candidate.id := v_id;
  v_candidate.schema_version := v_schema;
  v_candidate.app_version := p->>'app_version';
  v_candidate.device_id := p->>'device_id';
  v_candidate.row_revision := v_incoming_rev;
  v_candidate.deleted := coalesce((p->>'deleted')::boolean, false);
  v_candidate.event_key := v_event_key;
  v_candidate.match_key := v_match_key;
  v_candidate.scout_id := v_resolved_scout;
  v_candidate.target_team_number := (p->>'target_team_number')::int;
  v_candidate.alliance_color := p->>'alliance_color';
  v_candidate.station := (p->>'station')::int;
  v_candidate.inactive_first := (p->>'inactive_first')::boolean;
  v_candidate.inactive_first_source := nullif(p->>'inactive_first_source', '');
  v_candidate.teleop_clock_unconfirmed :=
    coalesce((p->>'teleop_clock_unconfirmed')::boolean, false);
  v_candidate.fuel_bursts := coalesce(p->'fuel_bursts', '[]'::jsonb);
  v_candidate.feeding_bursts := coalesce(p->'feeding_bursts', '[]'::jsonb);
  v_candidate.climb_level := coalesce((p->>'climb_level')::int, 0);
  v_candidate.climb_attempted := coalesce((p->>'climb_attempted')::boolean, false);
  v_candidate.climb_success := coalesce((p->>'climb_success')::boolean, false);
  v_candidate.auto_start_position := p->'auto_start_position';
  v_candidate.auto_path := p->'auto_path';
  v_candidate.auto_left_starting_line :=
    coalesce((p->>'auto_left_starting_line')::boolean, false);
  v_candidate.auto_climb_level1 :=
    coalesce((p->>'auto_climb_level1')::boolean, false);
  select coalesce(array_agg(x.value), '{}'::text[])
  into v_candidate.intake_sources
  from jsonb_array_elements_text(coalesce(p->'intake_sources', '[]'::jsonb)) x;
  v_candidate.max_fuel_capacity_observed :=
    coalesce((p->>'max_fuel_capacity_observed')::int, 0);
  v_rating := coalesce((p->>'defense_rating')::int, 0);
  v_candidate.defense_rating :=
    public.normalized_qualitative_rating(v_schema, v_rating);
  v_rating := coalesce((p->>'driver_skill')::int, 0);
  v_candidate.driver_skill :=
    public.normalized_qualitative_rating(v_schema, v_rating);
  v_rating := coalesce((p->>'agility')::int, 0);
  v_candidate.agility :=
    public.normalized_qualitative_rating(v_schema, v_rating);
  v_candidate.pins := coalesce((p->>'pins')::int, 0);
  v_candidate.fouls_minor := coalesce((p->>'fouls_minor')::int, 0);
  v_candidate.fouls_major := coalesce((p->>'fouls_major')::int, 0);
  select coalesce(array_agg(x.value), '{}'::text[])
  into v_candidate.foul_reasons
  from jsonb_array_elements_text(coalesce(p->'foul_reasons', '[]'::jsonb)) x;
  v_candidate.no_show := coalesce((p->>'no_show')::boolean, false);
  v_candidate.died := coalesce((p->>'died')::boolean, false);
  v_candidate.tipped := coalesce((p->>'tipped')::boolean, false);
  v_candidate.dropped_fuel := coalesce((p->>'dropped_fuel')::boolean, false);
  v_candidate.fed_corral := coalesce((p->>'fed_corral')::boolean, false);
  v_candidate.notes := p->>'notes';
  v_candidate.defense_duration_ms :=
    coalesce((p->>'defense_duration_ms')::int, 0);
  v_candidate.defended_duration_ms :=
    coalesce((p->>'defended_duration_ms')::int, 0);
  v_candidate.defense_intervals := coalesce(p->'defense_intervals', '[]'::jsonb);
  v_candidate.defended_intervals := coalesce(p->'defended_intervals', '[]'::jsonb);

  v_candidate_canonical := to_jsonb(v_candidate) - array[
    'created_at', 'updated_at', 'server_received_at',
    'auto_fuel', 'teleop_fuel_active', 'teleop_fuel_inactive',
    'endgame_fuel', 'fuel_by_shift', 'fuel_points',
    'fuel_estimate_confidence'
  ]::text[];

  if v_existing.id is not null then
    if v_existing.event_key <> v_event_key
       or v_existing.match_key <> v_match_key
       or v_existing.scout_id <> v_resolved_scout
    then
      return jsonb_build_object(
        'status', 'conflict',
        'current_revision', v_existing.row_revision,
        'identity_conflict', true
      );
    end if;
    if v_incoming_rev < v_existing.row_revision then
      return jsonb_build_object(
        'status', 'stale',
        'current_revision', v_existing.row_revision
      );
    end if;

    v_existing_canonical := to_jsonb(v_existing) - array[
      'created_at', 'updated_at', 'server_received_at',
      'auto_fuel', 'teleop_fuel_active', 'teleop_fuel_inactive',
      'endgame_fuel', 'fuel_by_shift', 'fuel_points',
      'fuel_estimate_confidence'
    ]::text[];
    if v_incoming_rev = v_existing.row_revision then
      if v_candidate_canonical = v_existing_canonical then
        return jsonb_build_object(
          'status', 'idempotent',
          'current_revision', v_existing.row_revision
        );
      end if;
      return jsonb_build_object(
        'status', 'conflict',
        'current_revision', v_existing.row_revision
      );
    end if;
  end if;

  perform set_config('app.skip_msr_bump', 'on', true);

  if not v_candidate.deleted
     and v_slot_existing.id is not null
     and v_slot_existing.id <> v_id
  then
    update public.match_scouting_report
    set deleted = true,
        row_revision = row_revision + 1
    where id = v_slot_existing.id;
  end if;

  if v_existing.id is null then
    insert into public.match_scouting_report (
      id, schema_version, app_version, device_id, event_key, match_key, scout_id,
      target_team_number, alliance_color, station, inactive_first,
      inactive_first_source, teleop_clock_unconfirmed, fuel_bursts,
      feeding_bursts, climb_level, climb_attempted, climb_success,
      auto_start_position, auto_path, auto_left_starting_line, auto_climb_level1,
      intake_sources, max_fuel_capacity_observed, defense_rating, driver_skill,
      agility, pins, fouls_minor, fouls_major, foul_reasons, no_show, died,
      tipped, dropped_fuel, fed_corral, notes, defense_duration_ms,
      defended_duration_ms, defense_intervals, defended_intervals,
      row_revision, deleted
    ) values (
      v_candidate.id, v_candidate.schema_version, v_candidate.app_version,
      v_candidate.device_id, v_candidate.event_key, v_candidate.match_key,
      v_candidate.scout_id, v_candidate.target_team_number,
      v_candidate.alliance_color, v_candidate.station,
      v_candidate.inactive_first, v_candidate.inactive_first_source,
      v_candidate.teleop_clock_unconfirmed, v_candidate.fuel_bursts,
      v_candidate.feeding_bursts, v_candidate.climb_level,
      v_candidate.climb_attempted, v_candidate.climb_success,
      v_candidate.auto_start_position, v_candidate.auto_path,
      v_candidate.auto_left_starting_line, v_candidate.auto_climb_level1,
      v_candidate.intake_sources, v_candidate.max_fuel_capacity_observed,
      v_candidate.defense_rating, v_candidate.driver_skill,
      v_candidate.agility, v_candidate.pins, v_candidate.fouls_minor,
      v_candidate.fouls_major, v_candidate.foul_reasons, v_candidate.no_show,
      v_candidate.died, v_candidate.tipped, v_candidate.dropped_fuel,
      v_candidate.fed_corral, v_candidate.notes,
      v_candidate.defense_duration_ms, v_candidate.defended_duration_ms,
      v_candidate.defense_intervals, v_candidate.defended_intervals,
      v_candidate.row_revision, v_candidate.deleted
    );
  else
    update public.match_scouting_report
    set schema_version = v_candidate.schema_version,
        app_version = v_candidate.app_version,
        device_id = v_candidate.device_id,
        target_team_number = v_candidate.target_team_number,
        alliance_color = v_candidate.alliance_color,
        station = v_candidate.station,
        inactive_first = v_candidate.inactive_first,
        inactive_first_source = v_candidate.inactive_first_source,
        teleop_clock_unconfirmed = v_candidate.teleop_clock_unconfirmed,
        fuel_bursts = v_candidate.fuel_bursts,
        feeding_bursts = v_candidate.feeding_bursts,
        climb_level = v_candidate.climb_level,
        climb_attempted = v_candidate.climb_attempted,
        climb_success = v_candidate.climb_success,
        auto_start_position = v_candidate.auto_start_position,
        auto_path = v_candidate.auto_path,
        auto_left_starting_line = v_candidate.auto_left_starting_line,
        auto_climb_level1 = v_candidate.auto_climb_level1,
        intake_sources = v_candidate.intake_sources,
        max_fuel_capacity_observed = v_candidate.max_fuel_capacity_observed,
        defense_rating = v_candidate.defense_rating,
        driver_skill = v_candidate.driver_skill,
        agility = v_candidate.agility,
        pins = v_candidate.pins,
        fouls_minor = v_candidate.fouls_minor,
        fouls_major = v_candidate.fouls_major,
        foul_reasons = v_candidate.foul_reasons,
        no_show = v_candidate.no_show,
        died = v_candidate.died,
        tipped = v_candidate.tipped,
        dropped_fuel = v_candidate.dropped_fuel,
        fed_corral = v_candidate.fed_corral,
        notes = v_candidate.notes,
        defense_duration_ms = v_candidate.defense_duration_ms,
        defended_duration_ms = v_candidate.defended_duration_ms,
        defense_intervals = v_candidate.defense_intervals,
        defended_intervals = v_candidate.defended_intervals,
        deleted = v_candidate.deleted,
        row_revision = v_candidate.row_revision
    where id = v_id;
  end if;

  perform public.recompute_match_report_aggregates(v_id);
  perform set_config('app.skip_msr_bump', 'off', true);

  return jsonb_build_object(
    'status', 'applied',
    'current_revision', v_incoming_rev,
    'superseded_id', case
      when v_slot_existing.id is not null and v_slot_existing.id <> v_id
      then v_slot_existing.id else null end
  );
end;
$$;

revoke all on function public.upsert_match_report(jsonb) from public;
grant execute on function public.upsert_match_report(jsonb)
  to anon, authenticated, service_role;
comment on function public.upsert_match_report(jsonb) is
  'Open by product policy. Anonymous callers can mutate scouting data (accepted BOLA/IDOR risk); this RPC provides validation, locking, and revision conflict safety only.';

-- ---------------------------------------------------------------------------
-- Pit-report equal-revision content conflicts and bounded effective payloads.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_pit_report(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event_key text;
  v_team int;
  v_incoming_rev bigint;
  v_has_base boolean;
  v_base_rev bigint;
  v_existing public.pit_scouting_report%rowtype;
  v_author uuid;
  v_has_photos boolean;
  v_photos jsonb;
  v_effective jsonb;
  v_existing_effective jsonb;
  photo jsonb;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'pit report payload must be an object' using errcode = '22023';
  end if;
  if pg_column_size(p) > 262144 then
    raise exception 'pit report payload exceeds 256 KiB' using errcode = '22023';
  end if;

  if nullif(p->>'event_key', '') is null
     or jsonb_typeof(p->'team_number') is distinct from 'number'
     or (
       p ? 'row_revision'
       and jsonb_typeof(p->'row_revision') is distinct from 'number'
     )
     or (
       p ? 'base_revision'
       and jsonb_typeof(p->'base_revision') not in ('number', 'null')
     )
  then
    raise exception 'pit report identity/revision field is malformed'
      using errcode = '22023';
  end if;

  v_event_key := p->>'event_key';
  v_team := (p->>'team_number')::int;
  v_incoming_rev := coalesce((p->>'row_revision')::bigint, 1);
  v_has_base := p ? 'base_revision';
  v_base_rev := nullif(p->>'base_revision', '')::bigint;
  v_author := nullif(p->>'author_scout_id', '')::uuid;
  v_has_photos := p ? 'photos';
  v_photos := p->'photos';

  if length(v_event_key) > 64
     or (p->>'team_number')::numeric <> trunc((p->>'team_number')::numeric)
     or v_team not between 1 and 999999
     or coalesce((p->>'row_revision')::numeric, 1) <>
       trunc(coalesce((p->>'row_revision')::numeric, 1))
     or v_incoming_rev not between 1 and 9007199254740991
     or (v_has_base and v_base_rev is not null
       and (
         (p->>'base_revision')::numeric <>
           trunc((p->>'base_revision')::numeric)
         or v_base_rev not between 1 and 9007199254740991
       ))
     or length(coalesce(p->>'drivetrain', '')) > 128
     or length(coalesce(p->>'vision_system', '')) > 512
     or length(coalesce(p->>'notes', '')) > 10000
  then
    raise exception 'pit report scalar field is invalid' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock_shared(
    hashtextextended('event_write:' || v_event_key, 0)
  );
  if not exists (
    select 1 from public.event_team et
    where et.event_key = v_event_key and et.team_number = v_team
  ) then
    raise exception 'pit report event/team is invalid' using errcode = '23503';
  end if;

  if jsonb_typeof(coalesce(p->'mechanisms', '[]'::jsonb))
       is distinct from 'array'
     or jsonb_array_length(coalesce(p->'mechanisms', '[]'::jsonb)) > 64
     or exists (
       select 1
       from jsonb_array_elements(coalesce(p->'mechanisms', '[]'::jsonb)) item
       where jsonb_typeof(item.value) is distinct from 'string'
          or length(item.value #>> '{}') > 128
     )
     or jsonb_typeof(coalesce(p->'match_strategy', '[]'::jsonb))
        is distinct from 'array'
     or jsonb_array_length(coalesce(p->'match_strategy', '[]'::jsonb)) > 64
     or exists (
       select 1
       from jsonb_array_elements(coalesce(p->'match_strategy', '[]'::jsonb)) item
       where jsonb_typeof(item.value) is distinct from 'string'
          or length(item.value #>> '{}') > 128
     )
     or (
       p ? 'capabilities'
       and jsonb_typeof(p->'capabilities') not in ('object', 'array', 'null')
     )
     or (
       p ? 'preferred_auto_path'
       and jsonb_typeof(p->'preferred_auto_path') <> 'null'
       and (
         jsonb_typeof(p->'preferred_auto_path') is distinct from 'array'
         or jsonb_array_length(p->'preferred_auto_path') > 256
       )
     )
  then
    raise exception 'pit report list exceeds its limit' using errcode = '22023';
  end if;

  if v_has_photos then
    if jsonb_typeof(v_photos) is distinct from 'array'
       or jsonb_array_length(v_photos) > 6
    then
      raise exception 'pit report photos must be an array of at most 6 items'
        using errcode = '22023';
    end if;
    for photo in select value from jsonb_array_elements(v_photos)
    loop
      if jsonb_typeof(photo) is distinct from 'object'
         or jsonb_typeof(photo->'id') is distinct from 'string'
         or length(photo->>'id') not between 1 and 128
         or (
           photo ? 'path'
           and photo->'path' <> 'null'::jsonb
           and (
             jsonb_typeof(photo->'path') is distinct from 'string'
             or length(photo->>'path') > 1024
           )
         )
         or (
           photo ? 'order'
           and (
             jsonb_typeof(photo->'order') is distinct from 'number'
             or (photo->>'order')::numeric <> trunc((photo->>'order')::numeric)
             or (photo->>'order')::int not between 0 and 5
           )
         )
      then
        raise exception 'pit report photo entry is malformed' using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_author is not null and not exists (
    select 1 from public.scout s
    where s.id = v_author and s.event_key = v_event_key
  ) then
    v_author := null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('pit_report:' || v_event_key || ':' || v_team::text, 0)
  );
  select * into v_existing
  from public.pit_scouting_report
  where event_key = v_event_key and team_number = v_team
  for update;

  if not v_has_photos then
    v_photos := case
      when v_existing.event_key is null then '[]'::jsonb
      else v_existing.photos
    end;
  end if;

  v_effective := jsonb_build_object(
    'event_key', v_event_key,
    'team_number', v_team,
    'drivetrain', p->>'drivetrain',
    'mechanisms', coalesce(p->'mechanisms', '[]'::jsonb),
    'capabilities', coalesce(p->'capabilities', '[]'::jsonb),
    'vision_system', p->>'vision_system',
    'batteries', p->'batteries',
    'preferred_auto_start_position', p->'preferred_auto_start_position',
    'preferred_auto_path', p->'preferred_auto_path',
    'match_strategy', coalesce(p->'match_strategy', '[]'::jsonb),
    'robot_dimensions', p->'robot_dimensions',
    'photos', v_photos,
    'photo_path', case
      when v_has_photos then v_photos->0->>'path'
      when v_existing.event_key is not null then v_existing.photo_path
      else p->>'photo_path'
    end,
    'notes', p->>'notes',
    'author_scout_id', v_author,
    'deleted', false
  );

  if v_existing.event_key is not null then
    v_existing_effective := jsonb_build_object(
      'event_key', v_existing.event_key,
      'team_number', v_existing.team_number,
      'drivetrain', v_existing.drivetrain,
      'mechanisms', coalesce(v_existing.mechanisms, '[]'::jsonb),
      'capabilities', coalesce(v_existing.capabilities, '[]'::jsonb),
      'vision_system', v_existing.vision_system,
      'batteries', v_existing.batteries,
      'preferred_auto_start_position', v_existing.preferred_auto_start_position,
      'preferred_auto_path', v_existing.preferred_auto_path,
      'match_strategy', coalesce(v_existing.match_strategy, '[]'::jsonb),
      'robot_dimensions', v_existing.robot_dimensions,
      'photos', v_existing.photos,
      'photo_path', v_existing.photo_path,
      'notes', v_existing.notes,
      'author_scout_id', v_existing.author_scout_id,
      'deleted', v_existing.deleted
    );
  end if;

  if v_existing.event_key is null then
    if v_has_base and v_base_rev is not null then
      return jsonb_build_object(
        'status', 'conflict', 'current_revision', null
      );
    end if;
  elsif v_existing.row_revision = v_incoming_rev then
    if v_effective = v_existing_effective then
      return jsonb_build_object(
        'status', 'idempotent',
        'current_revision', v_existing.row_revision
      );
    end if;
    return jsonb_build_object(
      'status', 'conflict',
      'current_revision', v_existing.row_revision
    );
  elsif v_has_base and v_base_rev is distinct from v_existing.row_revision then
    return jsonb_build_object(
      'status', 'conflict',
      'current_revision', v_existing.row_revision
    );
  elsif v_incoming_rev < v_existing.row_revision then
    return jsonb_build_object(
      'status', 'stale',
      'current_revision', v_existing.row_revision
    );
  end if;

  if v_existing.event_key is null then
    insert into public.pit_scouting_report (
      event_key, team_number, drivetrain, mechanisms, capabilities,
      vision_system, batteries, preferred_auto_start_position,
      preferred_auto_path, match_strategy, robot_dimensions, photos,
      photo_path, notes, author_scout_id, row_revision, updated_at,
      server_received_at, deleted
    ) values (
      v_event_key, v_team, p->>'drivetrain',
      coalesce(p->'mechanisms', '[]'::jsonb),
      coalesce(p->'capabilities', '[]'::jsonb),
      p->>'vision_system', p->'batteries',
      p->'preferred_auto_start_position', p->'preferred_auto_path',
      coalesce(p->'match_strategy', '[]'::jsonb),
      p->'robot_dimensions', v_photos,
      v_effective->>'photo_path', p->>'notes', v_author,
      v_incoming_rev, now(), now(), false
    );
  else
    if v_incoming_rev <= v_existing.row_revision then
      raise exception 'new pit report revision must be greater than current revision'
        using errcode = '22023';
    end if;
    insert into public.pit_report_history (event_key, team_number, snapshot)
    values (v_event_key, v_team, to_jsonb(v_existing));

    update public.pit_scouting_report
    set drivetrain = p->>'drivetrain',
        mechanisms = coalesce(p->'mechanisms', '[]'::jsonb),
        capabilities = coalesce(p->'capabilities', '[]'::jsonb),
        vision_system = p->>'vision_system',
        batteries = p->'batteries',
        preferred_auto_start_position = p->'preferred_auto_start_position',
        preferred_auto_path = p->'preferred_auto_path',
        match_strategy = coalesce(p->'match_strategy', '[]'::jsonb),
        robot_dimensions = p->'robot_dimensions',
        photos = v_photos,
        photo_path = v_effective->>'photo_path',
        notes = p->>'notes',
        author_scout_id = v_author,
        row_revision = v_incoming_rev,
        updated_at = now(),
        server_received_at = now(),
        deleted = false
    where event_key = v_event_key and team_number = v_team;
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'current_revision', v_incoming_rev
  );
end;
$$;

revoke all on function public.upsert_pit_report(jsonb) from public;
grant execute on function public.upsert_pit_report(jsonb)
  to anon, authenticated, service_role;
comment on function public.upsert_pit_report(jsonb) is
  'Open by product policy (accepted anonymous-control-plane risk). Provides bounded CAS and content-aware idempotency, not caller authorization.';

-- ---------------------------------------------------------------------------
-- Versioned, conflict-aware assignment batch replacement.
-- ---------------------------------------------------------------------------

create table public.assignment_batch_revision (
  event_key text not null references public.event(event_key) on delete cascade,
  assignment_kind text not null
    check (assignment_kind in ('match', 'pit')),
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  primary key (event_key, assignment_kind)
);

alter table public.assignment_batch_revision enable row level security;
revoke all on table public.assignment_batch_revision
  from public, anon, authenticated;

insert into public.assignment_batch_revision (
  event_key, assignment_kind, revision
)
select e.event_key, k.assignment_kind,
  case k.assignment_kind
    when 'match' then case when exists (
      select 1 from public.assignment a where a.event_key = e.event_key
    ) then 1 else 0 end
    when 'pit' then case when exists (
      select 1 from public.pit_assignment p where p.event_key = e.event_key
    ) then 1 else 0 end
  end
from public.event e
cross join (values ('match'), ('pit')) k(assignment_kind)
on conflict do nothing;

create or replace function public.get_assignment_batch_state(
  p_event_key text,
  p_assignment_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_revision bigint;
  v_count int;
begin
  if p_assignment_kind not in ('match', 'pit') then
    raise exception 'assignment kind must be match or pit' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.event e where e.event_key = p_event_key
  ) then
    raise exception 'event not found' using errcode = '23503';
  end if;
  insert into public.assignment_batch_revision (
    event_key, assignment_kind, revision
  ) values (p_event_key, p_assignment_kind, 0)
  on conflict do nothing;
  select r.revision into v_revision
  from public.assignment_batch_revision r
  where r.event_key = p_event_key
    and r.assignment_kind = p_assignment_kind;
  if p_assignment_kind = 'match' then
    select count(*)::int into v_count
    from public.assignment a where a.event_key = p_event_key;
  else
    select count(*)::int into v_count
    from public.pit_assignment a where a.event_key = p_event_key;
  end if;
  return jsonb_build_object(
    'status', 'authoritative',
    'revision', v_revision,
    'count', v_count
  );
end;
$$;

revoke all on function public.get_assignment_batch_state(text, text) from public;
grant execute on function public.get_assignment_batch_state(text, text)
  to anon, authenticated, service_role;

create or replace function public.set_assignments(
  p_event_key text,
  p_assignments jsonb,
  p_base_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  elem jsonb;
  v_revision bigint;
  v_count int;
  v_input_canonical jsonb;
  v_current_canonical jsonb;
begin
  perform pg_advisory_xact_lock_shared(
    hashtextextended('event_write:' || coalesce(p_event_key, ''), 0)
  );
  if not exists (
    select 1 from public.event e where e.event_key = p_event_key
  ) then
    raise exception 'event not found' using errcode = '23503';
  end if;
  if p_assignments is null
     or jsonb_typeof(p_assignments) is distinct from 'array'
     or jsonb_array_length(p_assignments) > 2000
     or pg_column_size(p_assignments) > 524288
  then
    raise exception 'match assignments must be an array of at most 2000 rows'
      using errcode = '22023';
  end if;
  if p_base_revision is not null and p_base_revision < 0 then
    raise exception 'base revision must be nonnegative' using errcode = '22023';
  end if;

  for elem in select value from jsonb_array_elements(p_assignments)
  loop
    if jsonb_typeof(elem) is distinct from 'object'
       or jsonb_typeof(elem->'match_key') is distinct from 'string'
       or jsonb_typeof(elem->'scout_id') is distinct from 'string'
       or jsonb_typeof(elem->'alliance_color') is distinct from 'string'
       or jsonb_typeof(elem->'station') is distinct from 'number'
       or jsonb_typeof(elem->'target_team_number') is distinct from 'number'
       or length(elem->>'match_key') > 128
       or elem->>'alliance_color' not in ('red', 'blue')
       or (elem->>'station')::numeric <> trunc((elem->>'station')::numeric)
       or (elem->>'station')::int not between 1 and 3
       or (elem->>'target_team_number')::numeric <>
          trunc((elem->>'target_team_number')::numeric)
       or (elem->>'target_team_number')::int not between 1 and 999999
       or (
         elem ? 'source'
         and elem->>'source' not in ('manual', 'auto')
       )
    then
      raise exception 'match assignment row is malformed' using errcode = '22023';
    end if;
    perform (elem->>'scout_id')::uuid;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(p_assignments) e
    group by e.value->>'match_key', e.value->>'alliance_color',
             (e.value->>'station')::int
    having count(*) > 1
  ) then
    raise exception 'duplicate match assignment seat' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_assignments) e
    group by e.value->>'match_key', (e.value->>'scout_id')::uuid
    having count(*) > 1
  ) then
    raise exception 'a scout cannot occupy multiple seats in one match'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_assignments) e
    left join public.match m
      on m.match_key = e.value->>'match_key'
     and m.event_key = p_event_key
    left join public.scout s
      on s.id = (e.value->>'scout_id')::uuid
     and s.event_key = p_event_key
    where m.match_key is null
       or s.id is null
       or not exists (
         select 1 from public.event_team et
         where et.event_key = p_event_key
           and et.team_number = (e.value->>'target_team_number')::int
       )
       or (e.value->>'target_team_number')::int is distinct from
          case e.value->>'alliance_color'
            when 'red' then case (e.value->>'station')::int
              when 1 then m.red1 when 2 then m.red2 when 3 then m.red3 end
            when 'blue' then case (e.value->>'station')::int
              when 1 then m.blue1 when 2 then m.blue2 when 3 then m.blue3 end
          end
  ) then
    raise exception 'assignment references a stale/cross-event seat or scout'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('match_assignments:' || p_event_key, 0)
  );
  insert into public.assignment_batch_revision (
    event_key, assignment_kind, revision
  ) values (p_event_key, 'match', 0)
  on conflict do nothing;
  select r.revision into v_revision
  from public.assignment_batch_revision r
  where r.event_key = p_event_key and r.assignment_kind = 'match'
  for update;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'match_key', e.value->>'match_key',
        'scout_id', (e.value->>'scout_id')::uuid,
        'alliance_color', e.value->>'alliance_color',
        'station', (e.value->>'station')::int,
        'target_team_number', (e.value->>'target_team_number')::int,
        'source', case
          when e.value->>'source' = 'manual' then 'manual' else 'auto' end
      )
      order by e.value->>'match_key', e.value->>'alliance_color',
               (e.value->>'station')::int
    ),
    '[]'::jsonb
  ) into v_input_canonical
  from jsonb_array_elements(p_assignments) e;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'match_key', a.match_key,
        'scout_id', a.scout_id,
        'alliance_color', a.alliance_color,
        'station', a.station,
        'target_team_number', a.target_team_number,
        'source', a.source
      )
      order by a.match_key, a.alliance_color, a.station
    ),
    '[]'::jsonb
  ) into v_current_canonical
  from public.assignment a
  where a.event_key = p_event_key;

  select count(*)::int into v_count
  from public.assignment a where a.event_key = p_event_key;
  if v_input_canonical = v_current_canonical then
    return jsonb_build_object(
      'status', 'idempotent', 'revision', v_revision, 'count', v_count
    );
  end if;
  if p_base_revision is not null and p_base_revision <> v_revision then
    return jsonb_build_object(
      'status', 'conflict', 'revision', v_revision, 'count', v_count
    );
  end if;

  delete from public.assignment where event_key = p_event_key;
  insert into public.assignment (
    event_key, match_key, scout_id, alliance_color, station,
    target_team_number, source
  )
  select
    p_event_key,
    e.value->>'match_key',
    (e.value->>'scout_id')::uuid,
    e.value->>'alliance_color',
    (e.value->>'station')::int,
    (e.value->>'target_team_number')::int,
    case when e.value->>'source' = 'manual' then 'manual' else 'auto' end
  from jsonb_array_elements(p_assignments) e;
  get diagnostics v_count = row_count;
  v_revision := v_revision + 1;
  update public.assignment_batch_revision
  set revision = v_revision, updated_at = now()
  where event_key = p_event_key and assignment_kind = 'match';

  return jsonb_build_object(
    'status', 'applied', 'revision', v_revision, 'count', v_count
  );
end;
$$;

revoke all on function public.set_assignments(text, jsonb, bigint) from public;
grant execute on function public.set_assignments(text, jsonb, bigint)
  to anon, authenticated, service_role;

-- Backward-compatible wrapper. It receives all atomic validation/locking, but
-- old callers have no base revision and therefore retain last-writer semantics.
create or replace function public.set_assignments(
  p_event_key text,
  p_assignments jsonb
)
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  v_result := public.set_assignments(p_event_key, p_assignments, null::bigint);
  return coalesce((v_result->>'count')::int, 0);
end;
$$;

revoke all on function public.set_assignments(text, jsonb) from public;
grant execute on function public.set_assignments(text, jsonb)
  to anon, authenticated, service_role;

create or replace function public.set_pit_assignments(
  p_event_key text,
  p_assignments jsonb,
  p_base_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  elem jsonb;
  v_revision bigint;
  v_count int;
  v_input_canonical jsonb;
  v_current_canonical jsonb;
begin
  perform pg_advisory_xact_lock_shared(
    hashtextextended('event_write:' || coalesce(p_event_key, ''), 0)
  );
  if not exists (
    select 1 from public.event e where e.event_key = p_event_key
  ) then
    raise exception 'event not found' using errcode = '23503';
  end if;
  if p_assignments is null
     or jsonb_typeof(p_assignments) is distinct from 'array'
     or jsonb_array_length(p_assignments) > 1000
     or pg_column_size(p_assignments) > 262144
  then
    raise exception 'pit assignments must be an array of at most 1000 rows'
      using errcode = '22023';
  end if;
  if p_base_revision is not null and p_base_revision < 0 then
    raise exception 'base revision must be nonnegative' using errcode = '22023';
  end if;

  for elem in select value from jsonb_array_elements(p_assignments)
  loop
    if jsonb_typeof(elem) is distinct from 'object'
       or jsonb_typeof(elem->'team_number') is distinct from 'number'
       or jsonb_typeof(elem->'scout_id') is distinct from 'string'
       or (elem->>'team_number')::numeric <>
          trunc((elem->>'team_number')::numeric)
       or (elem->>'team_number')::int not between 1 and 999999
       or (
         elem ? 'source'
         and elem->>'source' not in ('manual', 'auto')
       )
    then
      raise exception 'pit assignment row is malformed' using errcode = '22023';
    end if;
    perform (elem->>'scout_id')::uuid;
  end loop;
  if exists (
    select 1
    from jsonb_array_elements(p_assignments) e
    group by (e.value->>'team_number')::int, (e.value->>'scout_id')::uuid
    having count(*) > 1
  ) then
    raise exception 'duplicate pit crew membership' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_assignments) e
    left join public.event_team et
      on et.event_key = p_event_key
     and et.team_number = (e.value->>'team_number')::int
    left join public.scout s
      on s.event_key = p_event_key
     and s.id = (e.value->>'scout_id')::uuid
    where et.team_number is null or s.id is null
  ) then
    raise exception 'pit assignment references a cross-event team or scout'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('pit_assignments:' || p_event_key, 0)
  );
  insert into public.assignment_batch_revision (
    event_key, assignment_kind, revision
  ) values (p_event_key, 'pit', 0)
  on conflict do nothing;
  select r.revision into v_revision
  from public.assignment_batch_revision r
  where r.event_key = p_event_key and r.assignment_kind = 'pit'
  for update;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'team_number', (e.value->>'team_number')::int,
        'scout_id', (e.value->>'scout_id')::uuid,
        'source', case
          when e.value->>'source' = 'auto' then 'auto' else 'manual' end
      )
      order by (e.value->>'team_number')::int, (e.value->>'scout_id')::uuid
    ),
    '[]'::jsonb
  ) into v_input_canonical
  from jsonb_array_elements(p_assignments) e;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'team_number', a.team_number,
        'scout_id', a.scout_id,
        'source', a.source
      )
      order by a.team_number, a.scout_id
    ),
    '[]'::jsonb
  ) into v_current_canonical
  from public.pit_assignment a
  where a.event_key = p_event_key;

  select count(*)::int into v_count
  from public.pit_assignment a where a.event_key = p_event_key;
  if v_input_canonical = v_current_canonical then
    return jsonb_build_object(
      'status', 'idempotent', 'revision', v_revision, 'count', v_count
    );
  end if;
  if p_base_revision is not null and p_base_revision <> v_revision then
    return jsonb_build_object(
      'status', 'conflict', 'revision', v_revision, 'count', v_count
    );
  end if;

  delete from public.pit_assignment where event_key = p_event_key;
  insert into public.pit_assignment (
    event_key, team_number, scout_id, source
  )
  select
    p_event_key,
    (e.value->>'team_number')::int,
    (e.value->>'scout_id')::uuid,
    case when e.value->>'source' = 'auto' then 'auto' else 'manual' end
  from jsonb_array_elements(p_assignments) e;
  get diagnostics v_count = row_count;
  v_revision := v_revision + 1;
  update public.assignment_batch_revision
  set revision = v_revision, updated_at = now()
  where event_key = p_event_key and assignment_kind = 'pit';

  return jsonb_build_object(
    'status', 'applied', 'revision', v_revision, 'count', v_count
  );
end;
$$;

revoke all on function public.set_pit_assignments(text, jsonb, bigint)
  from public;
grant execute on function public.set_pit_assignments(text, jsonb, bigint)
  to anon, authenticated, service_role;

create or replace function public.set_pit_assignments(
  p_event_key text,
  p_assignments jsonb
)
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  v_result := public.set_pit_assignments(
    p_event_key, p_assignments, null::bigint
  );
  return coalesce((v_result->>'count')::int, 0);
end;
$$;

revoke all on function public.set_pit_assignments(text, jsonb) from public;
grant execute on function public.set_pit_assignments(text, jsonb)
  to anon, authenticated, service_role;
comment on function public.set_assignments(text, jsonb, bigint) is
  'Open by product policy (accepted anonymous control-plane risk). CAS is for consistency, not authorization.';
comment on function public.set_pit_assignments(text, jsonb, bigint) is
  'Open by product policy (accepted anonymous control-plane risk). CAS is for consistency, not authorization.';

-- ---------------------------------------------------------------------------
-- Serialized stable scouter identity selection/seeding.
-- ---------------------------------------------------------------------------

create or replace function public.select_scouter(
  p_event_key text,
  p_name text
)
returns public.scout
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(p_name);
  v_scout public.scout;
  v_uid_lock bigint;
  v_name_lock bigint;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  perform pg_advisory_xact_lock_shared(
    hashtextextended('event_write:' || coalesce(p_event_key, ''), 0)
  );
  if not exists (
    select 1 from public.event e where e.event_key = p_event_key
  ) then
    raise exception 'event not found' using errcode = '23503';
  end if;
  if v_name = '' or length(v_name) > 128 then
    raise exception 'scouter name must contain 1 to 128 characters'
      using errcode = '22023';
  end if;

  v_uid_lock := hashtextextended(
    'select_scouter_uid:' || p_event_key || ':' || v_uid::text,
    0
  );
  v_name_lock := hashtextextended(
    'scout_name:' || p_event_key || ':' || lower(v_name),
    0
  );
  perform pg_advisory_xact_lock(least(v_uid_lock, v_name_lock));
  if v_uid_lock <> v_name_lock then
    perform pg_advisory_xact_lock(greatest(v_uid_lock, v_name_lock));
  end if;

  update public.scout
  set auth_uid = gen_random_uuid()
  where event_key = p_event_key
    and auth_uid = v_uid
    and lower(btrim(display_name)) <> lower(v_name);

  select * into v_scout
  from public.scout s
  where s.event_key = p_event_key
    and lower(btrim(s.display_name)) = lower(v_name)
  for update;

  if v_scout.id is null then
    insert into public.scout (event_key, display_name, auth_uid)
    values (p_event_key, v_name, v_uid)
    returning * into v_scout;
  else
    update public.scout
    set auth_uid = v_uid, display_name = v_name
    where id = v_scout.id
    returning * into v_scout;
  end if;

  insert into public.profile (auth_uid) values (v_uid)
  on conflict (auth_uid) do nothing;
  return v_scout;
end;
$$;

revoke all on function public.select_scouter(text, text) from public;
grant execute on function public.select_scouter(text, text)
  to anon, authenticated, service_role;

create or replace function public.seed_event_scouts_from_roster(p_event_key text)
returns table (id uuid, display_name text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r record;
begin
  perform pg_advisory_xact_lock_shared(
    hashtextextended('event_write:' || coalesce(p_event_key, ''), 0)
  );
  if not exists (
    select 1 from public.event e where e.event_key = p_event_key
  ) then
    raise exception 'event not found' using errcode = '23503';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('seed_event_scouts:' || p_event_key, 0)
  );

  for r in
    select distinct on (lower(btrim(roster.name)))
      btrim(roster.name) as display_name
    from public.scouter_roster roster
    where not roster.hidden and btrim(roster.name) <> ''
    order by lower(btrim(roster.name)), roster.name
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(
        'scout_name:' || p_event_key || ':' || lower(r.display_name),
        0
      )
    );
    insert into public.scout (event_key, display_name, auth_uid)
    values (p_event_key, r.display_name, gen_random_uuid())
    on conflict do nothing;
  end loop;

  return query
  select s.id, s.display_name
  from public.scout s
  where s.event_key = p_event_key
    and not exists (
      select 1 from public.scouter_roster r
      where lower(btrim(r.name)) = lower(btrim(s.display_name))
        and r.hidden
    )
  order by s.display_name, s.id;
end;
$$;

revoke all on function public.seed_event_scouts_from_roster(text) from public;
grant execute on function public.seed_event_scouts_from_roster(text)
  to anon, authenticated, service_role;

-- Reset/delete participates in the same per-event serialization protocol as
-- imports. Report and assignment writers hold this lock in shared mode.
create or replace function public.delete_event(p_event_key text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_event_key is null or length(p_event_key) > 64 then
    raise exception 'event key is invalid' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('event_write:' || p_event_key, 0)
  );
  delete from public.match_scouting_report where event_key = p_event_key;
  delete from public.assignment where event_key = p_event_key;
  delete from public.pit_scouting_report where event_key = p_event_key;
  delete from public.pit_report_history where event_key = p_event_key;
  delete from public.matchup_note_history where event_key = p_event_key;
  delete from public.nexus_event_status where event_key = p_event_key;
  delete from public.scout where event_key = p_event_key;
  delete from public.match where event_key = p_event_key;
  delete from public.event_team where event_key = p_event_key;
  delete from public.event where event_key = p_event_key;
end;
$$;

revoke all on function public.delete_event(text) from public;
grant execute on function public.delete_event(text)
  to anon, authenticated, service_role;
comment on function public.delete_event(text) is
  'Open destructive control-plane operation by product policy (accepted anonymous authorization risk); per-event locking prevents partial concurrent resets.';

-- ---------------------------------------------------------------------------
-- Transactional event import promotion (Edge function stages in memory first).
-- ---------------------------------------------------------------------------

create or replace function public.promote_event_import(
  p_event jsonb,
  p_teams jsonb,
  p_matches jsonb,
  p_activate boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event_key text := p_event->>'event_key';
  v_team_count int;
  v_match_count int;
begin
  if p_event is null
     or jsonb_typeof(p_event) is distinct from 'object'
     or v_event_key is null
     or v_event_key !~ '^[0-9]{4}[a-z0-9]+$'
     or length(v_event_key) > 64
     or length(coalesce(p_event->>'name', '')) > 512
     or jsonb_typeof(p_teams) is distinct from 'array'
     or jsonb_array_length(p_teams) not between 1 and 1000
     or jsonb_typeof(p_matches) is distinct from 'array'
     or jsonb_array_length(p_matches) > 500
     or pg_column_size(p_event) + pg_column_size(p_teams) + pg_column_size(p_matches)
        > 2097152
  then
    raise exception 'event import bundle is malformed or exceeds limits'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_teams) t
    where jsonb_typeof(t.value) is distinct from 'object'
       or jsonb_typeof(t.value->'team_number') is distinct from 'number'
       or (t.value->>'team_number')::numeric <>
          trunc((t.value->>'team_number')::numeric)
       or (t.value->>'team_number')::int not between 1 and 999999
       or length(coalesce(t.value->>'nickname', '')) > 256
       or (
         t.value ? 'rookie_year'
         and t.value->'rookie_year' <> 'null'::jsonb
         and (
           jsonb_typeof(t.value->'rookie_year') is distinct from 'number'
           or (t.value->>'rookie_year')::numeric <>
              trunc((t.value->>'rookie_year')::numeric)
           or (t.value->>'rookie_year')::int not between 1900 and 2200
         )
       )
  ) or exists (
    select 1 from jsonb_array_elements(p_teams) t
    group by (t.value->>'team_number')::int
    having count(*) > 1
  ) then
    raise exception 'event import teams are malformed or duplicated'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_matches) m
    where jsonb_typeof(m.value) is distinct from 'object'
       or jsonb_typeof(m.value->'match_key') is distinct from 'string'
       or length(m.value->>'match_key') > 128
       or m.value->>'match_key' !~ ('^' || v_event_key || '_qm[0-9]+$')
       or jsonb_typeof(m.value->'match_number') is distinct from 'number'
       or (m.value->>'match_number')::numeric <>
          trunc((m.value->>'match_number')::numeric)
       or (m.value->>'match_number')::int not between 1 and 1000
       or exists (
         select 1
         from jsonb_each(m.value) field(key, value)
         where field.key in ('red1', 'red2', 'red3', 'blue1', 'blue2', 'blue3')
           and (
             jsonb_typeof(field.value) not in ('number', 'null')
             or (
               jsonb_typeof(field.value) = 'number'
               and (
                 (field.value #>> '{}')::numeric <>
                   trunc((field.value #>> '{}')::numeric)
                 or (field.value #>> '{}')::int not between 1 and 999999
               )
             )
           )
       )
  ) or exists (
    select 1 from jsonb_array_elements(p_matches) m
    group by m.value->>'match_key'
    having count(*) > 1
  ) then
    raise exception 'event import matches are malformed or duplicated'
      using errcode = '22023';
  end if;

  -- Every occupied station must name a team in the imported event roster.
  if exists (
    select 1
    from jsonb_array_elements(p_matches) m
    cross join lateral (
      values
        (m.value->>'red1'), (m.value->>'red2'), (m.value->>'red3'),
        (m.value->>'blue1'), (m.value->>'blue2'), (m.value->>'blue3')
    ) station(team_text)
    where station.team_text is not null
      and not exists (
        select 1 from jsonb_array_elements(p_teams) t
        where (t.value->>'team_number')::int = station.team_text::int
      )
  ) then
    raise exception 'event import match references a team outside its roster'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('event_write:' || v_event_key, 0)
  );

  insert into public.event (
    event_key, name, start_date, end_date, timezone, city, state_prov,
    imported_at
  ) values (
    v_event_key,
    p_event->>'name',
    nullif(p_event->>'start_date', '')::date,
    nullif(p_event->>'end_date', '')::date,
    p_event->>'timezone',
    p_event->>'city',
    p_event->>'state_prov',
    now()
  )
  on conflict (event_key) do update
  set name = excluded.name,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      timezone = excluded.timezone,
      city = excluded.city,
      state_prov = excluded.state_prov,
      imported_at = excluded.imported_at;

  insert into public.team (
    team_number, nickname, city, state_prov, rookie_year
  )
  select
    (t.value->>'team_number')::int,
    t.value->>'nickname',
    t.value->>'city',
    t.value->>'state_prov',
    nullif(t.value->>'rookie_year', '')::int
  from jsonb_array_elements(p_teams) t
  on conflict (team_number) do update
  set nickname = excluded.nickname,
      city = excluded.city,
      state_prov = excluded.state_prov,
      rookie_year = excluded.rookie_year;
  get diagnostics v_team_count = row_count;

  insert into public.event_team (event_key, team_number)
  select v_event_key, (t.value->>'team_number')::int
  from jsonb_array_elements(p_teams) t
  on conflict do nothing;

  insert into public.match (
    match_key, event_key, comp_level, match_number, scheduled_time,
    red1, red2, red3, blue1, blue2, blue3
  )
  select
    m.value->>'match_key',
    v_event_key,
    'qm',
    (m.value->>'match_number')::int,
    nullif(m.value->>'scheduled_time', '')::timestamptz,
    nullif(m.value->>'red1', '')::int,
    nullif(m.value->>'red2', '')::int,
    nullif(m.value->>'red3', '')::int,
    nullif(m.value->>'blue1', '')::int,
    nullif(m.value->>'blue2', '')::int,
    nullif(m.value->>'blue3', '')::int
  from jsonb_array_elements(p_matches) m
  on conflict (match_key) do update
  set event_key = excluded.event_key,
      comp_level = excluded.comp_level,
      match_number = excluded.match_number,
      scheduled_time = excluded.scheduled_time,
      red1 = excluded.red1,
      red2 = excluded.red2,
      red3 = excluded.red3,
      blue1 = excluded.blue1,
      blue2 = excluded.blue2,
      blue3 = excluded.blue3;
  get diagnostics v_match_count = row_count;

  insert into public.event_secret (event_key, join_code)
  values (
    v_event_key,
    upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8))
  )
  on conflict (event_key) do nothing;

  -- Activate only after every roster/schedule statement has succeeded. The
  -- entire RPC is one transaction, so readers see either old authority or the
  -- fully promoted event.
  if p_activate then
    lock table public.event in share row exclusive mode;
    update public.event
    set is_active = false
    where is_active and event_key <> v_event_key;
    update public.event
    set is_active = true
    where event_key = v_event_key and not is_active;
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'event_key', v_event_key,
    'team_count', jsonb_array_length(p_teams),
    'match_count', jsonb_array_length(p_matches)
  );
end;
$$;

revoke all on function public.promote_event_import(jsonb, jsonb, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.promote_event_import(
  jsonb, jsonb, jsonb, boolean
) to service_role;

-- Atomic demo replacement: the previous demo survives unless the complete
-- generated bundle validates and commits.
create or replace function public.replace_demo_event_bundle(p_bundle jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event jsonb := p_bundle->'event';
  v_event_key text := v_event->>'event_key';
  v_teams jsonb := p_bundle->'teams';
  v_matches jsonb := p_bundle->'matches';
  v_scouts jsonb := p_bundle->'scouts';
  v_pit_assignments jsonb := p_bundle->'pit_assignments';
  v_reports jsonb := p_bundle->'reports';
  v_pit_reports jsonb := p_bundle->'pit_reports';
  item jsonb;
  v_result jsonb;
begin
  if p_bundle is null
     or jsonb_typeof(p_bundle) is distinct from 'object'
     or pg_column_size(p_bundle) > 4194304
     or v_event_key <> '2026demo'
     or jsonb_typeof(v_teams) is distinct from 'array'
     or jsonb_array_length(v_teams) not between 1 and 1000
     or jsonb_typeof(v_matches) is distinct from 'array'
     or jsonb_array_length(v_matches) not between 1 and 500
     or jsonb_typeof(v_scouts) is distinct from 'array'
     or jsonb_array_length(v_scouts) not between 1 and 100
     or jsonb_typeof(v_pit_assignments) is distinct from 'array'
     or jsonb_array_length(v_pit_assignments) > 2000
     or jsonb_typeof(v_reports) is distinct from 'array'
     or jsonb_array_length(v_reports) > 3000
     or jsonb_typeof(v_pit_reports) is distinct from 'array'
     or jsonb_array_length(v_pit_reports) > 1000
  then
    raise exception 'demo replacement bundle is malformed or exceeds limits'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('event_write:' || v_event_key, 0)
  );
  perform public.delete_event(v_event_key);

  insert into public.event (
    event_key, name, start_date, end_date, timezone, city, state_prov,
    is_active, staged_fuel_per_match, imported_at
  ) values (
    v_event_key,
    v_event->>'name',
    nullif(v_event->>'start_date', '')::date,
    nullif(v_event->>'end_date', '')::date,
    v_event->>'timezone',
    v_event->>'city',
    v_event->>'state_prov',
    false,
    coalesce((v_event->>'staged_fuel_per_match')::int, 504),
    now()
  );
  insert into public.event_secret (event_key, join_code)
  values (
    v_event_key,
    coalesce(
      nullif(p_bundle->>'join_code', ''),
      upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8))
    )
  );

  insert into public.team (
    team_number, nickname, city, state_prov, rookie_year
  )
  select
    (t.value->>'team_number')::int,
    t.value->>'nickname',
    t.value->>'city',
    t.value->>'state_prov',
    nullif(t.value->>'rookie_year', '')::int
  from jsonb_array_elements(v_teams) t
  on conflict (team_number) do update
  set nickname = excluded.nickname,
      city = excluded.city,
      state_prov = excluded.state_prov,
      rookie_year = excluded.rookie_year;
  insert into public.event_team (event_key, team_number)
  select v_event_key, (t.value->>'team_number')::int
  from jsonb_array_elements(v_teams) t;

  insert into public.match (
    match_key, event_key, comp_level, match_number, scheduled_time,
    red1, red2, red3, blue1, blue2, blue3,
    actual_red_score, actual_blue_score, winner, result_synced_at
  )
  select
    m.value->>'match_key',
    v_event_key,
    'qm',
    (m.value->>'match_number')::int,
    nullif(m.value->>'scheduled_time', '')::timestamptz,
    nullif(m.value->>'red1', '')::int,
    nullif(m.value->>'red2', '')::int,
    nullif(m.value->>'red3', '')::int,
    nullif(m.value->>'blue1', '')::int,
    nullif(m.value->>'blue2', '')::int,
    nullif(m.value->>'blue3', '')::int,
    nullif(m.value->>'actual_red_score', '')::int,
    nullif(m.value->>'actual_blue_score', '')::int,
    nullif(m.value->>'winner', ''),
    nullif(m.value->>'result_synced_at', '')::timestamptz
  from jsonb_array_elements(v_matches) m;

  insert into public.scout (id, event_key, display_name, auth_uid)
  select
    (s.value->>'id')::uuid,
    v_event_key,
    s.value->>'display_name',
    (s.value->>'auth_uid')::uuid
  from jsonb_array_elements(v_scouts) s;

  v_result := public.set_pit_assignments(
    v_event_key, v_pit_assignments, 0::bigint
  );
  if v_result->>'status' not in ('applied', 'idempotent') then
    raise exception 'demo pit assignment replacement conflicted'
      using errcode = '40001';
  end if;

  for item in select value from jsonb_array_elements(v_reports)
  loop
    v_result := public.upsert_match_report(item);
    if v_result->>'status' not in ('applied', 'idempotent') then
      raise exception 'demo report replacement failed: %', v_result
        using errcode = '40001';
    end if;
  end loop;
  for item in select value from jsonb_array_elements(v_pit_reports)
  loop
    v_result := public.upsert_pit_report(item);
    if v_result->>'status' not in ('applied', 'idempotent') then
      raise exception 'demo pit report replacement failed: %', v_result
        using errcode = '40001';
    end if;
  end loop;

  return jsonb_build_object(
    'status', 'applied',
    'demo_event_key', v_event_key,
    'team_count', jsonb_array_length(v_teams),
    'match_count', jsonb_array_length(v_matches),
    'report_count', jsonb_array_length(v_reports),
    'pit_assignment_count', jsonb_array_length(v_pit_assignments)
  );
end;
$$;

revoke all on function public.replace_demo_event_bundle(jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_demo_event_bundle(jsonb)
  to service_role;

-- Additional composite relationship guards. NOT VALID preserves any historical
-- malformed rows while enforcing the invariant for every new/changed row.
do $$
declare
  c text;
  column_name text;
begin
  foreach column_name in array array[
    'red1', 'red2', 'red3', 'blue1', 'blue2', 'blue3'
  ]
  loop
    c := 'match_event_' || column_name || '_fkey';
    if not exists (select 1 from pg_constraint where conname = c) then
      execute format(
        'alter table public.match add constraint %I '
        || 'foreign key (event_key, %I) '
        || 'references public.event_team(event_key, team_number) not valid',
        c,
        column_name
      );
    end if;
  end loop;
  if not exists (
    select 1 from pg_constraint where conname = 'pit_report_event_team_fkey'
  ) then
    alter table public.pit_scouting_report
      add constraint pit_report_event_team_fkey
      foreign key (event_key, team_number)
      references public.event_team(event_key, team_number) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'pit_assignment_event_scout_fkey'
  ) then
    alter table public.pit_assignment
      add constraint pit_assignment_event_scout_fkey
      foreign key (event_key, scout_id)
      references public.scout(event_key, id) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'strategy_event_match_fkey'
  ) then
    alter table public.strategy_canvas
      add constraint strategy_event_match_fkey
      foreign key (event_key, match_key)
      references public.match(event_key, match_key) not valid;
  end if;
end;
$$;

-- SECURITY DEFINER hygiene under the deliberately open grant model: no
-- accidental execute-through-PUBLIC, no untrusted schema object shadowing, and
-- explicit role grants remain authoritative.
revoke create on schema public from public, anon, authenticated;
alter default privileges in schema public
  revoke execute on functions from public;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format('revoke execute on function %s from public', f.signature);
  end loop;
end;
$$;

comment on table public.assignment_batch_revision is
  'Consistency metadata only. Anonymous assignment writers remain intentionally authorized through explicit RPC grants; this does not mitigate control-plane IDOR.';

notify pgrst, 'reload schema';
