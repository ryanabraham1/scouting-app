-- 0020_roster_hide_unify.sql
-- Unifies the two scouter notions the dashboard used to manage separately:
--   1. `scouter_roster` — the persistent, team-scoped name list (NamePicker source).
--   2. `scout` — the per-event rows that reports/assignments FK to.
-- The dashboard's "Roster" and "Performance" sections are now a single panel,
-- and this migration gives that panel two team-wide (all-events) operations plus
-- a soft "hide" so a scouter's history is never lost just to clean up the picker.
--
-- Adds:
--   • scouter_roster.hidden — a hidden scouter keeps every report but disappears
--     from the "Who are you?" picker and from new assignment seeding. Reversible.
--   • set_roster_hidden(name, hidden) — toggle hidden; upserts so a scout-only
--     name (one that exists as a `scout` row but was never on the roster, e.g.
--     "E2E Capture") can still be hidden.
--   • delete_roster_scouter(name) — global delete: removes the roster entry AND
--     every `scout` row with that name across all events, plus their reports /
--     assignments (mirrors delete_scout's dependent cleanup, per matching row).
-- Updates:
--   • seed_event_scouts_from_roster — never seeds hidden names, and never returns
--     a scout whose name matches a hidden roster entry, so hidden scouters are
--     not assignable.

-- 1. The hide flag. Default false keeps every existing scouter visible.
alter table scouter_roster add column if not exists hidden boolean not null default false;

-- 2. Toggle hide. Update-then-insert (rather than ON CONFLICT on the lower(name)
--    expression index) keeps the upsert readable and lets us hide a name that
--    only exists as a `scout` row today.
create or replace function set_roster_hidden(p_name text, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update scouter_roster set hidden = p_hidden where lower(name) = lower(p_name);
  if not found then
    insert into scouter_roster (name, hidden) values (p_name, p_hidden);
  end if;
end;
$$;

grant execute on function set_roster_hidden(text, boolean) to anon, authenticated;

-- 3. Global delete by name. `scout` rows are FK-referenced by
--    match_scouting_report.scout_id (NOT NULL), assignment.scout_id, and
--    pit_scouting_report.author_scout_id (nullable) — so each matching scout's
--    dependents must be removed first, exactly like delete_scout(uuid).
create or replace function delete_roster_scouter(p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scout_id uuid;
begin
  for v_scout_id in
    select id from scout where lower(display_name) = lower(p_name)
  loop
    delete from match_scouting_report where scout_id = v_scout_id;
    delete from assignment where scout_id = v_scout_id;
    update pit_scouting_report set author_scout_id = null where author_scout_id = v_scout_id;
    delete from scout where id = v_scout_id;
  end loop;
  delete from scouter_roster where lower(name) = lower(p_name);
end;
$$;

grant execute on function delete_roster_scouter(text) to anon, authenticated;

-- 4. Re-create the seeder so hidden scouters are neither seeded nor returned.
create or replace function seed_event_scouts_from_roster(p_event_key text)
  returns table (id uuid, display_name text)
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  -- Insert a scout row for each NON-HIDDEN roster name not already at this event.
  insert into scout (event_key, display_name, auth_uid)
  select p_event_key, r.name, gen_random_uuid()
  from scouter_roster r
  where r.hidden = false
    and not exists (
      select 1 from scout s
      where s.event_key = p_event_key
        and lower(s.display_name) = lower(r.name)
    );

  -- Return every event scout EXCEPT those whose name is hidden on the roster,
  -- so the assignment pool never offers a hidden scouter.
  return query
    select s.id, s.display_name
    from scout s
    where s.event_key = p_event_key
      and not exists (
        select 1 from scouter_roster r
        where lower(r.name) = lower(s.display_name)
          and r.hidden = true
      )
    order by s.display_name asc;
end;
$$;

grant execute on function seed_event_scouts_from_roster(text) to anon, authenticated;
