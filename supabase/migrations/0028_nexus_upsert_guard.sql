-- 0028_nexus_upsert_guard.sql
-- Tighten the nexus_upsert_status staleness guard.
--
-- 0027's guard had a hole: `excluded.data_as_of_time is null` meant a push with
-- NO dataAsOfTime (a malformed/timestampless push) ALWAYS wrote, clobbering a
-- fresher timestamped snapshot AND nulling the stored timestamp — after which the
-- next stale push could no longer be ordered. Drop that disjunct so a
-- null-timestamp push only lands when the stored row is itself null/absent (first
-- push), never over a good timestamped one. The snapshot can then only move
-- forward in dataAsOfTime.

create or replace function nexus_upsert_status(
  p_event_key       text,
  p_data_as_of_time bigint,
  p_now_queuing     text,
  p_payload         jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_written boolean := false;
begin
  insert into nexus_event_status (event_key, data_as_of_time, now_queuing, payload, received_at)
  values (p_event_key, p_data_as_of_time, p_now_queuing, p_payload, now())
  on conflict (event_key) do update
    set data_as_of_time = excluded.data_as_of_time,
        now_queuing     = excluded.now_queuing,
        payload         = excluded.payload,
        received_at     = now()
    -- Write only when we don't yet have a timestamp to beat, or the incoming one
    -- is at least as new. A null incoming timestamp no longer forces a write.
    where nexus_event_status.data_as_of_time is null
       or (excluded.data_as_of_time is not null
           and excluded.data_as_of_time >= nexus_event_status.data_as_of_time);
  get diagnostics v_written = row_count;
  return v_written;
end $$;

revoke all on function nexus_upsert_status(text, bigint, text, jsonb) from public;
grant execute on function nexus_upsert_status(text, bigint, text, jsonb) to service_role;
