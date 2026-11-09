-- Re-point scouting reports that were filed for an offseason lettered robot
-- (TBA `frc581B`) under its parent team number (581).
--
-- Until the teamKey.ts fix, every TBA key was parsed with parseInt, so the B/C
-- robot was stored as its A team: schedules showed "581" twice and scouts'
-- reports landed on the A team. The schedule is now re-synced with lettered
-- robots encoded as their own ints (581B -> 100581, 581C -> 200581). A report
-- whose target team is no longer in its match, but whose alliance/station slot
-- now holds that team's lettered robot, belongs to that robot. The slot match
-- makes this unambiguous; anything else is left untouched. Idempotent.

with slots as (
  select r.id,
         case r.alliance_color
           when 'red' then case r.station when 1 then m.red1 when 2 then m.red2 when 3 then m.red3 end
           when 'blue' then case r.station when 1 then m.blue1 when 2 then m.blue2 when 3 then m.blue3 end
         end as slot_team
  from public.match_scouting_report r
  join public.match m on m.match_key = r.match_key
  where r.target_team_number is distinct from m.red1
    and r.target_team_number is distinct from m.red2
    and r.target_team_number is distinct from m.red3
    and r.target_team_number is distinct from m.blue1
    and r.target_team_number is distinct from m.blue2
    and r.target_team_number is distinct from m.blue3
)
update public.match_scouting_report r
set target_team_number = s.slot_team
from slots s
where s.id = r.id
  and s.slot_team >= 100000
  and s.slot_team % 100000 = r.target_team_number
  and exists (
    select 1 from public.event_team et
    where et.event_key = r.event_key and et.team_number = s.slot_team
  );
