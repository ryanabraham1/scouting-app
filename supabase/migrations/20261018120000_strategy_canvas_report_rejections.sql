-- 20261018120000_strategy_canvas_report_rejections.sql
--
-- upsert_strategy_canvas used to `return;` (void) for an unknown event, a bad
-- match key or an unknown phase. The client outbox only checks for an error, so
-- it marked those whiteboards synced although nothing was stored: the strokes
-- never reached any other device. It now returns a jsonb verdict —
-- {status: 'applied', revision} or {status: 'rejected', reason} — so the outbox
-- can dead-letter a rejected board with its local copy kept for recovery.
-- Merge semantics are unchanged from 20260710165106. Clients built before this
-- migration ignore the return value and keep working.

drop function if exists public.upsert_strategy_canvas(jsonb);

create function public.upsert_strategy_canvas(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text := p->>'event_key';
  v_match_key text := p->>'match_key';
  v_phase text := coalesce(p->>'phase', 'auto');
  v_strokes jsonb := coalesce(p->'strokes', '[]'::jsonb);
  v_deleted jsonb := coalesce(p->'deleted_ids', '[]'::jsonb);
  v_robots jsonb := coalesce(p->'robots', '[]'::jsonb);
  v_rev bigint := coalesce((p->>'row_revision')::bigint, 1);
  v_existing strategy_canvas%rowtype;
  v_merged_deleted jsonb;
  v_merged_strokes jsonb;
  v_merged_robots jsonb;
begin
  if v_event_key is null
     or not exists (select 1 from event e where e.event_key = v_event_key) then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown event');
  end if;
  if v_match_key is null or v_match_key = '' or length(v_match_key) > 64 then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid match key');
  end if;
  if v_phase not in ('auto', 'transition', 'active', 'inactive', 'endgame') then
    return jsonb_build_object('status', 'rejected', 'reason', 'unknown phase');
  end if;
  if jsonb_typeof(v_strokes) is distinct from 'array' then
    v_strokes := '[]'::jsonb;
  end if;
  if jsonb_typeof(v_deleted) is distinct from 'array' then
    v_deleted := '[]'::jsonb;
  end if;
  if jsonb_typeof(v_robots) is distinct from 'array' then
    v_robots := '[]'::jsonb;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'strategy_canvas:' || v_event_key || ':' || v_match_key || ':' || v_phase,
      0
    )
  );

  select * into v_existing
  from strategy_canvas
  where event_key = v_event_key and match_key = v_match_key and phase = v_phase
  for update;

  if not found then
    insert into strategy_canvas (
      event_key, match_key, phase, strokes, deleted_ids, robots, row_revision,
      updated_at, server_received_at
    ) values (
      v_event_key, v_match_key, v_phase,
      (
        select coalesce(
          jsonb_agg(s.value order by (s.value->>'seq')::numeric nulls last),
          '[]'::jsonb
        )
        from jsonb_array_elements(v_strokes) s
        where not (v_deleted ? (s.value->>'id'))
      ),
      v_deleted, v_robots, v_rev, now(), now()
    );
    return jsonb_build_object('status', 'applied', 'revision', v_rev);
  end if;

  select coalesce(jsonb_agg(distinct t.id), '[]'::jsonb)
    into v_merged_deleted
  from (
    select jsonb_array_elements_text(
      coalesce(v_existing.deleted_ids, '[]'::jsonb)
    ) as id
    union
    select jsonb_array_elements_text(v_deleted) as id
  ) t;

  select coalesce(
           jsonb_agg(u.s order by (u.s->>'seq')::numeric nulls last),
           '[]'::jsonb
         )
    into v_merged_strokes
  from (
    select i.value as s from jsonb_array_elements(v_strokes) i
    union all
    select e.value as s
    from jsonb_array_elements(coalesce(v_existing.strokes, '[]'::jsonb)) e
    where not exists (
      select 1 from jsonb_array_elements(v_strokes) i2
      where i2.value->>'id' = e.value->>'id'
    )
  ) u
  where not (v_merged_deleted ? (u.s->>'id'));

  select coalesce(jsonb_agg(
           case
             when i.value is null then e.value
             when e.value is null then i.value
             when coalesce((i.value->>'movedAt')::numeric, 0)
                  >= coalesce((e.value->>'movedAt')::numeric, 0) then i.value
             else e.value
           end), '[]'::jsonb)
    into v_merged_robots
  from (select value from jsonb_array_elements(v_robots)) i(value)
  full outer join
       (select value
        from jsonb_array_elements(coalesce(v_existing.robots, '[]'::jsonb))) e(value)
    on i.value->>'key' = e.value->>'key';

  update strategy_canvas set
    strokes = v_merged_strokes,
    deleted_ids = v_merged_deleted,
    robots = v_merged_robots,
    row_revision = greatest(v_existing.row_revision, v_rev),
    updated_at = now(),
    server_received_at = now()
  where event_key = v_event_key and match_key = v_match_key and phase = v_phase;

  return jsonb_build_object(
    'status', 'applied',
    'revision', greatest(v_existing.row_revision, v_rev)
  );
end;
$$;

revoke all on function public.upsert_strategy_canvas(jsonb) from public;
grant execute on function public.upsert_strategy_canvas(jsonb) to anon, authenticated, service_role;
