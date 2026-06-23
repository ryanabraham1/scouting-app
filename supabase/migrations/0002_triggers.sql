-- 0002_triggers.sql — server-authoritative metadata + recompute.

-- BEFORE UPDATE: bump revision + timestamps. row_revision is monotonic per row.
create or replace function msr_bump_meta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.row_revision := old.row_revision + 1;
  new.updated_at := now();
  new.server_received_at := now();
  return new;
end;
$$;

drop trigger if exists trg_msr_bump_meta on match_scouting_report;
create trigger trg_msr_bump_meta
  before update on match_scouting_report
  for each row execute function msr_bump_meta();

-- Drop the obsolete startMs-based classifier (superseded: recompute now attributes
-- bursts strictly by their declared window field, matching TS computeAggregates).
drop function if exists msr_window_of(text, int);

-- FROZEN: isInactive(n, inactiveFirst) = ((n % 2) = 1) = inactiveFirst
create or replace function msr_is_inactive(p_shift int, p_inactive_first boolean)
returns boolean
language plpgsql
immutable
as $$
begin
  return ((p_shift % 2) = 1) = p_inactive_first;
end;
$$;

-- Round half-up (away from +inf for non-negative values) to integer, mirroring TS.
create or replace function msr_round_half_up(p_val numeric)
returns int
language plpgsql
immutable
as $$
begin
  return floor(p_val + 0.5)::int;
end;
$$;

create or replace function recompute_match_report_aggregates(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  b jsonb;
  win text;
  -- float accumulators per window
  f_auto numeric := 0;
  f_transition numeric := 0;
  f_endgame numeric := 0;
  f_shift numeric[] := array[0,0,0,0]::numeric[];
  -- rounded results
  r_auto int; r_transition int; r_endgame int;
  r_shift int[] := array[0,0,0,0];
  v_active int := 0;
  v_inactive int := 0;
  v_points int := 0;
  v_inactive_first boolean;
  i int;
  burst_fuel numeric;
begin
  select * into r from match_scouting_report where id = p_report_id;
  if not found then
    return;
  end if;
  v_inactive_first := coalesce(r.inactive_first, false);

  -- Attribute each burst by its DECLARED window field, mirroring TS computeAggregates
  -- (floatByWindow[b.window] += burstFuel). We do NOT re-derive the window from startMs;
  -- a burst declared shift1 whose startMs straddles into transition still counts as shift1.
  for b in select * from jsonb_array_elements(r.fuel_bursts)
  loop
    burst_fuel := (b->>'rate')::numeric
      * ((b->>'endMs')::numeric - (b->>'startMs')::numeric) / 1000.0;
    win := b->>'window';
    if win = 'auto' then
      f_auto := f_auto + burst_fuel;
    elsif win = 'transition' then
      f_transition := f_transition + burst_fuel;
    elsif win = 'endgame' then
      f_endgame := f_endgame + burst_fuel;
    elsif win = 'shift1' then
      f_shift[1] := f_shift[1] + burst_fuel;
    elsif win = 'shift2' then
      f_shift[2] := f_shift[2] + burst_fuel;
    elsif win = 'shift3' then
      f_shift[3] := f_shift[3] + burst_fuel;
    elsif win = 'shift4' then
      f_shift[4] := f_shift[4] + burst_fuel;
    end if;
  end loop;

  -- Round half-up once per window (matches TS: round per window, not per burst).
  r_auto := msr_round_half_up(f_auto);
  r_transition := msr_round_half_up(f_transition);
  r_endgame := msr_round_half_up(f_endgame);
  for i in 1..4 loop
    r_shift[i] := msr_round_half_up(f_shift[i]);
  end loop;

  -- Active/inactive teleop sums + points (mirrors TS computeAggregates).
  -- teleop_fuel_active = transition (always active) + active shifts only.
  -- Auto and endgame are reported separately (auto_fuel/endgame_fuel), NOT folded into
  -- teleop_fuel_active. shiftN active iff NOT msr_is_inactive(N, inactiveFirst).
  v_active := r_transition; -- transition is always active teleop
  for i in 1..4 loop
    if msr_is_inactive(i, v_inactive_first) then
      v_inactive := v_inactive + r_shift[i];
    else
      v_active := v_active + r_shift[i];
    end if;
  end loop;

  -- fuelPoints: all active windows incl auto, * FUEL_POINTS (=1).
  v_points := r_auto + r_transition + r_endgame;
  for i in 1..4 loop
    if not msr_is_inactive(i, v_inactive_first) then
      v_points := v_points + r_shift[i];
    end if;
  end loop;

  update match_scouting_report
  set auto_fuel = r_auto,
      teleop_fuel_active = v_active,
      teleop_fuel_inactive = v_inactive,
      endgame_fuel = r_endgame,
      fuel_by_shift = r_shift,
      fuel_points = v_points * 1  -- SCORING.FUEL_POINTS
  where id = p_report_id;
end;
$$;
