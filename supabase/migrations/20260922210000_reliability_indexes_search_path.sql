-- 20260922210000_reliability_indexes_search_path.sql
--
-- Low-risk hardening surfaced by the Supabase advisors (2026-09-22). No data or
-- behaviour changes.
--
-- 1. The dashboard's incremental reports refetch (useEventReports) runs on
--    every realtime tick during a match:
--        where event_key = $1 and server_received_at >= $2
--    It was served by idx_msr_event_match (event_key prefix) plus a filter over
--    every report in the event. Index the exact predicate so the per-tick pull
--    stays an index range scan as an event (and a season) accumulates reports.
create index if not exists idx_msr_event_received
  on public.match_scouting_report (event_key, server_received_at);

-- 2. Cover msr_event_team_fkey (event_key, target_team_number) so removing a
--    team from an event's roster, and per-team report reads, never scan the
--    whole reports table.
create index if not exists idx_msr_event_target_team
  on public.match_scouting_report (event_key, target_team_number);

-- 3. Pin search_path on the two pure scoring helpers the recompute calls
--    (advisor: function_search_path_mutable). They reference only pg_catalog
--    built-ins, which are always resolvable with an empty search_path.
alter function public.msr_round_half_up(numeric) set search_path = '';
alter function public.msr_is_inactive(integer, boolean) set search_path = '';
