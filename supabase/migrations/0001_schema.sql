-- 0001_schema.sql — FROZEN columns. Single team (3256), quals only.
create extension if not exists pgcrypto;

create table event (
  event_key text primary key,
  name text,
  start_date date,
  end_date date,
  timezone text,
  city text,
  state_prov text,
  is_active boolean not null default false,
  staged_fuel_per_match int not null default 504,
  imported_at timestamptz
);

create table event_secret (
  event_key text primary key references event(event_key) on delete cascade,
  join_code text not null
);

create table team (
  team_number int primary key,
  nickname text,
  city text,
  state_prov text,
  rookie_year int
);

create table event_team (
  event_key text references event(event_key),
  team_number int references team(team_number),
  primary key (event_key, team_number)
);

create table match (
  match_key text primary key,
  event_key text references event(event_key),
  comp_level text not null check (comp_level = 'qm'),
  match_number int,
  scheduled_time timestamptz,
  red1 int, red2 int, red3 int,
  blue1 int, blue2 int, blue3 int,
  actual_red_score int,
  actual_blue_score int,
  red_auto_fuel int,
  blue_auto_fuel int,
  winner text,
  result_synced_at timestamptz
);

create table scout (
  id uuid primary key default gen_random_uuid(),
  event_key text references event(event_key),
  display_name text not null,
  auth_uid uuid not null unique,
  created_at timestamptz default now()
);

create table profile (
  auth_uid uuid primary key,
  role text not null default 'scouter' check (role in ('scouter','lead','admin'))
);

create table assignment (
  id uuid primary key default gen_random_uuid(),
  event_key text references event(event_key),
  match_key text references match(match_key),
  scout_id uuid references scout(id),
  alliance_color text check (alliance_color in ('red','blue')),
  station int check (station between 1 and 3),
  target_team_number int references team(team_number),
  source text check (source in ('manual','auto'))
);

create table match_scouting_report (
  id uuid primary key default gen_random_uuid(),
  schema_version int not null,
  app_version text,
  device_id text,
  created_at timestamptz not null default now(),
  server_received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_revision bigint not null default 1,
  deleted boolean not null default false,
  event_key text not null references event(event_key),
  match_key text not null references match(match_key),
  scout_id uuid not null references scout(id),
  target_team_number int not null references team(team_number),
  alliance_color text not null check (alliance_color in ('red','blue')),
  station int not null check (station between 1 and 3),
  inactive_first boolean,
  inactive_first_source text check (inactive_first_source in ('derived','scout','official')),
  teleop_clock_unconfirmed boolean default false,
  fuel_bursts jsonb not null default '[]'::jsonb,
  auto_fuel int default 0,
  teleop_fuel_active int default 0,
  teleop_fuel_inactive int default 0,
  endgame_fuel int default 0,
  fuel_by_shift int[] default '{0,0,0,0}',
  fuel_points int default 0,
  fuel_estimate_confidence numeric,
  climb_level int default 0 check (climb_level between 0 and 3),
  climb_attempted boolean default false,
  climb_success boolean default false,
  auto_start_position jsonb,
  auto_path jsonb,
  auto_left_starting_line boolean default false,
  auto_climb_level1 boolean default false,
  intake_sources text[] default '{}',
  max_fuel_capacity_observed int default 0,
  defense_rating int default 0 check (defense_rating between 0 and 3),
  pins int default 0,
  fouls_minor int default 0,
  fouls_major int default 0,
  no_show boolean default false,
  died boolean default false,
  tipped boolean default false,
  dropped_fuel boolean default false,
  fed_corral boolean default false,
  notes text
);

create table pit_scouting_report (
  event_key text references event(event_key),
  team_number int references team(team_number),
  drivetrain text,
  mechanisms jsonb,
  capabilities jsonb,
  photo_path text,
  notes text,
  row_revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  server_received_at timestamptz not null default now(),
  deleted boolean not null default false,
  author_scout_id uuid references scout(id),
  primary key (event_key, team_number)
);

create table pit_report_history (
  id uuid primary key default gen_random_uuid(),
  event_key text,
  team_number int,
  snapshot jsonb,
  created_at timestamptz default now()
);

-- Partial unique index: exactly one ACTIVE report per (match_key, scout_id).
-- Soft-deleted rows are exempt, so a match can be re-scouted after a delete.
-- This is the conflict target for upsert_match_report (ON CONFLICT ... WHERE NOT deleted).
create unique index idx_msr_match_scout_active
  on match_scouting_report (match_key, scout_id) where not deleted;

create index idx_msr_event_match on match_scouting_report (event_key, match_key);
create index idx_msr_target_team on match_scouting_report (target_team_number);
create index idx_msr_scout on match_scouting_report (scout_id);
create index idx_assignment_match on assignment (match_key);
create index idx_assignment_scout on assignment (scout_id);
