-- 0008_fuel_confidence.sql
-- Make fuel_estimate_confidence truthful in the server store.
--
-- Rate-derived FUEL is a low-confidence estimate (the capture client stamps
-- 0.3). The upsert_match_report RPC's INSERT does NOT list this column, so a
-- new row takes the column DEFAULT — which was previously unset (NULL). That
-- left every report with NULL confidence, which the dashboard coerced to 0,
-- ZEROING the FUEL contribution instead of down-weighting it to 0.3x.
--
-- Setting the column default to 0.3 makes every future upsert_match_report
-- INSERT persist 0.3 automatically (no RPC change needed); the backfill fixes
-- existing rows. The dashboard also defensively coalesces NULL -> 0.3.
alter table match_scouting_report
  alter column fuel_estimate_confidence set default 0.3;

update match_scouting_report
  set fuel_estimate_confidence = 0.3
  where fuel_estimate_confidence is null;
