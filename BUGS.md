# Full Event Simulation — Bug Report

**Date:** 2026-06-26
**Method:** (1) A multi-user **Playwright simulation** drove several concurrent browser
contexts (independent devices) through the real flows against the live active event
`2026casnv` — concurrent scouts capturing matches, two scouts on one target, the same
name on two devices, offline→reconnect, the lead dashboard, pit scouting, and re-scouting.
(2) An **adversarially-verified static bug hunt** fanned 8 finder agents across every
subsystem; each finding was refuted-or-confirmed against the real code (15 raw → **10
confirmed, 0 uncertain, 5 false-positives discarded**).

Baseline before testing: `tsc` clean, **744/744 unit tests pass**, dev server healthy.
So every bug below is a runtime/concurrency/logic defect the existing suite does **not** cover.

## Simulation results (dynamic)

| Scenario | Result |
|---|---|
| 3 scouts capture distinct targets concurrently → all sync, no dups | ✅ PASS |
| 2 different scouts on the SAME match+target → 2 distinct active rows | ✅ PASS |
| **Same scouter name on TWO devices, both capture → one report dead-letters** | ❌ **FAIL → BUG-1** |
| Offline capture queues (↑1) then drains on reconnect | ✅ PASS |
| Lead dashboard navigates all 7 tabs, no crash / no error boundary | ✅ PASS |
| Pit scouting submits and syncs | ✅ PASS |
| Re-scout same target on one device → supersede, 1 active row | ✅ PASS¹ |
| No uncaught page errors across all contexts | ✅ PASS |

¹ This scenario first *appeared* to fail (2 rows). It was a **test-helper bug**, not an app
bug: migration 0025 supersedes by **soft-delete** (`deleted=true`), and the count helper
wasn't filtering `deleted`. Fixed the helper to count active rows → passes. Confirms 0025
works. (Recorded here so the false alarm isn't mistaken for a defect.)

The dynamic FAIL (BUG-1) is the **same root cause** the static hunt ranked #1 — independent
confirmation from two methods.

---

## Confirmed bugs

Severity: **P1** = data loss / blocks a core flow; **P2** = wrong data or stuck state in a
real scenario; **P3** = narrow edge.

### BUG-1 — Same name on two devices permanently dead-letters a scout's matches (P1, data-loss)
*Confirmed dynamically (⚠1 dead-letter) **and** statically.*
**Where:** `supabase/migrations/0025_upsert_supersede_active.sql:46-50`, `src/sync/classifyError.ts`, `src/sync/mapReport.ts`, `supabase/migrations/0015/0016` `select_scouter`.
**What:** The app always runs an anonymous session, so `upsert_match_report` always takes the
`auth.uid() is not null` branch, which **raises `23503 'invalid scout_id: no such scout'`** when
the client's `scout_id` no longer exists. `select_scouter` consolidation **deletes all other
scout rows for a display name at an event**. When two devices pick the same name, device B's
pick deletes device A's canonical scout row — but A still holds locally-queued reports stamped
with the now-deleted `scout_id`. On sync, A's report raises 23503; `classifySyncError` maps 23503
→ **terminal → permanent dead-letter**. `mapReport` sends only `scout_id` (never `scout_name`),
so the server has no way to recover, and "Retry all" re-raises 23503 forever. **A scout's whole
match backlog silently vanishes.**
**Repro:** Two devices both pick "Test 5" at `2026casnv`; each captures a different match. One
device's report ends at `⚠1` and never syncs. (Playwright scenario 3.)
**Fix:** (a) Add `scoutName` to `LocalMatchReport`/`CaptureTarget`, stamp it at capture, emit
`scout_name` in `toUpsertPayload`. (b) New migration: in the authenticated branch of
`upsert_match_report`, when the `scout_id` row is missing, re-resolve by
`(event_key, lower(scout_name))` to the surviving canonical row, provisioning a caller-owned row
only if no name match. (c) Add a `23503 / invalid scout_id` predicate to the dead-letter
auto-requeue allowlist so already-stuck reports recover once the server fix ships.

### BUG-2 — ScoutHome binds captures to a STALE event after the active event changes (P1, data-loss)
**Where:** `src/capture/ScoutHome.tsx:201,287,342`, `src/auth/useSession.ts` (`cached_scout_row`).
**What:** `useSession` caches the last scout row in **non-event-scoped** localStorage and
resurrects it on any later mount. `effective = picked ?? scout`; the NamePicker shows only when
`!effective`. After a lead switches the active event (or toggles demo), a previously-signed-in
device keeps a truthy `effective` **from the OLD event** and is never re-prompted. Line 342
(`eventKey = effective.event_key || activeEvent`) then makes the **stale** event win, so manual
captures and pit reports are written and uploaded under the **previous** event — invisible on the
current event's dashboard.
**Fix:** Event-scope the gate — force the NamePicker when `activeEvent` is known and
`(picked ?? scout).event_key !== activeEvent`. Derive `eventKey` from `activeEvent` first so a
capture can never bind to a stale event. (Depends on BUG-3 so the corrective re-pick succeeds.)

### BUG-3 — A device cannot pick a scouter at a SECOND event (legacy constraint never dropped) (P1, blocks flow)
**Where:** `supabase/migrations/0001_schema.sql` `scout_auth_uid_key UNIQUE (auth_uid)` — **verified
live on the deployed DB** alongside `scout_event_uid_unique (event_key, auth_uid)`.
**What:** The `scout` table still carries the legacy single-column `UNIQUE (auth_uid)` from 0001
in addition to the per-event composite from 0009. `select_scouter` upserts with
`ON CONFLICT (event_key, auth_uid)`. A device that already has a scout row for event A, picking a
name at event B, produces a tuple that does **not** conflict on the composite → a genuine INSERT →
violates the global `scout_auth_uid_key` → unhandled **23505**; the RPC aborts and the device can
never join event B. Also blocks BUG-2's corrective re-pick.
**Fix:** Append-only migration `ALTER TABLE scout DROP CONSTRAINT IF EXISTS scout_auth_uid_key;`
leaving only the per-event composite. Synthetic per-row `auth_uid`s (seeding/QR) stay unique.

### BUG-4 — Undo on a fuel burst is a silent no-op; the over-counted burst is stuck forever (P1, data-loss)
**Where:** `src/capture/CaptureScreen.tsx:269-279` (no `onUndoBurst`), `:648/:662`, `useCaptureEvents.ts:143`.
**What:** Releasing the FUEL slider commits a burst (`s.holdEnd`) **and** pushes a `'burst'` undo
event, but `CaptureScreen` wires only defense/defended/foul/toggle handlers — **no `onUndoBurst`**.
Undo of a burst hits `handlers.onUndoBurst?.()` = `undefined` → no-op, yet the timeline event is
consumed, so the next Undo reverses the *previous* action. The mis-counted burst stays in
`bursts` and in the saved `fuel_bursts`/`fuelPoints`, unrecoverable. **Feeding** bursts (line 662)
never call `recordBurst` at all, so they can't be undone.
**Fix:** Add `session.undoLastBurst()` (pop last `bursts` entry + re-persist) and wire
`onUndoBurst`. Record a feeding `'burst'` event and add `undoLastFeedingBurst()` for parity.

### BUG-5 — Pit reports are unguarded last-write-wins; a stale resync clobbers newer data (P2, data-loss)
**Where:** `src/pit/pitStore.ts:124-162` (`pitUpsertPayload`/`upsertPitRow`), `supabase/migrations/0021_pit_write_open.sql`, `src/sync/pitOutbox.ts`.
**What:** Unlike match reports (revision-guarded RPC), pit reports do a direct PostgREST
`.upsert()` on PK `(event_key, team_number)`, **omit `row_revision`**, and always send every
field. 0021 opened pit writes with `check(true)` — no ownership/revision predicate, no bump
trigger. A device flushing an **older** queued pit report overwrites a newer one for the same
team, blanking vision/batteries/preferred-auto/dimensions, with no `pit_report_history` snapshot.
**Fix:** Route pit writes through a `SECURITY DEFINER upsert_pit_report(p jsonb)` RPC applying the
match path's monotonic revision guard (write only when incoming `row_revision` > stored), snapshot
the prior row to `pit_report_history`, and have the client send an incrementing `row_revision`.

### BUG-6 — Next-match hero re-pins to an already-played match when a result sync is dropped (P2, wrong-state)
**Where:** `src/dash/nextMatch.ts:172-194` (`trackedNextMatch`), `src/dash/NextMatchView.tsx:705-712`.
**What:** The only "already played" guard in `trackedNextMatch` is `isUnplayedMatch(row)`, which is
purely DB-driven. If `tba-webhook`/reconcile is dropped, the played match has no DB result so it
reads as unplayed; Nexus often leaves it flagged "On field", so it stays in `upcoming`.
`trackedNextMatch` finds that stale row first and returns it — re-pinning the hero/prediction to a
match we already played. The Upcoming **rail** already applies a Nexus live-frontier filter; the
hero path does not → inconsistent UI.
**Fix:** Apply the rail's live-frontier filter in `trackedNextMatch`: skip any resolved upcoming row
at/before the Nexus frontier (`onField`/`queuing`) in play order, in addition to `isUnplayedMatch`.

### BUG-7 — Undoing a defense interval leaves the interval in the uploaded report (P2, wrong-math)
**Where:** `src/capture/CaptureScreen.tsx:270-273`, `src/capture/useCaptureSession.ts:336-367` (`commitInterval`).
**What:** `commitDefense()` appends `{startMs,endMs,phase}` to `defenseIntervals` **and** adds a
duration; Undo (`onUndoDefense`) only does `setDefenseDurationMs(current - p.durationMs)`. So (1) the
interval stays in `defenseIntervals` forever — uploaded as `defense_intervals`, corrupting the
lead's match timeline with an interval the scout explicitly undid; and (2) `p.durationMs`
(CaptureScreen's `performance.now` diff) ≠ the ms the session added (recomputed off the match
clock), leaving residual ms so the total ≠ the sum of intervals. Same for being-defended.
**Fix:** Session owns undo: `undoLastDefenseInterval()`/`undoLastDefendedInterval()` that, in one
updater, pop the last interval **and** subtract that exact entry's `(endMs-startMs)` (clamped at 0),
then persist. Wire into `onUndoDefense`/`onUndoDefended`.

### BUG-8 — Two concurrent QR senders make the receiver thrash and never complete (P2, race)
**Where:** `src/qr/QrReceiveScreen.tsx:161-171` (session-adoption block), `QrSendScreen.tsx:52`.
**What:** The receiver adopts a new session — **discarding all decoded blocks** (`new
FountainDecoder()` + `setReceived(0)`) — on **every** frame whose `frame.s` differs from the pinned
`sessionId`, gated only by `!complete`. It can't tell a single sender restarting from a second
concurrent sender. If the camera catches frames from two active send screens (two scouts in the
same pit, a reflection), the two sessions alternately wipe each other's progress; `complete` never
fires; the transfer hangs with no error.
**Fix:** Don't adopt a new session on the first foreign frame — require a quiet gap on the current
sid and/or N consecutive foreign-session frames before resetting (or keep a `Map<sid, decoder>` and
let whichever completes first win). Preserves single-sender-restart recovery.

### BUG-9 — Partial QR ingest shows green "done" with no retry, losing the failed subset (P2, data-loss)
**Where:** `src/qr/QrReceiveScreen.tsx:57-89` (`runIngest`), `:240-255` (done view).
**What:** `runIngest` sets `canRetry=true` only when `ingested===0` (total failure). A **partial**
result (`ingested>0 && failed.length>0`) falls through to a green "Received and uploaded N reports"
view with no Retry button, even though the fully-decoded batch still lives in `decoderRef` and
re-POSTing is idempotent/revision-guarded. The user sees success and walks away; if the sender is
then wiped (QR exists precisely for that), the failed reports are lost.
**Fix:** Set `canRetry=true` whenever `failed.length>0`; render the Retry control in the done view
when `failedCount>0`. Re-running re-POSTs the whole batch; already-ingested rows are server no-ops.

### BUG-10 — Compressed QR payload loops on retry for a receiver lacking DecompressionStream (P3, edge)
**Where:** `src/qr/compress.ts:89-95` (`decompressForQr`), `QrReceiveScreen.tsx:63,82-88`.
**What:** `compressForQr` gates on `compressionSupported()` (sender capability), but
`decompressForQr` unconditionally constructs `new DecompressionStream('gzip')`. If the sender gzips
(`z=1`) but the **receiver** runs an old WebView without `DecompressionStream`, the constructor
throws → `phase='error'`, `canRetry=true`, and every Retry re-throws identically with a confusing
`DecompressionStream is not defined`. Narrow (needs a pre-2020 WebView), not global loss.
**Fix:** In `decompressForQr`, when compressed but `DecompressionStream` is undefined, throw a clear
**non-retryable** error and have `runIngest` set `canRetry=false` for that class (guide the user to a
modern browser / uncompressed resend).

---

## False positives discarded by adversarial verification (5)
The static hunt's verifier refuted 5 of 15 raw findings (already-guarded code, misread logic, or
not actually triggerable). They are intentionally **not** listed as bugs.

## Fix plan
P1 scouter-identity cluster (BUG-1/2/3) is fixed together (shared files + the second-event
constraint gates the others). Then capture-undo (BUG-4/7), dashboard (BUG-6), QR (BUG-8/9/10), and
the pit RPC (BUG-5).

---

## Fixes applied (all 10) + verification

| Bug | Fix | Migration |
|---|---|---|
| BUG-1 | `scoutName` plumbed client→server; `upsert_match_report` re-resolves orphaned `scout_id` by name → caller's own row → provision; 23503 dead-letters auto-requeue | 0030 + **0032** |
| BUG-2 | ScoutHome event-scopes the name-picker gate; derives `eventKey` from the active event first | — |
| BUG-3 | Drop legacy `scout_auth_uid_key UNIQUE(auth_uid)` | 0029 |
| BUG-4 | `undoLastBurst` / `undoLastFeedingBurst` session API wired to `onUndoBurst`; feeding bursts now recorded | — |
| BUG-5 | `upsert_pit_report` RPC: monotonic revision guard + `pit_report_history` snapshot; client sends `row_revision` (updatedAt epoch) | 0031 |
| BUG-6 | `trackedNextMatch` applies the Nexus live-frontier filter (skip rows at/before on-field) | — |
| BUG-7 | `undoLastDefenseInterval` / `undoLastDefendedInterval` pop the interval AND subtract its exact ms atomically | — |
| BUG-8 | Receiver debounces session adoption (N consecutive foreign frames) instead of wiping on the first | — |
| BUG-9 | `canRetry` + Retry button on PARTIAL ingest (not just total failure) | — |
| BUG-10 | `decompressForQr` throws a non-retryable `DecompressionUnsupportedError`; `runIngest` sets `canRetry=false` | — |

**Migrations 0029, 0030, 0031, 0032 deployed** to the remote Supabase (`supabase db push`) and verified live
(legacy constraint gone; both RPCs present; orphaned-scout re-resolve confirmed by `tests/db/rpcs.test.ts`).

### Verification results
- **`tsc` clean.**
- **Full Playwright simulation: 8/8 pass** — the previously-failing same-name-two-devices scenario (BUG-1)
  now syncs both reports with **zero dead-letters**; no uncaught page errors anywhere.
- **Unit suite: 745 logic/unit tests pass** + 5 new regression tests added (BUG-6 frontier, BUG-10 decompress
  guard, BUG-4 burst undo ×2, BUG-7 interval undo). `tests/db/rpcs.test.ts` passes 6/6 (verifies the new
  re-resolve contract at the DB level).
- A combined full-suite run additionally tripped Supabase's **anonymous-sign-in auth rate limit** (from
  repeatedly running the simulation + live-DB suites in a short window). Those failures are all
  `AuthApiError: Request rate limit reached` on `signInAnonymously` — an environmental cooldown, **not** a
  regression (every affected test passes in isolation once the limit resets).
