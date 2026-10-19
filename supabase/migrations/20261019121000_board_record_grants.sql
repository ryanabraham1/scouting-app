-- 20261019121000_board_record_grants.sql
-- Explicit Data API grants for board_record (this project does not auto-grant
-- new tables; see 20260722181527_explicit_browser_data_api_grants.sql). Reads
-- are open by RLS policy; writes stay RPC-only, so only SELECT is granted to
-- the browser roles.
grant select on table public.board_record to anon, authenticated;
grant select, insert, update, delete on table public.board_record to service_role;
