-- set_assignments replaced the whole event on every publish: delete all rows,
-- insert all rows. Realtime emits one event per row per subscriber, so a single
-- 378-row publish sent 756 events to every phone and took the REST API down with
-- 504/522s at 2026mttd. Touch only the seats that actually changed, so a small
-- edit stays a small publish.
--
-- Delete-then-insert rather than UPDATE: assignment_match_scout_uidx is not
-- deferrable, so swapping two scouts within a match would collide row by row.
-- Everything else (validation, locks, revision/conflict contract) is unchanged.
create or replace function public.set_assignments(
  p_event_key text,
  p_assignments jsonb,
  p_base_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
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

  delete from public.assignment a
  where a.event_key = p_event_key
    and not exists (
      select 1
      from jsonb_array_elements(v_input_canonical) e
      where e.value->>'match_key' = a.match_key
        and e.value->>'alliance_color' = a.alliance_color
        and (e.value->>'station')::int = a.station
        and (e.value->>'scout_id')::uuid = a.scout_id
        and (e.value->>'target_team_number')::int = a.target_team_number
        and e.value->>'source' = a.source
    );
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
    e.value->>'source'
  from jsonb_array_elements(v_input_canonical) e
  where not exists (
    select 1
    from public.assignment a
    where a.event_key = p_event_key
      and a.match_key = e.value->>'match_key'
      and a.alliance_color = e.value->>'alliance_color'
      and a.station = (e.value->>'station')::int
  );
  select count(*)::int into v_count
  from public.assignment a where a.event_key = p_event_key;
  v_revision := v_revision + 1;
  update public.assignment_batch_revision
  set revision = v_revision, updated_at = now()
  where event_key = p_event_key and assignment_kind = 'match';

  return jsonb_build_object(
    'status', 'applied', 'revision', v_revision, 'count', v_count
  );
end;
$function$;
