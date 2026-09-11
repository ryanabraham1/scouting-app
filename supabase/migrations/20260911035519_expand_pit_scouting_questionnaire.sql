-- Expand pit scouting without discarding the frozen legacy columns. New answers
-- live in bounded JSONB documents so an old offline client can still sync safely.
alter table public.pit_scouting_report
  add column if not exists pit_questionnaire jsonb not null default '{}'::jsonb,
  add column if not exists auto_routines jsonb not null default '[]'::jsonb;

alter function public.upsert_pit_report(jsonb)
  rename to upsert_pit_report_pre_questionnaire;

revoke all on function public.upsert_pit_report_pre_questionnaire(jsonb) from public;
revoke all on function public.upsert_pit_report_pre_questionnaire(jsonb) from anon, authenticated;
grant execute on function public.upsert_pit_report_pre_questionnaire(jsonb) to service_role;

create function public.upsert_pit_report(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event_key text;
  v_team int;
  v_incoming_rev bigint;
  v_existing public.pit_scouting_report%rowtype;
  v_result jsonb;
  v_has_questionnaire boolean := p ? 'pit_questionnaire';
  v_has_autos boolean := p ? 'auto_routines';
  v_questionnaire jsonb := coalesce(p->'pit_questionnaire', '{}'::jsonb);
  v_autos jsonb := coalesce(p->'auto_routines', '[]'::jsonb);
  auto jsonb;
  point jsonb;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' then
    raise exception 'pit report payload must be an object' using errcode = '22023';
  end if;
  if nullif(p->>'event_key', '') is null
     or jsonb_typeof(p->'team_number') is distinct from 'number'
     or (p ? 'row_revision' and jsonb_typeof(p->'row_revision') is distinct from 'number')
  then
    raise exception 'pit report identity/revision field is malformed' using errcode = '22023';
  end if;
  if (v_has_questionnaire and jsonb_typeof(p->'pit_questionnaire') not in ('object', 'null'))
     or (v_has_autos and jsonb_typeof(p->'auto_routines') not in ('array', 'null'))
  then
    raise exception 'pit questionnaire or auto routines are malformed' using errcode = '22023';
  end if;
  if v_questionnaire = 'null'::jsonb then v_questionnaire := '{}'::jsonb; end if;
  if v_autos = 'null'::jsonb then v_autos := '[]'::jsonb; end if;
  if jsonb_array_length(v_autos) > 12
     or pg_column_size(v_questionnaire) > 65536
     or pg_column_size(v_autos) > 196608
  then
    raise exception 'pit questionnaire or auto routines exceed their limits' using errcode = '22023';
  end if;

  for auto in select value from jsonb_array_elements(v_autos)
  loop
    if jsonb_typeof(auto) is distinct from 'object'
       or jsonb_typeof(auto->'id') is distinct from 'string'
       or length(auto->>'id') not between 1 and 128
       or length(coalesce(auto->>'description', '')) > 5000
       or (
         auto ? 'estimatedPoints' and auto->'estimatedPoints' <> 'null'::jsonb and (
           jsonb_typeof(auto->'estimatedPoints') is distinct from 'number'
           or (auto->>'estimatedPoints')::numeric not between 0 and 500
         )
       )
       or (
         auto ? 'underTrench' and auto->'underTrench' <> 'null'::jsonb
         and jsonb_typeof(auto->'underTrench') is distinct from 'boolean'
       )
       or (
         auto ? 'overBump' and auto->'overBump' <> 'null'::jsonb
         and jsonb_typeof(auto->'overBump') is distinct from 'boolean'
       )
       or (
         auto ? 'path' and auto->'path' <> 'null'::jsonb and (
           jsonb_typeof(auto->'path') is distinct from 'array'
           or jsonb_array_length(auto->'path') > 256
         )
       )
    then
      raise exception 'pit auto routine is malformed' using errcode = '22023';
    end if;
    if auto->'startPosition' is not null and auto->'startPosition' <> 'null'::jsonb then
      point := auto->'startPosition';
      if jsonb_typeof(point) is distinct from 'object'
         or jsonb_typeof(point->'x') is distinct from 'number'
         or jsonb_typeof(point->'y') is distinct from 'number'
      then
        raise exception 'pit auto start is malformed' using errcode = '22023';
      end if;
    end if;
    if jsonb_typeof(auto->'path') = 'array' then
      for point in select value from jsonb_array_elements(auto->'path')
      loop
        if jsonb_typeof(point) is distinct from 'object'
           or jsonb_typeof(point->'x') is distinct from 'number'
           or jsonb_typeof(point->'y') is distinct from 'number'
        then
          raise exception 'pit auto path point is malformed' using errcode = '22023';
        end if;
      end loop;
    end if;
  end loop;

  v_event_key := p->>'event_key';
  v_team := (p->>'team_number')::int;
  v_incoming_rev := coalesce((p->>'row_revision')::bigint, 1);

  -- Serialize the wrapper's same-revision comparison with the existing core RPC.
  perform pg_advisory_xact_lock(
    hashtextextended('pit_report:' || v_event_key || ':' || v_team::text, 0)
  );
  select * into v_existing
  from public.pit_scouting_report
  where event_key = v_event_key and team_number = v_team;

  v_result := public.upsert_pit_report_pre_questionnaire(p);

  if v_result->>'status' = 'idempotent' and v_existing.event_key is not null then
    if (v_has_questionnaire and v_questionnaire is distinct from v_existing.pit_questionnaire)
       or (v_has_autos and v_autos is distinct from v_existing.auto_routines)
    then
      return jsonb_build_object(
        'status', 'conflict', 'current_revision', v_existing.row_revision
      );
    end if;
  end if;

  if v_result->>'status' = 'applied' then
    update public.pit_scouting_report
    set pit_questionnaire = case when v_has_questionnaire then v_questionnaire else pit_questionnaire end,
        auto_routines = case when v_has_autos then v_autos else auto_routines end
    where event_key = v_event_key
      and team_number = v_team
      and row_revision = v_incoming_rev;
  end if;

  return v_result;
end;
$$;

revoke all on function public.upsert_pit_report(jsonb) from public;
grant execute on function public.upsert_pit_report(jsonb)
  to anon, authenticated, service_role;
comment on function public.upsert_pit_report(jsonb) is
  'Open by product policy. Adds bounded pit questionnaire and multi-auto documents around the revision-safe pit upsert core.';
