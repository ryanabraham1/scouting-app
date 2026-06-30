-- 0033_matchup_notes_table.sql — per-opponent matchup notes (Strategy/coaching).
-- One free-text note per (event, our-alliance-lead, their-alliance-lead). Event-scoped.
-- RLS mirrors the EFFECTIVE msr/pit read path (0009 `msr_read_open`/`pit_read_open`),
-- NOT the 0003 `*_read_member` policies. CRITICAL: the dashboard authors+reads these
-- notes from a SILENT ANONYMOUS session (ensureAnonSession.ts) that never picks a
-- scouter, so it has NO scout row and `get_my_event_keys()` returns EMPTY for it. A
-- member-scoped read policy would therefore return ZERO notes to the dashboard, and a
-- member-gated RPC would silently no-op every write — exactly the bug 0009 fixed when
-- it added the open `to anon, authenticated using (true)` read policies. So: READ is
-- OPEN (single-team internal app, scouting data is openly readable). WRITES go ONLY
-- through the SECURITY DEFINER upsert RPC (granted anon+authenticated, bypasses RLS)
-- with the monotonic row_revision guard + history snapshot, exactly like
-- upsert_pit_report (0031) — which itself has NO event-membership gate. Re-apply safe:
-- create-if-not-exists / drop-policy-if-exists.

create table if not exists matchup_note (
  event_key   text   not null references event(event_key) on delete cascade,
  our_team    int    not null,
  opp_team    int    not null,
  note        text   not null default '',
  row_revision bigint not null default 1,   -- caller sends local updatedAt epoch-ms (monotonic across authors)
  updated_at  timestamptz not null default now(),
  server_received_at timestamptz not null default now(),
  author_scout_id uuid,                      -- advisory; nulled if orphaned (never FK-fails the write)
  deleted     boolean not null default false,
  primary key (event_key, our_team, opp_team)
);

-- History so any overwrite is recoverable (mirrors pit_report_history).
create table if not exists matchup_note_history (
  id         bigint generated always as identity primary key,
  event_key  text not null,
  our_team   int  not null,
  opp_team   int  not null,
  snapshot   jsonb not null,
  archived_at timestamptz not null default now()
);

-- Lookup by either side of the pairing for fast resurfacing.
create index if not exists idx_matchup_note_event_our on matchup_note (event_key, our_team);
create index if not exists idx_matchup_note_event_opp on matchup_note (event_key, opp_team);

alter table matchup_note enable row level security;
alter table matchup_note_history enable row level security;

-- READ: OPEN to anon + authenticated, mirroring 0009's msr_read_open/pit_read_open.
-- (The dashboard reads as a scouter-less anon session; a member-scoped read would
-- return nothing to it. Single-team internal app => scouting data is openly readable.)
drop policy if exists matchup_note_read_open on matchup_note;
create policy matchup_note_read_open on matchup_note
  for select to anon, authenticated
  using (true);

-- No client INSERT/UPDATE/DELETE policy: all writes flow through the RPC below.
-- history has NO policies -> default deny to the client (only the SECURITY DEFINER RPC writes it).

-- SECURITY DEFINER upsert with the monotonic revision guard + history snapshot.
-- Mirrors upsert_pit_report (0031) exactly: write only when strictly newer; equal/stale = no-op.
create or replace function upsert_matchup_note(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text   := p->>'event_key';
  v_our int          := (p->>'our_team')::int;
  v_opp int          := (p->>'opp_team')::int;
  v_note text        := coalesce(p->>'note', '');
  v_incoming_rev bigint := coalesce((p->>'row_revision')::bigint, 1);
  v_existing_rev bigint;
  v_author uuid      := nullif(p->>'author_scout_id', '')::uuid;
begin
  -- Defense-in-depth: validate the event EXISTS rather than gating on a scout-row-
  -- derived membership. The dashboard authors notes from a scouter-less anon session,
  -- so `get_my_event_keys()` is EMPTY for it — a membership gate here would silently
  -- no-op EVERY dashboard write (data loss, and the outbox would even mark it synced
  -- because the RPC returns void). upsert_pit_report (the RPC we mirror) has no such
  -- gate for exactly this reason. We validate event existence only.
  if v_event_key is null or not exists (select 1 from event e where e.event_key = v_event_key) then
    return;
  end if;

  -- Author is advisory — never let an orphaned scout id FK/consistency-fail the write.
  if v_author is not null and not exists (select 1 from scout s where s.id = v_author) then
    v_author := null;
  end if;

  select row_revision into v_existing_rev
  from matchup_note
  where event_key = v_event_key and our_team = v_our and opp_team = v_opp;

  -- Stale OR duplicate resync: do not clobber a newer/equal note (the data-loss guard).
  if v_existing_rev is not null and v_incoming_rev <= v_existing_rev then
    return;
  end if;

  if v_existing_rev is null then
    insert into matchup_note (
      event_key, our_team, opp_team, note, row_revision,
      updated_at, server_received_at, author_scout_id, deleted
    ) values (
      v_event_key, v_our, v_opp, v_note, v_incoming_rev,
      now(), now(), v_author, false
    );
  else
    insert into matchup_note_history (event_key, our_team, opp_team, snapshot)
    select v_event_key, v_our, v_opp, to_jsonb(mn)
    from matchup_note mn
    where mn.event_key = v_event_key and mn.our_team = v_our and mn.opp_team = v_opp;

    update matchup_note set
      note = v_note,
      row_revision = v_incoming_rev,
      updated_at = now(),
      server_received_at = now(),
      author_scout_id = v_author,
      deleted = false
    where event_key = v_event_key and our_team = v_our and opp_team = v_opp;
  end if;
end;
$$;

grant execute on function upsert_matchup_note(jsonb) to anon, authenticated;
