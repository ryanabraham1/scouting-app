-- Repair runtime resolution defects found by post-deploy plpgsql_check.
-- Keep the original hardening migration immutable now that it is deployed.

alter function public.promote_event_import(jsonb, jsonb, jsonb, boolean)
  set search_path = pg_catalog, public, extensions;
alter function public.replace_demo_event_bundle(jsonb)
  set search_path = pg_catalog, public, extensions;

create or replace function public.seed_event_scouts_from_roster(p_event_key text)
returns table (id uuid, display_name text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  roster_row record;
begin
  perform pg_advisory_xact_lock_shared(
    hashtextextended('event_write:' || coalesce(p_event_key, ''), 0)
  );
  if not exists (
    select 1 from public.event e where e.event_key = p_event_key
  ) then
    raise exception 'event not found' using errcode = '23503';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('seed_event_scouts:' || p_event_key, 0)
  );

  for roster_row in
    select distinct on (lower(btrim(roster.name)))
      btrim(roster.name) as display_name
    from public.scouter_roster roster
    where not roster.hidden and btrim(roster.name) <> ''
    order by lower(btrim(roster.name)), roster.name
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(
        'scout_name:' || p_event_key || ':' || lower(roster_row.display_name),
        0
      )
    );
    insert into public.scout (event_key, display_name, auth_uid)
    values (p_event_key, roster_row.display_name, gen_random_uuid())
    on conflict do nothing;
  end loop;

  return query
  select s.id, s.display_name
  from public.scout s
  where s.event_key = p_event_key
    and not exists (
      select 1
      from public.scouter_roster hidden_roster
      where lower(btrim(hidden_roster.name)) =
            lower(btrim(s.display_name))
        and hidden_roster.hidden
    )
  order by s.display_name, s.id;
end;
$$;

revoke all on function public.seed_event_scouts_from_roster(text) from public;
grant execute on function public.seed_event_scouts_from_roster(text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
