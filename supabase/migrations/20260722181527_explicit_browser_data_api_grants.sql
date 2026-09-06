-- Explicit browser Data API grants for fresh Supabase projects.
--
-- Supabase no longer automatically grants public-schema objects to Data API
-- roles on new projects. Keep this manifest aligned with literal browser
-- `.from()` and `.rpc()` calls under src/. RLS remains the row-level boundary.

-- Remove legacy automatic table privileges first so existing projects converge
-- on the same least-privilege surface as fresh projects.
revoke all privileges on table
  public.assignment,
  public.assignment_batch_revision,
  public.event,
  public.event_secret,
  public.event_team,
  public.match,
  public.match_scouting_report,
  public.matchup_note,
  public.matchup_note_history,
  public.nexus_event_status,
  public.picklist,
  public.pit_assignment,
  public.pit_report_history,
  public.pit_scouting_report,
  public.profile,
  public.scout,
  public.scouter_roster,
  public.strategy_canvas,
  public.team
from anon, authenticated, service_role;

-- Direct browser reads. Every table below has RLS enabled and an intentional
-- anon/authenticated SELECT policy in the existing migrations.
grant select on table
  public.assignment,
  public.event,
  public.event_team,
  public.match,
  public.match_scouting_report,
  public.matchup_note,
  public.nexus_event_status,
  public.picklist,
  public.pit_assignment,
  public.pit_scouting_report,
  public.scout,
  public.scouter_roster,
  public.strategy_canvas,
  public.team
to anon, authenticated;

-- These are the only direct browser table mutations. Report, assignment,
-- canvas, note, event, and roster-hidden mutations stay behind RPCs.
grant insert, delete on table public.scouter_roster to anon, authenticated;
grant insert, update on table public.picklist to anon, authenticated;

-- Direct service-role table access used by Edge Functions. RPC-owned backend
-- writes remain covered by SECURITY DEFINER functions, so they do not require
-- broader table grants here.
grant select on table
  public.event,
  public.event_secret
to service_role;
grant select, insert, update on table public.match to service_role;

-- matchup_note_history is the only public table backed by a sequence. It is
-- private RPC-owned history, so Data API roles need no direct sequence access.
revoke all privileges on sequence public.matchup_note_history_id_seq
  from anon, authenticated, service_role;

-- PostgreSQL grants EXECUTE to PUBLIC on new functions by default, while older
-- migrations also granted anon/authenticated directly on legacy wrappers and
-- destructive helpers. Reset every path first: revoking PUBLIC alone would not
-- remove those direct role grants. service_role remains the trusted backend role
-- for Edge Functions, maintenance helpers, and legacy admin/test operations.
revoke execute on all functions in schema public
  from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- Keep future Data API objects private until a migration adds them to the
-- explicit manifest. Existing projects can retain Supabase's legacy automatic
-- table/function/sequence grants even after current-object ACLs are reset.
-- Supabase migrations are owned by postgres, so set that owner's defaults
-- explicitly rather than relying on project-era platform defaults.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables
  from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences
  from anon, authenticated, service_role;
-- PUBLIC's built-in function EXECUTE default is global. PostgreSQL explicitly
-- documents that a schema-scoped REVOKE cannot remove that global default.
alter default privileges for role postgres
  revoke execute on functions from public;
-- Supabase's automatic Data API role defaults are schema-scoped, so revoke the
-- direct browser-role grants in public separately.
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

-- Exact browser RPC entry points. Legacy non-CAS assignment overloads,
-- delete_scout, join/recovery RPCs, old demo RPCs, scoring helpers, and
-- service-only import/webhook functions intentionally remain ungranted.
grant execute on function public.upsert_match_report(jsonb) to anon, authenticated;
grant execute on function public.upsert_pit_report(jsonb) to anon, authenticated;
grant execute on function public.upsert_matchup_note(jsonb) to anon, authenticated;
grant execute on function public.upsert_strategy_canvas(jsonb) to anon, authenticated;
grant execute on function public.get_assignment_batch_state(text, text) to anon, authenticated;
grant execute on function public.set_assignments(text, jsonb, bigint) to anon, authenticated;
grant execute on function public.set_pit_assignments(text, jsonb, bigint) to anon, authenticated;
grant execute on function public.select_scouter(text, text) to anon, authenticated;
grant execute on function public.seed_event_scouts_from_roster(text) to anon, authenticated;
grant execute on function public.set_roster_hidden(text, boolean) to anon, authenticated;
grant execute on function public.delete_roster_scouter(text) to anon, authenticated;
grant execute on function public.set_active_event(text) to anon, authenticated;
grant execute on function public.delete_event(text) to anon, authenticated;
-- ingest-reports binds the receiver JWT to an anon-key client and calls this
-- membership helper before switching to its service-role client for writes.
grant execute on function public.get_my_event_keys() to anon, authenticated;
