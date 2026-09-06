# AGENTS.md

Guidance for coding agents working in this repository. (The parallel `CLAUDE.md` covers the
same ground; keep the two in sync when either drifts.)

## What this is

An offline-first PWA for FRC team 3256 scouting the 2026 game **REBUILT**. One app, two
roles (no login wall): **Scout** captures match/pit data from the stands; **Lead Dashboard**
turns it into live, broadcast-style strategy. The whole point is surviving a bad venue
network — local-first storage, persisted caches, and QR device-to-device transfer.

## Porting to a new season

This app is the 2026 REBUILT instantiation of a game-agnostic scouting engine. To adapt it
to a future year's game (drop in `<YEAR>GameManual.pdf`), follow **`docs/game-migration/`**
— a phased playbook: extract manual → write game-reference → fill the slot Decision Sheet →
implement from the change catalog → verify/deploy. Start at `docs/game-migration/README.md`
(phases `01`–`05`). The one hard invariant: scoring logic is duplicated across the client
(`src/scoring/`), the `upsert_match_report` RPC, and `seed-demo` (see its shared
`supabase/functions/_shared/demoScoring.ts`), and they must stay byte-equivalent
(see `docs/game-migration/04-scoring-sync-contract.md`).

## Commands

```bash
npm run dev              # Vite dev server at http://localhost:5173
npm run build            # tsc -b && vite build
npm test                 # Local Vitest unit/contract tests (vitest run); test:watch for watch mode
npm run test:integration # Remote Supabase DB + Edge Function tests (vitest --config vitest.integration.config.ts)
npm run test:e2e         # Playwright e2e (boots dev server on :5173 automatically)
npm run typecheck        # tsc --noEmit -p tsconfig.json
```

Run a single test: `npx vitest run src/scoring/compute.test.ts` or `-t "<name>"`.
Single e2e: `npx playwright test tests/e2e/capture.spec.ts`.

`vitest.config.ts` (the default `npm test` config) includes `src/**/*.{test,spec}.{ts,tsx}`
plus the one pure contract test `tests/functions/seed-demo-scoring.test.ts` (no backend
needed); it excludes `tests/e2e/**`. `vitest.integration.config.ts` covers the remote suites
`tests/db/**/*.test.ts` and `tests/functions/**/*.test.ts` (excluding the pure contract test),
runs with `fileParallelism: false`, and calls `assertDedicatedRemoteTestProject()` at load so
it refuses to run against a non-dedicated project — these tests can mutate the configured
Supabase project. E2e under `tests/e2e/**` runs only through Playwright. Both Vitest configs
use the custom jsdom compat shim `vitest-env-jsdom-compat.ts` and `vitest.setup.ts`, and `@`
aliases `src/`.

**Playwright e2e hits a real remote Supabase**, so it runs single-worker (`workers: 1`):
the live specs share one DB and mutate the global `event.is_active` singleton — parallel
files would stomp each other.

## Deployment

The Supabase backend is **already deployed to a remote project** (not local). After changing
anything under `supabase/`, push it — there is a standing instruction to auto-deploy (the CLI
is invoked via `npx supabase` in this environment):

```bash
npx supabase db push            # apply new migrations
npx supabase functions deploy   # deploy edge functions
```

Frontend deploys via Vercel on merge to `main`. Migrations are **append-only** — never edit a
migration that has been pushed; add a new one. Numbering has two eras: the original sequential
`0001_`…`0045_` files, and newer **timestamp-style** names (`20260710…`, `20260722…`), which
is the current convention for new migrations. Webhook/live-data setup is documented in
`docs/webhooks-setup.md`.

## Environment

`VITE_*` vars ship to the browser and are safe (RLS protects them):
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (anon/publishable key the client ships
with). Anything without the `VITE_` prefix is server-only and must never reach the browser:
`SUPABASE_SECRET_KEY` / the deployed functions' `SUPABASE_SERVICE_ROLE_KEY` bypass RLS (Edge
Functions and migrations only); `TBA_API_KEY` is used by the `tba-proxy` and TBA import/sync
functions; `TBA_WEBHOOK_SECRET` and `NEXUS_WEBHOOK_TOKEN` authenticate the inbound webhooks;
`SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD` authenticate the Supabase CLI. See
`.env.example`; copy to `.env.local` (gitignored — never commit real keys).

## Authorization model (intentional)

This is deliberately a login-less, shared-trust team app. Anonymous users are intended to be
able to create, edit, overwrite, and delete shared app data; those broad capabilities are not
authorization bugs. Do not propose login walls, ownership checks, role gates, or narrower
anonymous RLS policies unless the user explicitly asks to redesign this model. Continue to
protect server-only secrets and flag any accidental exposure of service-role credentials.

## Architecture

**Frontend** — React 18 + TS + Vite, Tailwind, React Router. State via Zustand (small
stores like `activeEventStore`, `baseTeamStore`) + TanStack Query. `App.tsx` wraps everything
in `PersistQueryClientProvider` so the query cache persists to IndexedDB (`idb-keyval`) and an
offline reload rehydrates the last good data instead of hanging.

**No auth, no role gates** (`src/routes/router.tsx`). Every route is open; a silent anonymous
Supabase session (`src/auth/ensureAnonSession.ts`, called from `main.tsx`) satisfies RLS.
Every route carries the same `errorElement` (`RouteError`) so a single screen throwing can
never blank the whole app — critical because offline fetch failures otherwise read as a dead
page. `/pit` and `/admin` are redirects that fold into `/scout?mode=pit` and the dashboard
Setup tab.

**Local-first storage** — `src/db/localStore.ts` is a Dexie (IndexedDB) DB (`scouting-db`,
currently on schema version 5+). Reports and drafts persist immediately with a `syncState`
(`dirty`/`pending`/`synced`/error). It also holds the v2 "preload cache" (`cachedMatches`,
`cachedAssignments`, `cachedPitAssignments`, `cachedRoster`, `cachedTeams`, `preloadMeta`) that
pre-downloads event data so scout screens work with zero wifi (see `db/preloadClient.ts`), plus
outbox tables for `matchupNotes` (team strategy notes) and `strategyCanvas` (per-match
whiteboard docs). Pit reports live in a **separate** Dexie DB `pit-scouting-db`
(`src/pit/pitStore.ts`); the cross-tab sync lease uses a third DB (`scouting-sync-coordination`).
The Dexie version number is a hard merge-gate: a new store must bump the version and redeclare
all prior stores, or `db.open()` throws app-wide.

**Sync engine** (`src/sync/`) — `useSync.ts` is the controller hook: it drives the outboxes on
mount, on the offline→online edge, every `SYNC_POLL_MS` while online, and on demand, and never
auto-runs while offline. There are four sibling outboxes, all draining through
revision-guarded/idempotent upsert RPCs: `outbox.ts` (match reports → `upsert_match_report`),
`pitOutbox.ts` (pit reports + photo upload → `upsert_pit_report`), `matchupNotesSync.ts`
(→ `upsert_matchup_note`), and `strategyCanvasSync.ts` (→ `upsert_strategy_canvas`). Drains run
under a cross-tab lease (`syncLease.ts`) so multiple open tabs don't stampede. `mapReport.ts`
is the *single* source of the snake_case match-report upsert wire shape — the server recomputes
aggregates from raw fields, so keep client and RPC in sync. `classifyError.ts` splits failures
into **transient** (network/5xx/408/429/connection-class SQLSTATE → retry with backoff) vs
**terminal** (validation/auth/4xx → dead-letter); pure network gaps (`isNetworkFailure`) do NOT
count against the report because a dead venue network is normal operating condition.
`retrySchedule.ts` holds the exponential backoff (2s→5min, honoring `Retry-After`) and a shared
sync circuit breaker. `SYNC_MAX_ATTEMPTS` is retained for diagnostics/back-compat but infra
failures no longer dead-letter solely on attempt count. `localRecovery.ts` / the store's
`requeueAuthClass*DeadLetters` re-queue auth-class dead-letters once a deployed RLS/RPC fix ships.

**QR transfer** (`src/qr/`) — when there's no network at all, reports move device-to-device by
animated QR (fountain-coded; see `sync/constants.ts`: `FOUNTAIN_BLOCK_BYTES`, `QR_FRAME_MS`,
`QR_SCAN_DELAY_MS`, `QR_ENVELOPE_VERSION`) and merge on the receiving side; the receiving device
POSTs the merged batch to the `ingest-reports` Edge Function.

**Scoring model** (`src/scoring/`) — pure, versioned (`SCHEMA_VERSION`, currently 2) REBUILT
scoring. `computeAggregates` (`compute.ts`) turns raw inputs (fuel bursts over time windows,
climbs, defense intervals, auto routines) into aggregates, using `windows.ts` for shift/window
math and `fouls.ts` for penalties. `migrations.ts`/`migrateUp` upgrades old report shapes. This
is duplicated server-side (the RPC recomputes) — the client computation is for display/preview.
`index.ts` is the public entry point.

**Dashboard prediction** (`src/dash/`) — `predict.ts` is a pure confidence-weighted next-match
prediction: blends our scouting expectation with EPA, weighted by how many matches we've
scouted, degrading to scouting-only or EPA-only when a source is missing. `localEpa.ts` /
`seasonEpa.ts` compute a cross-event (season carry-over) scalar EPA locally over TBA results
when Statbotics is unavailable — `localEpa.ts` mirrors the live Statbotics repo math (not the
2023 blog) and is fed by TBA matches since the local table has no scores. `demoEvent.ts` drives
demo mode. `proxies.ts` reads the Edge proxies' `{ available: false }` sentinel so an upstream
outage degrades gracefully.

**Backend** (`supabase/`) — Postgres with RLS. Edge Functions (`supabase/functions/`):
- Read proxies that **degrade gracefully**, returning `{ available: false }` rather than
  throwing: `tba-proxy`, `statbotics-proxy`, `nexus-proxy` (live field status).
- `import-event` (open TBA event import via service role), `ingest-reports` (QR/cross-scout
  ingest, gated by the receiver's JWT), `seed-demo` (builds a demo event from a real TBA event
  using a service-role client; scoring shared via `_shared/demoScoring.ts`).
- Live-data webhooks (deployed `verify_jwt = false`, return 200 except on auth failure):
  `tba-webhook` (match results, HMAC-verified), `nexus-webhook` (live field status,
  `Nexus-Token`-verified), and `sync-event-results` (pull-based reconcile that self-heals
  dropped TBA webhooks).

Key RPCs: `upsert_match_report`, `upsert_pit_report`, `upsert_matchup_note`,
`upsert_strategy_canvas`, `select_scouter`, `seed_event_scouts_from_roster`, `set_assignments`,
`set_pit_assignments`, `set_active_event`, `nexus_upsert_status`, `delete_event`, `delete_scout`
(and `delete_roster_scouter`).

## Conventions

- Design docs live under `docs/design/` (`requirements-and-decisions.md`,
  `spec-review-punchlist.md`) and `docs/superpowers/`; per-feature plans under `docs/plans/`.
  Sync/dash code comments cite section labels like `phase3-contracts.md §N`; there is no file by
  that literal name — the corresponding contracts are captured in the phase-3 plan
  (`docs/superpowers/plans/2026-06-23-phase3-sync-qr.md`) and the design docs. When changing the
  sync wire shape or prediction math, check those.
- Scouter identity is fragile — `select_scouter` has had several migrations consolidating
  duplicate seeded scout rows and re-pointing reports before deletion. Touch it carefully.
