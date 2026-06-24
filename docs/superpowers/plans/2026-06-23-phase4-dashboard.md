# Phase 4 — Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A staff/drive-coach dashboard that turns scouting + TBA + Statbotics into decisions: confidence-weighted next-match predictions, team deep-dives, ranking/compare, a shared picklist, an autonomous-routines field overlay, and CSV/JSON export — degrading gracefully when Statbotics is down.

**Architecture:** Pure analytics modules (`aggregate`, `predict`) over the existing `match_scouting_report` aggregates, fed by react-query data hooks (supabase + the `tba-proxy`/`statbotics-proxy` passthroughs). Four views under a tabbed shell at `/dashboard` (RequireRole lead). One new server table (`picklist`, staff RLS). FieldDiagram gains a read-only multi-robot overlay.

**Tech Stack:** React 18 + TS strict; `@tanstack/react-query` (installed, first use here); supabase-js; existing Edge Function proxies; Postgres migration for the picklist.

## Global Constraints
- **FROZEN CONTRACTS:** `.superpowers/sdd/phase4-contracts.md` is binding for every shape/signature. Copy verbatim.
- **Graceful degradation:** a Statbotics outage (`{ available: false }`) must NEVER hard-fail the dashboard — predictions fall back to scouting-only; the UI shows EPA as unavailable.
- **Rate-FUEL visibly down-weighted** (`fuelPointsWeighted = meanFuelPoints * meanFuelConfidence`); the UI must surface the low confidence.
- **3256 is unscouted** — no TeamAgg; EPA-only in predictions; omitted from our-alliance auto overlay.
- **Scoring is frozen** — use `@/scoring` `SCORING.CLIMB`; never re-implement magnitudes.
- **Read-only against scouting data** — the dashboard never writes match reports; the only writes are the picklist (staff RLS).
- TS strict, `noUnusedLocals/Parameters`; `@/*`→`./src`; dark theme; shadcn/ui; staff-only gate; testids on interactive elements. Secrets: client reads only `VITE_` vars.
- **Live backend (migration deploy) is a trust boundary:** implementers PAUSE; controller applies `0007_picklist.sql` (apply-sql.py) under standing authorization + live-verifies.

## File Structure
- `src/dash/types.ts` — `MsrRow` + shared view types. [ANALYTICS]
- `src/dash/constants.ts` — CONFIDENCE_N / WINPROB_K / OUR_TEAM. [ANALYTICS]
- `src/dash/aggregate.ts` + `predict.ts` — pure analytics. [ANALYTICS]
- `src/dash/proxies.ts` — tbaGet/statboticsGet + epaFromTeamEvent. [DATA]
- `src/dash/useEventData.ts` — react-query hooks; `src/App.tsx` provider. [DATA]
- `src/dash/useActiveEvent.ts` — resolve the active event for staff. [DATA]
- `src/components/FieldDiagram.tsx` (extend) + `src/dash/AutoRoutines.tsx`. [FIELD2]
- `supabase/migrations/0007_picklist.sql` + `src/dash/picklistClient.ts`. [SERVER]
- `src/dash/NextMatchView.tsx`, `TeamView.tsx`, `RankingView.tsx`, `PicklistView.tsx`, `exportDash.ts`. [Wave 2 views]
- `src/dash/DashboardScreen.tsx` + `src/routes/router.tsx` (wire). [SHELL, controller]
- Tests under `src/dash/__tests__/`; E2E `tests/e2e/dashboard.spec.ts`. [GATE]

## Execution Waves
- **Wave 1 (parallel, disjoint):** ANALYTICS (types+constants+aggregate+predict), DATA (proxies+react-query provider+hooks), FIELD2 (overlay), SERVER (migration+picklist client).
- **Wave 2 (parallel, disjoint views; consume Wave 1):** NEXTMATCH (+AutoRoutines use), TEAMVIEW, RANKING, PICKLIST (+exportDash).
- **Wave 3 (controller):** SHELL (DashboardScreen tabs + wire /dashboard) + GATE.
opus, shared-tree disjoint files.

---

## Task ANALYTICS: pure aggregate + prediction core
**Files:** create `src/dash/types.ts`, `src/dash/constants.ts`, `src/dash/aggregate.ts`, `src/dash/predict.ts`; tests `src/dash/__tests__/aggregate.test.ts`, `predict.test.ts`.
**Interfaces:** contracts §1 (MsrRow), §2 (aggregate), §3 (predict), §9 (constants). Consumes `@/scoring` `SCORING`.
- [ ] **Aggregate tests:** build MsrRow[] for a team (2-3 matches) and assert each TeamAgg field by hand-computed values, incl. `fuelPointsWeighted = meanFuelPoints*meanFuelConfidence`, `meanClimbPoints` via `SCORING.CLIMB[level].teleop` only when `climb_success`, reliability, and `aggregateEvent` grouping (skips `deleted`). Run→fail.
- [ ] **Implement aggregate.ts** per §2. Run→pass.
- [ ] **Predict tests** (the core — be thorough): both-present blend (`w=min(1,m/CONFIDENCE_N)`), scouting-only when `statboticsAvailable=false` (epa ignored, w=1), epa-only for unscouted team (m=0), neither→0/'none', alliance score = Σ, `redWinProb` logistic monotonic + 0.5 at equal scores, `confidence` drops when Statbotics unavailable, NO throw on unknown teams. Run→fail.
- [ ] **Implement predict.ts** per §3. Run→pass.
- [ ] Commit `feat(dash): pure aggregate + confidence-weighted prediction core`.

## Task DATA: proxy client + react-query hooks
**Files:** create `src/dash/proxies.ts`, `src/dash/useEventData.ts`, `src/dash/useActiveEvent.ts`; modify `src/App.tsx` (QueryClientProvider); tests `src/dash/__tests__/proxies.test.ts`, `useEventData.test.tsx`.
**Interfaces:** contracts §4, §5. `@/lib/env` (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY), `@/lib/supabase`.
- [ ] **proxies tests:** mock `fetch` + `supabase.auth.getSession`; assert `tbaGet` hits `/functions/v1/tba-proxy?path=...` with apikey+Authorization and throws on non-2xx; `statboticsGet` returns parsed JSON on 200, `{available:false}` on the sentinel body AND on a thrown fetch/500 (never throws); `epaFromTeamEvent` extracts a number or null defensively. Run→fail→implement→pass.
- [ ] **hooks:** wrap `<AppRouter/>` in `QueryClientProvider`. Implement `useEventReports/useEventMatches/useEventTeams/useTbaRankings/useEventEpa` + `useActiveEvent` (supabase `event` where `is_active`). Test with a `QueryClientProvider` wrapper + mocked supabase/proxies (assert query keys + that `useEventEpa` returns `{epaByTeam, available:false}` when Statbotics is down). Run→fail→implement→pass.
- [ ] Commit `feat(dash): proxy client + react-query event-data hooks`.

## Task FIELD2: multi-robot auto-routines overlay
**Files:** modify `src/components/FieldDiagram.tsx` (add `overlays` prop, read-only render); create `src/dash/AutoRoutines.tsx`; tests `src/components/__tests__/FieldDiagram.test.tsx` (extend), `src/dash/__tests__/AutoRoutines.test.tsx`.
**Interfaces:** contracts §7. Do NOT change existing FieldDiagram behavior/props/testids.
- [ ] **Test** the additive `overlays` prop renders N polylines/markers with given colors (read-only, no pointer handlers fire), existing single-path/start still works. `AutoRoutines` builds overlays from reports (latest auto_start_position/auto_path per team), color-codes, and OMITS `OUR_TEAM` (3256) when `isOurAlliance`. Run→fail→implement→pass.
- [ ] Commit `feat(dash): FieldDiagram overlays + auto-routines display`.

## Task SERVER: picklist table + client
**Files:** create `supabase/migrations/0007_picklist.sql`, `src/dash/picklistClient.ts`; test `tests/db/picklist.test.ts` (live, gated) OR `src/dash/__tests__/picklistClient.test.ts` (mocked supabase). PAUSE for controller to apply the migration.
**Interfaces:** contracts §6. `is_staff()` exists (0005).
- [ ] Write `0007_picklist.sql` exactly per §6. Write `picklistClient.ts` (`getPicklist` selects entries (`[]` if none), `savePicklist` upserts on `event_key`, stamping nothing extra client-side).
- [ ] Mocked client test (assert upsert payload + `[]` default). Run→pass. **PAUSE:** report DONE_WITH_CONCERNS — controller applies 0007 + runs a live staff round-trip (insert+read).
- [ ] Commit `feat(dash): shared picklist table (staff RLS) + client`.

## Wave 2 — Views (each default-export, consumes Wave 1; mock data hooks in tests)
### NEXTMATCH (`src/dash/NextMatchView.tsx`, testid `dash-next`)
- [ ] Resolve our (3256) next unplayed qm from matches; show both alliances, `predictMatch` scores + `redWinProb` + per-team `TeamPrediction` (source badge), key team stats, a **rate-FUEL low-confidence indicator**, and `<AutoRoutines>` for each alliance (3256 omitted from ours). When `useEventEpa().available===false`, show an "EPA unavailable — scouting only" banner (still renders predictions). Test (mock hooks incl. Statbotics-down) → renders predictions + degraded banner. Commit.
### TEAMVIEW (`src/dash/TeamView.tsx`, testid `dash-team`)
- [ ] Team picker → TeamAgg detail (fuel breakdown with confidence, climb, defense, reliability), Statbotics EPA (or "unavailable"), the team's matches. Test → renders for a team + handles no-data + Statbotics-down. Commit.
### RANKING (`src/dash/RankingView.tsx`, testid `dash-ranking`)
- [ ] Sortable table of all event teams: matchesScouted, scoutingExpectedPoints, climb%, defense, EPA, TBA rank; multi-select compare. Test → sorts + renders rows + degraded EPA column. Commit.
### PICKLIST (`src/dash/PicklistView.tsx`, testid `dash-picklist`) + `exportDash.ts`
- [ ] Load via `getPicklist`, reorder (up/down buttons — no dnd dep), add/remove team, tier/note, `savePicklist` on change; CSV/JSON export via `exportDash` (revoke blob URL). Test (mock picklistClient) → add/reorder/save called + export builds CSV. Commit.

## Task SHELL + ROUTER (controller)
- [ ] Create `DashboardScreen.tsx` (testid `dashboard`) — `useActiveEvent()`, tabbed nav (`dash-tab-*`) rendering the 4 views; empty/no-active-event state. Wire `/dashboard` → `DashboardScreen` (replace `DashboardPlaceholder`) under the existing `RequireRole role="lead"`. typecheck + tests + build.
- [ ] Commit `feat(dash): dashboard shell + wire /dashboard`.

## Task GATE (controller-inline)
**Files:** `tests/e2e/dashboard.spec.ts`.
- [ ] **E2E:** seed (global-setup already seeds `_e2etest` + a match + team; extend to make `_e2etest` active OR use 2026casnv) — admin logs in (admin ≥ lead) → `/dashboard` → `dashboard` visible → `dash-tab-next` renders a prediction (works even if Statbotics is down) → picklist tab: add a team, assert it persists (service-role read of the `picklist` row) → cleanup. Keep it resilient to a live Statbotics outage (assert the dashboard renders + a prediction number appears, not a specific score).
- [ ] **Verification gate:** `npm run test` + typecheck + build + `test:e2e` (browser egress) all green. Commit.

## Self-Review (controller)
- Spec coverage: next-match preview + confidence-weighted prediction (ANALYTICS+NEXTMATCH), team deep-dive (TEAMVIEW), ranking/compare (RANKING), picklist (PICKLIST+SERVER), auto-routines overlay both alliances 3256-omitted (FIELD2), CSV/JSON export (exportDash), TBA/Statbotics + graceful degradation (DATA), rate-FUEL down-weight (aggregate+UI). ✓
- Acceptance: predictions render; Statbotics-down path is first-class (proxies + predict + every view); rate-FUEL down-weighted + surfaced. ✓
- Types pinned to the contracts file; no placeholders. ✓
