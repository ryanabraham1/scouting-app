-- Expand subjective robot ratings from 1–3 to 1–10. Zero remains "not rated".
-- Preserve the meaning of existing low/mid/high observations by mapping their
-- normalized positions onto the new scale: 1/3 -> 3/10, 2/3 -> 7/10, 3/3 -> 10/10.

alter table match_scouting_report
  drop constraint if exists match_scouting_report_defense_rating_check;

update match_scouting_report
set
  defense_rating = case defense_rating
    when 1 then 3
    when 2 then 7
    when 3 then 10
    else defense_rating
  end,
  driver_skill = case driver_skill
    when 1 then 3
    when 2 then 7
    when 3 then 10
    else driver_skill
  end,
  agility = case agility
    when 1 then 3
    when 2 then 7
    when 3 then 10
    else agility
  end
where defense_rating between 1 and 3
   or driver_skill between 1 and 3
   or agility between 1 and 3;

alter table match_scouting_report
  add constraint match_scouting_report_defense_rating_check
    check (defense_rating between 0 and 10),
  add constraint match_scouting_report_driver_skill_check
    check (driver_skill between 0 and 10),
  add constraint match_scouting_report_agility_check
    check (agility between 0 and 10);
