-- 0043_strategy_phases_robots.sql — phase-keyed whiteboards + robot squares +
-- schedule-less ("manual") boards for the Strategy tab.
--
-- 1. PHASES: one whiteboard per (event, match, PHASE) — auto / transition /
--    active / inactive / endgame — so a strategy meeting can plan each game
--    period on its own board. PK re-keyed to include `phase`; existing 0042
--    rows default to 'auto'.
-- 2. ROBOTS: the auto board carries draggable robot-sized start squares for
--    OUR alliance. Positions live in a `robots` jsonb array of
--    { key, team, x, y, movedAt } (normalized coords, epoch-ms). The RPC
--    merges them PER KEY with the NEWER `movedAt` winning, so two iPads
--    dragging different robots never clobber each other.
-- 3. MANUAL BOARDS: the match FK is DROPPED so a board keyed
--    '__manual__:<phase>' can cloud-sync when there is no schedule yet (the
--    tab must stay fully usable offline/PWA with manually entered teams).
--    Safe: matches are only ever deleted via delete_event, and the event FK
--    (ON DELETE CASCADE, kept) already removes every board with the event —
--    the match FK added nothing but a failure mode for manual keys.
-- Re-apply safe throughout.

alter table strategy_canvas add column if not exists phase text not null default 'auto';
alter table strategy_canvas add column if not exists robots jsonb not null default '[]'::jsonb;

-- Guard against garbage phases (a bad payload would otherwise mint unreachable rows).
alter table strategy_canvas drop constraint if exists strategy_canvas_phase_check;
alter table strategy_canvas add constraint strategy_canvas_phase_check
  check (phase in ('auto', 'transition', 'active', 'inactive', 'endgame'));

alter table strategy_canvas drop constraint if exists strategy_canvas_match_key_fkey;
alter table strategy_canvas drop constraint if exists strategy_canvas_pkey;
alter table strategy_canvas add primary key (event_key, match_key, phase);

-- RPC v2: same name/signature (p jsonb); adds `phase` + `robots` handling on
-- top of 0042's stroke-id merge. Full definition (create-or-replace).
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
  -- Validate the event (mirror 0033: NO membership gate — the dashboard writes
  -- from a scouter-less anon session). Bad keys are a silent no-op, never an
  -- error the outbox would dead-letter.
  if v_event_key is null
     or not exists (select 1 from event e where e.event_key = v_event_key) then
    return;
  end if;
  -- The match key only needs to be a sane non-empty label now (the FK is gone
  -- so '__manual__' boards work); length-capped against garbage accumulation.
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

  -- Row-lock the doc so two concurrent RPCs serialize their merges.
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
        select coalesce(jsonb_agg(s.value order by (s.value->>'seq')::numeric nulls last), '[]'::jsonb)
        from jsonb_array_elements(v_strokes) s
        where not (v_deleted ? (s.value->>'id'))
      ),
      v_deleted, v_robots, v_rev, now(), now()
    );
    return;
  end if;

  -- Tombstone union (distinct string ids).
  select coalesce(jsonb_agg(distinct t.id), '[]'::jsonb) into v_merged_deleted
  from (
    select jsonb_array_elements_text(coalesce(v_existing.deleted_ids, '[]'::jsonb)) as id
    union
    select jsonb_array_elements_text(v_deleted) as id
  ) t;

  -- Stroke merge: incoming wins per id; keep existing strokes the payload
  -- didn't re-send; drop anything tombstoned; ordered by seq.
  select coalesce(jsonb_agg(u.s order by (u.s->>'seq')::numeric nulls last), '[]'::jsonb)
    into v_merged_strokes
  from (
    select i.value as s from jsonb_array_elements(v_strokes) i
    union all
    select e.value as s from jsonb_array_elements(coalesce(v_existing.strokes, '[]'::jsonb)) e
    where not exists (
      select 1 from jsonb_array_elements(v_strokes) i2
      where i2.value->>'id' = e.value->>'id'
    )
  ) u
  where not (v_merged_deleted ? (u.s->>'id'));

  -- Robot merge: per key, the NEWER movedAt wins; keep robots only one side knows.
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
       (select value from jsonb_array_elements(coalesce(v_existing.robots, '[]'::jsonb))) e(value)
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

grant execute on function upsert_strategy_canvas(jsonb) to anon, authenticated;
