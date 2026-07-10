-- Data-audit backend hardening.
--
-- This migration intentionally uses a timestamp later than
-- 20260710020057_shared_pit_crews.sql. That migration is already deployed, so a
-- conventional 0046 filename would sort before it and break fresh-install order.

-- ---------------------------------------------------------------------------
-- Active event: one row at most, narrow RPC-only writes, validated target.
-- ---------------------------------------------------------------------------

-- Repair an already-invalid state deterministically before adding the invariant.
do $$
begin
  lock table event in share row exclusive mode;
  with keep as (
    select event_key
    from event
    where is_active
    order by imported_at desc nulls last, event_key
    limit 1
  )
  update event e
  set is_active = false
  where e.is_active
    and e.event_key is distinct from (select event_key from keep);
end;
$$;

create unique index if not exists event_single_active_idx
  on event ((true))
  where is_active;

drop policy if exists event_update_open on event;
revoke update on table event from anon, authenticated;

create or replace function set_active_event(p_event_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Serialize selectors, and validate before changing the current authority.
  lock table event in share row exclusive mode;

  if not exists (select 1 from event where event_key = p_event_key) then
    raise exception 'event not found: %', p_event_key using errcode = '23503';
  end if;

  -- Two statements are safe inside this transaction: concurrent readers cannot
  -- observe the intermediate state, and the partial unique index is never
  -- transiently violated while moving the singleton.
  update event
     set is_active = false
   where is_active
     and event_key <> p_event_key;

  update event
     set is_active = true
   where event_key = p_event_key
     and not is_active;
end;
$$;

revoke all on function set_active_event(text) from public;
grant execute on function set_active_event(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Matchup notes: serialize first insert, return an explicit sync disposition.
-- ---------------------------------------------------------------------------

drop function upsert_matchup_note(jsonb);

create function upsert_matchup_note(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text := p->>'event_key';
  v_our int := (p->>'our_team')::int;
  v_opp int := (p->>'opp_team')::int;
  v_note text := coalesce(p->>'note', '');
  v_incoming_rev bigint := coalesce((p->>'row_revision')::bigint, 1);
  v_existing matchup_note%rowtype;
  v_author uuid := nullif(p->>'author_scout_id', '')::uuid;
begin
  if v_event_key is null
     or not exists (select 1 from event e where e.event_key = v_event_key) then
    raise exception 'matchup note event is invalid' using errcode = '23503';
  end if;

  if v_our is null or v_opp is null then
    raise exception 'matchup note teams are required' using errcode = '22023';
  end if;

  if v_author is not null
     and not exists (select 1 from scout s where s.id = v_author) then
    v_author := null;
  end if;

  -- FOR UPDATE cannot lock a missing row. The advisory key serializes both the
  -- first insert and all later updates for this exact namespace.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'matchup_note:' || v_event_key || ':' || v_our::text || ':' || v_opp::text,
      0
    )
  );

  select * into v_existing
  from matchup_note
  where event_key = v_event_key and our_team = v_our and opp_team = v_opp
  for update;

  if not found then
    insert into matchup_note (
      event_key, our_team, opp_team, note, row_revision,
      updated_at, server_received_at, author_scout_id, deleted
    ) values (
      v_event_key, v_our, v_opp, v_note, v_incoming_rev,
      now(), now(), v_author, false
    );
    return jsonb_build_object(
      'status', 'applied',
      'current_revision', v_incoming_rev
    );
  end if;

  if v_incoming_rev < v_existing.row_revision then
    return jsonb_build_object(
      'status', 'stale',
      'current_revision', v_existing.row_revision
    );
  end if;

  if v_incoming_rev = v_existing.row_revision then
    if v_note = v_existing.note and not v_existing.deleted then
      return jsonb_build_object(
        'status', 'applied',
        'current_revision', v_existing.row_revision,
        'idempotent', true
      );
    end if;
    return jsonb_build_object(
      'status', 'conflict',
      'current_revision', v_existing.row_revision
    );
  end if;

  insert into matchup_note_history (event_key, our_team, opp_team, snapshot)
  values (v_event_key, v_our, v_opp, to_jsonb(v_existing));

  update matchup_note set
    note = v_note,
    row_revision = v_incoming_rev,
    updated_at = now(),
    server_received_at = now(),
    author_scout_id = v_author,
    deleted = false
  where event_key = v_event_key and our_team = v_our and opp_team = v_opp;

  return jsonb_build_object(
    'status', 'applied',
    'current_revision', v_incoming_rev
  );
end;
$$;

revoke all on function upsert_matchup_note(jsonb) from public;
grant execute on function upsert_matchup_note(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Pit reports: preserve omitted photos and serialize first inserts.
-- ---------------------------------------------------------------------------

create or replace function upsert_pit_report(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text := p->>'event_key';
  v_team int := (p->>'team_number')::int;
  v_incoming_rev bigint := coalesce((p->>'row_revision')::bigint, 1);
  v_has_base boolean := p ? 'base_revision';
  v_base_rev bigint := nullif(p->>'base_revision', '')::bigint;
  v_existing pit_scouting_report%rowtype;
  v_author uuid := nullif(p->>'author_scout_id', '')::uuid;
  v_has_photos boolean := p ? 'photos';
  v_photos jsonb := p->'photos';
begin
  if v_event_key is null
    or not exists (select 1 from event e where e.event_key = v_event_key)
    or not exists (
      select 1 from event_team et
      where et.event_key = v_event_key and et.team_number = v_team
    )
  then
    raise exception 'pit report event/team is invalid' using errcode = '23503';
  end if;

  if v_has_photos
     and (jsonb_typeof(v_photos) <> 'array' or jsonb_array_length(v_photos) > 6) then
    raise exception 'pit report photos must be an array of at most 6 items'
      using errcode = '22023';
  end if;

  if v_author is not null
    and not exists (
      select 1 from scout s
      where s.id = v_author and s.event_key = v_event_key
    )
  then
    v_author := null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('pit_report:' || v_event_key || ':' || v_team::text, 0)
  );

  select * into v_existing
  from pit_scouting_report
  where event_key = v_event_key and team_number = v_team
  for update;

  if not found then
    if v_has_base and v_base_rev is not null then
      return jsonb_build_object('status', 'conflict', 'current_revision', null);
    end if;

    insert into pit_scouting_report (
      event_key, team_number, drivetrain, mechanisms, capabilities, vision_system,
      batteries, preferred_auto_start_position, preferred_auto_path, match_strategy,
      robot_dimensions, photos, photo_path, notes, author_scout_id, row_revision,
      updated_at, server_received_at, deleted
    ) values (
      v_event_key, v_team,
      p->>'drivetrain',
      coalesce(p->'mechanisms', '[]'::jsonb),
      coalesce(p->'capabilities', '[]'::jsonb),
      p->>'vision_system',
      p->'batteries',
      p->'preferred_auto_start_position',
      p->'preferred_auto_path',
      coalesce(p->'match_strategy', '[]'::jsonb),
      p->'robot_dimensions',
      coalesce(v_photos, '[]'::jsonb),
      case
        when v_has_photos then v_photos->0->>'path'
        else p->>'photo_path'
      end,
      p->>'notes',
      v_author,
      v_incoming_rev,
      now(), now(), false
    );

    return jsonb_build_object(
      'status', 'applied',
      'revision', v_incoming_rev
    );
  end if;

  if v_existing.row_revision = v_incoming_rev then
    return jsonb_build_object(
      'status', 'applied',
      'revision', v_existing.row_revision,
      'idempotent', true
    );
  end if;

  if v_has_base and v_base_rev is distinct from v_existing.row_revision then
    return jsonb_build_object(
      'status', 'conflict',
      'current_revision', v_existing.row_revision
    );
  end if;

  if not v_has_base and v_incoming_rev < v_existing.row_revision then
    return jsonb_build_object(
      'status', 'stale',
      'current_revision', v_existing.row_revision
    );
  end if;

  if v_incoming_rev <= v_existing.row_revision then
    raise exception 'new pit report revision must be greater than the loaded revision'
      using errcode = '22023';
  end if;

  insert into pit_report_history (event_key, team_number, snapshot)
  values (v_event_key, v_team, to_jsonb(v_existing));

  update pit_scouting_report set
    drivetrain = p->>'drivetrain',
    mechanisms = coalesce(p->'mechanisms', '[]'::jsonb),
    capabilities = coalesce(p->'capabilities', '[]'::jsonb),
    vision_system = p->>'vision_system',
    batteries = p->'batteries',
    preferred_auto_start_position = p->'preferred_auto_start_position',
    preferred_auto_path = p->'preferred_auto_path',
    match_strategy = coalesce(p->'match_strategy', '[]'::jsonb),
    robot_dimensions = p->'robot_dimensions',
    photos = case when v_has_photos then v_photos else v_existing.photos end,
    photo_path = case
      when v_has_photos then v_photos->0->>'path'
      else v_existing.photo_path
    end,
    notes = p->>'notes',
    author_scout_id = v_author,
    row_revision = v_incoming_rev,
    updated_at = now(),
    server_received_at = now(),
    deleted = false
  where event_key = v_event_key and team_number = v_team;

  return jsonb_build_object('status', 'applied', 'revision', v_incoming_rev);
end;
$$;

revoke all on function upsert_pit_report(jsonb) from public;
grant execute on function upsert_pit_report(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Complete pit-assignment replacement: serialize publishers per event.
-- ---------------------------------------------------------------------------

create or replace function set_pit_assignments(
  p_event_key text,
  p_assignments jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not exists (select 1 from event where event_key = p_event_key) then
    raise exception 'event not found' using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('pit_assignments:' || p_event_key, 0)
  );

  delete from pit_assignment where event_key = p_event_key;

  insert into pit_assignment (event_key, team_number, scout_id, source)
  select distinct on (team_number, scout_id)
    p_event_key,
    team_number,
    scout_id,
    source
  from (
    select
      (elem->>'team_number')::int as team_number,
      (elem->>'scout_id')::uuid as scout_id,
      case when elem->>'source' = 'auto' then 'auto' else 'manual' end as source,
      ordinality
    from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb))
      with ordinality as input(elem, ordinality)
    where nullif(elem->>'scout_id', '') is not null
      and nullif(elem->>'team_number', '') is not null
  ) parsed
  where exists (
    select 1
    from event_team et
    where et.event_key = p_event_key
      and et.team_number = parsed.team_number
  )
    and exists (
      select 1
      from scout s
      where s.event_key = p_event_key
        and s.id = parsed.scout_id
  )
  order by team_number, scout_id, ordinality desc;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function set_pit_assignments(text, jsonb) from public;
grant execute on function set_pit_assignments(text, jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Strategy canvas: serialize the missing-row path as well as existing rows.
-- ---------------------------------------------------------------------------

create or replace function upsert_strategy_canvas(p jsonb)
returns void
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
    return;
  end if;
  if v_match_key is null or v_match_key = '' or length(v_match_key) > 64 then
    return;
  end if;
  if v_phase not in ('auto', 'transition', 'active', 'inactive', 'endgame') then
    return;
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
    return;
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
end;
$$;

revoke all on function upsert_strategy_canvas(jsonb) from public;
grant execute on function upsert_strategy_canvas(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Qualitative ratings: schema v1 is the old 1-3 ordinal; v2 is literal 1-10.
-- ---------------------------------------------------------------------------

create or replace function normalize_qualitative_ratings()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.schema_version < 2 then
    if tg_op = 'INSERT' or new.defense_rating is distinct from old.defense_rating then
      new.defense_rating := case new.defense_rating
        when 1 then 3 when 2 then 7 when 3 then 10 else new.defense_rating end;
    end if;
    if tg_op = 'INSERT' or new.driver_skill is distinct from old.driver_skill then
      new.driver_skill := case new.driver_skill
        when 1 then 3 when 2 then 7 when 3 then 10 else new.driver_skill end;
    end if;
    if tg_op = 'INSERT' or new.agility is distinct from old.agility then
      new.agility := case new.agility
        when 1 then 3 when 2 then 7 when 3 then 10 else new.agility end;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_normalize_qualitative_ratings
  on match_scouting_report;
create trigger trg_normalize_qualitative_ratings
  before insert or update on match_scouting_report
  for each row execute function normalize_qualitative_ratings();

notify pgrst, 'reload schema';
