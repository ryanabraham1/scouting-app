-- 2026mttd: fold TBA's offseason placeholder teams into the lettered robots.
--
-- Field software runs B/C robots under placeholder numbers 99xx, and TBA lists
-- those placeholders ("Off-Season Demo Team 99xx") in /event/{key}/teams while
-- its matches use the real lettered keys (frc971B). The import took both, so
-- the roster showed 62 robots for a 48-robot event, and pit scouts filed 12
-- reports (and the picklist 10 entries) under the 99xx numbers.
--
-- Mapping = TBA's event.remap_teams for 2026mttd. Moves pit reports, pit
-- history, pit crews and picklist entries to the lettered robot, then removes
-- the placeholders from the event roster. Idempotent; never overwrites a row
-- that already exists for the lettered robot. import-event now applies
-- remap_teams itself, so future imports don't add placeholders.

create temporary table mttd_remap (old_team int primary key, new_team int not null) on commit drop;
insert into mttd_remap (old_team, new_team) values
  (9999, 101323), (9991, 100581), (9981, 200581), (9984, 100841),
  (9971, 100971), (9973, 100973), (9978, 101678), (9979, 201678),
  (9980, 101868), (9990, 102073), (9998, 104698), (9988, 105940),
  (9987, 108033), (9986, 109470);

-- Lettered robots must be on the roster before rows can point at them.
insert into public.event_team (event_key, team_number)
select '2026mttd', r.new_team from mttd_remap r
where exists (select 1 from public.event e where e.event_key = '2026mttd')
  and exists (select 1 from public.team t where t.team_number = r.new_team)
on conflict do nothing;

update public.pit_scouting_report p
set team_number = r.new_team
from mttd_remap r
where p.event_key = '2026mttd'
  and p.team_number = r.old_team
  and not exists (
    select 1 from public.pit_scouting_report x
    where x.event_key = '2026mttd' and x.team_number = r.new_team
  );

update public.pit_report_history h
set team_number = r.new_team
from mttd_remap r
where h.event_key = '2026mttd' and h.team_number = r.old_team;

update public.pit_assignment a
set team_number = r.new_team
from mttd_remap r
where a.event_key = '2026mttd'
  and a.team_number = r.old_team
  and not exists (
    select 1 from public.pit_assignment x
    where x.event_key = '2026mttd' and x.team_number = r.new_team and x.scout_id = a.scout_id
  );

-- Picklist: remap each entry, keeping the first occurrence if both exist.
update public.picklist pl
set entries = coalesce((
  select jsonb_agg(e.entry order by e.ord)
  from (
    select distinct on (coalesce(r.new_team, (x.value->>'teamNumber')::int))
           x.ordinality as ord,
           case when r.new_team is null then x.value
                else jsonb_set(x.value, '{teamNumber}', to_jsonb(r.new_team)) end as entry
    from jsonb_array_elements(pl.entries) with ordinality x(value, ordinality)
    left join mttd_remap r on r.old_team = (x.value->>'teamNumber')::int
    order by coalesce(r.new_team, (x.value->>'teamNumber')::int), x.ordinality
  ) e
), '[]'::jsonb),
    updated_at = now()
where pl.event_key = '2026mttd'
  and exists (
    select 1 from jsonb_array_elements(pl.entries) x
    join mttd_remap r on r.old_team = (x.value->>'teamNumber')::int
  );

-- Drop the placeholders from the roster only once nothing still references them.
delete from public.event_team et
using mttd_remap r
where et.event_key = '2026mttd'
  and et.team_number = r.old_team
  and not exists (select 1 from public.pit_scouting_report p where p.event_key = et.event_key and p.team_number = et.team_number)
  and not exists (select 1 from public.match_scouting_report m where m.event_key = et.event_key and m.target_team_number = et.team_number)
  and not exists (select 1 from public.match mt where mt.event_key = et.event_key
                  and et.team_number in (mt.red1, mt.red2, mt.red3, mt.blue1, mt.blue2, mt.blue3));
