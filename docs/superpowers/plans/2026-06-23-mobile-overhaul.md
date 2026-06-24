# Mobile-First Scouting Overhaul Implementation Plan

> **For agentic workers:** Implement task-by-task with TDD. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebuild the FRC scouting PWA as a mobile-first, landscape, big-button, icon-driven app: remove visible auth, add a persistent scouter roster + name-pick onboarding, fix the active-event-disappears bug, rebuild capture as a field-map with a press-drag slider-shoot (0–30 BPS) and press-and-hold defense/being-defended durations, add a per-scouter "my data" view, and fix QR-receive camera.

**Architecture:** Keep Supabase + an *invisible* anonymous session (RLS intact). Capture is a new field-map UI that records an in-memory timeline and **derives the existing frozen `LocalMatchReport` on Save** (no scoring/sync/dashboard rewrite). One additive migration `0009` (roster table, `select_scouter` RPC, two duration columns).

**Tech Stack:** React 18 + TS, Vite, Tailwind + shadcn-style UI, lucide-react, zustand, dexie, @tanstack/react-query, @supabase/supabase-js, @zxing/browser, vitest + RTL, Playwright.

## Global Constraints

- Single team (3256), quals only. Do NOT change scoring computation, `upsert_match_report` aggregate recompute, QR envelope shape, or dashboard aggregation math.
- Schema changes are **additive only** (migration `0009`). Existing columns keep their semantics.
- Defense durations are **exact ms, no buckets**. `defense_rating` stays at default `0`.
- Slider-shoot rate range is **0–30 BPS**.
- Touch targets ≥ 56px; landscape-first; lucide icons; no login/role UI anywhere.
- `useCaptureSession.save()` remains the stable contract that produces `LocalMatchReport`.

---

## PHASE 0 — Shared Foundation (sequential, single owner; unblocks all parallel work)

These touch tightly-coupled shared files (`db/types`, `useSession`, `router`, `useCaptureSession`, migration, `mapReport`, UI `button`). Done first so parallel workstreams never edit the same file.

### Task 0.1: Migration `0009`
**Files:** Create `supabase/migrations/0009_overhaul.sql`; Modify `supabase/migrations/0004_rpcs.sql` is NOT edited — instead the new migration `create or replace`s `upsert_match_report`.
- [ ] Add `scouter_roster` table + RLS (anon+authenticated all, using/check true) + unique index on `lower(name)`.
- [ ] Add unique constraint `scout_event_uid_unique` on `scout (event_key, auth_uid)` (guard with a DO block if it may already exist).
- [ ] `create or replace function select_scouter(p_event_key text, p_name text) returns scout` (SECURITY DEFINER, upsert on conflict (event_key, auth_uid)).
- [ ] `alter table match_scouting_report add column if not exists defense_duration_ms int not null default 0;` and `defended_duration_ms` likewise.
- [ ] `create or replace` `upsert_match_report` copied from `0004_rpcs.sql` with two new params `p_defense_duration_ms int default 0`, `p_defended_duration_ms int default 0` added to the insert/update column lists. (Read `0004_rpcs.sql` first; preserve every existing param/column verbatim.)
- [ ] Commit.

### Task 0.2: Report type + sync mapping + local store carry the new fields
**Files:** Modify `src/db/types.ts` (add `defenseDurationMs: number; defendedDurationMs: number` to `LocalMatchReport`), `src/sync/mapReport.ts` (add `defense_duration_ms`, `defended_duration_ms` to payload), `src/capture/useCaptureSession.ts` (add to `DeferredState` + initial + setters + `save()` report).
**Interfaces — Produces:**
- `LocalMatchReport.defenseDurationMs: number`, `.defendedDurationMs: number`
- `useCaptureSession` returns `defenseDurationMs`, `setDefenseDurationMs(ms)`, `defendedDurationMs`, `setDefendedDurationMs(ms)` (and keeps all existing returns).
- [ ] TDD: extend `src/sync/__tests__/mapReport.test.ts` to assert both snake_case keys map. Add a `useCaptureSession` test asserting `save()` persists both durations.
- [ ] Implement; run `npm run test -- mapReport useCaptureSession`; commit.

### Task 0.3: `ensureAnonSession` util + simplified `useSession` (bug fix core)
**Files:** Create `src/auth/ensureAnonSession.ts` (lift the anon sign-in logic out of `joinEvent.ts`). Modify `src/auth/useSession.ts`.
**Interfaces — Produces:**
- `ensureAnonSession(): Promise<void>`
- `useSession(): { session: Session|null; scout: ScoutRow|null; loading: boolean }` — **no `role`**. `loading` is set true only on the FIRST resolve; later `onAuthStateChange` events update `session` WITHOUT setting `loading` back to true.
- [ ] TDD: `useSession.test.ts` — assert a second `onAuthStateChange` (e.g. TOKEN_REFRESHED) does NOT flip `loading` to true (regression for the disappearing-event bug).
- [ ] Implement; run tests; commit.

### Task 0.4: Open routing; delete auth/join/role surface
**Files:** Modify `src/routes/router.tsx`, `src/main.tsx` (call `ensureAnonSession()` at boot). Delete `src/routes/guards.tsx`, `src/auth/AdminLogin.tsx`, `src/auth/JoinScreen.tsx`, `src/auth/roles.ts`, `src/auth/adminAuth.ts`, `src/routes/JoinPlaceholder.tsx`, `src/routes/AdminPlaceholder.tsx`, and their `__tests__`. Lift any still-needed bits out of `joinEvent.ts` (then delete it + tests).
**Interfaces — Produces:** routes `/scout`, `/pit`, `/qr/send`, `/qr/receive`, `/dashboard`, `/sync`, `/my-data` all open; `/admin` → `<Navigate to="/dashboard?tab=setup" replace/>`; `/` → `/scout`; `*` → `/scout`.
- [ ] Update `router.test.tsx` to assert no redirect-to-login and open access.
- [ ] Implement; ensure `npm run typecheck` passes (fix all references to deleted modules — `ScoutHome` import of `joinEvent`/`useSession.role`, etc.); commit.

### Task 0.5: `big` button variant + landscape base
**Files:** Modify `src/components/ui/button.tsx` (add a `size: 'big'` CVA variant ≥56px, large text) ; `src/index.css` if a landscape utility helps.
**Interfaces — Produces:** `<Button size="big">` available to all workstreams.
- [ ] TDD in `button.test.tsx`; implement; commit.

### Task 0.6: Active-event persistence v2 (bug fix)
**Files:** Modify `src/dash/useActiveEvent.ts`; Create `src/dash/activeEventStore.ts` (localStorage get/set `active_event_key`) and `src/dash/setActiveEvent.ts` (flips server `is_active` + writes localStorage + updates query cache).
**Interfaces — Produces:**
- `useActiveEvent(): { eventKey: string|null; loading: boolean }` — seeds `initialData` from localStorage so refetch/focus never blanks it.
- `setActiveEvent(eventKey: string): Promise<void>`
- [ ] TDD: `useActiveEvent.test.tsx` — assert localStorage seed used as initialData; a refetch returning the same value never produces a null flash.
- [ ] Implement; commit.

---

## PARALLEL WORKSTREAMS (dispatched after Phase 0; disjoint file ownership)

### Workstream A — Capture field-map rebuild  ⟶ owns `src/capture/*` (except `useCaptureSession.ts` contract from 0.2), new `src/capture/fieldmap/*`
**Depends on:** 0.2 (duration setters), 0.5 (big button).
**Deliverables:**
- `src/capture/useCaptureEvents.ts`: in-memory timeline `{type, ts, payload}[]`, `undo()`, and derivation helpers feeding `useCaptureSession` setters.
- Rebuilt `src/capture/CaptureScreen.tsx`: landscape full-bleed field map (reuse `FieldDiagram` + `/assets/field/field.png`), top bar (alliance team badge, phase, `mm:ss`, always-visible Undo), one-tap Start with auto-advancing phases, haptic (`navigator.vibrate`) on phase change + action, phase-scoped action sets.
- `src/capture/SliderShoot.tsx`: vertical press-drag slider. Press+drag up sets rate 0–30; held>0 = shooting at rate; release → springs to 0 and commits a `FuelBurst {startMs,endMs,rate,window}`. (Verify `scoring/compute.ts` handles rate>5; add regression test in `src/scoring/__tests__`.)
- Defense controls: `Shield` (playing defense) + `ShieldAlert` (being defended), each press-and-hold accumulating EXACT ms across intervals into `defenseDurationMs` / `defendedDurationMs`; per-interval start/end kept in the timeline for a future timeline view.
- Restyle `ReviewScreen.tsx` (landscape, big buttons) + allow editing both durations before Save.
- **TDD:** RTL tests for phase-scoped rendering, slider-shoot commit+spring-to-0, both hold controls accumulate exact ms over 2 intervals, Undo reverses last action.
**Must not touch:** scoring math, sync, dashboard, auth, roster files.

### Workstream B — Roster + scouter onboarding + My Data  ⟶ owns new `src/roster/*`, `src/capture/ScoutHome.tsx`, new `src/scout/MyDataView.tsx`
**Depends on:** 0.1 (roster table + `select_scouter`), 0.3 (`useSession` no role), 0.4 (open routes), 0.6 (active event).
**Deliverables:**
- `src/roster/rosterClient.ts`: `listRoster()`, `addScouter(name)`, `removeScouter(id)` against `scouter_roster`.
- `src/roster/selectScouter.ts`: wraps `select_scouter` RPC → returns `ScoutRow`; remembers chosen name in localStorage (`my_scouter_name`).
- Rebuilt `src/capture/ScoutHome.tsx`: resolves active event automatically; if no name chosen, show a **type-to-filter name picker** from the roster (tap name → `selectScouter(activeEvent, name)` → sets `scout`); remembered across reloads; then shows assignments / manual pick / drafts (restyled, landscape). Remove all join-code UI.
- `src/scout/MyDataView.tsx` at `/my-data`: list local reports filtered by current `scoutId` (use `listReports` from `localStore`; add it if missing), newest first, per-match detail incl. both defense durations; link from ScoutHome.
- **TDD:** rosterClient (mock supabase), selectScouter localStorage, ScoutHome name-pick flow (RTL), MyDataView filtering.
**Must not touch:** capture internals (A), dashboard tabs (C), QR (D).

### Workstream C — Lead dashboard: open, tabbed, roster+setup, restyle  ⟶ owns `src/dash/DashboardScreen.tsx`, `src/admin/*` integration into dashboard, new `src/dash/RosterTab.tsx`, `src/dash/SetupTab.tsx`
**Depends on:** 0.4 (open), 0.5 (big button), 0.6 (`setActiveEvent`), 0.1 (roster table), Workstream B's `rosterClient` (import only — B owns the file).
**Deliverables:**
- Rebuilt `DashboardScreen.tsx`: landscape tab bar with lucide icons — Next Match · Team · Ranking · Picklist · **Roster** · **Setup**. Read tab from `?tab=` query so `/admin` alias lands on Setup.
- `src/dash/RosterTab.tsx`: add/list/remove scouter names via `rosterClient`.
- `src/dash/SetupTab.tsx`: `EventSetup` import + a "Set active event" control calling `setActiveEvent` + `AssignmentBoard`. Replaces standalone `AdminPage` usage (keep `AdminPage` importable or migrate its body here).
- Restyle existing dash views minimally for landscape/big-button consistency (no logic change).
- **TDD:** DashboardScreen tab routing incl. `?tab=setup`; RosterTab add/remove; SetupTab set-active calls `setActiveEvent`.
**Must not touch:** capture (A), ScoutHome/roster client impl (B owns rosterClient.ts), QR (D).

### Workstream D — QR-receive camera fix  ⟶ owns `src/qr/QrReceiveScreen.tsx`
**Depends on:** 0.5 only.
**Deliverables:** Apply systematic-debugging. Likely fixes: add `autoPlay` to `<video>`; request rear camera via `facingMode:'environment'`; guard `navigator.mediaDevices` undefined (insecure context) with a clear in-UI message; ensure `playsInline`. Restyle landscape/big-button. Add a unit/RTL test for the secure-context/permission error state.
**Must not touch:** envelope/ingest logic, other areas.

---

## Integration & Verification (single owner, after parallel streams land)
- [ ] `npm run typecheck` clean.
- [ ] `npm run test` — full vitest suite green (update/remove tests for deleted auth/join/role modules).
- [ ] `npm run build` succeeds.
- [ ] Playwright E2E (`tests/`): open lead view w/o login; set event, reload, event persists; scouter picks name → capture (slider-shoot + both defense holds) → save → appears in My Data; landscape viewport. Run `npm run test:e2e` (or document if env/Supabase unavailable).
- [ ] Final commit + summary.

## Self-Review (done by planner)
- Spec A→F all mapped: A→0.1/0.3/0.4 + B; B→0.6 + C; C→A; D→D(visual)+C; E→B; F→D. ✓
- No buckets: 0.2/A persist exact ms, `defense_rating` untouched. ✓
- 0–30 BPS: Workstream A SliderShoot + scoring regression test. ✓
- Shared files isolated in Phase 0; parallel streams have disjoint ownership. ✓
