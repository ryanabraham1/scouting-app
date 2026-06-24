-- 0007_picklist.sql — shared drive-team picklist (phase4-contracts.md §6).
-- One row per event; `entries` is an ordered jsonb array of
-- { "teamNumber": int, "tier": text|null, "note": text|null }.
-- Staff-only (lead/admin) via is_staff() (defined in 0005_admin.sql); mirrors
-- the staff-read policy style there + the drop-then-create idempotency of 0006.
-- Re-apply is safe: create-if-not-exists / drop policy if exists before create.

create table if not exists picklist (
  event_key text primary key references event(event_key) on delete cascade,
  entries jsonb not null default '[]'::jsonb,   -- [{ "teamNumber": int, "tier": text|null, "note": text|null }] ordered
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table picklist enable row level security;

drop policy if exists picklist_read_staff on picklist;
create policy picklist_read_staff on picklist
  for select to authenticated
  using (is_staff());

drop policy if exists picklist_write_staff on picklist;
create policy picklist_write_staff on picklist
  for all to authenticated
  using (is_staff())
  with check (is_staff());
