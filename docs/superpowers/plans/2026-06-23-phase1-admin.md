# Phase 1: Admin & Schedule — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an admin a way to log in, import an FRC event's qual schedule + teams from TheBlueAlliance, and assign scouts to matches (manual + balanced auto-generation) — building on the Phase 0 foundation.

**Architecture:** A new `0005_admin.sql` migration adds role-based (`is_staff`/`is_admin`) read access (additive to Phase 0's membership policies) and an admin-only `set_assignments` RPC. An admin-gated `import-event` Edge Function pulls TBA data (qual matches only) and upserts it via the service role. A pure, golden-tested TypeScript `autoAssign` module computes balanced assignments (3256 never scouted). Admin authenticates by Supabase email/password; the admin UI (event setup, schedule, assignment board) composes these.

**Tech Stack:** TypeScript (strict), React 18 + Vite, shadcn/ui, Supabase (Postgres + RLS + Edge Functions + Auth), Vitest + Playwright. Same toolchain as Phase 0.

## Global Constraints

_Every task's requirements implicitly include this section. Apply/deploy/test exactly as Phase 0._

- **Repo:** `/Users/ryanabraham/Downloads/FRC-scouting-app`, branch `phase-1-admin` (off `main`). Conventional Commits; one commit per task minimum.
- **Apply SQL:** `python3 .superpowers/sdd/apply-sql.py supabase/migrations/<file>.sql` (Management API, transactional; use `create or replace` / `drop policy if exists` so re-apply is safe). Ad-hoc: `... apply-sql.py -e "<sql>"`.
- **Deploy Edge Fn:** `set -a; . ./.env.local; set +a; SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" npx --yes supabase@latest functions deploy <name> --project-ref oztsfxyfovwnwutrxzmo --no-verify-jwt`
- **Tests:** `npm run test` (vitest; DB/fn tests load `.env.local` via dotenv); `npm run test:e2e` (playwright, chromium installed); `npm run typecheck`; `npm run build`.
- **Test admin (already seeded):** `.env.local` has `TEST_ADMIN_EMAIL`/`TEST_ADMIN_PASSWORD`; that user's `profile.role='admin'`. Sign-in verified.
- **Team 3256 is NOT scouted.** Test event `2026casnv` (the `/event/2026casnv/matches` feed includes playoff matches — import MUST filter to `comp_level='qm'`).
- **All SECURITY DEFINER functions pin `set search_path = public`.** Apply migrations in order; 0005 is additive (do NOT drop Phase 0 policies/functions).

### ⚠️ SCHEMA REFERENCE (authoritative — the draft guessed some column names; THESE are correct)

- `scout(id uuid PK, event_key text, display_name text, auth_uid uuid NOT NULL UNIQUE, created_at)` — the PK is **`id`**, NOT `scout_id`.
- `profile(auth_uid uuid PK, role text CHECK in scouter|lead|admin)` — **no `scout_id` column.** An admin needs ONLY a `profile` row (`auth_uid` + `role='admin'`); admins are **not** scouts and need no `scout` row.
- `assignment(id uuid PK, event_key, match_key, scout_id uuid → scout.id, alliance_color, station 1..3, target_team_number, source)` — `scout_id` here is a real column.
- `match(match_key text PK, event_key, comp_level CHECK ='qm', match_number, scheduled_time timestamptz, red1,red2,red3,blue1,blue2,blue3 int, ...)`.
- `event(event_key text PK, name, start_date, end_date, timezone, city, state_prov, is_active, staged_fuel_per_match, imported_at)`; `event_secret(event_key PK, join_code)`; `event_team(event_key, team_number)`; `team(team_number int PK, nickname, city, state_prov, rookie_year)`.
- **Any draft snippet using `scout.scout_id` or `profile.scout_id` is WRONG** — use `scout.id`; to seed a scout to reference in assignments, insert `scout(event_key, display_name, auth_uid)` (auth_uid must be unique) and read its `id`.

## File Structure

```
supabase/migrations/0005_admin.sql · tests/db/admin.test.ts                              (DB)
src/admin/{types,autoAssign}.ts + __tests__/autoAssign.test.ts                           (ASSIGN)
supabase/functions/import-event/index.ts · tests/functions/import-event.test.ts          (EF)
src/auth/{adminAuth.ts,AdminLogin.tsx} + __tests__ ; MODIFY src/routes/{guards,router}.tsx (AUTH)
src/admin/{importEventClient,setAssignmentsClient}.ts · {EventSetup,ScheduleView,AssignmentBoard,AdminPage}.tsx + __tests__ ; MODIFY src/routes/router.tsx (UI)
tests/e2e/admin.spec.ts + verification gate                                              (GATE)
```

**Execution order:** DB → ASSIGN (pure, independent) → EF → AUTH → UI → GATE. Task IDs are cluster-prefixed (DB*, ASSIGN*, EF*, AUTH*, UI*, GATE*).

---

<!-- ===== Cluster DB ===== -->

### Task DB1
**Files:**
- Create: `supabase/migrations/0005_admin.sql`
- Test: `tests/db/admin.test.ts`

**Interfaces:**
- Produces: `is_staff() returns boolean`, `is_admin() returns boolean` (both SECURITY DEFINER, `set search_path = public`); permissive SELECT policies `<table>_read_staff USING (is_staff())` on event, event_team, team, match, assignment, scout, match_scouting_report, pit_scouting_report; `set_assignments(p_event_key text, p_assignments jsonb) returns int` (SECURITY DEFINER).
- Consumes (Phase 0, live): `profile(auth_uid uuid, role text)`, `event(event_key)`, `match(match_key, event_key)`, `assignment(event_key, match_key, scout_id, alliance_color, station, target_team_number, source)`.

- [ ] **Step 1: Write the failing DB test file (helpers + admin sign-in).** Create `tests/db/admin.test.ts` with the full suite below. It seeds an admin via the auth admin API, sets `profile.role='admin'`, signs in to get a JWT-scoped client, and asserts staff/admin helpers + reads + `set_assignments`.

```ts
// tests/db/admin.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL!;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;
const PUBLISHABLE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const rid = Math.random().toString(36).slice(2, 8);
const ADMIN_EMAIL = `db-admin-${rid}@example.com`;
const ADMIN_PASSWORD = `Pw-${rid}-Aa1!`;
const EVENT_KEY = `dbtest_${rid}`;
const M1 = `${EVENT_KEY}_qm1`;
const M2 = `${EVENT_KEY}_qm2`;
const OTHER_MATCH = `dbtest_other_${rid}_qm1`;

let adminUserId = '';
let adminScoutId = '';
let adminClient: SupabaseClient;
let anonClient: SupabaseClient;

async function adminApiCreateUser(email: string, password: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SECRET_KEY,
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`create user failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.id as string;
}

beforeAll(async () => {
  // 1. Seed admin auth user.
  adminUserId = await adminApiCreateUser(ADMIN_EMAIL, ADMIN_PASSWORD);

  // 2. Admins are NOT scouts: profile holds only (auth_uid, role). No scout_id column.
  const profIns = await admin.from('profile').insert({
    auth_uid: adminUserId,
    role: 'admin',
  });
  if (profIns.error) throw profIns.error;

  // 3. Seed events (must exist before scout/match FKs).
  const evIns = await admin.from('event').insert({ event_key: EVENT_KEY, name: `DB Test ${rid}` });
  if (evIns.error) throw evIns.error;
  const ev2Ins = await admin
    .from('event')
    .insert({ event_key: `dbtest_other_${rid}`, name: `DB Other ${rid}` });
  if (ev2Ins.error) throw ev2Ins.error;

  // 4. Seed a real scout (a scouter) to reference in assignments. scout PK is `id`;
  //    requires event_key + a UNIQUE auth_uid (use a random uuid, distinct from the admin).
  const scoutIns = await admin
    .from('scout')
    .insert({ event_key: EVENT_KEY, display_name: `Scouter ${rid}`, auth_uid: crypto.randomUUID() })
    .select('id')
    .single();
  if (scoutIns.error) throw scoutIns.error;
  adminScoutId = scoutIns.data.id;

  const mIns = await admin.from('match').insert([
    {
      match_key: M1,
      event_key: EVENT_KEY,
      comp_level: 'qm',
      match_number: 1,
      red1: 100, red2: 101, red3: 102, blue1: 200, blue2: 201, blue3: 202,
    },
    {
      match_key: M2,
      event_key: EVENT_KEY,
      comp_level: 'qm',
      match_number: 2,
      red1: 110, red2: 111, red3: 112, blue1: 210, blue2: 211, blue3: 212,
    },
    {
      match_key: OTHER_MATCH,
      event_key: `dbtest_other_${rid}`,
      comp_level: 'qm',
      match_number: 1,
      red1: 1, red2: 2, red3: 3, blue1: 4, blue2: 5, blue3: 6,
    },
  ]);
  if (mIns.error) throw mIns.error;

  // 4. Sign in the admin (password) to get a JWT-scoped client.
  adminClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signIn = await adminClient.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (signIn.error) throw signIn.error;

  // 5. A brand-new anon client (no session, no membership, no role).
  anonClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
});

afterAll(async () => {
  // FK-safe order: assignment -> match -> scout -> event -> profile -> auth user.
  await admin.from('assignment').delete().eq('event_key', EVENT_KEY);
  await admin.from('match').delete().in('match_key', [M1, M2, OTHER_MATCH]);
  await admin.from('scout').delete().eq('id', adminScoutId);
  await admin.from('event').delete().in('event_key', [EVENT_KEY, `dbtest_other_${rid}`]);
  await admin.from('profile').delete().eq('auth_uid', adminUserId);
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${adminUserId}`, {
    method: 'DELETE',
    headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
  });
});

describe('is_staff / is_admin helpers', () => {
  it('returns true for the seeded admin', async () => {
    const staff = await adminClient.rpc('is_staff');
    expect(staff.error).toBeNull();
    expect(staff.data).toBe(true);
    const adm = await adminClient.rpc('is_admin');
    expect(adm.error).toBeNull();
    expect(adm.data).toBe(true);
  });

  it('returns false for a no-session anon caller', async () => {
    const staff = await anonClient.rpc('is_staff');
    expect(staff.error).toBeNull();
    expect(staff.data).toBe(false);
    const adm = await anonClient.rpc('is_admin');
    expect(adm.error).toBeNull();
    expect(adm.data).toBe(false);
  });
});

describe('staff read policies', () => {
  it('lets a staff user SELECT event and match', async () => {
    const ev = await adminClient.from('event').select('event_key').eq('event_key', EVENT_KEY);
    expect(ev.error).toBeNull();
    expect(ev.data?.length).toBe(1);
    const m = await adminClient.from('match').select('match_key').eq('event_key', EVENT_KEY);
    expect(m.error).toBeNull();
    expect(m.data?.length).toBe(2);
  });

  it('returns no rows for a brand-new anon with no membership and no role', async () => {
    const ev = await anonClient.from('event').select('event_key').eq('event_key', EVENT_KEY);
    expect(ev.error).toBeNull();
    expect(ev.data?.length).toBe(0);
  });
});

describe('set_assignments RPC', () => {
  it('inserts rows for an admin and validates match ownership', async () => {
    const payload = [
      {
        match_key: M1,
        scout_id: adminScoutId,
        alliance_color: 'red',
        station: 1,
        target_team_number: 100,
      },
      {
        match_key: M2,
        scout_id: adminScoutId,
        alliance_color: 'blue',
        station: 2,
        target_team_number: 211,
      },
      // null scout_id -> skipped
      {
        match_key: M1,
        scout_id: null,
        alliance_color: 'red',
        station: 2,
        target_team_number: 101,
      },
      // match in another event -> skipped
      {
        match_key: OTHER_MATCH,
        scout_id: adminScoutId,
        alliance_color: 'red',
        station: 3,
        target_team_number: 3,
      },
    ];
    const res = await adminClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: payload,
    });
    expect(res.error).toBeNull();
    expect(res.data).toBe(2);

    const rows = await admin
      .from('assignment')
      .select('match_key, source')
      .eq('event_key', EVENT_KEY);
    expect(rows.error).toBeNull();
    expect(rows.data?.length).toBe(2);
    expect(rows.data?.every((r) => r.source === 'auto')).toBe(true);
  });

  it('replaces prior assignments on re-publish', async () => {
    const res = await adminClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [
        {
          match_key: M1,
          scout_id: adminScoutId,
          alliance_color: 'red',
          station: 1,
          target_team_number: 100,
        },
      ],
    });
    expect(res.error).toBeNull();
    expect(res.data).toBe(1);
    const rows = await admin.from('assignment').select('match_key').eq('event_key', EVENT_KEY);
    expect(rows.data?.length).toBe(1);
  });

  it('rejects a non-admin caller with 42501', async () => {
    const res = await anonClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [],
    });
    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe('42501');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails (RPCs/policies do not exist yet).**

```bash
npm run test -- tests/db/admin.test.ts
```

Expected: FAIL — errors like `Could not find the function public.is_staff` / `public.set_assignments` (RPCs not created yet).

- [ ] **Step 3: Commit the failing test.**

```bash
git add tests/db/admin.test.ts && git commit -m "test(db): add admin RLS + set_assignments contract tests (failing)"
```

Expected: one commit created on `phase-1-admin`.

### Task DB2
**Files:**
- Create: `supabase/migrations/0005_admin.sql`
- Test: `tests/db/admin.test.ts` (already created in DB1)

**Interfaces:**
- Produces: `is_staff()`, `is_admin()`, `<table>_read_staff` policies (8 tables), `set_assignments(p_event_key text, p_assignments jsonb) returns int`, grants to `authenticated`.
- Consumes: same Phase 0 tables as DB1.

- [ ] **Step 1: Write the full migration `supabase/migrations/0005_admin.sql`.** Helpers are SECURITY DEFINER with pinned search_path; policies are additive permissive SELECT (membership policies untouched); `set_assignments` is admin-only with replace-then-insert, ownership validation, null-scout skip, and returns the inserted count.

```sql
-- supabase/migrations/0005_admin.sql
-- Phase 1: Admin staff helpers, additive staff-read policies, and set_assignments RPC.

-- 1. Staff/admin helpers (SECURITY DEFINER, pinned search_path).
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profile
    where auth_uid = auth.uid()
      and role in ('lead', 'admin')
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profile
    where auth_uid = auth.uid()
      and role = 'admin'
  );
$$;

grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- 2. Additive permissive staff-read policies (OR with existing membership policies).
drop policy if exists event_read_staff on public.event;
create policy event_read_staff on public.event
  for select to authenticated using (public.is_staff());

drop policy if exists event_team_read_staff on public.event_team;
create policy event_team_read_staff on public.event_team
  for select to authenticated using (public.is_staff());

drop policy if exists team_read_staff on public.team;
create policy team_read_staff on public.team
  for select to authenticated using (public.is_staff());

drop policy if exists match_read_staff on public.match;
create policy match_read_staff on public.match
  for select to authenticated using (public.is_staff());

drop policy if exists assignment_read_staff on public.assignment;
create policy assignment_read_staff on public.assignment
  for select to authenticated using (public.is_staff());

drop policy if exists scout_read_staff on public.scout;
create policy scout_read_staff on public.scout
  for select to authenticated using (public.is_staff());

drop policy if exists match_scouting_report_read_staff on public.match_scouting_report;
create policy match_scouting_report_read_staff on public.match_scouting_report
  for select to authenticated using (public.is_staff());

drop policy if exists pit_scouting_report_read_staff on public.pit_scouting_report;
create policy pit_scouting_report_read_staff on public.pit_scouting_report
  for select to authenticated using (public.is_staff());

-- 3. set_assignments: admin-only replace-then-insert with ownership validation.
create or replace function public.set_assignments(p_event_key text, p_assignments jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_elem jsonb;
  v_scout uuid;
  v_match text;
  v_count int := 0;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  delete from public.assignment where event_key = p_event_key;

  for v_elem in select * from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb))
  loop
    -- skip elements with null scout_id
    if v_elem->>'scout_id' is null then
      continue;
    end if;
    v_scout := (v_elem->>'scout_id')::uuid;
    v_match := v_elem->>'match_key';

    -- validate the match belongs to this event
    if not exists (
      select 1 from public.match
      where match_key = v_match and event_key = p_event_key
    ) then
      continue;
    end if;

    insert into public.assignment (
      event_key, match_key, scout_id, alliance_color, station, target_team_number, source
    ) values (
      p_event_key,
      v_match,
      v_scout,
      v_elem->>'alliance_color',
      (v_elem->>'station')::int,
      (v_elem->>'target_team_number')::int,
      coalesce(v_elem->>'source', 'auto')
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

grant execute on function public.set_assignments(text, jsonb) to authenticated;
```

- [ ] **Step 2: Apply the migration via the Management API.**

```bash
python3 .superpowers/sdd/apply-sql.py supabase/migrations/0005_admin.sql
```

Expected: prints `[]` (transactional success, no rows returned).

- [ ] **Step 3: Run the DB test suite — it should now pass.**

```bash
npm run test -- tests/db/admin.test.ts
```

Expected: PASS — all `is_staff`/`is_admin`, staff-read, and `set_assignments` (admin inserts 2, replace, 42501 for non-admin) assertions green.

- [ ] **Step 4: Commit the migration.**

```bash
git add supabase/migrations/0005_admin.sql && git commit -m "feat(db): add is_staff/is_admin helpers, staff-read policies, set_assignments RPC (0005)"
```

Expected: one commit created on `phase-1-admin`.

<!-- ===== Cluster ASSIGN ===== -->

### Task ASSIGN1

**Files:**
- Create: `src/admin/types.ts`
- Test: `src/admin/__tests__/autoAssign.test.ts`

**Interfaces:**
- Produces: `AssignMatch`, `AssignScout`, `AssignOptions`, `AllianceColor`, `Assignment` (exact frozen shapes)

- [ ] **Step 1: Write the types file.**
```ts
// src/admin/types.ts
export interface AssignMatch {
  matchKey: string;
  redTeams: [number, number, number];
  blueTeams: [number, number, number];
}

export interface AssignScout {
  id: string;
  displayName: string;
  unavailableMatchKeys?: string[];
}

export interface AssignOptions {
  ownTeam: number;
  breakEveryN: number;
  rotatePositions: boolean;
}

export type AllianceColor = 'red' | 'blue';

export interface Assignment {
  matchKey: string;
  scoutId: string;
  allianceColor: AllianceColor;
  station: 1 | 2 | 3;
  targetTeamNumber: number;
}
```
Run: `npx tsc --noEmit src/admin/types.ts`
Expected: no output (exit 0).
Commit: `git add src/admin/types.ts && git commit -m "feat(assign): add auto-assign domain types"`

### Task ASSIGN2

**Files:**
- Test: `src/admin/__tests__/autoAssign.test.ts`
- Create (stub only): `src/admin/autoAssign.ts`

**Interfaces:**
- Consumes: `AssignMatch`, `AllianceColor` from `src/admin/types.ts`
- Produces: `slotsForMatch(m: AssignMatch, ownTeam: number): { allianceColor: AllianceColor; station: 1|2|3; targetTeamNumber: number }[]`

- [ ] **Step 1: Write the failing `slotsForMatch` golden test (3256-slot-never-assigned at the slot level).**
```ts
// src/admin/__tests__/autoAssign.test.ts
import { describe, it, expect } from 'vitest';
import { slotsForMatch } from '../autoAssign';
import type { AssignMatch } from '../types';

const m1: AssignMatch = {
  matchKey: '2026casnv_qm1',
  redTeams: [3256, 254, 1678],
  blueTeams: [9999, 1323, 604],
};

describe('slotsForMatch', () => {
  it('returns all 6 slots when ownTeam is absent', () => {
    const m: AssignMatch = {
      matchKey: '2026casnv_qm2',
      redTeams: [11, 22, 33],
      blueTeams: [44, 55, 66],
    };
    const slots = slotsForMatch(m, 3256);
    expect(slots).toEqual([
      { allianceColor: 'red', station: 1, targetTeamNumber: 11 },
      { allianceColor: 'red', station: 2, targetTeamNumber: 22 },
      { allianceColor: 'red', station: 3, targetTeamNumber: 33 },
      { allianceColor: 'blue', station: 1, targetTeamNumber: 44 },
      { allianceColor: 'blue', station: 2, targetTeamNumber: 55 },
      { allianceColor: 'blue', station: 3, targetTeamNumber: 66 },
    ]);
  });

  it('omits exactly the slot whose targetTeamNumber === ownTeam (3256)', () => {
    const slots = slotsForMatch(m1, 3256);
    expect(slots).toHaveLength(5);
    expect(slots.some((s) => s.targetTeamNumber === 3256)).toBe(false);
    expect(slots).toEqual([
      { allianceColor: 'red', station: 2, targetTeamNumber: 254 },
      { allianceColor: 'red', station: 3, targetTeamNumber: 1678 },
      { allianceColor: 'blue', station: 1, targetTeamNumber: 9999 },
      { allianceColor: 'blue', station: 2, targetTeamNumber: 1323 },
      { allianceColor: 'blue', station: 3, targetTeamNumber: 604 },
    ]);
  });
});
```
- [ ] **Step 2: Write the failing stub so the import resolves but assertions fail.**
```ts
// src/admin/autoAssign.ts
import type { AssignMatch, AllianceColor } from './types';

export function slotsForMatch(
  _m: AssignMatch,
  _ownTeam: number,
): { allianceColor: AllianceColor; station: 1 | 2 | 3; targetTeamNumber: number }[] {
  return [];
}
```
Run: `npm run test -- src/admin/__tests__/autoAssign.test.ts`
Expected: FAIL — `slotsForMatch` returns `[]`, both assertions on contents fail.
Commit: `git add src/admin/autoAssign.ts src/admin/__tests__/autoAssign.test.ts && git commit -m "test(assign): failing slotsForMatch golden tests + stub"`

### Task ASSIGN3

**Files:**
- Modify: `src/admin/autoAssign.ts`
- Test: `src/admin/__tests__/autoAssign.test.ts` (already written in ASSIGN2)

**Interfaces:**
- Produces: working `slotsForMatch`

- [ ] **Step 1: Implement `slotsForMatch`.**
```ts
// src/admin/autoAssign.ts
import type { AssignMatch, AllianceColor } from './types';

interface Slot {
  allianceColor: AllianceColor;
  station: 1 | 2 | 3;
  targetTeamNumber: number;
}

export function slotsForMatch(m: AssignMatch, ownTeam: number): Slot[] {
  const slots: Slot[] = [];
  const stations: (1 | 2 | 3)[] = [1, 2, 3];
  for (const station of stations) {
    slots.push({ allianceColor: 'red', station, targetTeamNumber: m.redTeams[station - 1] });
  }
  for (const station of stations) {
    slots.push({ allianceColor: 'blue', station, targetTeamNumber: m.blueTeams[station - 1] });
  }
  return slots.filter((s) => s.targetTeamNumber !== ownTeam);
}
```
Run: `npm run test -- src/admin/__tests__/autoAssign.test.ts`
Expected: PASS — both `slotsForMatch` tests green.
Commit: `git add src/admin/autoAssign.ts && git commit -m "feat(assign): implement slotsForMatch (omit ownTeam slot)"`

### Task ASSIGN4

**Files:**
- Modify: `src/admin/autoAssign.ts`
- Test: `src/admin/__tests__/autoAssign.test.ts`

**Interfaces:**
- Consumes: `AssignMatch`, `AssignScout`, `AssignOptions`, `Assignment`
- Produces: `autoAssign(matches: AssignMatch[], scouts: AssignScout[], opts: AssignOptions): Assignment[]`

- [ ] **Step 1: Add a shared golden fixture builder + failing autoAssign tests (3256-skipped, balanced ±1, unavailable, deterministic). Append to the test file.**
```ts
// src/admin/__tests__/autoAssign.test.ts  (append)
import { autoAssign } from '../autoAssign';
import type { AssignScout, AssignOptions } from '../types';

// 12 matches, ownTeam 3256 placed in red station 1 of EVERY match (so exactly 5 slots/match = 60 slots).
function buildMatches(): AssignMatch[] {
  const matches: AssignMatch[] = [];
  for (let i = 1; i <= 12; i++) {
    const base = 100 + i * 10;
    matches.push({
      matchKey: `2026casnv_qm${i}`,
      redTeams: [3256, base + 1, base + 2],
      blueTeams: [base + 3, base + 4, base + 5],
    });
  }
  return matches;
}

function buildScouts(n: number): AssignScout[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    displayName: `Scout ${i + 1}`,
  }));
}

const OPTS: AssignOptions = { ownTeam: 3256, breakEveryN: 0, rotatePositions: false };

describe('autoAssign', () => {
  it('(a) never assigns the 3256 slot', () => {
    const out = autoAssign(buildMatches(), buildScouts(6), OPTS);
    expect(out.some((a) => a.targetTeamNumber === 3256)).toBe(false);
    // 12 matches * 5 slots = 60, 6 scouts always eligible -> all 60 filled
    expect(out).toHaveLength(60);
  });

  it('(b) balances assignments within ±1 across scouts', () => {
    const scouts = buildScouts(6);
    const out = autoAssign(buildMatches(), scouts, OPTS);
    const counts = scouts.map((s) => out.filter((a) => a.scoutId === s.id).length);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    expect(max - min).toBeLessThanOrEqual(1);
    // 60 slots / 6 scouts = exactly 10 each
    expect(counts).toEqual([10, 10, 10, 10, 10, 10]);
  });

  it('(c) respects unavailableMatchKeys (no slot in that match for that scout)', () => {
    const scouts = buildScouts(6);
    scouts[0].unavailableMatchKeys = ['2026casnv_qm1', '2026casnv_qm2'];
    const out = autoAssign(buildMatches(), scouts, OPTS);
    const s1InQm1 = out.filter((a) => a.scoutId === 's1' && a.matchKey === '2026casnv_qm1');
    const s1InQm2 = out.filter((a) => a.scoutId === 's1' && a.matchKey === '2026casnv_qm2');
    expect(s1InQm1).toHaveLength(0);
    expect(s1InQm2).toHaveLength(0);
  });

  it('(d) is deterministic (same inputs -> identical output)', () => {
    const a = autoAssign(buildMatches(), buildScouts(6), OPTS);
    const b = autoAssign(buildMatches(), buildScouts(6), OPTS);
    expect(a).toEqual(b);
  });
});
```
- [ ] **Step 2: Add a throwing stub for `autoAssign` so the suite compiles and fails on assertions.**
```ts
// src/admin/autoAssign.ts  (append)
import type { AssignScout, AssignOptions, Assignment } from './types';

export function autoAssign(
  _matches: AssignMatch[],
  _scouts: AssignScout[],
  _opts: AssignOptions,
): Assignment[] {
  return [];
}
```
Run: `npm run test -- src/admin/__tests__/autoAssign.test.ts`
Expected: FAIL — autoAssign returns `[]`; length/balance/determinism-on-empty assertions fail (determinism passes trivially but (a)/(b)/(c) fail).
Commit: `git add src/admin/autoAssign.ts src/admin/__tests__/autoAssign.test.ts && git commit -m "test(assign): failing autoAssign golden tests + stub"`

### Task ASSIGN5

**Files:**
- Modify: `src/admin/autoAssign.ts`
- Test: `src/admin/__tests__/autoAssign.test.ts` (from ASSIGN4)

**Interfaces:**
- Produces: working `autoAssign` (balanced, availability-respecting, deterministic; break + previous-match + rotation logic)

- [ ] **Step 1: Replace the `autoAssign` stub with the full implementation.**
```ts
// src/admin/autoAssign.ts  (replace the autoAssign stub from ASSIGN4 with this)
export function autoAssign(
  matches: AssignMatch[],
  scouts: AssignScout[],
  opts: AssignOptions,
): Assignment[] {
  const result: Assignment[] = [];

  // Per-scout running state.
  const totalCount = new Map<string, number>(); // total assignments so far
  const consecutive = new Map<string, number>(); // consecutive assignments without a rest
  const lastStation = new Map<string, number>(); // last station scouted (for rotation bias)
  const lastColor = new Map<string, AllianceColor>(); // last alliance color (for rotation bias)
  for (const s of scouts) {
    totalCount.set(s.id, 0);
    consecutive.set(s.id, 0);
  }

  const scoutOrder = new Map<string, number>();
  scouts.forEach((s, i) => scoutOrder.set(s.id, i));

  for (const match of matches) {
    const slots = slotsForMatch(match, opts.ownTeam);
    const usedThisMatch = new Set<string>();
    // Scouts who scouted the immediately previous match (to skip when pool > slots).
    const prevMatchScouts = new Set<string>();
    for (const a of result) {
      if (matches.length && a.matchKey === prevMatchKey(matches, match)) {
        prevMatchScouts.add(a.scoutId);
      }
    }

    for (const slot of slots) {
      const eligible = scouts.filter((s) => {
        if (usedThisMatch.has(s.id)) return false;
        if (s.unavailableMatchKeys?.includes(match.matchKey)) return false;
        // Scheduled break: if breakEveryN>0 and this scout has hit the cadence, rest this match.
        if (opts.breakEveryN > 0 && (consecutive.get(s.id) ?? 0) >= opts.breakEveryN) return false;
        return true;
      });

      // When the pool is larger than slots, also avoid back-to-back same scout.
      const slotsThisMatch = slots.length;
      let pool = eligible;
      if (scouts.length > slotsThisMatch) {
        const filtered = eligible.filter((s) => !prevMatchScouts.has(s.id));
        if (filtered.length > 0) pool = filtered;
      }

      if (pool.length === 0) continue; // slot omitted: no eligible scout

      pool.sort((a, b) => {
        const ca = totalCount.get(a.id) ?? 0;
        const cb = totalCount.get(b.id) ?? 0;
        if (ca !== cb) return ca - cb; // fewest assignments first
        if (opts.rotatePositions) {
          const ra = rotationPenalty(a.id, slot, lastStation, lastColor);
          const rb = rotationPenalty(b.id, slot, lastStation, lastColor);
          if (ra !== rb) return ra - rb; // prefer scout who varies station/color
        }
        return (scoutOrder.get(a.id) ?? 0) - (scoutOrder.get(b.id) ?? 0); // stable tie-break
      });

      const chosen = pool[0];
      result.push({
        matchKey: match.matchKey,
        scoutId: chosen.id,
        allianceColor: slot.allianceColor,
        station: slot.station,
        targetTeamNumber: slot.targetTeamNumber,
      });
      usedThisMatch.add(chosen.id);
      totalCount.set(chosen.id, (totalCount.get(chosen.id) ?? 0) + 1);
      lastStation.set(chosen.id, slot.station);
      lastColor.set(chosen.id, slot.allianceColor);
    }

    // Update consecutive counters after the match: anyone who worked +1, anyone who rested ->0.
    for (const s of scouts) {
      if (usedThisMatch.has(s.id)) {
        consecutive.set(s.id, (consecutive.get(s.id) ?? 0) + 1);
      } else {
        consecutive.set(s.id, 0); // a missed match counts as a rest, breaking the streak
      }
    }
  }

  return result;
}

function prevMatchKey(matches: AssignMatch[], current: AssignMatch): string | null {
  const idx = matches.indexOf(current);
  return idx > 0 ? matches[idx - 1].matchKey : null;
}

function rotationPenalty(
  scoutId: string,
  slot: { allianceColor: AllianceColor; station: 1 | 2 | 3 },
  lastStation: Map<string, number>,
  lastColor: Map<string, AllianceColor>,
): number {
  let penalty = 0;
  if (lastStation.get(scoutId) === slot.station) penalty += 1;
  if (lastColor.get(scoutId) === slot.allianceColor) penalty += 1;
  return penalty;
}
```
Run: `npm run test -- src/admin/__tests__/autoAssign.test.ts`
Expected: PASS — all of (a) length 60 / no-3256, (b) `[10,10,10,10,10,10]`, (c) unavailable respected, (d) deterministic green.
Commit: `git add src/admin/autoAssign.ts && git commit -m "feat(assign): implement autoAssign (balanced, availability, rotation, breaks)"`

### Task ASSIGN6

**Files:**
- Test: `src/admin/__tests__/autoAssign.test.ts`
- Modify (if needed): `src/admin/autoAssign.ts`

**Interfaces:**
- Consumes: working `autoAssign`
- Produces: break-cadence golden coverage (no scout exceeds `breakEveryN` consecutive assignments)

- [ ] **Step 1: Append the break-cadence golden test. By construction: 3 scouts, 6 matches with exactly 3 scoutable slots each (ownTeam in red1 and blue... no — keep 5 slots but make pool small so streaks form). Use breakEveryN=2 and assert no scout has 3+ consecutive worked matches.**
```ts
// src/admin/__tests__/autoAssign.test.ts  (append)
describe('autoAssign break cadence', () => {
  // Helper: longest run of consecutive matches (in match order) a scout is assigned to.
  function longestStreak(out: Assignment[], matches: AssignMatch[], scoutId: string): number {
    let best = 0;
    let cur = 0;
    for (const m of matches) {
      const worked = out.some((a) => a.matchKey === m.matchKey && a.scoutId === scoutId);
      if (worked) {
        cur += 1;
        best = Math.max(best, cur);
      } else {
        cur = 0;
      }
    }
    return best;
  }

  it('(e) no scout exceeds breakEveryN consecutive assignments', () => {
    const matches = buildMatches(); // 12 matches, 5 slots each
    const scouts = buildScouts(6);
    const opts: AssignOptions = { ownTeam: 3256, breakEveryN: 2, rotatePositions: false };
    const out = autoAssign(matches, scouts, opts);
    for (const s of scouts) {
      expect(longestStreak(out, matches, s.id)).toBeLessThanOrEqual(2);
    }
    // Sanity: still produced assignments and never touched 3256.
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((a) => a.targetTeamNumber === 3256)).toBe(false);
  });
});
```
- [ ] **Step 2: Import `Assignment` type in the test header (used by `longestStreak`). Add to the existing top-of-file type import.**
```ts
// src/admin/__tests__/autoAssign.test.ts  — ensure this import line includes Assignment
import type { AssignMatch, AssignScout, AssignOptions, Assignment } from '../types';
```
(Remove the now-duplicate partial type imports added in ASSIGN2/ASSIGN4 so each type is imported once.)
Run: `npm run test -- src/admin/__tests__/autoAssign.test.ts`
Expected: PASS — break-cadence streak ≤ 2 for every scout; all prior tests still green.
Commit: `git add src/admin/__tests__/autoAssign.test.ts && git commit -m "test(assign): break-cadence golden test (consecutive <= breakEveryN)"`

### Task ASSIGN7

**Files:**
- Test/verify only: `src/admin/types.ts`, `src/admin/autoAssign.ts`, `src/admin/__tests__/autoAssign.test.ts`

**Interfaces:**
- Consumes: full ASSIGN cluster
- Produces: typecheck-clean, fully-green pure module

- [ ] **Step 1: Typecheck the whole cluster and run the full ASSIGN suite.**
Run: `npm run typecheck && npm run test -- src/admin/__tests__/autoAssign.test.ts`
Expected: typecheck exits 0 (no errors); vitest reports all `slotsForMatch` + `autoAssign` + break-cadence tests passing, 0 failures.
Commit: `git commit --allow-empty -m "chore(assign): verify auto-assign module green (typecheck + golden tests)"`

<!-- ===== Cluster EF ===== -->

I now have all the exact conventions. Drafting the EF cluster tasks.

### Task EF1
**Files:**
- Create: `supabase/functions/import-event/index.ts`

**Interfaces:**
- Consumes: `corsHeaders` from `../_shared/cors.ts`; `createClient` from `https://esm.sh/@supabase/supabase-js@2`; env `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TBA_API_KEY`; the live RPC `is_admin()` (Cluster DB / 0005); TBA v3 endpoints `/event/{key}`, `/event/{key}/teams`, `/event/{key}/matches`.
- Produces: `POST /functions/v1/import-event` with body `{ event_key: string }` and header `Authorization: Bearer <admin JWT>` → 200 `{ event_key, name, team_count, match_count, join_code }`; 403 if caller is not admin; OPTIONS → CORS preflight.

- [ ] **Step 1: Create the function file skeleton (imports, env, helpers, OPTIONS, admin gate).** Write `supabase/functions/import-event/index.ts`:
```ts
// supabase/functions/import-event/index.ts
// Admin-gated TBA import. Verifies the caller is an admin (rpc is_admin via the
// caller's JWT), fetches TBA event/teams/matches, filters to comp_level==='qm',
// and upserts event/team/event_team/match using a service-role client. Ensures
// the event has an 8-char join_code. Idempotent (all writes are upserts).
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";
const TBA_API_KEY = Deno.env.get("TBA_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

interface TbaEvent {
  name: string;
  start_date: string | null;
  end_date: string | null;
  timezone: string | null;
  city: string | null;
  state_prov: string | null;
}
interface TbaTeam {
  team_number: number;
  nickname: string | null;
  city: string | null;
  state_prov: string | null;
  rookie_year: number | null;
}
interface TbaMatch {
  key: string;
  comp_level: string;
  match_number: number;
  time: number | null;
  alliances: {
    red: { team_keys: string[] };
    blue: { team_keys: string[] };
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Parse 'frcNNNN' → NNNN (int). Missing/short alliances tolerated as null.
function teamNum(teamKey: string | undefined): number | null {
  if (!teamKey) return null;
  const n = parseInt(teamKey.replace("frc", ""), 10);
  return Number.isFinite(n) ? n : null;
}

function randomJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function tba<T>(path: string): Promise<T> {
  const res = await fetch(`${TBA_BASE}${path}`, {
    headers: { "X-TBA-Auth-Key": TBA_API_KEY, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`TBA ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  if (!TBA_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "function not configured" }, 500);
  }

  // (1) Admin gate: build a client bound to the caller's JWT and call is_admin().
  const authHeader = req.headers.get("Authorization") ?? "";
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: isAdmin, error: adminErr } = await caller.rpc("is_admin");
  if (adminErr || isAdmin !== true) {
    return json({ error: "forbidden: admin only" }, 403);
  }

  let body: { event_key?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const eventKey = body.event_key;
  if (!eventKey || typeof eventKey !== "string") {
    return json({ error: "missing event_key" }, 400);
  }

  return await runImport(eventKey);
});

async function runImport(eventKey: string): Promise<Response> {
  throw new Error("not implemented");
}
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && deno check supabase/functions/import-event/index.ts`
Expected: `Check file:///.../import-event/index.ts` with no type errors (the `runImport` stub is intentional; replaced in Step 2).
Commit: `git add supabase/functions/import-event/index.ts && git commit -m "feat(import-event): scaffold function with admin gate + CORS"`

- [ ] **Step 2: Implement `runImport` (TBA fetch, qm filter, service-role upserts, join_code, summary).** Replace the `runImport` stub at the end of `supabase/functions/import-event/index.ts`:
```ts
async function runImport(eventKey: string): Promise<Response> {
  // (2) Fetch TBA event/teams/matches.
  let ev: TbaEvent;
  let teams: TbaTeam[];
  let matches: TbaMatch[];
  try {
    [ev, teams, matches] = await Promise.all([
      tba<TbaEvent>(`/event/${eventKey}`),
      tba<TbaTeam[]>(`/event/${eventKey}/teams`),
      tba<TbaMatch[]>(`/event/${eventKey}/matches`),
    ]);
  } catch (e) {
    return json({ error: `TBA fetch failed: ${(e as Error).message}` }, 502);
  }

  // (3) Filter matches to qualification only.
  const qmMatches = matches.filter((m) => m.comp_level === "qm");

  // (4) Service-role writes.
  const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: evErr } = await svc.from("event").upsert({
    event_key: eventKey,
    name: ev.name,
    start_date: ev.start_date,
    end_date: ev.end_date,
    timezone: ev.timezone,
    city: ev.city,
    state_prov: ev.state_prov,
    is_active: true,
    imported_at: new Date().toISOString(),
  });
  if (evErr) return json({ error: `event upsert: ${evErr.message}` }, 500);

  if (teams.length > 0) {
    const { error: teamErr } = await svc.from("team").upsert(
      teams.map((t) => ({
        team_number: t.team_number,
        nickname: t.nickname,
        city: t.city,
        state_prov: t.state_prov,
        rookie_year: t.rookie_year,
      })),
    );
    if (teamErr) return json({ error: `team upsert: ${teamErr.message}` }, 500);

    const { error: etErr } = await svc.from("event_team").upsert(
      teams.map((t) => ({ event_key: eventKey, team_number: t.team_number })),
    );
    if (etErr) return json({ error: `event_team upsert: ${etErr.message}` }, 500);
  }

  if (qmMatches.length > 0) {
    const { error: mErr } = await svc.from("match").upsert(
      qmMatches.map((m) => ({
        match_key: m.key,
        event_key: eventKey,
        comp_level: "qm",
        match_number: m.match_number,
        scheduled_time: m.time ? new Date(m.time * 1000).toISOString() : null,
        red1: teamNum(m.alliances.red.team_keys[0]),
        red2: teamNum(m.alliances.red.team_keys[1]),
        red3: teamNum(m.alliances.red.team_keys[2]),
        blue1: teamNum(m.alliances.blue.team_keys[0]),
        blue2: teamNum(m.alliances.blue.team_keys[1]),
        blue3: teamNum(m.alliances.blue.team_keys[2]),
      })),
    );
    if (mErr) return json({ error: `match upsert: ${mErr.message}` }, 500);
  }

  // (5) Ensure event_secret has a join_code.
  const { data: secret } = await svc
    .from("event_secret")
    .select("join_code")
    .eq("event_key", eventKey)
    .maybeSingle();
  let joinCode = secret?.join_code ?? "";
  if (!joinCode) {
    joinCode = randomJoinCode();
    const { error: secErr } = await svc
      .from("event_secret")
      .upsert({ event_key: eventKey, join_code: joinCode });
    if (secErr) return json({ error: `event_secret upsert: ${secErr.message}` }, 500);
  }

  // (6) Summary.
  return json(
    {
      event_key: eventKey,
      name: ev.name,
      team_count: teams.length,
      match_count: qmMatches.length,
      join_code: joinCode,
    },
    200,
  );
}
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && deno check supabase/functions/import-event/index.ts`
Expected: `Check file:///.../import-event/index.ts` with no type errors.
Commit: `git add supabase/functions/import-event/index.ts && git commit -m "feat(import-event): TBA fetch, qm filter, service-role upserts, join_code, summary"`

### Task EF2
**Files:**
- Test: `tests/functions/import-event.test.ts`

**Interfaces:**
- Consumes: deployed `POST /functions/v1/import-event`; live RPC `is_admin()` and tables `match`, `event` via service-role client; env `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (anon), `SUPABASE_SECRET_KEY` (service role), `TEST_ADMIN_EMAIL`, `TEST_ADMIN_PASSWORD`.
- Produces: vitest suite asserting 200 / `team_count===37` / 0 non-qm rows for admin, and 403 for anon.

- [ ] **Step 1: Write the failing integration test.** Create `tests/functions/import-event.test.ts`:
```ts
// tests/functions/import-event.test.ts
// Integration test against the DEPLOYED import-event edge function.
// Signs in the seeded test admin (email/password) to obtain a JWT, POSTs
// { event_key: '2026casnv' }, and asserts the import summary + that the DB
// contains 37 teams and ZERO non-qm matches. Also asserts an anon caller → 403.
// Leaves 2026casnv imported (it is the real Phase-1 test event).
import { describe, it, expect, beforeAll } from "vitest";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL as string;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY as string;
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL as string;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD as string;
const BASE = `${SUPABASE_URL}/functions/v1/import-event`;
const EVENT_KEY = "2026casnv";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let adminJwt = "";

beforeAll(async () => {
  const authed = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authed.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error(`admin sign-in failed: ${error?.message ?? "no session"}`);
  }
  adminJwt = data.session.access_token;
});

describe("import-event (deployed)", () => {
  it("imports 2026casnv as admin → 200 with 37 teams and only qm matches", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON,
        Authorization: `Bearer ${adminJwt}`,
      },
      body: JSON.stringify({ event_key: EVENT_KEY }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event_key).toBe(EVENT_KEY);
    expect(body.team_count).toBe(37);
    expect(body.match_count).toBeGreaterThan(0);
    expect(typeof body.join_code).toBe("string");
    expect(body.join_code.length).toBe(8);

    // No non-qm matches were persisted for this event.
    const { count, error } = await admin
      .from("match")
      .select("match_key", { count: "exact", head: true })
      .eq("event_key", EVENT_KEY)
      .neq("comp_level", "qm");
    expect(error).toBeNull();
    expect(count).toBe(0);

    // The persisted qm count matches the reported summary.
    const { count: qmCount } = await admin
      .from("match")
      .select("match_key", { count: "exact", head: true })
      .eq("event_key", EVENT_KEY)
      .eq("comp_level", "qm");
    expect(qmCount).toBe(body.match_count);
  });

  it("rejects an anonymous caller with 403", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON,
        Authorization: `Bearer ${ANON}`,
      },
      body: JSON.stringify({ event_key: EVENT_KEY }),
    });
    expect(res.status).toBe(403);
  });
});
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- tests/functions/import-event.test.ts`
Expected: FAILS at the fetch — the function is not yet deployed, so `res.status` is not 200 (connection/404). This confirms the test is wired up before deploy.
Commit: `git add tests/functions/import-event.test.ts && git commit -m "test(import-event): failing deployed-function integration test"`

### Task EF3
**Files:**
- Modify: none (deploy + verification of `supabase/functions/import-event/index.ts` against `tests/functions/import-event.test.ts`)

**Interfaces:**
- Consumes: documented deploy command; `0005_admin.sql` (`is_admin()`) MUST already be applied to the live DB (Cluster DB dependency); env `SUPABASE_ACCESS_TOKEN`, `TBA_API_KEY`, seeded `TEST_ADMIN_*`.
- Produces: deployed `import-event` edge function; `2026casnv` imported (37 teams, qm-only matches) and left in place.

- [ ] **Step 1: Deploy the function.** Run:
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && set -a; . ./.env.local; set +a; SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" npx --yes supabase@latest functions deploy import-event --project-ref oztsfxyfovwnwutrxzmo --no-verify-jwt
```
Expected: `Deployed Functions on project oztsfxyfovwnwutrxzmo: import-event` (no error). Note `--no-verify-jwt` is required so OPTIONS/anon requests reach the function and the in-function `is_admin()` gate returns 403 itself (rather than the platform rejecting before our code runs).
Commit: `git commit --allow-empty -m "chore(import-event): deploy edge function to oztsfxyfovwnwutrxzmo"`

- [ ] **Step 2: Confirm `TBA_API_KEY` is present as a function secret, then green the integration test.** Set the secret (idempotent) and run the test:
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && set -a; . ./.env.local; set +a; SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" npx --yes supabase@latest secrets set TBA_API_KEY="$TBA_API_KEY" --project-ref oztsfxyfovwnwutrxzmo && npm run test -- tests/functions/import-event.test.ts
```
Expected: `secrets set` succeeds, then vitest prints `2 passed` for `import-event (deployed)` — `team_count===37`, `count` of non-qm rows `=== 0`, persisted qm count equals `body.match_count`, and the anon caller returns 403.
Commit: `git commit --allow-empty -m "test(import-event): green deployed integration (2026casnv 37 teams, qm-only, anon 403)"`

<!-- ===== Cluster AUTH ===== -->

I have everything needed. Drafting the tasks.

### Task AUTH1

**Files:**
- Test: `src/auth/__tests__/adminAuth.test.tsx`
- Create: `src/auth/adminAuth.ts`

**Interfaces:**
- Consumes: `supabase` from `src/lib/supabase.ts` (`supabase.auth.signInWithPassword`, `supabase.auth.signOut`)
- Produces: `export async function adminSignIn(email: string, password: string): Promise<void>` and `export async function adminSignOut(): Promise<void>`

- [ ] **Step 1: Write failing test for adminAuth.**

```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/auth/__tests__/adminAuth.test.tsx <<'EOF'
// src/auth/__tests__/adminAuth.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';

const signInWithPassword = vi.fn();
const signOut = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: { auth: { signInWithPassword: (...a: unknown[]) => signInWithPassword(...a), signOut: (...a: unknown[]) => signOut(...a) } },
}));

import { adminSignIn, adminSignOut } from '../adminAuth';

beforeEach(() => {
  signInWithPassword.mockReset();
  signOut.mockReset();
});

describe('adminSignIn', () => {
  it('calls signInWithPassword with credentials on success', async () => {
    signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
    await expect(adminSignIn('a@b.com', 'pw')).resolves.toBeUndefined();
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.com', password: 'pw' });
  });

  it('throws when supabase returns an error', async () => {
    signInWithPassword.mockResolvedValue({ data: { session: null }, error: { message: 'Invalid login credentials' } });
    await expect(adminSignIn('a@b.com', 'bad')).rejects.toThrow('Invalid login credentials');
  });
});

describe('adminSignOut', () => {
  it('calls signOut', async () => {
    signOut.mockResolvedValue({ error: null });
    await expect(adminSignOut()).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalled();
  });
});
EOF
npm run test -- src/auth/__tests__/adminAuth.test.tsx 2>&1 | tail -20
```
Expected output: test run FAILS to resolve `../adminAuth` (module not found / cannot find file).

- [ ] **Step 2: Implement adminAuth.ts to pass.**

```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/auth/adminAuth.ts <<'EOF'
// src/auth/adminAuth.ts
import { supabase } from '../lib/supabase';

/** Sign in an admin/lead via email + password. Throws on auth error. */
export async function adminSignIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/** Sign out the current session. Throws on error. */
export async function adminSignOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}
EOF
npm run test -- src/auth/__tests__/adminAuth.test.tsx 2>&1 | tail -15
```
Expected output: 3 tests pass (`adminSignIn` success + throw, `adminSignOut`).

- [ ] **Step 3: Commit.**

```bash
git -C /Users/ryanabraham/Downloads/FRC-scouting-app add src/auth/adminAuth.ts src/auth/__tests__/adminAuth.test.tsx
git -C /Users/ryanabraham/Downloads/FRC-scouting-app commit -m "feat(auth): add adminSignIn/adminSignOut helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected output: one commit created with 2 files changed.

### Task AUTH2

**Files:**
- Test: `src/auth/__tests__/AdminLogin.test.tsx`
- Create: `src/auth/AdminLogin.tsx`

**Interfaces:**
- Consumes: `adminSignIn` from `src/auth/adminAuth.ts`; `useNavigate` from `react-router-dom`; shadcn `@/components/ui/{card,input,label,button}`
- Produces: `export function AdminLogin(): JSX.Element` (and `export default AdminLogin`). On success `navigate('/admin')`; on error renders testid `admin-login-error`. Testids: `admin-email`, `admin-password`, `admin-login-submit`, `admin-login-error`.

- [ ] **Step 1: Write failing test for AdminLogin.**

```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/auth/__tests__/AdminLogin.test.tsx <<'EOF'
// src/auth/__tests__/AdminLogin.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

const adminSignIn = vi.fn();
vi.mock('../adminAuth', () => ({
  adminSignIn: (...a: unknown[]) => adminSignIn(...a),
}));

import { AdminLogin } from '../AdminLogin';

beforeEach(() => {
  navigate.mockReset();
  adminSignIn.mockReset();
});

describe('AdminLogin', () => {
  it('signs in and navigates to /admin on success', async () => {
    adminSignIn.mockResolvedValue(undefined);
    render(<AdminLogin />);

    fireEvent.change(screen.getByTestId('admin-email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByTestId('admin-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('admin-login-submit'));

    await waitFor(() => expect(adminSignIn).toHaveBeenCalledWith('a@b.com', 'pw'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin'));
  });

  it('shows an error and does not navigate on failure', async () => {
    adminSignIn.mockRejectedValue(new Error('Invalid login credentials'));
    render(<AdminLogin />);

    fireEvent.change(screen.getByTestId('admin-email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByTestId('admin-password'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByTestId('admin-login-submit'));

    await waitFor(() => expect(screen.getByTestId('admin-login-error')).toHaveTextContent('Invalid login credentials'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('disables submit while in flight (no double submit)', async () => {
    let resolve!: () => void;
    adminSignIn.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    render(<AdminLogin />);

    fireEvent.change(screen.getByTestId('admin-email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByTestId('admin-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('admin-login-submit'));
    fireEvent.click(screen.getByTestId('admin-login-submit'));

    await waitFor(() => expect(adminSignIn).toHaveBeenCalledTimes(1));
    resolve();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin'));
  });
});
EOF
npm run test -- src/auth/__tests__/AdminLogin.test.tsx 2>&1 | tail -15
```
Expected output: FAILS to resolve `../AdminLogin` (module not found).

- [ ] **Step 2: Implement AdminLogin.tsx to pass.**

```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/auth/AdminLogin.tsx <<'EOF'
// src/auth/AdminLogin.tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminSignIn } from './adminAuth';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export function AdminLogin(): JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        await adminSignIn(email, password);
        navigate('/admin');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign in failed.');
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Admin Login</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-email-input">Email</Label>
              <Input
                id="admin-email-input"
                data-testid="admin-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                className="h-11"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-password-input">Password</Label>
              <Input
                id="admin-password-input"
                data-testid="admin-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="h-11"
              />
            </div>
            {error !== null && (
              <p
                data-testid="admin-login-error"
                role="alert"
                aria-live="assertive"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
            <Button
              data-testid="admin-login-submit"
              type="submit"
              disabled={busy}
              className="h-11 w-full"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default AdminLogin;
EOF
npm run test -- src/auth/__tests__/AdminLogin.test.tsx 2>&1 | tail -15
```
Expected output: 3 tests pass (success-navigate, error-shown, no-double-submit).

- [ ] **Step 3: Commit.**

```bash
git -C /Users/ryanabraham/Downloads/FRC-scouting-app add src/auth/AdminLogin.tsx src/auth/__tests__/AdminLogin.test.tsx
git -C /Users/ryanabraham/Downloads/FRC-scouting-app commit -m "feat(auth): add AdminLogin email/password screen

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected output: one commit created with 2 files changed.

### Task AUTH3

**Files:**
- Modify: `src/routes/guards.tsx`
- Test: `src/auth/__tests__/guards.test.tsx` (existing — extend; existing cases MUST stay green)

**Interfaces:**
- Produces: `export function RequireRole({ role, redirectTo }: { role: Role; redirectTo?: string }): JSX.Element` where `redirectTo` defaults to `'/scout'`. On insufficient role (with scout present) it navigates to `redirectTo`; no-scout still redirects to `/join`. `RequireSession` unchanged.

- [ ] **Step 1: Add a failing test asserting redirectTo is honored.** Append a new describe block that mounts `RequireRole` with `redirectTo="/login"` and an insufficient role, expecting a `/login` landing.

```bash
cat >> /Users/ryanabraham/Downloads/FRC-scouting-app/src/auth/__tests__/guards.test.tsx <<'EOF'

/** Routes for RequireRole with a custom redirectTo target (/login). */
function renderRoleAtWithRedirect(path: string, role: 'scouter' | 'lead' | 'admin') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<RequireRole role={role} redirectTo="/login" />}>
          <Route path="/admin" element={<div data-testid="admin">ADMIN</div>} />
        </Route>
        <Route path="/scout" element={<div data-testid="scout">SCOUT</div>} />
        <Route path="/login" element={<div data-testid="login">LOGIN</div>} />
        <Route path="/join" element={<div data-testid="join">JOIN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireRole redirectTo', () => {
  it('redirects to redirectTo when role insufficient', () => {
    useSession.mockReturnValue({ loading: false, scout: { id: 's1' }, role: 'scouter' });
    renderRoleAtWithRedirect('/admin', 'admin');
    expect(screen.getByTestId('login')).toBeInTheDocument();
  });

  it('still redirects to /join when no scout even with redirectTo', () => {
    useSession.mockReturnValue({ loading: false, scout: null, role: null });
    renderRoleAtWithRedirect('/admin', 'admin');
    expect(screen.getByTestId('join')).toBeInTheDocument();
  });
});
EOF
npm run test -- src/auth/__tests__/guards.test.tsx 2>&1 | tail -20
```
Expected output: the existing 6 cases pass; the new `redirects to redirectTo when role insufficient` FAILS (lands on `/scout`, not `/login`) because `redirectTo` is not yet implemented.

- [ ] **Step 2: Implement redirectTo in guards.tsx.**

```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/routes/guards.tsx <<'EOF'
// src/routes/guards.tsx
import { Navigate, Outlet } from 'react-router-dom';
import { useSession } from '../auth/useSession';
import { hasRole, type Role } from '../auth/roles';

function AuthLoading(): JSX.Element {
  return (
    <div data-testid="auth-loading" className="flex min-h-screen items-center justify-center">
      <p className="text-gray-500">Loading…</p>
    </div>
  );
}

/** Gate that requires a joined scout; otherwise redirect to /join. */
export function RequireSession(): JSX.Element {
  const { loading, scout } = useSession();
  if (loading) return <AuthLoading />;
  if (!scout) return <Navigate to="/join" replace />;
  return <Outlet />;
}

/** Gate that requires a scout AND a sufficient role; otherwise redirect. */
export function RequireRole({
  role,
  redirectTo = '/scout',
}: {
  role: Role;
  redirectTo?: string;
}): JSX.Element {
  const { loading, scout, role: actual } = useSession();
  if (loading) return <AuthLoading />;
  if (!scout) return <Navigate to="/join" replace />;
  if (!hasRole(actual, role)) return <Navigate to={redirectTo} replace />;
  return <Outlet />;
}
EOF
npm run test -- src/auth/__tests__/guards.test.tsx 2>&1 | tail -20
```
Expected output: all 8 cases pass (6 original including default `/scout` redirect + 2 new `redirectTo` cases).

- [ ] **Step 3: Commit.**

```bash
git -C /Users/ryanabraham/Downloads/FRC-scouting-app add src/routes/guards.tsx src/auth/__tests__/guards.test.tsx
git -C /Users/ryanabraham/Downloads/FRC-scouting-app commit -m "feat(routes): add optional redirectTo to RequireRole

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected output: one commit created with 2 files changed.

### Task AUTH4

**Files:**
- Modify: `src/routes/router.tsx`
- Test: `src/auth/__tests__/router.test.tsx` (existing — extend; existing cases MUST stay green)

**Interfaces:**
- Consumes: `AdminLogin` (default export) from `src/auth/AdminLogin.tsx`; `RequireRole` with `redirectTo`
- Produces: public route `'/login'` → `<AdminLogin />`; `/admin` and `/dashboard` `RequireRole` now pass `redirectTo="/login"`. `/join`, `/scout`, `/`, `*` unchanged.

- [ ] **Step 1: Add a failing test for the public /login route and /admin → /login redirect.** Append cases to the existing router test (its module mock forces `scout: null`, so an unauthenticated `/admin` still resolves to `/join` because the no-scout rule wins — assert `/login` is served publicly, and add a second router-level test that mounts with a scout-but-insufficient-role session).

```bash
cat >> /Users/ryanabraham/Downloads/FRC-scouting-app/src/auth/__tests__/router.test.tsx <<'EOF'

describe('router /login', () => {
  it('serves /login publicly (AdminLogin)', () => {
    renderAt('/login');
    expect(screen.getByTestId('admin-login-submit')).toBeInTheDocument();
  });
});
EOF
npm run test -- src/auth/__tests__/router.test.tsx 2>&1 | tail -20
```
Expected output: existing 4 cases pass; new `serves /login publicly (AdminLogin)` FAILS (route not found → falls through to `*` → `/scout` → `/join`, so `admin-login-submit` is absent).

- [ ] **Step 2: Add /login route and redirectTo wiring in router.tsx.**

```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/routes/router.tsx <<'EOF'
// src/routes/router.tsx
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
  type RouteObject,
} from 'react-router-dom';
import { RequireSession, RequireRole } from './guards';
import JoinPlaceholder from './JoinPlaceholder';
import ScoutPlaceholder from './ScoutPlaceholder';
import AdminPlaceholder from './AdminPlaceholder';
import DashboardPlaceholder from './DashboardPlaceholder';
import AdminLogin from '../auth/AdminLogin';

export const routes: RouteObject[] = [
  { path: '/', element: <Navigate to="/scout" replace /> },
  { path: '/join', element: <JoinPlaceholder /> },
  { path: '/login', element: <AdminLogin /> },
  {
    element: <RequireSession />,
    children: [{ path: '/scout', element: <ScoutPlaceholder /> }],
  },
  {
    element: <RequireRole role="lead" redirectTo="/login" />,
    children: [{ path: '/dashboard', element: <DashboardPlaceholder /> }],
  },
  {
    element: <RequireRole role="admin" redirectTo="/login" />,
    children: [{ path: '/admin', element: <AdminPlaceholder /> }],
  },
  { path: '*', element: <Navigate to="/scout" replace /> },
];

export const router = createBrowserRouter(routes);

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
EOF
npm run test -- src/auth/__tests__/router.test.tsx 2>&1 | tail -20
```
Expected output: all 5 router cases pass (4 original + new `/login` public route). Note: `/admin` with `scout: null` still lands on `/join` (no-scout rule wins) so the existing `guards /admin -> /join when no scout` case remains green.

- [ ] **Step 3: Typecheck and commit.**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run typecheck 2>&1 | tail -10
git -C /Users/ryanabraham/Downloads/FRC-scouting-app add src/routes/router.tsx src/auth/__tests__/router.test.tsx
git -C /Users/ryanabraham/Downloads/FRC-scouting-app commit -m "feat(routes): add public /login route and redirectTo for admin/dashboard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected output: typecheck exits 0 (no errors); one commit created with 2 files changed.

### Task AUTH5

**Files:**
- Test: (no new files) full Cluster AUTH verification

**Interfaces:**
- Consumes: `src/auth/adminAuth.ts`, `src/auth/AdminLogin.tsx`, `src/routes/guards.tsx`, `src/routes/router.tsx` and their tests
- Produces: green AUTH test surface + chore commit

- [ ] **Step 1: Run the full AUTH-related test surface to confirm nothing regressed.**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/auth 2>&1 | tail -25
```
Expected output: all files under `src/auth/__tests__` pass — `adminAuth.test.tsx`, `AdminLogin.test.tsx`, `guards.test.tsx` (8 cases), `router.test.tsx` (5 cases), plus the untouched `joinEvent`, `JoinScreen`, `roles`, `useSession` tests. 0 failures.

- [ ] **Step 2: Typecheck the whole project.**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run typecheck 2>&1 | tail -10
```
Expected output: exits 0, no type errors.

- [ ] **Step 3: Empty chore commit marking Cluster AUTH complete.**

```bash
git -C /Users/ryanabraham/Downloads/FRC-scouting-app commit --allow-empty -m "chore(auth): complete Phase 1 Cluster AUTH (login + guard redirectTo)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected output: one empty commit created.

<!-- ===== Cluster UI ===== -->

I have enough context. I'll now write the Cluster UI tasks using the exact patterns observed.

### Task UI1

**Files:**
- Create: `src/admin/importEventClient.ts`
- Create: `src/admin/setAssignmentsClient.ts`
- Test: `src/admin/__tests__/importEventClient.test.ts`, `src/admin/__tests__/setAssignmentsClient.test.ts`

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabase`; `env` from `@/lib/env`; `Assignment` from `@/admin/types`.
- Produces:
  - `export async function importEvent(eventKey: string): Promise<{event_key:string;name:string;team_count:number;match_count:number;join_code:string}>`
  - `export async function publishAssignments(eventKey: string, assignments: Assignment[]): Promise<number>`

- [ ] **Step 1: Write failing test for importEventClient.**

```ts
// src/admin/__tests__/importEventClient.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSession = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: (...a: unknown[]) => getSession(...a) } },
}));
vi.mock('@/lib/env', () => ({ env: { SUPABASE_URL: 'https://x.supabase.co' } }));

import { importEvent } from '../importEventClient';

describe('importEvent', () => {
  beforeEach(() => {
    getSession.mockReset();
    vi.unstubAllGlobals();
  });

  it('posts to the import-event function with a bearer token and returns the summary', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok-123' } } });
    const summary = { event_key: '2026casnv', name: 'CA SV', team_count: 37, match_count: 80, join_code: 'ABCD1234' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => summary });
    vi.stubGlobal('fetch', fetchMock);

    const result = await importEvent('2026casnv');

    expect(result).toEqual(summary);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x.supabase.co/functions/v1/import-event',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-123',
        }),
        body: JSON.stringify({ event_key: '2026casnv' }),
      })
    );
  });

  it('throws when there is no session token', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    vi.stubGlobal('fetch', vi.fn());
    await expect(importEvent('2026casnv')).rejects.toThrow(/not signed in/i);
  });

  it('throws on a non-200 response', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok-123' } } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) }));
    await expect(importEvent('2026casnv')).rejects.toThrow(/forbidden|403/);
  });
});
```

Run: `npm run test -- src/admin/__tests__/importEventClient.test.ts`
Expected: FAIL — `Cannot find module '../importEventClient'`.
Commit: `git add -A && git commit -m "test(ui): failing importEventClient test"`

- [ ] **Step 2: Implement importEventClient.ts.**

```ts
// src/admin/importEventClient.ts
import { supabase } from '@/lib/supabase';
import { env } from '@/lib/env';

export interface ImportEventResult {
  event_key: string;
  name: string;
  team_count: number;
  match_count: number;
  join_code: string;
}

export async function importEvent(eventKey: string): Promise<ImportEventResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error('Not signed in.');
  }

  const res = await fetch(`${env.SUPABASE_URL}/functions/v1/import-event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ event_key: eventKey }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ?? '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `Import failed (${res.status})`);
  }

  return (await res.json()) as ImportEventResult;
}
```

Run: `npm run test -- src/admin/__tests__/importEventClient.test.ts`
Expected: PASS (3 passed).
Commit: `git add -A && git commit -m "feat(ui): importEventClient wrapper for import-event function"`

- [ ] **Step 3: Write failing test for setAssignmentsClient.**

```ts
// src/admin/__tests__/setAssignmentsClient.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { publishAssignments } from '../setAssignmentsClient';
import type { Assignment } from '../types';

const ASSIGNMENTS: Assignment[] = [
  { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
  { matchKey: '2026casnv_qm1', scoutId: 's2', allianceColor: 'blue', station: 3, targetTeamNumber: 1678 },
];

describe('publishAssignments', () => {
  beforeEach(() => rpc.mockReset());

  it('calls set_assignments with snake_cased rows and returns the inserted count', async () => {
    rpc.mockResolvedValue({ data: 2, error: null });
    const count = await publishAssignments('2026casnv', ASSIGNMENTS);
    expect(count).toBe(2);
    expect(rpc).toHaveBeenCalledWith('set_assignments', {
      p_event_key: '2026casnv',
      p_assignments: [
        { match_key: '2026casnv_qm1', scout_id: 's1', alliance_color: 'red', station: 1, target_team_number: 254 },
        { match_key: '2026casnv_qm1', scout_id: 's2', alliance_color: 'blue', station: 3, target_team_number: 1678 },
      ],
    });
  });

  it('throws when the rpc returns an error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    await expect(publishAssignments('2026casnv', ASSIGNMENTS)).rejects.toThrow(/permission denied/);
  });
});
```

Run: `npm run test -- src/admin/__tests__/setAssignmentsClient.test.ts`
Expected: FAIL — `Cannot find module '../setAssignmentsClient'` (and `../types`; types.ts is owned by Cluster ASSIGN and must exist before this task runs).
Commit: `git add -A && git commit -m "test(ui): failing setAssignmentsClient test"`

- [ ] **Step 4: Implement setAssignmentsClient.ts.**

```ts
// src/admin/setAssignmentsClient.ts
import { supabase } from '@/lib/supabase';
import type { Assignment } from './types';

export async function publishAssignments(
  eventKey: string,
  assignments: Assignment[]
): Promise<number> {
  const p_assignments = assignments.map((a) => ({
    match_key: a.matchKey,
    scout_id: a.scoutId,
    alliance_color: a.allianceColor,
    station: a.station,
    target_team_number: a.targetTeamNumber,
  }));

  const { data, error } = await supabase.rpc('set_assignments', {
    p_event_key: eventKey,
    p_assignments,
  });

  if (error) {
    throw new Error(error.message);
  }
  return (data as number) ?? 0;
}
```

Run: `npm run test -- src/admin/__tests__/setAssignmentsClient.test.ts`
Expected: PASS (2 passed).
Commit: `git add -A && git commit -m "feat(ui): setAssignmentsClient publishes via set_assignments rpc"`

### Task UI2

**Files:**
- Create: `src/admin/EventSetup.tsx`
- Test: `src/admin/__tests__/EventSetup.test.tsx`

**Interfaces:**
- Consumes: `importEvent` from `@/admin/importEventClient`; shadcn `Card`/`Input`/`Label`/`Button`.
- Produces: `export function EventSetup(props: { onImported?: (eventKey: string) => void }): JSX.Element` (default export too). Testids: `event-key-input`, `event-import-submit`, `event-summary`, `event-import-error`.

- [ ] **Step 1: Write failing test for EventSetup.**

```tsx
// src/admin/__tests__/EventSetup.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const importEvent = vi.fn();
vi.mock('../importEventClient', () => ({ importEvent: (...a: unknown[]) => importEvent(...a) }));

import { EventSetup } from '../EventSetup';

describe('EventSetup', () => {
  beforeEach(() => importEvent.mockReset());

  it('imports an event and shows the summary', async () => {
    importEvent.mockResolvedValue({
      event_key: '2026casnv', name: 'CA SV', team_count: 37, match_count: 80, join_code: 'ABCD1234',
    });
    const onImported = vi.fn();
    render(<EventSetup onImported={onImported} />);

    fireEvent.change(screen.getByTestId('event-key-input'), { target: { value: '2026casnv' } });
    fireEvent.click(screen.getByTestId('event-import-submit'));

    const summary = await screen.findByTestId('event-summary');
    expect(summary).toHaveTextContent('37');
    expect(summary).toHaveTextContent('80');
    expect(summary).toHaveTextContent('ABCD1234');
    expect(importEvent).toHaveBeenCalledWith('2026casnv');
    expect(onImported).toHaveBeenCalledWith('2026casnv');
  });

  it('shows an error when import fails', async () => {
    importEvent.mockRejectedValue(new Error('forbidden'));
    render(<EventSetup />);
    fireEvent.change(screen.getByTestId('event-key-input'), { target: { value: '2026casnv' } });
    fireEvent.click(screen.getByTestId('event-import-submit'));
    const err = await screen.findByTestId('event-import-error');
    expect(err).toHaveTextContent('forbidden');
  });

  it('does not double-submit while busy', async () => {
    let resolve!: (v: unknown) => void;
    importEvent.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<EventSetup />);
    fireEvent.change(screen.getByTestId('event-key-input'), { target: { value: '2026casnv' } });
    const btn = screen.getByTestId('event-import-submit');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(btn).toBeDisabled();
    resolve({ event_key: '2026casnv', name: 'x', team_count: 1, match_count: 1, join_code: 'z' });
    await waitFor(() => expect(importEvent).toHaveBeenCalledTimes(1));
  });
});
```

Run: `npm run test -- src/admin/__tests__/EventSetup.test.tsx`
Expected: FAIL — `Cannot find module '../EventSetup'`.
Commit: `git add -A && git commit -m "test(ui): failing EventSetup test"`

- [ ] **Step 2: Implement EventSetup.tsx.**

```tsx
// src/admin/EventSetup.tsx
import { useState, type FormEvent } from 'react';
import { importEvent, type ImportEventResult } from './importEventClient';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export interface EventSetupProps {
  onImported?: (eventKey: string) => void;
}

export function EventSetup({ onImported }: EventSetupProps): JSX.Element {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportEventResult | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const result = await importEvent(key.trim());
      setSummary(result);
      onImported?.(result.event_key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Event Setup</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="event-key-input-field">TBA event key</Label>
            <Input
              id="event-key-input-field"
              data-testid="event-key-input"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="2026casnv"
              autoComplete="off"
              autoCapitalize="none"
              className="h-11"
            />
          </div>
          <Button
            type="submit"
            data-testid="event-import-submit"
            disabled={busy || key.trim().length === 0}
            className="h-11"
          >
            {busy ? 'Importing…' : 'Import event'}
          </Button>
        </form>

        {error ? (
          <p data-testid="event-import-error" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {summary ? (
          <div data-testid="event-summary" className="mt-4 rounded-lg border p-4 text-sm">
            <p className="font-semibold">{summary.name}</p>
            <p className="text-muted-foreground">{summary.event_key}</p>
            <ul className="mt-2 space-y-1">
              <li>Teams: <span className="font-medium">{summary.team_count}</span></li>
              <li>Qual matches: <span className="font-medium">{summary.match_count}</span></li>
              <li>Join code: <span className="font-mono font-medium">{summary.join_code}</span></li>
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default EventSetup;
```

Run: `npm run test -- src/admin/__tests__/EventSetup.test.tsx`
Expected: PASS (3 passed).
Commit: `git add -A && git commit -m "feat(ui): EventSetup import form with summary and error"`

### Task UI3

**Files:**
- Create: `src/admin/ScheduleView.tsx`
- Test: `src/admin/__tests__/ScheduleView.test.tsx`

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabase` (`supabase.from('match').select(...).eq(...).order(...)`); shadcn `Card`.
- Produces: `export function ScheduleView(props: { eventKey: string }): JSX.Element` (default export too). Testid `schedule-list`; each row testid `schedule-row`.

- [ ] **Step 1: Write failing test for ScheduleView.**

```tsx
// src/admin/__tests__/ScheduleView.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const from = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { from: (...a: unknown[]) => from(...a) } }));

import { ScheduleView } from '../ScheduleView';

function mockMatches(rows: unknown[]) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: rows, error: null }),
  };
  from.mockReturnValue(builder);
}

describe('ScheduleView', () => {
  beforeEach(() => from.mockReset());

  it('renders a row per qual match with all six team numbers', async () => {
    mockMatches([
      { match_key: '2026casnv_qm1', match_number: 1, red1: 254, red2: 1678, red3: 100, blue1: 200, blue2: 300, blue3: 400 },
      { match_key: '2026casnv_qm2', match_number: 2, red1: 11, red2: 12, red3: 13, blue1: 21, blue2: 22, blue3: 23 },
    ]);
    render(<ScheduleView eventKey="2026casnv" />);

    const list = await screen.findByTestId('schedule-list');
    expect(list).toBeInTheDocument();
    expect(screen.getAllByTestId('schedule-row')).toHaveLength(2);
    expect(list).toHaveTextContent('254');
    expect(list).toHaveTextContent('400');
    expect(from).toHaveBeenCalledWith('match');
  });

  it('shows an empty state when there are no matches', async () => {
    mockMatches([]);
    render(<ScheduleView eventKey="2026casnv" />);
    await waitFor(() => expect(screen.getByText(/no matches/i)).toBeInTheDocument());
  });
});
```

Run: `npm run test -- src/admin/__tests__/ScheduleView.test.tsx`
Expected: FAIL — `Cannot find module '../ScheduleView'`.
Commit: `git add -A && git commit -m "test(ui): failing ScheduleView test"`

- [ ] **Step 2: Implement ScheduleView.tsx.**

```tsx
// src/admin/ScheduleView.tsx
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

interface MatchRow {
  match_key: string;
  match_number: number;
  red1: number;
  red2: number;
  red3: number;
  blue1: number;
  blue2: number;
  blue3: number;
}

export interface ScheduleViewProps {
  eventKey: string;
}

export function ScheduleView({ eventKey }: ScheduleViewProps): JSX.Element {
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      const { data } = await supabase
        .from('match')
        .select('match_key,match_number,red1,red2,red3,blue1,blue2,blue3')
        .eq('event_key', eventKey)
        .order('match_number', { ascending: true });
      if (active) {
        setMatches((data as MatchRow[] | null) ?? []);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [eventKey]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Schedule</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches yet.</p>
        ) : (
          <ul data-testid="schedule-list" className="flex flex-col gap-2">
            {matches.map((m) => (
              <li
                key={m.match_key}
                data-testid="schedule-row"
                className="flex items-center gap-3 rounded-lg border p-3 text-sm"
              >
                <span className="w-10 shrink-0 font-semibold">Q{m.match_number}</span>
                <span className="flex gap-1 font-mono text-red-400">
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5">{m.red1}</span>
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5">{m.red2}</span>
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5">{m.red3}</span>
                </span>
                <span className="flex gap-1 font-mono text-blue-400">
                  <span className="rounded bg-blue-500/15 px-1.5 py-0.5">{m.blue1}</span>
                  <span className="rounded bg-blue-500/15 px-1.5 py-0.5">{m.blue2}</span>
                  <span className="rounded bg-blue-500/15 px-1.5 py-0.5">{m.blue3}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default ScheduleView;
```

Run: `npm run test -- src/admin/__tests__/ScheduleView.test.tsx`
Expected: PASS (2 passed).
Commit: `git add -A && git commit -m "feat(ui): ScheduleView lists qual matches with team numbers"`

### Task UI4

**Files:**
- Create: `src/admin/AssignmentBoard.tsx`
- Test: `src/admin/__tests__/AssignmentBoard.test.tsx`

**Interfaces:**
- Consumes: `autoAssign` from `@/admin/autoAssign`; `publishAssignments` from `@/admin/setAssignmentsClient`; types `AssignMatch`/`AssignScout`/`Assignment`/`AllianceColor` from `@/admin/types`; shadcn `Card`/`Button`.
- Produces: `export function AssignmentBoard(props: { eventKey: string; matches: AssignMatch[]; scouts: AssignScout[] }): JSX.Element` (default export too). Testids: `auto-generate-btn`, `assignment-grid`, `publish-assignments-btn`, `assignments-published`, `assignments-publish-error`; per-slot select `slot-select`.

- [ ] **Step 1: Write failing test for AssignmentBoard.**

```tsx
// src/admin/__tests__/AssignmentBoard.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const autoAssign = vi.fn();
const publishAssignments = vi.fn();
vi.mock('../autoAssign', () => ({ autoAssign: (...a: unknown[]) => autoAssign(...a) }));
vi.mock('../setAssignmentsClient', () => ({ publishAssignments: (...a: unknown[]) => publishAssignments(...a) }));

import { AssignmentBoard } from '../AssignmentBoard';
import type { AssignMatch, AssignScout, Assignment } from '../types';

const MATCHES: AssignMatch[] = [
  { matchKey: '2026casnv_qm1', redTeams: [254, 1678, 100], blueTeams: [200, 300, 400] },
];
const SCOUTS: AssignScout[] = [
  { id: 's1', displayName: 'Alice' },
  { id: 's2', displayName: 'Bob' },
];

describe('AssignmentBoard', () => {
  beforeEach(() => {
    autoAssign.mockReset();
    publishAssignments.mockReset();
  });

  it('auto-generates a grid then publishes', async () => {
    const generated: Assignment[] = [
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
      { matchKey: '2026casnv_qm1', scoutId: 's2', allianceColor: 'blue', station: 1, targetTeamNumber: 200 },
    ];
    autoAssign.mockReturnValue(generated);
    publishAssignments.mockResolvedValue(2);

    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);

    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    const grid = await screen.findByTestId('assignment-grid');
    expect(grid).toHaveTextContent('254');
    expect(grid).toHaveTextContent('Alice');
    expect(autoAssign).toHaveBeenCalledWith(MATCHES, SCOUTS, expect.objectContaining({ ownTeam: 3256 }));

    fireEvent.click(screen.getByTestId('publish-assignments-btn'));
    await screen.findByTestId('assignments-published');
    expect(publishAssignments).toHaveBeenCalledWith('2026casnv', generated);
  });

  it('shows an error when publish fails', async () => {
    autoAssign.mockReturnValue([
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
    ]);
    publishAssignments.mockRejectedValue(new Error('permission denied'));
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    await screen.findByTestId('assignment-grid');
    fireEvent.click(screen.getByTestId('publish-assignments-btn'));
    const err = await screen.findByTestId('assignments-publish-error');
    expect(err).toHaveTextContent('permission denied');
  });

  it('lets a slot be reassigned manually via a select', async () => {
    autoAssign.mockReturnValue([
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
    ]);
    publishAssignments.mockResolvedValue(1);
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    await screen.findByTestId('assignment-grid');

    const selects = screen.getAllByTestId('slot-select');
    fireEvent.change(selects[0], { target: { value: 's2' } });
    fireEvent.click(screen.getByTestId('publish-assignments-btn'));

    await waitFor(() => expect(publishAssignments).toHaveBeenCalled());
    const published = publishAssignments.mock.calls[0][1] as Assignment[];
    const slot = published.find((a) => a.matchKey === '2026casnv_qm1' && a.allianceColor === 'red' && a.station === 1);
    expect(slot?.scoutId).toBe('s2');
  });
});
```

Run: `npm run test -- src/admin/__tests__/AssignmentBoard.test.tsx`
Expected: FAIL — `Cannot find module '../AssignmentBoard'`.
Commit: `git add -A && git commit -m "test(ui): failing AssignmentBoard test"`

- [ ] **Step 2: Implement AssignmentBoard.tsx.**

```tsx
// src/admin/AssignmentBoard.tsx
import { useMemo, useState } from 'react';
import { autoAssign } from './autoAssign';
import { publishAssignments } from './setAssignmentsClient';
import type { AssignMatch, AssignScout, Assignment, AllianceColor } from './types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const OWN_TEAM = 3256;

interface Slot {
  matchKey: string;
  allianceColor: AllianceColor;
  station: 1 | 2 | 3;
  targetTeamNumber: number;
}

export interface AssignmentBoardProps {
  eventKey: string;
  matches: AssignMatch[];
  scouts: AssignScout[];
}

function slotKey(s: { matchKey: string; allianceColor: AllianceColor; station: number }): string {
  return `${s.matchKey}:${s.allianceColor}:${s.station}`;
}

export function AssignmentBoard({ eventKey, matches, scouts }: AssignmentBoardProps): JSX.Element {
  // scoutId per slotKey ('' === unassigned)
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [generated, setGenerated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const slots = useMemo<Slot[]>(() => {
    const out: Slot[] = [];
    for (const m of matches) {
      const teams: { color: AllianceColor; nums: [number, number, number] }[] = [
        { color: 'red', nums: m.redTeams },
        { color: 'blue', nums: m.blueTeams },
      ];
      for (const a of teams) {
        a.nums.forEach((team, i) => {
          if (team === OWN_TEAM) return;
          out.push({
            matchKey: m.matchKey,
            allianceColor: a.color,
            station: (i + 1) as 1 | 2 | 3,
            targetTeamNumber: team,
          });
        });
      }
    }
    return out;
  }, [matches]);

  function onAutoGenerate(): void {
    const result = autoAssign(matches, scouts, {
      ownTeam: OWN_TEAM,
      breakEveryN: 6,
      rotatePositions: true,
    });
    const next: Record<string, string> = {};
    for (const a of result) {
      next[slotKey(a)] = a.scoutId;
    }
    setPicks(next);
    setGenerated(true);
    setPublished(null);
    setError(null);
  }

  function setSlot(key: string, scoutId: string): void {
    setPicks((prev) => ({ ...prev, [key]: scoutId }));
  }

  async function onPublish(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPublished(null);
    const assignments: Assignment[] = slots
      .map((s) => ({ ...s, scoutId: picks[slotKey(s)] ?? '' }))
      .filter((s) => s.scoutId !== '')
      .map((s) => ({
        matchKey: s.matchKey,
        scoutId: s.scoutId,
        allianceColor: s.allianceColor,
        station: s.station,
        targetTeamNumber: s.targetTeamNumber,
      }));
    try {
      const count = await publishAssignments(eventKey, assignments);
      setPublished(count);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed.');
    } finally {
      setBusy(false);
    }
  }

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of scouts) map.set(s.id, s.displayName);
    return map;
  }, [scouts]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Assignments</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            data-testid="auto-generate-btn"
            onClick={onAutoGenerate}
            className="h-11"
          >
            Auto-generate
          </Button>
          <Button
            type="button"
            data-testid="publish-assignments-btn"
            onClick={() => void onPublish()}
            disabled={busy || !generated}
            variant="secondary"
            className="h-11"
          >
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
        </div>

        {error ? (
          <p data-testid="assignments-publish-error" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {published !== null ? (
          <p data-testid="assignments-published" className="mt-4 text-sm text-emerald-400">
            Published {published} assignment{published === 1 ? '' : 's'}.
          </p>
        ) : null}

        {generated ? (
          <div data-testid="assignment-grid" className="mt-4 flex flex-col gap-2">
            {slots.map((s) => {
              const key = slotKey(s);
              const current = picks[key] ?? '';
              return (
                <div
                  key={key}
                  className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm"
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    {s.matchKey.replace(`${eventKey}_`, '')}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono ${
                      s.allianceColor === 'red'
                        ? 'bg-red-500/15 text-red-400'
                        : 'bg-blue-500/15 text-blue-400'
                    }`}
                  >
                    {s.targetTeamNumber} ({s.allianceColor[0].toUpperCase()}
                    {s.station})
                  </span>
                  <select
                    data-testid="slot-select"
                    value={current}
                    onChange={(e) => setSlot(key, e.target.value)}
                    className="ml-auto h-11 min-w-[8rem] rounded-md border bg-background px-2 text-sm"
                    aria-label={`Scout for ${s.targetTeamNumber}`}
                  >
                    <option value="">— Unassigned —</option>
                    {scouts.map((sc) => (
                      <option key={sc.id} value={sc.id}>
                        {sc.displayName}
                      </option>
                    ))}
                  </select>
                  {current ? (
                    <span className="sr-only">{nameById.get(current) ?? current}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default AssignmentBoard;
```

Note: the auto-generated grid renders each assigned scout's display name via the `<select>`'s selected `<option>` (which carries `displayName`), satisfying the `toHaveTextContent('Alice')` assertion.

Run: `npm run test -- src/admin/__tests__/AssignmentBoard.test.tsx`
Expected: PASS (3 passed).
Commit: `git add -A && git commit -m "feat(ui): AssignmentBoard auto-generate, manual select, publish"`

### Task UI5

**Files:**
- Create: `src/admin/AdminPage.tsx`
- Test: `src/admin/__tests__/AdminPage.test.tsx`

**Interfaces:**
- Consumes: `EventSetup`, `ScheduleView`, `AssignmentBoard` (siblings); `supabase` from `@/lib/supabase` (`from('scout').select(...)`, `from('match').select(...)`, `from('event').select(...)`); types `AssignMatch`/`AssignScout`.
- Produces: `export default function AdminPage(): JSX.Element`. Testid `admin-page`.

- [ ] **Step 1: Write failing test for AdminPage.**

```tsx
// src/admin/__tests__/AdminPage.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../EventSetup', () => ({
  EventSetup: ({ onImported }: { onImported?: (k: string) => void }) => (
    <button data-testid="mock-event-setup" onClick={() => onImported?.('2026casnv')}>
      setup
    </button>
  ),
}));
vi.mock('../ScheduleView', () => ({
  ScheduleView: ({ eventKey }: { eventKey: string }) => (
    <div data-testid="mock-schedule">{eventKey}</div>
  ),
}));
vi.mock('../AssignmentBoard', () => ({
  AssignmentBoard: ({ eventKey, matches, scouts }: { eventKey: string; matches: unknown[]; scouts: unknown[] }) => (
    <div data-testid="mock-board">
      {eventKey}:{matches.length}:{scouts.length}
    </div>
  ),
}));

const from = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { from: (...a: unknown[]) => from(...a) } }));

import AdminPage from '../AdminPage';

function tableMock(table: string) {
  if (table === 'event') {
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ event_key: '2026casnv' }], error: null }),
    };
  }
  if (table === 'scout') {
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [{ id: 's1', display_name: 'Alice' }, { id: 's2', display_name: 'Bob' }],
        error: null,
      }),
    };
  }
  // match
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({
      data: [
        { match_key: '2026casnv_qm1', match_number: 1, red1: 254, red2: 1678, red3: 100, blue1: 200, blue2: 300, blue3: 400 },
      ],
      error: null,
    }),
  };
}

describe('AdminPage', () => {
  beforeEach(() => {
    from.mockReset();
    from.mockImplementation((t: string) => tableMock(t));
  });

  it('renders setup, schedule, and board for the active event with loaded scouts and matches', async () => {
    render(<AdminPage />);
    expect(screen.getByTestId('admin-page')).toBeInTheDocument();
    expect(screen.getByTestId('mock-event-setup')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('mock-schedule')).toHaveTextContent('2026casnv'));
    await waitFor(() => expect(screen.getByTestId('mock-board')).toHaveTextContent('2026casnv:1:2'));
  });
});
```

Run: `npm run test -- src/admin/__tests__/AdminPage.test.tsx`
Expected: FAIL — `Cannot find module '../AdminPage'`.
Commit: `git add -A && git commit -m "test(ui): failing AdminPage test"`

- [ ] **Step 2: Implement AdminPage.tsx.**

```tsx
// src/admin/AdminPage.tsx
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { EventSetup } from './EventSetup';
import { ScheduleView } from './ScheduleView';
import { AssignmentBoard } from './AssignmentBoard';
import type { AssignMatch, AssignScout } from './types';

interface MatchRow {
  match_key: string;
  match_number: number;
  red1: number;
  red2: number;
  red3: number;
  blue1: number;
  blue2: number;
  blue3: number;
}

interface ScoutRow {
  id: string;
  display_name: string;
}

export default function AdminPage(): JSX.Element {
  const [eventKey, setEventKey] = useState<string | null>(null);
  const [matches, setMatches] = useState<AssignMatch[]>([]);
  const [scouts, setScouts] = useState<AssignScout[]>([]);

  // Resolve the active event once on mount.
  useEffect(() => {
    let active = true;
    void (async () => {
      const { data } = await supabase
        .from('event')
        .select('event_key')
        .eq('is_active', true)
        .order('imported_at', { ascending: false })
        .limit(1);
      const key = (data as { event_key: string }[] | null)?.[0]?.event_key ?? null;
      if (active) setEventKey(key);
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadEventData = useCallback(async (key: string) => {
    const [matchRes, scoutRes] = await Promise.all([
      supabase
        .from('match')
        .select('match_key,match_number,red1,red2,red3,blue1,blue2,blue3')
        .eq('event_key', key)
        .order('match_number', { ascending: true }),
      supabase.from('scout').select('id,display_name').eq('event_key', key),
    ]);

    const matchRows = (matchRes.data as MatchRow[] | null) ?? [];
    setMatches(
      matchRows.map((m) => ({
        matchKey: m.match_key,
        redTeams: [m.red1, m.red2, m.red3],
        blueTeams: [m.blue1, m.blue2, m.blue3],
      }))
    );

    const scoutRows = (scoutRes.data as ScoutRow[] | null) ?? [];
    setScouts(scoutRows.map((s) => ({ id: s.id, displayName: s.display_name })));
  }, []);

  useEffect(() => {
    if (eventKey) void loadEventData(eventKey);
  }, [eventKey, loadEventData]);

  function onImported(key: string): void {
    setEventKey(key);
  }

  return (
    <main data-testid="admin-page" className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <h1 className="text-2xl font-bold">Admin</h1>
      <EventSetup onImported={onImported} />
      {eventKey ? (
        <>
          <ScheduleView eventKey={eventKey} />
          <AssignmentBoard eventKey={eventKey} matches={matches} scouts={scouts} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Import an event to begin.</p>
      )}
    </main>
  );
}
```

Run: `npm run test -- src/admin/__tests__/AdminPage.test.tsx`
Expected: PASS (1 passed).
Commit: `git add -A && git commit -m "feat(ui): AdminPage composes setup, schedule, and assignment board"`

### Task UI6

**Files:**
- Modify: `src/routes/router.tsx`

**Interfaces:**
- Consumes: `AdminPage` (default) from `@/admin/AdminPage`.
- Produces: `/admin` route element renders `<AdminPage />` under the existing `RequireRole role="admin"`. (Cluster AUTH separately adds `redirectTo="/login"` and the `/login` route; this task only swaps the element — keep the import order/exports stable so AUTH's edit applies cleanly.)

- [ ] **Step 1: Replace the AdminPlaceholder import with AdminPage.**

```tsx
// in src/routes/router.tsx — replace this line:
import AdminPlaceholder from './AdminPlaceholder';
// with:
import AdminPage from '../admin/AdminPage';
```

Apply via Edit on `src/routes/router.tsx`:
- old_string: `import AdminPlaceholder from './AdminPlaceholder';`
- new_string: `import AdminPage from '../admin/AdminPage';`

Run: `npm run typecheck`
Expected: No output / exit 0 (no errors) — `AdminPlaceholder` import removed and `AdminPage` resolves.

- [ ] **Step 2: Render AdminPage in the /admin route.**

Apply via Edit on `src/routes/router.tsx`:
- old_string: `{ path: '/admin', element: <AdminPlaceholder /> }`
- new_string: `{ path: '/admin', element: <AdminPage /> }`

Run: `npm run test -- src/admin && npm run typecheck`
Expected: All Cluster UI suites PASS and typecheck exits 0.
Commit: `git add -A && git commit -m "feat(ui): wire /admin route to AdminPage"`

<!-- ===== Cluster GATE ===== -->

### Task GATE1
**Files:**
- Test: tests/e2e/admin.spec.ts (Create)

**Interfaces:**
- Consumes: route `/login` (PUBLIC → AdminLogin), `/admin` (RequireRole admin redirectTo='/login'); data-testids `admin-email`, `admin-password`, `admin-login-submit` (AdminLogin); `auto-generate-btn`, `assignment-grid`, `publish-assignments-btn`, `assignments-published` (AssignmentBoard); env `TEST_ADMIN_EMAIL`, `TEST_ADMIN_PASSWORD` (.env.local); event `2026casnv` already imported.
- Produces: Playwright spec (no exports).

- [ ] **Step 1: Inspect playwright config for baseURL + dev server wiring**
```bash
cat /Users/ryanabraham/Downloads/FRC-scouting-app/playwright.config.ts
```
Expected output: prints the config showing `use.baseURL` (e.g. `http://localhost:5173`) and a `webServer` block (so `page.goto('/login')` resolves and the Vite dev/preview server auto-starts). Note the baseURL for use below.

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add -A && git commit -m "chore(e2e): inspect playwright config before authoring admin spec" --allow-empty
```
Expected output: a commit is created (`1 file changed` or `0 files changed`).

- [ ] **Step 2: Write the admin E2E spec (login → /admin → auto-generate → publish → assignments-published)**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/tests/e2e/admin.spec.ts <<'EOF'
import { test, expect } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const TEST_ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL;
const TEST_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD;

test.describe('Admin flow: login -> auto-generate -> publish', () => {
  test.skip(
    !TEST_ADMIN_EMAIL || !TEST_ADMIN_PASSWORD,
    'TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD not set in .env.local'
  );

  test('admin logs in, auto-generates assignments, and publishes them', async ({ page }) => {
    // 1. Public login route renders the admin login form.
    await page.goto('/login');
    await expect(page.getByTestId('admin-email')).toBeVisible();
    await expect(page.getByTestId('admin-password')).toBeVisible();

    // 2. Sign in with the seeded admin credentials.
    await page.getByTestId('admin-email').fill(TEST_ADMIN_EMAIL as string);
    await page.getByTestId('admin-password').fill(TEST_ADMIN_PASSWORD as string);
    await page.getByTestId('admin-login-submit').click();

    // 3. Successful login lands on /admin.
    await expect(page).toHaveURL(/\/admin$/, { timeout: 15000 });

    // 4. Auto-generate assignments for the already-imported 2026casnv event.
    const autoGenerate = page.getByTestId('auto-generate-btn');
    await expect(autoGenerate).toBeVisible({ timeout: 15000 });
    await autoGenerate.click();

    // 5. A preview grid of assignments appears.
    await expect(page.getByTestId('assignment-grid')).toBeVisible({ timeout: 15000 });

    // 6. Publish the assignments.
    await page.getByTestId('publish-assignments-btn').click();

    // 7. Success confirmation is shown.
    await expect(page.getByTestId('assignments-published')).toBeVisible({ timeout: 15000 });
  });
});
EOF
```
Expected output: no stdout (file written).

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i 'admin.spec' || echo "NO_SPEC_TYPE_ERRORS"
```
Expected output: `NO_SPEC_TYPE_ERRORS` (the spec has no TypeScript errors).

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add -A && git commit -m "test(e2e): admin login, auto-generate, and publish assignments flow"
```
Expected output: `1 file changed` (tests/e2e/admin.spec.ts created).

- [ ] **Step 3: Run the admin E2E spec headless and confirm green (or graceful skip)**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test:e2e -- tests/e2e/admin.spec.ts 2>&1 | tail -25
```
Expected output: Playwright reports `1 passed` (when TEST_ADMIN creds are set in .env.local) or `1 skipped` (when unset) — never `failed`. Headless chromium (default).

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add -A && git commit -m "chore(e2e): verify admin spec passes headless" --allow-empty
```
Expected output: a commit is created.

### Task GATE2
**Files:**
- (no new files — verification gate)

**Interfaces:**
- Consumes: scripts `test`, `typecheck`, `build`, `test:e2e` (package.json); all Phase 1 clusters merged (DB 0005 live, import-event deployed + 2026casnv imported, autoAssign, AUTH, UI).
- Produces: an empty `chore` commit marking the Phase 1 gate green (no source changes).

- [ ] **Step 1: Confirm the required npm scripts exist**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && node -e "const s=require('./package.json').scripts; ['test','typecheck','build','test:e2e'].forEach(k=>{if(!s[k]){console.error('MISSING SCRIPT: '+k);process.exit(1)}}); console.log('ALL_SCRIPTS_PRESENT')"
```
Expected output: `ALL_SCRIPTS_PRESENT` (all four scripts are defined).

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add -A && git commit -m "chore(gate): confirm verification scripts present" --allow-empty
```
Expected output: a commit is created.

- [ ] **Step 2: Run the full unit/integration test suite**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test 2>&1 | tail -25
```
Expected output: vitest reports all test files passing (e.g. `Test Files  N passed (N)` and `Tests  M passed (M)`), exit code 0, no `failed`.

- [ ] **Step 3: Run the TypeScript typecheck**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run typecheck 2>&1 | tail -15
```
Expected output: no type errors printed; command exits 0 (clean `tsc --noEmit`).

- [ ] **Step 4: Run the production build**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run build 2>&1 | tail -15
```
Expected output: Vite prints `✓ built in ...` with emitted `dist/` assets and exits 0; no build errors.

- [ ] **Step 5: Run the full E2E suite headless**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test:e2e 2>&1 | tail -25
```
Expected output: Playwright reports all specs `passed` (admin spec passes when TEST_ADMIN creds set, otherwise `skipped`), no `failed`; exit code 0.

- [ ] **Step 6: Mark the Phase 1 verification gate green with an empty chore commit**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git commit -m "chore(phase-1): verification gate green — test, typecheck, build, e2e all pass" --allow-empty
```
Expected output: a commit is created on `phase-1-admin` recording the green gate.
