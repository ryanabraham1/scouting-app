-- Pit assignments, conflict-safe report editing, and ordered multi-photo support.

create table pit_assignment (
  event_key text not null,
  team_number int not null,
  scout_id uuid not null references scout(id) on delete cascade,
  source text not null default 'manual' check (source in ('manual', 'auto')),
  created_at timestamptz not null default now(),
  primary key (event_key, team_number),
  foreign key (event_key, team_number)
    references event_team(event_key, team_number) on delete cascade
);

create index pit_assignment_scout_idx on pit_assignment (scout_id, event_key);

alter table pit_assignment enable row level security;

create policy pit_assignment_read_open on pit_assignment
  for select to anon, authenticated
  using (true);

grant select on table pit_assignment to anon, authenticated;

create or replace function set_pit_assignments(
  p_event_key text,
  p_assignments jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not exists (select 1 from event where event_key = p_event_key) then
    raise exception 'event not found' using errcode = '23503';
  end if;

  delete from pit_assignment where event_key = p_event_key;

  insert into pit_assignment (event_key, team_number, scout_id, source)
  select distinct on (team_number)
    p_event_key,
    team_number,
    scout_id,
    source
  from (
    select
      (elem->>'team_number')::int as team_number,
      (elem->>'scout_id')::uuid as scout_id,
      case when elem->>'source' = 'auto' then 'auto' else 'manual' end as source,
      ordinality
    from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb))
      with ordinality as input(elem, ordinality)
    where nullif(elem->>'scout_id', '') is not null
      and nullif(elem->>'team_number', '') is not null
  ) parsed
  where exists (
    select 1
    from event_team et
    where et.event_key = p_event_key
      and et.team_number = parsed.team_number
  )
    and exists (
      select 1
      from scout s
      where s.event_key = p_event_key
        and s.id = parsed.scout_id
  )
  order by team_number, ordinality desc;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function set_pit_assignments(text, jsonb) from public;
grant execute on function set_pit_assignments(text, jsonb) to anon, authenticated;

alter table pit_scouting_report
  add column photos jsonb not null default '[]'::jsonb;

alter table pit_scouting_report
  add constraint pit_scouting_report_photos_shape
  check (
    jsonb_typeof(photos) = 'array'
    and jsonb_array_length(photos) <= 6
  );

update pit_scouting_report
set photos = jsonb_build_array(
  jsonb_build_object(
    'id', 'legacy',
    'path', photo_path,
    'order', 0,
    'mimeType', null,
    'width', null,
    'height', null
  )
)
where photo_path is not null
  and photos = '[]'::jsonb;

-- PostgreSQL cannot change a function's return type with CREATE OR REPLACE.
drop function upsert_pit_report(jsonb);

create function upsert_pit_report(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text := p->>'event_key';
  v_team int := (p->>'team_number')::int;
  v_incoming_rev bigint := coalesce((p->>'row_revision')::bigint, 1);
  v_has_base boolean := p ? 'base_revision';
  v_base_rev bigint := nullif(p->>'base_revision', '')::bigint;
  v_existing pit_scouting_report%rowtype;
  v_author uuid := nullif(p->>'author_scout_id', '')::uuid;
  v_photos jsonb := coalesce(p->'photos', '[]'::jsonb);
begin
  if v_event_key is null
    or not exists (select 1 from event e where e.event_key = v_event_key)
    or not exists (
      select 1 from event_team et
      where et.event_key = v_event_key and et.team_number = v_team
    )
  then
    raise exception 'pit report event/team is invalid' using errcode = '23503';
  end if;

  if jsonb_typeof(v_photos) <> 'array' or jsonb_array_length(v_photos) > 6 then
    raise exception 'pit report photos must be an array of at most 6 items'
      using errcode = '22023';
  end if;

  if v_author is not null
    and not exists (
      select 1 from scout s
      where s.id = v_author and s.event_key = v_event_key
    )
  then
    v_author := null;
  end if;

  select * into v_existing
  from pit_scouting_report
  where event_key = v_event_key and team_number = v_team
  for update;

  if not found then
    if v_has_base and v_base_rev is not null then
      return jsonb_build_object(
        'status', 'conflict',
        'current_revision', null
      );
    end if;

    insert into pit_scouting_report (
      event_key, team_number, drivetrain, mechanisms, capabilities, vision_system,
      batteries, preferred_auto_start_position, preferred_auto_path, match_strategy,
      robot_dimensions, photos, photo_path, notes, author_scout_id, row_revision,
      updated_at, server_received_at, deleted
    ) values (
      v_event_key, v_team,
      p->>'drivetrain',
      coalesce(p->'mechanisms', '[]'::jsonb),
      coalesce(p->'capabilities', '[]'::jsonb),
      p->>'vision_system',
      p->'batteries',
      p->'preferred_auto_start_position',
      p->'preferred_auto_path',
      coalesce(p->'match_strategy', '[]'::jsonb),
      p->'robot_dimensions',
      v_photos,
      coalesce(v_photos->0->>'path', p->>'photo_path'),
      p->>'notes',
      v_author,
      v_incoming_rev,
      now(), now(), false
    );

    return jsonb_build_object(
      'status', 'applied',
      'revision', v_incoming_rev
    );
  end if;

  -- A retry of the revision already committed is an idempotent success.
  if v_existing.row_revision = v_incoming_rev then
    return jsonb_build_object(
      'status', 'applied',
      'revision', v_existing.row_revision,
      'idempotent', true
    );
  end if;

  -- New clients send the revision they loaded. A mismatch means another device
  -- edited this shared team report, so preserve both sides instead of overwriting.
  if v_has_base and v_base_rev is distinct from v_existing.row_revision then
    return jsonb_build_object(
      'status', 'conflict',
      'current_revision', v_existing.row_revision
    );
  end if;

  -- Backward compatibility for already-installed clients that do not send a
  -- base revision: preserve the old strictly-newer timestamp guard.
  if not v_has_base and v_incoming_rev < v_existing.row_revision then
    return jsonb_build_object(
      'status', 'stale',
      'current_revision', v_existing.row_revision
    );
  end if;

  if v_incoming_rev <= v_existing.row_revision then
    raise exception 'new pit report revision must be greater than the loaded revision'
      using errcode = '22023';
  end if;

  insert into pit_report_history (event_key, team_number, snapshot)
  values (v_event_key, v_team, to_jsonb(v_existing));

  update pit_scouting_report set
    drivetrain = p->>'drivetrain',
    mechanisms = coalesce(p->'mechanisms', '[]'::jsonb),
    capabilities = coalesce(p->'capabilities', '[]'::jsonb),
    vision_system = p->>'vision_system',
    batteries = p->'batteries',
    preferred_auto_start_position = p->'preferred_auto_start_position',
    preferred_auto_path = p->'preferred_auto_path',
    match_strategy = coalesce(p->'match_strategy', '[]'::jsonb),
    robot_dimensions = p->'robot_dimensions',
    photos = v_photos,
    photo_path = coalesce(v_photos->0->>'path', p->>'photo_path'),
    notes = p->>'notes',
    author_scout_id = v_author,
    row_revision = v_incoming_rev,
    updated_at = now(),
    server_received_at = now(),
    deleted = false
  where event_key = v_event_key and team_number = v_team;

  return jsonb_build_object(
    'status', 'applied',
    'revision', v_incoming_rev
  );
end;
$$;

revoke all on function upsert_pit_report(jsonb) from public;
grant execute on function upsert_pit_report(jsonb) to anon, authenticated;

-- Enforce the limits in source control as well as in the client. New photos are
-- normalized to JPEG, while PNG/WebP remain allowed for existing/manual uploads.
insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
values (
  'pit-photos',
  'pit-photos',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Recreate select_scouter so same-name consolidation also preserves pit work.
create or replace function select_scouter(p_event_key text, p_name text)
returns scout
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_scout scout;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  update scout
    set auth_uid = gen_random_uuid()
    where event_key = p_event_key
      and auth_uid = v_uid
      and lower(display_name) <> lower(p_name);

  select * into v_scout
    from scout
    where event_key = p_event_key
      and lower(display_name) = lower(p_name)
    order by (auth_uid is not distinct from v_uid) desc, created_at asc
    limit 1;

  if v_scout.id is null then
    insert into scout (event_key, display_name, auth_uid)
    values (p_event_key, p_name, v_uid)
    returning * into v_scout;
  else
    update scout
      set auth_uid = v_uid, display_name = p_name
      where id = v_scout.id
      returning * into v_scout;
  end if;

  update assignment a
    set scout_id = v_scout.id
    from scout s
    where a.scout_id = s.id
      and s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name);

  -- A team has only one pit assignment. If both the canonical and duplicate
  -- scout are assigned, keep the canonical row and discard the duplicate row.
  delete from pit_assignment a
  using scout s
  where a.scout_id = s.id
    and s.event_key = p_event_key
    and s.id <> v_scout.id
    and lower(s.display_name) = lower(p_name)
    and exists (
      select 1 from pit_assignment keep
      where keep.event_key = a.event_key
        and keep.team_number = a.team_number
        and keep.scout_id = v_scout.id
    );

  update pit_assignment a
    set scout_id = v_scout.id
    from scout s
    where a.scout_id = s.id
      and s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name);

  update match_scouting_report r
    set deleted = true
    from scout s
    where r.scout_id = s.id
      and s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name)
      and not r.deleted
      and exists (
        select 1 from match_scouting_report m
        where m.scout_id = v_scout.id
          and m.match_key = r.match_key
          and not m.deleted
      );

  with ranked as (
    select r.id,
           row_number() over (
             partition by r.match_key
             order by r.row_revision desc, r.updated_at desc, r.id desc
           ) as rn
    from match_scouting_report r
    join scout s on s.id = r.scout_id
    where s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name)
      and not r.deleted
  )
  update match_scouting_report r
    set deleted = true
    from ranked
    where r.id = ranked.id
      and ranked.rn > 1;

  update match_scouting_report r
    set scout_id = v_scout.id
    from scout s
    where r.scout_id = s.id
      and s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name);

  update pit_scouting_report p
    set author_scout_id = v_scout.id
    from scout s
    where p.author_scout_id = s.id
      and s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name);

  delete from scout s
    where s.event_key = p_event_key
      and s.id <> v_scout.id
      and lower(s.display_name) = lower(p_name);

  insert into profile (auth_uid) values (v_uid)
  on conflict (auth_uid) do nothing;

  return v_scout;
end;
$$;

grant execute on function select_scouter(text, text) to anon, authenticated;
