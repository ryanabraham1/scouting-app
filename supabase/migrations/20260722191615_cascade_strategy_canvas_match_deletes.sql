-- Make the strategy_canvas -> match composite foreign key cascade on delete.
--
-- 20260710192440 re-added a composite (event_key, match_key) FK from
-- strategy_canvas to match as NOT VALID and with the default ON DELETE NO ACTION.
-- That NO ACTION behaviour makes delete_event's plain
--   delete from match where event_key = ...
-- throw an FK violation whenever the event has any saved strategy canvas rows.
--
-- Re-create the constraint with ON DELETE CASCADE so match deletes clean up the
-- referencing canvas rows, then validate it.
--
-- Idempotent / re-apply safe (drop constraint if exists before re-adding).
alter table public.strategy_canvas
  drop constraint if exists strategy_event_match_fkey;

alter table public.strategy_canvas
  add constraint strategy_event_match_fkey
  foreign key (event_key, match_key)
  references public.match(event_key, match_key)
  on delete cascade
  not valid;

alter table public.strategy_canvas
  validate constraint strategy_event_match_fkey;
