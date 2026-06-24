# Mobile-First Scouting Overhaul — Design

**Date:** 2026-06-23
**Status:** Approved (design), pending spec review

## Goal

Overhaul the FRC scouting PWA into a mobile-first, **landscape-oriented**, big-button,
icon-driven, simplified app. Remove all login/role gating for lead and drive-coach
views, replace the join-code scouter onboarding with a persistent server-side roster
that scouters pick a name from, fix the "selected event disappears" bug, rebuild the
in-match capture screen as a Lovat-style field map (with a combined press-drag slider
for shooting and a press-and-hold defense-duration control), and let each scouter view
their own data.

## Decisions (locked)

1. **Auth:** Remove all visible auth. Keep an *invisible* anonymous Supabase session so
   RLS and cloud sync keep working. `/dashboard` and `/admin` become open.
2. **Roster:** Server-side, **team-scoped** `scouter_roster` table — persists across events.
3. **Capture:** Full Lovat-style **field-map UX**, but it **derives the existing frozen
   report fields on Save**. We do NOT rewrite the persisted data model, scoring engine,
   server RPC, QR envelope, or dashboard aggregations. Only additive schema change:
   `defense_duration_ms`.
4. **Shooting rate range:** slider goes **0–30 BPS** (bots exceed 5 BPS), not 1–5.

## Non-Goals

- No rewrite of the scoring engine (`src/scoring/*`) computation, the
  `upsert_match_report` RPC's aggregate recompute, the QR envelope shape, the sync
  mapping, or the dashboard aggregation logic.
- No multi-team support (single-team app, team 3256, quals only — unchanged).
- No new analytics features beyond the per-scouter "my data" list.

---

## A. Identity, Auth & Roster

### A1. Invisible anonymous session
- On app load, ensure an anonymous Supabase session exists (reuse `ensureAnonSession`
  logic from `joinEvent.ts`, lifted into a small `ensureAnonSession()` util used at app
  boot). No UI. One `auth.uid()` per device (idempotent).
- `useSession` is simplified: it resolves `{ session, scout, loading }`. **`role` is
  removed.** Critically, it must **not** thrash `loading` back to `true` on every
  `onAuthStateChange` (token refresh / tab focus). Only set `loading` during the initial
  resolve; subsequent auth events update `session` silently without flipping `loading`.
  (This is the root cause of the "event disappears" bug — see B1.)

### A2. `scouter_roster` table (migration `0009`)
```sql
create table scouter_roster (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create unique index scouter_roster_name_unique on scouter_roster (lower(name));
alter table scouter_roster enable row level security;
-- Open to anon + authenticated: read, insert, delete. (Single-team app.)
create policy scouter_roster_all on scouter_roster
  for all to anon, authenticated using (true) with check (true);
```
- Team-scoped, **not** event-scoped → persists across events.

### A3. Scouter selection RPC (migration `0009`)
Replaces the join-code path. A SECURITY DEFINER RPC that maps a chosen roster name +
active event to a per-event `scout` row owned by this device's `auth.uid()`:
```sql
create or replace function select_scouter(p_event_key text, p_name text)
returns scout language plpgsql security definer set search_path = public as $$
declare r scout;
begin
  insert into scout (event_key, display_name, auth_uid)
  values (p_event_key, p_name, auth.uid())
  on conflict (event_key, auth_uid) do update set display_name = excluded.display_name
  returning * into r;
  return r;
end; $$;
```
- Requires a unique constraint on `scout (event_key, auth_uid)` (add in `0009` if not
  present). Reuses the existing `scout.id` → reports/assignments pipeline unchanged.

### A4. Defense duration columns (migration `0009`)
```sql
alter table match_scouting_report add column if not exists defense_duration_ms int not null default 0;
alter table match_scouting_report add column if not exists defended_duration_ms int not null default 0;
```
- `defense_duration_ms` = exact ms the scouted robot **played defense** (on others).
- `defended_duration_ms` = exact ms the scouted robot **was being defended** (by others).
- Add BOTH to the `upsert_match_report` RPC param list + insert/update (additive; existing
  columns and recompute logic untouched).
- **No buckets.** The legacy `defense_rating` column is left at its default (`0`) and is
  **not** derived from duration. The two exact durations are the source of truth and will
  be visualized on a match timeline later.

### A5. Routing changes (`src/routes/router.tsx`)
- Remove `RequireRole` and the `/login` route. Remove `RequireSession` join gate
  (scouter identity now comes from name selection, not a guarded join).
- `/` → `/scout`. `/scout`, `/pit`, `/qr/*`, `/dashboard`, `/admin`, `/sync` all open.
- Delete `AdminLogin.tsx`, `JoinScreen.tsx`, `JoinPlaceholder.tsx`, `AdminPlaceholder.tsx`,
  `guards.tsx`, `adminAuth.ts`, `joinEvent.ts` (after lifting `ensureAnonSession`), and
  their tests. `roles.ts` removed.

---

## B. Lead View (open) + Active-Event Persistence

### B1. Active event that "stays" (fixes the bug)
- Introduce `useActiveEvent` v2 that resolves the active event from a **stable source**:
  - Source of truth = server `event.is_active`, but cached in `localStorage`
    (`active_event_key`) and seeded into React Query's initial data so a refetch/focus
    never blanks it mid-session.
  - Setting the active event (lead action) writes `localStorage` AND flips the server
    `is_active` flag, then updates the query cache.
- Because `/dashboard` + `/admin` are no longer behind the `RequireRole`/`useSession`
  loading gate, the guard-driven unmount that wiped local state is gone.

### B2. Lead view structure
- `/dashboard` (the lead/drive-coach hub) gets a top-level **landscape tab bar** with
  lucide icons: **Next Match · Team · Ranking · Picklist · Roster · Setup**.
  - Next/Team/Ranking/Picklist: existing views, restyled (B/D).
  - **Roster** (new): add a scouter name (text input + Add), list existing names with a
    delete button. Backed by `scouter_roster` (A2).
  - **Setup**: event import (existing `EventSetup`) + set/confirm active event (B1) +
    assignment board (existing `AssignmentBoard`).
- `/admin` is folded into the dashboard **Setup** tab. The `/admin` route is kept as an
  alias that redirects to `/dashboard` (Setup tab) so existing links/tests don't 404.

---

## C. Capture Screen — Field-Map Rebuild (derives existing report)

`CaptureScreen.tsx` is rebuilt. A new `useCaptureEvents` layer records an in-memory
timeline of interactions; on Save it **derives the existing `LocalMatchReport` fields**
(via `useCaptureSession`'s `save`, which is reused/extended). No persisted-schema rewrite.

### C1. Layout (landscape, full-bleed)
- Top-down `FieldDiagram` as the backdrop (reuse component + `/assets/field/field.png`).
- Compact top bar: alliance-colored team badge, phase label, live `mm:ss` timer,
  always-visible **Undo** (lucide `Undo2`) disabled when timeline empty.
- One-tap **Start**; phases auto-advance on the existing match clock (auto → teleop →
  endgame). Light haptic pulse (`navigator.vibrate`) on phase change + on each action.
- **Phase-scoped action sets**: only render actions legal in the current phase.

### C2. Combined slider-shoot control (replaces HOLD button + 1–5 slider)
- A vertical slider rendered near the hub/target on the field.
- Gesture: **press + drag up** sets the **BPS rate (0–30)**; while the thumb is held
  above 0 the robot is "shooting" at that rate; on **release** the thumb **springs back
  to 0** and the burst is committed.
- Each completed gesture appends a `FuelBurst { startMs, endMs, rate, window }` — exactly
  today's shape; `rate` now ranges 0–30. Verify `scoring/compute.ts` handles arbitrary
  rate (fuel = rate × duration); add a regression test for rate > 5.

### C3. Defense = press-and-hold duration (exact, no buckets)
Two independent press-and-hold controls, each accumulating **exact elapsed ms** across
any number of intervals during the match:
- **Playing defense** — Defense action button (lucide `Shield`). Hold while the scouted
  robot is playing defense on opponents. Accumulates `defenseDurationMs`.
- **Being defended** — a second control (lucide `ShieldAlert`) the scouter holds while
  the scouted robot **is being defended** by opponents. Accumulates `defendedDurationMs`.
- On Save: `defense_duration_ms = defenseDurationMs`, `defended_duration_ms =
  defendedDurationMs`. **Exact totals only — no rating bucket.** `defense_rating` stays 0.
- Both durations are recorded with per-interval start/end timestamps in the in-memory
  timeline so a later feature can render them on a match timeline. (Persisted fields are
  the two totals; the per-interval detail lives in the capture timeline / review.)
- Both are editable in the Review screen before Save.

### C4. Other actions (phase-scoped, big icon buttons)
- Auto: pick start position (tap field), draw auto path (existing `FieldDiagram` modes),
  Left Starting Line, Auto Climb.
- Teleop/Endgame: climb level, intake source, fouls, pins, no-show/died/tipped/etc. as
  big toggle/stepper buttons with lucide icons. These map 1:1 to existing deferred fields.
- Undo pops the last timeline entry and reverses its derived effect.

### C5. Save / Review
- "To Review" → existing `ReviewScreen` (restyled) confirms derived values, then Save
  produces the unchanged `LocalMatchReport` (+ new `defenseDurationMs`).

---

## D. Visual System (mobile-first, landscape)

- **Landscape-first**: layouts assume horizontal space; primary actions in a horizontal
  band, secondary controls along the edges. Test at ~720×360 and up.
- Touch targets ≥ 56px; primary capture controls larger.
- **lucide-react** icons throughout (already a dependency).
- Tailwind/shadcn tokens already in place; introduce shared sizing utilities
  (e.g. a `big-button` variant on the `Button` CVA) rather than ad-hoc `h-XX` everywhere.
- Simplify each screen to one clear purpose; remove dead/legacy nav (join, login).

## E. Scouter "My Data" View

- New `/scout` section or sub-route: list matches scouted by the **current `scout_id`**
  (this device's selected name + active event), most recent first, with per-match detail
  (team, fuel totals, climb, defense duration, fouls, notes). Reads local reports
  (`listReports` filtered by `scoutId`) merged with synced server rows where available.

---

## F. Fix: QR-Receive Camera Capture

`QrReceiveScreen.tsx` camera does not work. Apply systematic-debugging to find the real
cause before patching. Likely suspects to investigate:
- `<video>` lacks `autoPlay`; the stream attaches but never plays on some browsers.
- Camera requires a **secure context** (HTTPS or `localhost`) — confirm the served
  origin; surface a clear in-UI message if `navigator.mediaDevices` is unavailable.
- `@zxing/browser@0.2.0` `decodeFromVideoDevice` device selection / API shape; prefer the
  rear camera via `facingMode: 'environment'` constraints where supported.
- iOS Safari `playsInline` + gesture requirements.
Deliver a verified fix (reproduce → diagnose → fix → confirm) with an explicit camera
permission/secure-context error state in the redesigned (landscape, big-button) screen.

---

## Migrations Summary (`supabase/migrations/0009_overhaul.sql`)
1. `scouter_roster` table + RLS (A2).
2. `select_scouter` RPC + `scout (event_key, auth_uid)` unique constraint (A3).
3. `match_scouting_report.defense_duration_ms` + `defended_duration_ms` columns (A4).
4. Extend `upsert_match_report` RPC to read/write both duration columns (A4).

## Testing Strategy

- **Unit (vitest):** roster client, `select_scouter` client wrapper, active-event
  persistence (localStorage seed + no-blank-on-refetch), defense/defended duration
  accumulation across multiple intervals (exact ms, no buckets), fuel burst at rate > 5,
  slider-shoot gesture state machine.
- **Component (RTL):** capture field-map phase-scoped rendering, slider-shoot
  press/drag/release → burst committed + springs to 0, hold-defense + hold-defended each
  accumulate exact ms, Undo reverses last action, roster manager add/remove, "my data"
  list filtered by scout.
- **E2E (Playwright):** open lead view with no login; set event and confirm it persists
  across reload; scouter selects name → capture → save → appears in "my data" and
  dashboard. Landscape viewport.
- Update/remove tests for deleted auth/join/role modules.

## Risk & Sequencing Notes

- Migration `0009` must land before the roster/scouter-select clients are wired.
- The capture rebuild is the largest unit; keep `useCaptureSession.save` as the stable
  contract so the field-map layer only changes how inputs are gathered.
- Removing auth touches routing, guards, and many tests — do it as one coherent unit to
  avoid a half-gated state.
