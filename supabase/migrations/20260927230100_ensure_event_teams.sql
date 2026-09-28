-- ensure_event_teams: add teams TBA's match data names to an event after import.
--
-- match.red1..blue3 reference event_team(event_key, team_number), and event_team
-- is only filled by the one-time promote_event_import. A team TBA adds to the
-- event later (late registration, a swap, a regenerated schedule) failed that FK
-- on every match write — and sync-event-results upserts in bulk, so one such
-- team froze the whole event's schedule and results. Scout and pit reports for
-- the team then dead-lettered on msr_event_team_fkey / pit_report_event_team_fkey.
--
-- Called by the sync-event-results / tba-webhook Edge Functions (service role)
-- right before they write match rows. Idempotent; existing team rows keep their
-- nickname (a missing one is filled in). Returns the team numbers newly added to
-- the event. Service-role only, like promote_event_import.

create or replace function public.ensure_event_teams(p_event_key text, p_teams jsonb)
returns int[]
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_added int[];
begin
  if p_teams is null or jsonb_typeof(p_teams) is distinct from 'array' then
    raise exception 'p_teams must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_teams) > 200 then
    raise exception 'too many teams' using errcode = '22023';
  end if;
  if not exists (select 1 from public.event e where e.event_key = p_event_key) then
    raise exception 'event does not exist' using errcode = '23503';
  end if;

  -- Validated, de-duplicated input: one row per team, a supplied nickname wins.
  insert into public.team (team_number, nickname)
  select distinct on (i.team_number) i.team_number, i.nickname
  from (
    select (t.value->>'team_number')::int as team_number,
           nullif(left(btrim(t.value->>'nickname'), 256), '') as nickname
    from jsonb_array_elements(p_teams) t
    where jsonb_typeof(t.value) = 'object'
      and jsonb_typeof(t.value->'team_number') = 'number'
      and (t.value->>'team_number')::numeric = trunc((t.value->>'team_number')::numeric)
      and (t.value->>'team_number')::numeric between 1 and 999999
  ) i
  order by i.team_number, i.nickname nulls last
  on conflict (team_number) do update
    set nickname = excluded.nickname
    where public.team.nickname is null and excluded.nickname is not null;

  with added as (
    insert into public.event_team (event_key, team_number)
    select distinct p_event_key, (t.value->>'team_number')::int
    from jsonb_array_elements(p_teams) t
    where jsonb_typeof(t.value) = 'object'
      and jsonb_typeof(t.value->'team_number') = 'number'
      and (t.value->>'team_number')::numeric = trunc((t.value->>'team_number')::numeric)
      and (t.value->>'team_number')::numeric between 1 and 999999
    on conflict (event_key, team_number) do nothing
    returning team_number
  )
  select coalesce(array_agg(team_number order by team_number), '{}'::int[])
  into v_added
  from added;

  return v_added;
end;
$$;

revoke all on function public.ensure_event_teams(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ensure_event_teams(text, jsonb) to service_role;
