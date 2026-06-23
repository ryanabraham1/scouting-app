# Phase 0 Final Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all 5 findings from the Phase 0 final review: security fix for upsert_match_report forge vulnerability, ingest-reports test using wrong FuelBurst shape, dead code removal in compute.ts, new inactiveFirst:false golden test, and env-gate the statbotics-proxy test hook.

**Architecture:** Fix the SQL RPC first (security), then fix/extend tests in parallel groups (ingest-reports test fix, compute golden addition), clean up dead code in compute.ts, and env-gate the statbotics proxy. Each change is isolated to one file except the RPC which touches migration + test.

**Tech Stack:** TypeScript, Vitest, Supabase (PostgreSQL + Edge Functions/Deno), Supabase JS client

## Global Constraints

- Apply SQL via `python3 .superpowers/sdd/apply-sql.py <file.sql>` from the project root
- Deploy edge functions via: `set -a; . ./.env.local; set +a; SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" npx --yes supabase@latest functions deploy <name> --project-ref oztsfxyfovwnwutrxzmo --no-verify-jwt`
- DB/function tests read `.env.local` via dotenv
- Do NOT weaken the ownership gate even if ingest tests fail — stop and report instead
- `FUEL_POINTS = 1` (from constants.ts)
- Frozen FuelBurst shape: `{ startMs, endMs, rate, window }` (from src/scoring/types.ts)
- `inactiveFirst: true` → shift1 & shift3 INACTIVE, shift2 & shift4 ACTIVE
- `inactiveFirst: false` → shift1 & shift3 ACTIVE, shift2 & shift4 INACTIVE

---

### Task 1: Fix `upsert_match_report` ownership gate (CRITICAL security)

**Files:**
- Modify: `supabase/migrations/0004_rpcs.sql`
- Modify: `tests/db/rpcs.test.ts`

**Interfaces:**
- Consumes: `auth.uid()` (PostgreSQL built-in), `scout` table with `id` and `auth_uid` columns
- Produces: ownership-enforced `upsert_match_report` function; two new test cases in rpcs.test.ts

- [ ] **Step 1: Add ownership gate to upsert_match_report in 0004_rpcs.sql**

In `supabase/migrations/0004_rpcs.sql`, find the `upsert_match_report` function body. After:
```sql
  perform set_config('app.skip_msr_bump', 'on', true);
```
And before:
```sql
  select row_revision into v_existing_rev
```
Add the ownership gate block:
```sql
  -- Ownership gate: when called by a real JWT user (anon or regular),
  -- verify the scout_id belongs to auth.uid(). The ingest-reports edge function
  -- uses service-role (auth.uid() is NULL) and is exempt.
  if auth.uid() is not null then
    if not exists (
      select 1 from scout s
      where s.id = (p->>'scout_id')::uuid
        and s.auth_uid = auth.uid()
    ) then
      raise exception 'not authorized: scout_id not owned by caller' using errcode = '42501';
    end if;
  end if;
```

- [ ] **Step 2: Re-apply the migration**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
python3 .superpowers/sdd/apply-sql.py supabase/migrations/0004_rpcs.sql
```
Expected: no errors, function re-created with ownership gate.

- [ ] **Step 3: Add forge tests to tests/db/rpcs.test.ts**

At the end of `tests/db/rpcs.test.ts`, BEFORE the closing brace of the describe block or after the last `it()`, add two new tests. These tests must run AFTER the existing `anon sign-in + join_event` test so `myScoutId` and `anon` client are populated.

Add after the last existing `it(...)` block (after line 91):

```typescript
it('upsert_match_report SUCCEEDS for scout owned by caller (forge guard - self)', async () => {
  const reportId = crypto.randomUUID();
  const selfReport = {
    id: reportId,
    schema_version: 1,
    event_key: EVENT,
    match_key: MATCH,
    scout_id: myScoutId,     // <-- owned by this anon user
    target_team_number: TEAM,
    alliance_color: 'blue',
    station: 2,
    inactive_first: false,
    row_revision: 1,
    fuel_bursts: [{ startMs: 0, endMs: 5000, rate: 1.0, window: 'auto' }],
  };
  const { error } = await anon.rpc('upsert_match_report', { p: selfReport });
  expect(error, `own report should succeed: ${error?.message}`).toBeNull();
});

it('upsert_match_report REJECTS a forged scout_id (forge guard - foreign)', async () => {
  // Seed a second scout owned by a DIFFERENT auth user via admin (service role).
  const foreignAuthUid = crypto.randomUUID();
  const { data: foreignScout, error: seedErr } = await admin
    .from('scout')
    .insert({ event_key: EVENT, display_name: 'Foreign Scout', auth_uid: foreignAuthUid })
    .select('id')
    .single();
  expect(seedErr, `foreign scout seed: ${seedErr?.message}`).toBeNull();
  const foreignScoutId = foreignScout!.id;

  const reportId = crypto.randomUUID();
  const forgedReport = {
    id: reportId,
    schema_version: 1,
    event_key: EVENT,
    match_key: MATCH,
    scout_id: foreignScoutId,  // <-- NOT owned by this anon user
    target_team_number: TEAM,
    alliance_color: 'blue',
    station: 2,
    inactive_first: false,
    row_revision: 1,
    fuel_bursts: [],
  };
  const { error } = await anon.rpc('upsert_match_report', { p: forgedReport });
  expect(error, 'should be rejected').not.toBeNull();
  expect(error!.code).toBe('42501');

  // Cleanup foreign scout
  await admin.from('scout').delete().eq('id', foreignScoutId);
});
```

- [ ] **Step 4: Run the rpcs tests to verify**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npx vitest run tests/db/rpcs.test.ts
```
Expected: all tests pass, including the two new forge tests.

---

### Task 2: Fix ingest-reports test — use correct FuelBurst shape + aggregate assertion

**Files:**
- Modify: `tests/functions/ingest-reports.test.ts`

**Interfaces:**
- Consumes: FuelBurst shape `{ startMs, endMs, rate, window }` from src/scoring/types.ts
- Produces: ingest test that proves recomputed `auto_fuel` and `fuel_points` are correct

The frozen FuelBurst shape is `{ startMs, endMs, rate, window }`. The current test sends `{ shift, count, source }` which is wrong.

For a known set: 8 bursts, B3 golden or simpler. Let's use a simple known set:
- 1 auto burst: startMs=0, endMs=10000, rate=2.0, window='auto' → 20.0 fuel → auto_fuel=20
- 1 shift1 burst: startMs=10000, endMs=20000, rate=1.0, window='shift1' → 10.0 fuel → shift1=10
With `inactive_first: false` → shift1 is ACTIVE → fuelPoints = auto(20) + shift1(10) = 30

- [ ] **Step 1: Replace the fuel_bursts in the ingest test and add aggregate assertions**

In `tests/functions/ingest-reports.test.ts`, replace the `ingests a valid report` test body.

Replace:
```typescript
  it("ingests a valid report (ingested:1) and row exists with aggregates", async () => {
    // fuel_bursts is a valid JSONB array (shift/count/source entries)
    const report = {
      id: TEST_REPORT_ID,
      schema_version: 1,
      app_version: "test-1.0.0",
      device_id: "test-device-d4",
      event_key: TEST_EVENT_KEY,
      match_key: TEST_MATCH_KEY,
      scout_id: TEST_SCOUT_ID,
      target_team_number: TEST_TEAM_NUMBER,
      alliance_color: "red",
      station: 1,
      fuel_bursts: [{ shift: 0, count: 3, source: "floor" }],
      row_revision: 1,
    };
    const reports = [report];
    const hmac = sign(reports);

    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ANON}`,
        apikey: ANON,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reports, hmac }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ingested).toBe(1);

    // Verify the row exists in the DB
    const { data, error } = await admin
      .from("match_scouting_report")
      .select("id, event_key, match_key, target_team_number, fuel_bursts")
      .eq("id", TEST_REPORT_ID)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(TEST_REPORT_ID);
    expect(data?.event_key).toBe(TEST_EVENT_KEY);
    // aggregates recomputed: fuel_bursts stored
    expect(Array.isArray(data?.fuel_bursts)).toBe(true);
  }, 30000);
```

With:
```typescript
  it("ingests a valid report (ingested:1) and row exists with correct recomputed aggregates", async () => {
    // Use the frozen FuelBurst shape: { startMs, endMs, rate, window }
    // Known set: auto burst 0..10000ms @2.0/s = 20.0 fuel (auto_fuel=20)
    //            shift1 burst 10000..20000ms @1.0/s = 10.0 fuel (shift1=10)
    // inactive_first: false → shift1 is ACTIVE (odd shifts active when inactiveFirst=false)
    // fuelPoints = auto(20) + shift1(10) = 30 (FUEL_POINTS=1, transition=0, endgame=0, shift2/3/4=0)
    const report = {
      id: TEST_REPORT_ID,
      schema_version: 1,
      app_version: "test-1.0.0",
      device_id: "test-device-d4",
      event_key: TEST_EVENT_KEY,
      match_key: TEST_MATCH_KEY,
      scout_id: TEST_SCOUT_ID,
      target_team_number: TEST_TEAM_NUMBER,
      alliance_color: "red",
      station: 1,
      inactive_first: false,
      fuel_bursts: [
        { startMs: 0, endMs: 10000, rate: 2.0, window: "auto" },
        { startMs: 10000, endMs: 20000, rate: 1.0, window: "shift1" },
      ],
      row_revision: 1,
    };
    const reports = [report];
    const hmac = sign(reports);

    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ANON}`,
        apikey: ANON,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reports, hmac }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ingested).toBe(1);

    // Verify the row exists and recomputed aggregates are correct
    const { data, error } = await admin
      .from("match_scouting_report")
      .select("id, event_key, match_key, target_team_number, fuel_bursts, auto_fuel, fuel_points")
      .eq("id", TEST_REPORT_ID)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(TEST_REPORT_ID);
    expect(data?.event_key).toBe(TEST_EVENT_KEY);
    // recomputed aggregates must match the golden values
    expect(data?.auto_fuel).toBe(20);   // 0..10000ms @2.0/s = 20.0 → rounds to 20
    expect(data?.fuel_points).toBe(30); // active fuel = auto(20) + shift1(10) = 30
    expect(Array.isArray(data?.fuel_bursts)).toBe(true);
  }, 30000);
```

- [ ] **Step 2: Run ingest-reports tests to verify**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npx vitest run tests/functions/ingest-reports.test.ts
```
Expected: all tests pass including the new aggregate assertion.

---

### Task 3: Remove dead code in compute.ts

**Files:**
- Modify: `src/scoring/compute.ts`

The dead code is at lines 53-61 of compute.ts:
```typescript
  for (const w of ['shift1', 'shift2', 'shift3', 'shift4'] as const) {
    const n = shiftNumberOf(w)!;    // <-- dead: result assigned but never read
    if (isWindowActive(w, input.inactiveFirst)) {
      teleopFuelActive += roundedByWindow[w];
    } else {
      teleopFuelInactive += roundedByWindow[w];
    }
    void n;    // <-- suppresses TS unused-var, but n itself is useless
  }
```

The `const n = shiftNumberOf(w)!` and `void n` lines do nothing. Remove them; the loop logic is unchanged.

- [ ] **Step 1: Remove the dead n variable from compute.ts**

Replace:
```typescript
  for (const w of ['shift1', 'shift2', 'shift3', 'shift4'] as const) {
    const n = shiftNumberOf(w)!;
    if (isWindowActive(w, input.inactiveFirst)) {
      teleopFuelActive += roundedByWindow[w];
    } else {
      teleopFuelInactive += roundedByWindow[w];
    }
    void n;
  }
```

With:
```typescript
  for (const w of ['shift1', 'shift2', 'shift3', 'shift4'] as const) {
    if (isWindowActive(w, input.inactiveFirst)) {
      teleopFuelActive += roundedByWindow[w];
    } else {
      teleopFuelInactive += roundedByWindow[w];
    }
  }
```

Also remove the unused `shiftNumberOf` import if it is no longer used anywhere else in compute.ts. Check: `shiftNumberOf` is imported at line 4 but only used in the dead code loop (the second loop at line 66 uses `isWindowActive` only). Remove it from the import.

Replace:
```typescript
import { isWindowActive, shiftNumberOf } from './windows';
```
With:
```typescript
import { isWindowActive } from './windows';
```

- [ ] **Step 2: Run scoring tests to verify no behavior change**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npx vitest run src/scoring/__tests__/compute.test.ts
```
Expected: all existing tests pass.

- [ ] **Step 3: Run typecheck to verify no TS errors**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run typecheck
```
Expected: clean, no errors.

---

### Task 4: Add inactiveFirst:false golden test case to compute.test.ts

**Files:**
- Modify: `src/scoring/__tests__/compute.test.ts`

With `inactiveFirst: false`:
- odd shifts (shift1, shift3) are ACTIVE
- even shifts (shift2, shift4) are INACTIVE

Using the SAME 8 bursts from the existing golden (inactiveFirst:true) test:
- auto: 4.5 fuel → 5
- transition: 2.5 → 3
- shift1 (ACTIVE with inactiveFirst:false): 5.5 → 6
- shift2 (INACTIVE with inactiveFirst:false): 3.5 → 4
- shift3 (ACTIVE with inactiveFirst:false): 2.5 → 3
- shift4 (INACTIVE with inactiveFirst:false): 1.5 → 2
- endgame: 6.5 → 7

Expected with inactiveFirst:false:
- autoFuel: 5
- endgameFuel: 7
- fuelByShift: [6, 4, 3, 2] (same, it's just the per-shift rounded amounts, order unchanged)
- teleopFuelActive = transition(3) + shift1(6, active) + shift3(3, active) = 12
- teleopFuelInactive = shift2(4, inactive) + shift4(2, inactive) = 6
- activeFuel = auto(5) + transition(3) + shift1(6) + shift3(3) + endgame(7) = 24
- fuelPoints = 24 * FUEL_POINTS(1) = 24

- [ ] **Step 1: Add the inactiveFirst:false golden describe block to compute.test.ts**

After the last closing brace of the second describe block (after line 100 of compute.test.ts), add:

```typescript

describe('computeAggregates — inactiveFirst:false inverts active/inactive shift attribution', () => {
  // Same 8 bursts as the inactiveFirst:true golden above, but inactiveFirst=false.
  // With inactiveFirst:false: odd shifts (shift1,shift3) are ACTIVE; even (shift2,shift4) INACTIVE.
  const input: MatchReportInputs = {
    schemaVersion: 1,
    inactiveFirst: false, // shift1 & shift3 ACTIVE; shift2 & shift4 INACTIVE
    climbLevel: 0,
    autoClimbLevel1: false,
    fuelBursts: [
      // auto: 4.5 fuel -> rounds half-up to 5
      { startMs: 0, endMs: 9000, rate: 0.5, window: 'auto' },
      // transition: 2.5 fuel -> rounds half-up to 3
      { startMs: 0, endMs: 5000, rate: 0.5, window: 'transition' },
      // shift1 (ACTIVE): float = 4.0 + 1.5 = 5.5 -> 6
      { startMs: 8000, endMs: 12000, rate: 1.0, window: 'shift1' },
      { startMs: 15000, endMs: 18000, rate: 0.5, window: 'shift1' },
      // shift2 (INACTIVE): 3.5 -> 4
      { startMs: 35000, endMs: 42000, rate: 0.5, window: 'shift2' },
      // shift3 (ACTIVE): 2.5 -> 3
      { startMs: 60000, endMs: 65000, rate: 0.5, window: 'shift3' },
      // shift4 (INACTIVE): 1.5 -> 2
      { startMs: 85000, endMs: 88000, rate: 0.5, window: 'shift4' },
      // endgame: 6.5 -> 7
      { startMs: 110000, endMs: 123000, rate: 0.5, window: 'endgame' },
    ],
  };

  const agg = computeAggregates(input);

  it('auto and endgame fuel unchanged (always active)', () => {
    expect(agg.autoFuel).toBe(5);
    expect(agg.endgameFuel).toBe(7);
  });

  it('fuelByShift unchanged (same burst amounts, different active/inactive label)', () => {
    // Per-shift rounded amounts are the same regardless of inactiveFirst
    expect(agg.fuelByShift).toEqual([6, 4, 3, 2]);
  });

  it('teleopFuelActive = transition + shift1(active) + shift3(active)', () => {
    // transition 3 + shift1 6 + shift3 3 = 12  (shift2 & shift4 are now INACTIVE)
    expect(agg.teleopFuelActive).toBe(12);
  });

  it('teleopFuelInactive = shift2(inactive) + shift4(inactive)', () => {
    // shift2 4 + shift4 2 = 6  (shift1 & shift3 are now ACTIVE)
    expect(agg.teleopFuelInactive).toBe(6);
  });

  it('fuelPoints = active fuel * FUEL_POINTS (shift attribution swapped)', () => {
    // active = auto 5 + transition 3 + shift1 6 + shift3 3 + endgame 7 = 24
    expect(agg.fuelPoints).toBe(24);
  });
});
```

- [ ] **Step 2: Run compute tests to verify**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npx vitest run src/scoring/__tests__/compute.test.ts
```
Expected: all tests pass including the new inactiveFirst:false describe block.

---

### Task 5: Env-gate the statbotics-proxy test hook + redeploy

**Files:**
- Modify: `supabase/functions/statbotics-proxy/index.ts`

- [ ] **Step 1: Wrap the _forceUpstreamStatus hook in a DENO_ENV !== "production" guard**

In `supabase/functions/statbotics-proxy/index.ts`, replace:
```typescript
  // Test-only hook to simulate an upstream outage deterministically.
  const forced = url.searchParams.get("_forceUpstreamStatus");
  if (forced) {
    const code = Number(forced);
    if (code >= 500) return unavailable();
  }
```

With:
```typescript
  // Test-only hook to simulate an upstream outage deterministically.
  // Disabled in production to prevent misuse.
  if (Deno.env.get("DENO_ENV") !== "production") {
    const forced = url.searchParams.get("_forceUpstreamStatus");
    if (forced) {
      const code = Number(forced);
      if (code >= 500) return unavailable();
    }
  }
```

- [ ] **Step 2: Deploy the statbotics-proxy function**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
set -a; . ./.env.local; set +a; SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" npx --yes supabase@latest functions deploy statbotics-proxy --project-ref oztsfxyfovwnwutrxzmo --no-verify-jwt
```
Expected: "Done in Xs" or equivalent success message.

- [ ] **Step 3: Run the statbotics-proxy tests to verify**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npx vitest run tests/functions/statbotics-proxy.test.ts
```
Expected: all tests pass.

---

### Task 6: Run full test suite and verify all green

- [ ] **Step 1: Run the full vitest suite**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run test
```
Expected: all tests pass, no failures.

- [ ] **Step 2: Run typecheck**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run typecheck
```
Expected: clean, no errors.

- [ ] **Step 3: Write the final fix report**

Write to `/Users/ryanabraham/Downloads/FRC-scouting-app/.superpowers/sdd/final-fix-report.md`:
- Status
- Commit SHAs + subjects
- One-line result for each of the 5 items
- Any concerns
- Report path

---

## Self-Review

**Spec coverage:**
1. CRITICAL — upsert_match_report ownership gate: Task 1 (SQL + test) ✓
2. IMPORTANT — ingest-reports test wrong shape: Task 2 ✓
3. FIX-NOW MINOR 1 — dead n variable in compute.ts: Task 3 ✓
4. FIX-NOW MINOR 2 — inactiveFirst:false golden test: Task 4 ✓
5. FIX-NOW MINOR 3 — statbotics-proxy env-gate: Task 5 ✓
6. Full test suite + typecheck + report: Task 6 ✓

**Placeholder scan:** All steps have concrete code and commands. No TBD or "implement later" patterns found.

**Type consistency:**
- FuelBurst shape `{ startMs, endMs, rate, window }` used consistently in Tasks 2, 4
- `isWindowActive` import after Task 3 cleanup is consistent with second loop usage
- `MatchReportInputs` type used in Task 4 matches definition in src/scoring/types.ts
