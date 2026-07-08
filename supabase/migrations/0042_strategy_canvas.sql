-- 0042_strategy_canvas.sql — per-match strategy whiteboard (Strategy tab).
--
-- One drawing document per (event, match): an array of freehand strokes drawn
-- over the field image during pre-match strategy meetings. Multiple devices
-- (e.g. two coaches' iPads) edit the SAME document concurrently, so the write
-- path is NOT last-write-wins: the SECURITY DEFINER RPC below MERGES strokes by
-- client-generated stroke id and applies erase tombstones (`deleted_ids`), so
-- two simultaneous editors are additive — neither ever clobbers the other's
-- strokes. A tombstoned id is dead forever (an undo-of-erase re-adds the stroke
-- under a FRESH id client-side), which keeps the merge monotonic and idempotent.
--
-- RLS mirrors matchup_note (0033): READ is OPEN to anon + authenticated (the
-- dashboard runs on a scouter-less silent anon session — a member-scoped policy
-- would return nothing to it); there is NO client INSERT/UPDATE/DELETE policy —
-- all writes flow through the RPC.
--
-- Both FKs are ON DELETE CASCADE. CRITICAL: delete_event (0017/0038) does a
-- plain `delete from match where event_key = ...` — a non-cascading match_key FK
-- here would make event deletion throw an FK violation. With cascade, no
-- delete_event change is needed (no history table either).
--
-- Realtime: added to supabase_realtime (0034 pattern) so a second device sees
-- strokes land live during the meeting. Realtime respects the open read policy.
-- Re-apply safe: create-if-not-exists / drop-policy-if-exists / or-replace.

create table if not exists strategy_canvas (
  event_key   text not null references event(event_key) on delete cascade,
  match_key   text not null references match(match_key) on delete cascade,
  -- Array of stroke objects: { id, seq, color, size, points: [[x,y,p], ...] }.
  -- Points are NORMALIZED [0,1] field coords (same convention as auto_path), so
  -- drawings compose with FieldDiagram overlays and survive any render size.
  strokes     jsonb not null default '[]'::jsonb,
  -- Erase tombstones: array of stroke-id strings. Union-merged on every write so
  -- an erase on device A can never be resurrected by a later save from device B.
  deleted_ids jsonb not null default '[]'::jsonb,
  row_revision bigint not null default 1,  -- caller sends local epoch-ms; server keeps greatest()
  updated_at  timestamptz not null default now(),
  server_received_at timestamptz not null default now(),
  primary key (event_key, match_key)
);

create index if not exists idx_strategy_canvas_event on strategy_canvas (event_key);

alter table strategy_canvas enable row level security;

-- READ: OPEN (mirrors matchup_note_read_open — the dashboard reads as anon).
drop policy if exists strategy_canvas_read_open on strategy_canvas;
create policy strategy_canvas_read_open on strategy_canvas
  for select to anon, authenticated
  using (true);

-- No client write policies: all writes flow through the RPC below.

-- SECURITY DEFINER merge-upsert. Unlike upsert_matchup_note's strictly-newer
-- guard (which is right for a single scalar note), a whiteboard is a SET of
-- strokes — so instead of rejecting stale writers we MERGE:
--   * tombstones  = existing.deleted_ids ∪ incoming.deleted_ids
--   * strokes     = incoming ∪ (existing minus ids re-sent by incoming),
--                   minus anything tombstoned; incoming wins per id
--   * row_revision = greatest(existing, incoming)  (change-detection only)
-- Every write is idempotent (re-sending the same payload is a no-op merge), so
-- the offline outbox can retry safely.
create or replace function upsert_strategy_canvas(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text := p->>'event_key';
  v_match_key text := p->>'match_key';
  v_strokes jsonb := coalesce(p->'strokes', '[]'::jsonb);
  v_deleted jsonb := coalesce(p->'deleted_ids', '[]'::jsonb);
  v_rev bigint := coalesce((p->>'row_revision')::bigint, 1);
  v_existing strategy_canvas%rowtype;
  v_merged_deleted jsonb;
  v_merged_strokes jsonb;
begin
  -- Validate existence (mirror 0033: NO membership gate — the dashboard writes
  -- from a scouter-less anon session). A bad key is a silent no-op, never an
  -- FK error the outbox would dead-letter.
  if v_event_key is null
     or not exists (select 1 from event e where e.event_key = v_event_key) then
    return;
  end if;
  if v_match_key is null
     or not exists (
       select 1 from match m
       where m.match_key = v_match_key and m.event_key = v_event_key
     ) then
    return;
  end if;
  if jsonb_typeof(v_strokes) is distinct from 'array' then
    v_strokes := '[]'::jsonb;
  end if;
  if jsonb_typeof(v_deleted) is distinct from 'array' then
    v_deleted := '[]'::jsonb;
  end if;

  -- Row-lock the doc so two concurrent RPCs serialize their merges.
  select * into v_existing
  from strategy_canvas
  where event_key = v_event_key and match_key = v_match_key
  for update;

  if not found then
    -- First write for this match: still honor the payload's own tombstones.
    insert into strategy_canvas (
      event_key, match_key, strokes, deleted_ids, row_revision,
      updated_at, server_received_at
    ) values (
      v_event_key, v_match_key,
      (
        select coalesce(jsonb_agg(s.value order by (s.value->>'seq')::numeric nulls last), '[]'::jsonb)
        from jsonb_array_elements(v_strokes) s
        where not (v_deleted ? (s.value->>'id'))
      ),
      v_deleted, v_rev, now(), now()
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
  -- didn't re-send; drop anything tombstoned. Ordered by seq (client epoch-ms
  -- at stroke creation) so draw order stays stable across merges.
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

  update strategy_canvas set
    strokes = v_merged_strokes,
    deleted_ids = v_merged_deleted,
    row_revision = greatest(v_existing.row_revision, v_rev),
    updated_at = now(),
    server_received_at = now()
  where event_key = v_event_key and match_key = v_match_key;
end;
$$;

grant execute on function upsert_strategy_canvas(jsonb) to anon, authenticated;

-- Realtime (0034 pattern): a second device's strokes land live in the meeting.
alter table strategy_canvas replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'strategy_canvas'
    ) then
      execute 'alter publication supabase_realtime add table strategy_canvas';
    end if;
  end if;
end $$;
