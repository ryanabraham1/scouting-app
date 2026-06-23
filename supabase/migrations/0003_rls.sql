-- 0003_rls.sql — default-deny everywhere; explicit grants below.
alter table event enable row level security;
alter table event_secret enable row level security;
alter table team enable row level security;
alter table event_team enable row level security;
alter table match enable row level security;
alter table scout enable row level security;
alter table profile enable row level security;
alter table assignment enable row level security;
alter table match_scouting_report enable row level security;
alter table pit_scouting_report enable row level security;
alter table pit_report_history enable row level security;

-- event_secret has NO policies -> default deny to anon/authenticated.
-- join_code is therefore never readable by the client; it is only read inside
-- SECURITY DEFINER RPCs (join_event/recover_identity) in 0004.

-- Helper SECURITY DEFINER function: returns the set of event_keys where
-- the current auth.uid() has a scout row.  Bypasses scout RLS so the
-- policies on other tables can call it without infinite recursion.
create or replace function get_my_event_keys()
  returns setof text
  language sql
  security definer
  stable
  set search_path = public
as $$
  select event_key from scout where auth_uid = auth.uid();
$$;

-- Helper SECURITY DEFINER function: returns the set of scout ids owned by the
-- current auth.uid().  Bypasses scout RLS so insert-self WITH CHECK policies are
-- self-contained and do NOT depend on scout_read_member to resolve ownership.
create or replace function get_my_scout_ids()
  returns setof uuid
  language sql
  security definer
  stable
  set search_path = public
as $$
  select id from scout where auth_uid = auth.uid();
$$;

-- Helper: events the current auth.uid() is a member of (via scout row).
-- Inlined as EXISTS in each policy to keep policies self-contained.
-- All policies that reference the scout table use get_my_event_keys()
-- to avoid infinite recursion on the scout table's own RLS.

-- event: readable if caller is a scout in that event.
drop policy if exists event_read_member on event;
create policy event_read_member on event
  for select to authenticated
  using (event.event_key in (select get_my_event_keys()));

-- match: readable for matches in the caller's event.
drop policy if exists match_read_member on match;
create policy match_read_member on match
  for select to authenticated
  using (match.event_key in (select get_my_event_keys()));

-- team: readable if the team participates in any of the caller's events.
drop policy if exists team_read_member on team;
create policy team_read_member on team
  for select to authenticated
  using (exists (
    select 1 from event_team et
    where et.team_number = team.team_number
      and et.event_key in (select get_my_event_keys())
  ));

-- event_team: readable within the caller's event.
drop policy if exists event_team_read_member on event_team;
create policy event_team_read_member on event_team
  for select to authenticated
  using (event_team.event_key in (select get_my_event_keys()));

-- scout: caller can read scout rows in its own event (to see teammates).
-- Uses get_my_event_keys() (SECURITY DEFINER) to avoid self-referential
-- infinite recursion.
drop policy if exists scout_read_member on scout;
create policy scout_read_member on scout
  for select to authenticated
  using (scout.event_key in (select get_my_event_keys()));

-- profile: caller reads only its own profile.
drop policy if exists profile_read_self on profile;
create policy profile_read_self on profile
  for select to authenticated
  using (profile.auth_uid = auth.uid());

-- assignment: readable within the caller's event.
drop policy if exists assignment_read_member on assignment;
create policy assignment_read_member on assignment
  for select to authenticated
  using (assignment.event_key in (select get_my_event_keys()));

-- match_scouting_report: readable within the caller's event.
drop policy if exists msr_read_member on match_scouting_report;
create policy msr_read_member on match_scouting_report
  for select to authenticated
  using (match_scouting_report.event_key in (select get_my_event_keys()));

-- pit_scouting_report: readable within the caller's event.
drop policy if exists pit_read_member on pit_scouting_report;
create policy pit_read_member on pit_scouting_report
  for select to authenticated
  using (pit_scouting_report.event_key in (select get_my_event_keys()));

-- match_scouting_report: anon (authenticated anon user) may INSERT only rows whose
-- scout_id resolves to its own auth.uid() and whose event matches that scout's event.
-- Updates/deletes from the client are NOT granted (server RPC owns mutation).
-- Uses get_my_event_keys() + get_my_scout_ids() (both SECURITY DEFINER) so the
-- WITH CHECK is self-contained and does NOT depend on scout_read_member.
drop policy if exists msr_insert_self on match_scouting_report;
create policy msr_insert_self on match_scouting_report
  for insert to authenticated
  with check (
    match_scouting_report.event_key in (select get_my_event_keys())
    and match_scouting_report.scout_id in (select get_my_scout_ids())
  );

-- pit_scouting_report: insert only as self (author_scout_id resolves to auth.uid()).
drop policy if exists pit_insert_self on pit_scouting_report;
create policy pit_insert_self on pit_scouting_report
  for insert to authenticated
  with check (
    pit_scouting_report.event_key in (select get_my_event_keys())
    and pit_scouting_report.author_scout_id in (select get_my_scout_ids())
  );
