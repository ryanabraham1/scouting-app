-- 0019_drop_demo_rpc.sql
-- Demo mode no longer seeds via an in-database RPC. The approach moved to the
-- `seed-demo` Edge Function, which builds a SEPARATE demo event (2026demo) from a
-- REAL source event (2026casnv) using The Blue Alliance — REAL teams and REAL
-- qualification schedule — and generates per-match scouting reports grounded in
-- TBA match results. Real team numbers make team-scoped features (TBA team info,
-- world rank, Statbotics / cross-event EPA) work, which the old fake 9001..9029
-- teams broke. So drop the obsolete SQL seeding from 0018.
drop function if exists seed_demo_event(text);
drop function if exists skill_of(int);
