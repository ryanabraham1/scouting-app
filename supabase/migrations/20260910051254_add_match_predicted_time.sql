-- Preserve TBA's live predicted start separately from the event's originally
-- scheduled start. The estimate may move throughout the event; keeping both
-- lets scout clients label the value honestly and fall back when TBA cannot
-- produce a prediction.
alter table public.match
  add column if not exists predicted_time timestamptz;

comment on column public.match.predicted_time is
  'Latest TBA-predicted match start time; nullable when TBA has no prediction.';
