-- 20261019120000_board_records.sql — Ryan's Board (lead dashboard infinite canvas).
--
-- One board per event; one ROW per canvas record (ink stroke, text, image,
-- widget) so two devices editing different things never conflict and a moved
-- shape sends one small row. Plan: docs/plans/ryans-board/README.md §8.
--
-- Merge rule (mirrors src/dash/board/model.ts recordWins): per record, the
-- higher `rev` wins; equal revs break on `client_id`. Deletes are tombstones
-- (deleted = true) with their own rev, so a later undo re-creates the record
-- simply by writing it at a newer rev. The RPC is idempotent: re-sending a
-- record never changes anything unless it is newer.
--
-- RLS mirrors strategy_canvas (0042): READ is open to anon + authenticated
-- (the dashboard runs on a silent anon session); there are no client write
-- policies — every write goes through the SECURITY DEFINER RPC.
--
-- FK is ON DELETE CASCADE so delete_event needs no change.
-- Realtime: published (the realtime-publication gotcha: one unpublished table
-- on a multi-binding channel silently kills every binding on it).

create table if not exists board_record (
  board_key  text not null references event(event_key) on delete cascade,
  record_id  text not null,
  data       jsonb not null,
  rev        bigint not null,
  client_id  text not null,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (board_key, record_id)
);

create index if not exists idx_board_record_board_rev on board_record (board_key, rev);

alter table board_record enable row level security;

drop policy if exists board_record_read_open on board_record;
create policy board_record_read_open on board_record
  for select to anon, authenticated
  using (true);

-- Merge-upsert a batch of records for one board.
-- Returns { ok, accepted, stale, rejected: [record ids] }.
create or replace function upsert_board_records(p_board_key text, p_records jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  v_id text;
  v_rev bigint;
  v_by text;
  v_accepted int := 0;
  v_stale int := 0;
  v_rejected text[] := '{}';
  v_rows int;
begin
  if p_board_key is null or not exists (select 1 from event where event_key = p_board_key) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_event');
  end if;
  if jsonb_typeof(coalesce(p_records, '[]'::jsonb)) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'bad_payload');
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_records, '[]'::jsonb)) loop
    v_id := r->>'id';
    v_by := r->>'by';
    begin
      v_rev := (r->>'rev')::bigint;
    exception when others then
      v_rev := null;
    end;
    if v_id is null or length(v_id) > 80 or v_by is null or length(v_by) > 80
       or v_rev is null or octet_length(r::text) > 1500000 then
      v_rejected := array_append(v_rejected, coalesce(left(v_id, 80), ''));
      continue;
    end if;

    insert into board_record as b (board_key, record_id, data, rev, client_id, deleted, updated_at)
    values (p_board_key, v_id, r, v_rev, v_by, coalesce((r->>'deleted')::boolean, false), now())
    on conflict (board_key, record_id) do update
      set data = excluded.data,
          rev = excluded.rev,
          client_id = excluded.client_id,
          deleted = excluded.deleted,
          updated_at = now()
      where (excluded.rev, excluded.client_id) > (b.rev, b.client_id);
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      v_accepted := v_accepted + 1;
    else
      v_stale := v_stale + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'accepted', v_accepted,
    'stale', v_stale,
    'rejected', to_jsonb(v_rejected)
  );
end;
$$;

revoke all on function upsert_board_records(text, jsonb) from public;
grant execute on function upsert_board_records(text, jsonb) to anon, authenticated;

-- Realtime.
alter table board_record replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'board_record'
    ) then
      execute 'alter publication supabase_realtime add table board_record';
    end if;
  end if;
end $$;

-- Board images: public-read bucket, open anon writes (login-less model,
-- matching the pit-photos policies of 20260920180000). Paths: <board>/<shape>.webp
insert into storage.buckets (id, name, public)
values ('board-assets', 'board-assets', true)
on conflict (id) do nothing;

drop policy if exists board_assets_select on storage.objects;
drop policy if exists board_assets_insert on storage.objects;
drop policy if exists board_assets_update on storage.objects;

create policy board_assets_select on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'board-assets');

create policy board_assets_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'board-assets');

create policy board_assets_update on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'board-assets')
  with check (bucket_id = 'board-assets');
