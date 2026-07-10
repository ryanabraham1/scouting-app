-- Allow a team to have a shared pit crew while preserving one report per
-- (event, team). Each scout may appear at most once on a team's crew.
alter table pit_assignment
  drop constraint pit_assignment_pkey,
  add constraint pit_assignment_pkey
    primary key (event_key, team_number, scout_id);

-- Publishing remains a complete, atomic replacement for the event. Duplicate
-- payload entries for the same team/scout collapse to the last entry so retries
-- and UI mistakes cannot create duplicate crew memberships.
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
grant execute on function set_pit_assignments(text, jsonb) to anon, authenticated;
