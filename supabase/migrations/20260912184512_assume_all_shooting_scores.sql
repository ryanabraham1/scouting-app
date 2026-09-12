-- Scouts record visible shooting, not the field's alternating HUB activation.
-- Treat every recorded FUEL burst as scored, retain the legacy aggregate columns
-- for API compatibility, and place all Teleop FUEL in teleop_fuel_active.

create or replace function public.recompute_match_report_aggregates(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.match_scouting_report%rowtype;
  b jsonb;
  v_window text;
  v_numerator numeric;
  n_auto numeric := 0;
  n_transition numeric := 0;
  n_endgame numeric := 0;
  n_shift numeric[] := array[0, 0, 0, 0]::numeric[];
  r_auto int := 0;
  r_transition int := 0;
  r_endgame int := 0;
  r_shift int[] := array[0, 0, 0, 0];
  v_teleop int := 0;
  v_points int := 0;
  i int;
begin
  select * into r
  from public.match_scouting_report
  where id = p_report_id;
  if not found then return; end if;

  if not r.no_show then
    for b in
      select value from jsonb_array_elements(r.fuel_bursts)
    loop
      v_numerator :=
        floor((b->>'rate')::numeric * 1000000000 + 0.5)
        * greatest(0, (b->>'endMs')::bigint - (b->>'startMs')::bigint);
      v_window := b->>'window';
      if v_window = 'auto' then n_auto := n_auto + v_numerator;
      elsif v_window = 'transition' then n_transition := n_transition + v_numerator;
      elsif v_window = 'endgame' then n_endgame := n_endgame + v_numerator;
      elsif v_window = 'shift1' then n_shift[1] := n_shift[1] + v_numerator;
      elsif v_window = 'shift2' then n_shift[2] := n_shift[2] + v_numerator;
      elsif v_window = 'shift3' then n_shift[3] := n_shift[3] + v_numerator;
      elsif v_window = 'shift4' then n_shift[4] := n_shift[4] + v_numerator;
      end if;
    end loop;

    r_auto := floor((n_auto + 500000000000) / 1000000000000)::int;
    r_transition := floor((n_transition + 500000000000) / 1000000000000)::int;
    r_endgame := floor((n_endgame + 500000000000) / 1000000000000)::int;
    for i in 1..4 loop
      r_shift[i] :=
        floor((n_shift[i] + 500000000000) / 1000000000000)::int;
    end loop;
  end if;

  v_teleop := r_transition;
  for i in 1..4 loop
    v_teleop := v_teleop + r_shift[i];
  end loop;
  v_points := r_auto + v_teleop + r_endgame;

  if greatest(r_auto, v_teleop, r_endgame, v_points) > 2500000 then
    raise exception 'computed match aggregate exceeds supported range'
      using errcode = '22003';
  end if;

  update public.match_scouting_report
  set auto_fuel = r_auto,
      teleop_fuel_active = v_teleop,
      teleop_fuel_inactive = 0,
      endgame_fuel = r_endgame,
      fuel_by_shift = r_shift,
      fuel_points = v_points
  where id = p_report_id;
end;
$$;

revoke all on function public.recompute_match_report_aggregates(uuid) from public;
grant execute on function public.recompute_match_report_aggregates(uuid)
  to service_role;

-- Bring existing reports onto the same rule using their retained raw bursts.
do $$
declare
  v_report_id uuid;
begin
  for v_report_id in
    select id from public.match_scouting_report
  loop
    perform public.recompute_match_report_aggregates(v_report_id);
  end loop;
end;
$$;
