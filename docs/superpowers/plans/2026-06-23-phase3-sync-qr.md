# Phase 3 — Sync & QR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get offline-captured reports off the device — automatically when the network returns (revision-guarded outbox with backoff + dead-letter), and device-to-device over animated QR when there is no network — with a lead-facing view of which reports have actually landed on the server.

**Architecture:** A pure camelCase→snake_case mapper feeds two transports that share the same idempotent server RPC (`upsert_match_report`): (1) a direct online **outbox engine** that drains the local Dexie queue and (2) a **QR hand-off** (chunked animated frames → live camera scan → `ingest-reports` Edge Function → service-role upsert). The `ingest-reports` function is rewritten from shared-secret HMAC to **JWT event-member authorization**. A lead **sync-status** screen queries the server to show per-match coverage vs. the assignment grid.

**Tech Stack:** React 18 + Vite + TS strict; Dexie 4; supabase-js; `qrcode` (frame generation) + `@zxing/browser`/`@zxing/library` (camera scan); Supabase Edge Function (Deno) + Postgres RPC.

## Global Constraints

- **FROZEN CONTRACTS:** `.superpowers/sdd/phase3-contracts.md` is the binding spec for every wire format, signature, and key name. Copy verbatim; never guess schema.
- **No duplicates / no regressions on resync:** all uploads go through `upsert_match_report` (revision-guarded, idempotent: re-upload of same id+revision is a no-op). Never bypass it.
- **Server recomputes aggregates:** the mapper sends RAW fields ONLY (contracts §1a). Never send `auto_fuel`/`fuel_points`/`fuel_by_shift`/timestamps.
- **Offline-first stays intact:** capture/save never gains a network dependency (Phase 2 invariant). Sync is strictly additive and runs after save.
- **Ingest auth = JWT event-member** (no HMAC, no secret in the client). **QR = live camera scan.**
- **Scoring is frozen:** no scoring math anywhere in Phase 3; the server owns recompute.
- **Secrets:** client reads only `VITE_`-prefixed env. `QR_INGEST_HMAC_SECRET` must NOT appear in the client bundle.
- **TS strict, `noUnusedLocals/Parameters`; `@/*`→`./src`; dark theme; shadcn/ui; 44px min touch targets; testids on interactive elements.**
- **Live backend changes (migrations/EF deploy) are a trust boundary:** implementers PAUSE and relay; the controller applies/deploys under the user's standing backend authorization, then live-verifies.

---

## File Structure

- `src/sync/mapReport.ts` — `toUpsertPayload` (the wire mapper). [MAP]
- `src/sync/constants.ts` — backoff/poll/QR constants. [MAP]
- `src/sync/classifyError.ts` — transient vs terminal. [NET]
- `src/sync/useOnline.ts` — online/offline hook. [NET]
- `src/sync/outbox.ts` — `syncOnce()` engine over the Dexie queue. [OUTBOX]
- `src/sync/useSync.ts` — auto (reconnect + poll) + manual trigger, backoff. [OUTBOX]
- `src/sync/SyncIndicator.tsx` — online/queue/dead-letter badge + "Sync now" + retry. [SYNCUI]
- `src/sync/SyncStatusScreen.tsx` — lead server-coverage view. [SYNCUI]
- `src/db/localStore.ts` — add markPending/markSyncError/markDirtyRetry/getSyncQueue/listDeadLetters/requeueReport. [MAP]
- `src/db/types.ts` — add rowRevision/syncAttempts/lastSyncError. [MAP]
- `src/capture/useCaptureSession.ts` — stamp the 3 new fields at save(). [MAP]
- `src/qr/envelope.ts` — frame build/parse/accumulate + CRC32. [QRENC]
- `src/qr/QrSendScreen.tsx` — animated frames of the unsynced backlog. [QRENC]
- `src/qr/QrReceiveScreen.tsx` — camera scan → accumulate → POST ingest. [QRDEC]
- `src/qr/ingestClient.ts` — POST to `ingest-reports` with the session JWT. [QRDEC]
- `supabase/functions/ingest-reports/index.ts` — JWT event-member rewrite. [S]
- `src/routes/router.tsx` — wire /qr/send, /qr/receive, /sync. [ROUTER]
- Tests under each dir's `__tests__/`; E2E `tests/e2e/sync.spec.ts`. [GATE]

## Execution Waves (controller)

- **Wave 1 (parallel, disjoint):** S (server EF), MAP (types+localStore+mapper+save), NET (useOnline+classifyError), QRENC (envelope+send screen).
- **Wave 2 (parallel, disjoint):** OUTBOX (needs MAP+NET), QRDEC (needs envelope+EF contract), SYNCUI (needs OUTBOX hook).
- **Wave 3:** ROUTER wire (controller) → GATE.

Use opus for all agents; shared-tree disjoint-files parallelism (worktrees blocked).

---

## Task S: ingest-reports — JWT event-member rewrite

**Files:**
- Modify: `supabase/functions/ingest-reports/index.ts`
- Test: `tests/functions/ingest-reports.test.ts` (live, gated on env)

**Interfaces:**
- Consumes: contracts §5 (request/gate/upsert/response), the `import-event` gate pattern (`createClient(SUPABASE_URL, ANON_KEY, { global:{ headers:{ Authorization }}})` → `caller.rpc(...)`), `get_my_event_keys()` (contracts §1/§6).
- Produces: `POST { reports: [...] }` + `Authorization: Bearer <jwt>` → `{ ingested: number }`; 401 (no auth), 403 (not a member / report outside member events), 400 (bad json / upsert error).

- [ ] **Step 1: Write the failing live test** `tests/functions/ingest-reports.test.ts`. Mirror `tests/functions/tba-proxy.test.ts` setup (dotenv, supabase-js, skip when env missing). Seed (service role) an event + event_secret + a scout (anon-join) for that event; build ONE valid report payload (snake_case per §1a, fresh `id`, `row_revision:1`, the scout's `scout_id`, the event_key). Cases:
  - no `Authorization` → 401.
  - valid member JWT + report in their event → 200 `{ ingested: 1 }`; the row exists in `match_scouting_report`.
  - re-POST the SAME report → 200 `{ ingested: 1 }` and NO duplicate (row count unchanged — revision guard).
  - member JWT but report `event_key` set to a different event → 403, nothing written.
  Clean up (delete report, scout, event) in afterAll.
- [ ] **Step 2: Run it; expect FAIL** (function still HMAC-based → 401/“invalid hmac”).
- [ ] **Step 3: Rewrite the function** per contracts §5. Keep CORS + `json()` helper. Remove HMAC code + `QR_INGEST_HMAC_SECRET`. Add `ANON_KEY`. Gate: read Authorization → caller client → `caller.rpc('get_my_event_keys')` → 403 if error/empty. Validate body `{ reports: [] }`. Pre-check every `report.event_key ∈ myEvents` (else 403, write nothing). Then service-role loop `svc.rpc('upsert_match_report', { p: report })`; on error 400 `{ error, ingested }`. Return `{ ingested }`.
- [ ] **Step 4: PAUSE — relay to controller to deploy.** Implementer reports DONE_WITH_CONCERNS noting the function needs redeploy. Controller deploys `ingest-reports` and runs the live test.
- [ ] **Step 5: Controller runs the live test; expect PASS.**
- [ ] **Step 6: Commit** `feat(ingest): JWT event-member auth for ingest-reports (drop HMAC)`.

---

## Task MAP: wire mapper + local-store sync fields & helpers

**Files:**
- Modify: `src/db/types.ts`, `src/db/localStore.ts`, `src/capture/useCaptureSession.ts`
- Create: `src/sync/mapReport.ts`, `src/sync/constants.ts`
- Test: `src/sync/__tests__/mapReport.test.ts`, extend `src/db/__tests__/localStore.test.ts`

**Interfaces:**
- Consumes: contracts §1a (payload keys), §2 (new fields), §3 (helper signatures), §4 (mapper), §8 (constants).
- Produces: `toUpsertPayload(r): Record<string,unknown>`; localStore: `markPending/markSyncError/markDirtyRetry/getSyncQueue/listDeadLetters/requeueReport`; `LocalMatchReport` gains `rowRevision/syncAttempts/lastSyncError`; `save()` stamps them.

- [ ] **Step 1: Add the 3 fields** to `LocalMatchReport` (contracts §2) and the constants file (contracts §8).
- [ ] **Step 2: Stamp at save()** in `useCaptureSession.ts`: `rowRevision: 1, syncAttempts: 0, lastSyncError: null` on the report object.
- [ ] **Step 3: Write `mapReport.test.ts`** — construct a fully-populated `LocalMatchReport`, assert `toUpsertPayload(r)` has EXACTLY the §1a keys (use `expect(Object.keys(p).sort()).toEqual([...].sort())`), correct snake_case values, `auto_*` jsonb passthrough, `intake_sources` array, `row_revision` from `rowRevision ?? 1`, `deleted:false`, and that it OMITS all aggregate/timestamp keys.
- [ ] **Step 4: Run it; expect FAIL** (no mapper).
- [ ] **Step 5: Implement `toUpsertPayload`** per §4. Run; expect PASS.
- [ ] **Step 6: Write localStore helper tests** (fake-indexeddb): save 3 reports in mixed states; assert `getSyncQueue()` returns dirty+pending only (not error/synced), oldest first; `markPending/markSyncError/markDirtyRetry` set state + fields (syncAttempts increments on retry); `listDeadLetters()` returns only 'error'; `requeueReport()` resets to dirty/0/null.
- [ ] **Step 7: Run; expect FAIL. Implement the helpers** per §3 (default `?? ` on read). Run; expect PASS. Fix existing report factories in `localStore.test.ts`/`exportReports.test.ts`/`useCaptureSession.test.tsx` to include the 3 new fields (typecheck must pass).
- [ ] **Step 8: Commit** `feat(sync): wire mapper + local-store sync queue fields/helpers`.

---

## Task NET: online status + error taxonomy

**Files:**
- Create: `src/sync/useOnline.ts`, `src/sync/classifyError.ts`
- Test: `src/sync/__tests__/classifyError.test.ts`, `src/sync/__tests__/useOnline.test.tsx`

**Interfaces:**
- Consumes: contracts §9 (taxonomy).
- Produces: `useOnline(): boolean`; `classifySyncError(err): 'transient'|'terminal'`.

- [ ] **Step 1: Write `classifyError.test.ts`** — transient: `new TypeError('Failed to fetch')`, `{ message:'NetworkError' }`, `{ code:'503' }`/status 500/408/429, `null`/undefined response. terminal: PostgrestError `{ code:'42501' }`, `{ code:'PGRST204' }`, `{ status:400 }`, `{ status:403 }`.
- [ ] **Step 2: Run; expect FAIL. Implement `classifySyncError`** per §9 (inspect `.message` for fetch/network, numeric `.status`/`.code` ranges; default unknown → 'transient' so we retry rather than dead-letter prematurely; the `SYNC_MAX_ATTEMPTS` cap converts persistent transients to terminal in the engine). Run; expect PASS.
- [ ] **Step 3: Write `useOnline.test.tsx`** — renders, reflects `navigator.onLine`, flips on dispatched `offline`/`online` window events.
- [ ] **Step 4: Run; expect FAIL. Implement `useOnline`** (initial `navigator.onLine`, add/remove `online`/`offline` listeners). Run; expect PASS.
- [ ] **Step 5: Commit** `feat(sync): online-status hook + error taxonomy`.

---

## Task OUTBOX: online sync engine + controller hook

**Files:**
- Create: `src/sync/outbox.ts`, `src/sync/useSync.ts`
- Test: `src/sync/__tests__/outbox.test.ts`, `src/sync/__tests__/useSync.test.tsx`

**Interfaces:**
- Consumes: MAP (`toUpsertPayload`, queue helpers), NET (`classifySyncError`), constants §8, `supabase.rpc('upsert_match_report', { p })`.
- Produces:
  ```ts
  // outbox.ts
  export interface SyncSummary { attempted: number; synced: number; retried: number; deadLettered: number; }
  export async function syncOnce(rpc?: RpcFn): Promise<SyncSummary>; // rpc injectable for tests
  // useSync.ts
  export function useSync(): { online: boolean; queued: number; deadLetters: number; syncing: boolean; syncNow: () => void; };
  ```

- [ ] **Step 1: Write `outbox.test.ts`** with an injected fake rpc (no network):
  - all-success: 3 dirty → `syncOnce` → all 'synced'; summary `{attempted:3, synced:3,...}`; fake rpc called with `{ p }` whose keys match §1a.
  - transient: rpc throws `TypeError('Failed to fetch')` → report returns to 'dirty', `syncAttempts` incremented, NOT dead-lettered (under cap).
  - terminal: rpc returns `{ error:{ code:'42501' } }` → 'error' dead-letter, `lastSyncError` set.
  - cap: a report already at `syncAttempts === SYNC_MAX_ATTEMPTS` that fails transiently → dead-lettered (terminal by cap).
  - idempotency: re-running `syncOnce` after success is a no-op (queue empty).
- [ ] **Step 2: Run; expect FAIL. Implement `syncOnce`** — `getSyncQueue()`; for each: `markPending`; try `await rpc('upsert_match_report', { p: toUpsertPayload(r) })`; if `{ error }` returned → classify; on success `markSynced`. transient under cap → `markDirtyRetry`; terminal OR (transient AND attempts ≥ cap) → `markSyncError`. Accumulate `SyncSummary`. (Default `rpc` = `supabase.rpc` bound.) Run; expect PASS.
- [ ] **Step 3: Write `useSync.test.tsx`** — mock `useOnline` true and `syncOnce`; assert `syncNow()` invokes `syncOnce` and updates `queued`/`deadLetters` from the store; when offline, the periodic tick does NOT call `syncOnce`; reconnect (online flips false→true) triggers one `syncOnce`.
- [ ] **Step 4: Run; expect FAIL. Implement `useSync`** — read `useOnline()`; on mount + on online-edge + every `SYNC_POLL_MS` while online + on `syncNow()`, run `syncOnce` (guard against overlap with a ref); after each run refresh `queued = (await getUnsynced()).length` and `deadLetters = (await listDeadLetters()).length`. Backoff is honored by `syncOnce` via per-report `syncAttempts` (the poll re-attempts; a fuller per-report nextAttempt schedule is YAGNI for v1 — the cap + dead-letter is the safety net). Run; expect PASS.
- [ ] **Step 5: Commit** `feat(sync): revision-guarded outbox engine + auto/manual sync hook`.

---

## Task QRENC: QR envelope + sender screen

**Files:**
- Create: `src/qr/envelope.ts`, `src/qr/QrSendScreen.tsx`
- Test: `src/qr/__tests__/envelope.test.ts`, `src/qr/__tests__/QrSendScreen.test.tsx`
- Add dep: `qrcode` (+ `@types/qrcode`). PAUSE for controller to `npm install` if the sandbox blocks network; else install.

**Interfaces:**
- Consumes: contracts §6 (frame format + helpers), §8 (QR_CHUNK_CHARS/QR_FRAME_MS), `getSyncQueue()` for the backlog.
- Produces: `buildFrames/frameToString/parseFrame/FrameAccumulator/crc32hex` (§6); `QrSendScreen` (testid `qr-send`) rendering one animated `<canvas>`/`<img>` QR at `QR_FRAME_MS` cadence, frame counter `qr-send-progress` (`i+1/n`), and a `qr-send-done` control.

- [ ] **Step 1: Write `envelope.test.ts`** — `crc32hex('')`/known vector; `buildFrames(reports, 'sid')` yields frames covering the full base64 (n = ceil(len/QR_CHUNK_CHARS)), each `crc` valid; `parseFrame(frameToString(f)) deep-equals f`; `parseFrame('{bad')`→null; `parseFrame` of a frame with a tampered `d` (crc mismatch) → null; **round-trip**: feed all frames (shuffled) into `FrameAccumulator` → `complete` true → `reports()` deep-equals input; missing one frame → `complete` false + `reports()` throws; a duplicate frame is idempotent.
- [ ] **Step 2: Run; expect FAIL. Implement `envelope.ts`** per §6 (CRC32 table impl; base64 via `btoa`/`atob` over UTF-8-safe encoding — encode bytes with `encodeURIComponent`→`unescape` or `TextEncoder`+manual; ensure deterministic). Run; expect PASS.
- [ ] **Step 3: Write `QrSendScreen.test.tsx`** — mock `qrcode` (`toDataURL` resolves a stub) and `getSyncQueue` (2 reports); assert it renders `qr-send`, advances `qr-send-progress` over time (use fake timers), and shows “nothing to send” when the queue is empty.
- [ ] **Step 4: Run; expect FAIL. Implement `QrSendScreen`** — load `getSyncQueue()`; `buildFrames`; cycle `frameIndex` every `QR_FRAME_MS`; render `QRCode.toDataURL(frameToString(frames[i]))` into an `<img data-testid="qr-frame">`; show `qr-send-progress`. Empty-queue state. Run; expect PASS.
- [ ] **Step 5: Commit** `feat(qr): chunked QR envelope (crc + reassembly) + animated sender`.

---

## Task QRDEC: camera receiver + ingest client

**Files:**
- Create: `src/qr/ingestClient.ts`, `src/qr/QrReceiveScreen.tsx`
- Test: `src/qr/__tests__/ingestClient.test.ts`, `src/qr/__tests__/QrReceiveScreen.test.tsx`
- Add dep: `@zxing/browser` + `@zxing/library`. PAUSE for controller install if needed.

**Interfaces:**
- Consumes: §5 (ingest request/JWT), §6 (`parseFrame`/`FrameAccumulator`), `supabase.auth.getSession()` for the access token, `saveReport` (persist received reports locally on the receiver too, so a wiped sender's data is recoverable even before server confirm).
- Produces:
  ```ts
  // ingestClient.ts
  export async function postIngest(reports: unknown[]): Promise<{ ingested: number }>;
  ```
  `QrReceiveScreen` (testid `qr-receive`): live camera scan via `@zxing/browser`, `FrameAccumulator`, progress `qr-receive-progress` (`received/total`), on `complete` → `postIngest(reports())` → success `qr-receive-done`; error states surfaced.

- [ ] **Step 1: Write `ingestClient.test.ts`** — mock `supabase.auth.getSession` (token) + global `fetch`; assert `postIngest` POSTs to `${SUPABASE_URL}/functions/v1/ingest-reports` with `Authorization: Bearer <token>` and body `{ reports }`, returns parsed `{ ingested }`; throws on non-2xx (message from body).
- [ ] **Step 2: Run; expect FAIL. Implement `postIngest`** (read `env.SUPABASE_URL`; `getSession()` token; `fetch` POST). Run; expect PASS.
- [ ] **Step 3: Write `QrReceiveScreen.test.tsx`** — mock `@zxing/browser` reader to emit a known frame sequence via a callback; mock `postIngest`; assert progress advances, on completion `postIngest` is called with the reconstructed reports and `qr-receive-done` shows; a malformed/foreign frame is ignored (no crash).
- [ ] **Step 4: Run; expect FAIL. Implement `QrReceiveScreen`** — `BrowserQRCodeReader.decodeFromVideoDevice` into a `<video>`; on each text → `parseFrame` → `accumulator.add`; update progress; when `complete` → stop the stream, `reports()`, optionally `saveReport` each locally, then `postIngest`. Handle camera-permission denial with a visible message. Run; expect PASS.
- [ ] **Step 5: Commit** `feat(qr): live camera receiver + JWT ingest client`.

---

## Task SYNCUI: sync indicator + lead status screen

**Files:**
- Create: `src/sync/SyncIndicator.tsx`, `src/sync/SyncStatusScreen.tsx`
- Modify: `src/capture/ScoutHome.tsx` (mount `SyncIndicator`, add /qr links)
- Test: `src/sync/__tests__/SyncIndicator.test.tsx`, `src/sync/__tests__/SyncStatusScreen.test.tsx`

**Interfaces:**
- Consumes: OUTBOX `useSync()`; for the lead view, server queries: `assignment` (expected coverage) + `match_scouting_report` (`event_key, match_key, target_team_number, scout_id, server_received_at`) for the active event, both RLS-scoped (lead is staff → staff-read policies from Phase 0/1 apply).
- Produces: `SyncIndicator` (testid `sync-indicator`: online dot, `sync-queued` count, `sync-deadletters` count, `sync-now` button, retry-all for dead-letters); `SyncStatusScreen` (testid `sync-status`: per-match rows showing received/expected, missing scouts, latest `server_received_at`).

- [ ] **Step 1: Write `SyncIndicator.test.tsx`** — mock `useSync` (online true, queued 2, deadLetters 1); assert counts render, `sync-now` calls `syncNow`, offline shows an offline state.
- [ ] **Step 2: Run; expect FAIL. Implement `SyncIndicator`.** Run; expect PASS. Mount it in `ScoutHome` header (replace/augment the raw "Unsynced: N"), add buttons/links to `/qr/send` and `/qr/receive`.
- [ ] **Step 3: Write `SyncStatusScreen.test.tsx`** — mock supabase to return a small assignment set + report set; assert per-match coverage (e.g., "2/3") and that a missing assigned report is flagged. Keep the query layer thin and injectable/medockable.
- [ ] **Step 4: Run; expect FAIL. Implement `SyncStatusScreen`** — fetch assignments + reports for the active event, group by match_key, compute received vs expected (by target_team_number/scout), show latest server_received_at. Empty/no-active-event state. Run; expect PASS.
- [ ] **Step 5: Commit** `feat(sync): status indicator + lead server-coverage view`.

---

## Task ROUTER (controller): wire routes

**Files:** Modify `src/routes/router.tsx` (+ `src/routes/__tests__` if guard tests exist).
- [ ] Add `/qr/send`, `/qr/receive` under `RequireSession`; `/sync` under `RequireRole role="lead"`. Lazy-import the screens if it keeps the main chunk reasonable (optional). Run router/guard tests + typecheck.
- [ ] Commit `feat(routes): wire /qr/send, /qr/receive, /sync`.

---

## Task GATE (controller-inline): E2E + verification

**Files:** `tests/e2e/sync.spec.ts`; reuse `global-setup`/`global-teardown` (`_e2etest` event).
- [ ] **Outbox E2E:** joined scout (browser egress) → capture a match offline (reuse capture.spec flow) → assert `Unsynced: 1` → trigger `sync-now` → assert the queue drains (`Unsynced: 0`) and a row exists in `match_scouting_report` for that scout/match (verify via service-role client in the test); re-trigger sync → still exactly one row (no duplicate).
- [ ] **QR envelope round-trip** is covered by unit tests; **QR ingest** is covered by `ingest-reports.test.ts` (live). A full camera E2E is out of scope (no camera in headless CI) — `log`/note this explicitly; the receiver UI is unit-tested with a mocked reader.
- [ ] **Verification gate:** `npm run test` + `npm run typecheck` + `npm run build` + `npm run test:e2e` (browser egress) all green. Commit.

---

## Self-Review (controller, after writing — done)

- **Spec coverage:** outbox sync w/ backoff+taxonomy+dead-letter → OUTBOX+NET+MAP; QR send/receive + checksum + session lifecycle + ingest → QRENC+QRDEC+S; identity recovery → already shipped (Phase 0/1 `recover_identity` + JoinScreen), verified by GATE-adjacent rpc tests; lead sync-status view → SYNCUI. ✓
- **No duplicates/regressions:** guaranteed by `upsert_match_report` revision guard; GATE asserts it. ✓
- **Wiped-device recoverable:** QR receiver ingests to server (and stores locally); plus `recover_identity`. ✓
- **Type consistency:** mapper keys ↔ contracts §1a; localStore signatures ↔ §3; envelope helpers ↔ §6 — all pinned to the frozen contracts file. ✓
- **Placeholders:** none — each task has concrete tests/signatures; full code lives in the frozen contracts + task steps. ✓
