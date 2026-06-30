-- 0031_upsert_pit_report.sql — give pit reports the same monotonic write guard +
-- history snapshot the match path has, so a stale resync can't clobber newer data.
--
-- BUG (data loss): pit reports were written with a direct PostgREST .upsert() on PK
-- (event_key, team_number) (pitStore.upsertPitRow), with row_revision omitted, every
-- field always sent, and 0021's check(true) RLS — i.e. pure last-write-wins with no
-- concurrency control and NO bump trigger. A device flushing an OLDER queued/offline
-- pit report overwrites a newer one another scouter uploaded for the same team,
-- blanking vision/batteries/preferred-auto/dimensions, with no pit_report_history
-- snapshot to recover from.
--
-- FIX: route pit writes through this SECURITY DEFINER RPC. The client now sends
-- row_revision = the report's local updatedAt epoch-ms (monotonic with edit time, so
-- it is comparable ACROSS authors unlike a per-author counter). The server writes
-- only when the incoming revision is STRICTLY NEWER than the stored one; a stale
-- (older) resync is a no-op, and an idempotent re-send (equal) is a no-op too (no
-- history spam). Before any overwrite the prior row is snapshotted into
-- pit_report_history. author_scout_id is resolved defensively (nulled if the scout
-- row was consolidated away) so it can never FK-fail the whole upsert.

create or replace function upsert_pit_report(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text := p->>'event_key';
  v_team int := (p->>'team_number')::int;
  v_incoming_rev bigint := coalesce((p->>'row_revision')::bigint, 1);
  v_existing_rev bigint;
  v_author uuid := nullif(p->>'author_scout_id', '')::uuid;
begin
  -- Author is advisory and the row is keyed by team — never let an orphaned
  -- author_scout_id (deleted by select_scouter consolidation) FK-fail the write.
  if v_author is not null and not exists (select 1 from scout s where s.id = v_author) then
    v_author := null;
  end if;

  select row_revision into v_existing_rev
  from pit_scouting_report
  where event_key = v_event_key and team_number = v_team;

  -- Stale OR duplicate resync: do not clobber a newer/equal report (this is the fix).
  if v_existing_rev is not null and v_incoming_rev <= v_existing_rev then
    return;
  end if;

  if v_existing_rev is null then
    insert into pit_scouting_report (
      event_key, team_number, drivetrain, mechanisms, capabilities, vision_system,
      batteries, preferred_auto_start_position, preferred_auto_path, match_strategy,
      robot_dimensions, photo_path, notes, author_scout_id, row_revision,
      updated_at, server_received_at, deleted
    ) values (
      v_event_key, v_team,
      p->>'drivetrain',
      coalesce(p->'mechanisms', '[]'::jsonb),
      p->'capabilities',
      p->>'vision_system',
      p->'batteries',
      p->'preferred_auto_start_position',
      p->'preferred_auto_path',
      coalesce(p->'match_strategy', '[]'::jsonb),
      p->'robot_dimensions',
      p->>'photo_path',
      p->>'notes',
      v_author,
      v_incoming_rev,
      now(), now(), false
    );
  else
    -- Snapshot the prior row so an overwrite is always recoverable.
    insert into pit_report_history (event_key, team_number, snapshot)
    select v_event_key, v_team, to_jsonb(psr)
    from pit_scouting_report psr
    where psr.event_key = v_event_key and psr.team_number = v_team;

    update pit_scouting_report set
      drivetrain = p->>'drivetrain',
      mechanisms = coalesce(p->'mechanisms', '[]'::jsonb),
      capabilities = p->'capabilities',
      vision_system = p->>'vision_system',
      batteries = p->'batteries',
      preferred_auto_start_position = p->'preferred_auto_start_position',
      preferred_auto_path = p->'preferred_auto_path',
      match_strategy = coalesce(p->'match_strategy', '[]'::jsonb),
      robot_dimensions = p->'robot_dimensions',
      photo_path = p->>'photo_path',
      notes = p->>'notes',
      author_scout_id = v_author,
      row_revision = v_incoming_rev,
      updated_at = now(),
      server_received_at = now(),
      deleted = false
    where event_key = v_event_key and team_number = v_team;
  end if;
end;
$$;

grant execute on function upsert_pit_report(jsonb) to anon, authenticated;
