# Post-Match Report Correction (Edit + Resubmit)

Feature class: Workflow / trust. Let a scout re-open a previously SUBMITTED match report,
edit its fields, and resubmit with a revision bump. The sync RPC (`upsert_match_report`,
migrations 0025/0030/0032) is already revision-guarded and idempotent, so this is almost
entirely **client plumbing**: a single-report read, a session "edit mode" that reconstitutes
draft state from an existing report, a revision increment on save, and a UI entry point.

---

## 1. Overview & exact user-facing behavior

**Where it lives:** the "My Data" screen (`/my-data`, `src/scout/MyDataView.tsx`), which already
lists the current device-scout's own reports newest-first.

**Eligibility — IMPORTANT (corrected from earlier draft):** there is **no local soft-delete**.
`LocalMatchReport` (`src/db/types.ts:3-68`) has NO `deleted` field; soft-delete (`deleted:true`)
exists only server-side (`src/dash/types.ts`, set by the supersede UPDATE inside the RPC) and
never round-trips back into the local Dexie store. `mapReport` confirms this — it reads the field
defensively as `(r as {deleted?:boolean}).deleted ?? false` and the unit test
(`src/sync/__tests__/mapReport.test.ts:205`) asserts "always sends deleted:false (LocalMatchReport
has no deleted field today)". Therefore **any `r.deleted` check locally is dead code** (always
`undefined`) and the "superseded" label is unreachable. This plan **drops the `deleted`
eligibility branch and the "superseded" label entirely.** The only real local non-editable state
is `syncState === 'error'` (set by `markSyncError`, `src/db/localStore.ts:89`).

(If superseded-detection is ever genuinely wanted it requires a NEW `deleted?: boolean` on
`LocalMatchReport`, persistence of it on the QR/ingest merge or a local-delete path, and a
`withSyncDefaults` backfill — that is out of scope here and not in the file list below.)

**Flow:**
1. On each report row in My Data, an **Edit** button (`data-testid="my-data-edit-<id>"`) appears
   for every report whose `syncState !== 'error'`. Dead-lettered (`error`) reports show the row
   but **no Edit button** — instead a small muted "needs sync fix" label linking to `/sync`, to
   avoid editing a report whose server state is ambiguous. (No `deleted`/"superseded" branch — see
   the eligibility note above.)
2. Tapping **Edit** navigates to `/scout?edit=<reportId>` (match mode).
3. `ScoutHome` parses `?edit=<reportId>`, loads that report via the new `getReport(id)`, and —
   once the scouter gate (`effective`) is satisfied — sets `active` to a `CaptureTarget`
   reconstructed from the report **plus** `editingReportId: report.id`.
4. `CaptureFlow` in edit mode **skips the live capture screen entirely** and opens directly on
   `ReviewScreen` (the live fuel-shooting timeline cannot be meaningfully re-run after the match;
   all editable fields — climb, defense, fouls, flags, auto path, notes, and the fuel/defense
   numeric inputs that already exist in Review — are reachable there).
5. The Review header shows **"Editing · rev N -> N+1"** instead of "Review" when in edit mode,
   so the scout knows this is a correction, not a fresh capture.
6. Tapping **SAVE** writes the report **in place** (same `id`), with `rowRevision` incremented to
   `loadedRowRevision + 1`, recomputed aggregates, `syncState: 'dirty'`, `syncAttempts: 0`,
   `lastSyncError: null`. The sync engine drains it through `upsert_match_report`; because the
   incoming `row_revision` is strictly greater, the server UPDATEs the existing row (idempotent
   re-send of the same revision is a server no-op).
7. After save, **ScoutHome** (which owns navigation — `CaptureFlow.onDone` is arg-less and
   `ReviewScreen.onSaved` is `(id:string)=>void`; see §1a) navigates to `/my-data?updated=1`.
   `MyDataView` reads `?updated=1` to show a transient toast/banner "Report updated" confirming a
   re-upload, not a new submit, then strips the param.

### 1a. Navigation ownership (corrected)

Today `ScoutHome` — not `CaptureFlow` — drives post-capture navigation: it renders
`<CaptureFlow onDone={() => { setActive(null); refreshLocal(); }} onExit={...}/>`
(`src/capture/ScoutHome.tsx:336-347`) and `CaptureFlow` has no router access. `ReviewScreen.onSaved`
is `(id:string)=>void` (`src/capture/ReviewScreen.tsx:56`) and `CaptureFlow.onDone` is arg-less
(`ScoutHome.tsx:51`). To avoid splitting navigation control (and a `setActive(null)` re-render
racing a `navigate`), **keep navigation entirely in ScoutHome**: branch in ScoutHome's `onDone`
on whether the active target is an edit —
`if (active.editingReportId) navigate('/my-data?updated=1'); else { setActive(null); void refreshLocal(); }`.
Do **not** add `useNavigate` inside `CaptureFlow`. The toast is driven solely by the `?updated=1`
query param read in `MyDataView` (this is the single approach — not "param or navigation state").

**Editable vs not:** All deferred fields (climb, intake, defense seconds, being-defended seconds,
pins, max capacity, fouls minor/major, foul reasons, flags no-show/died/tipped/dropped, auto
start/path, notes). The raw fuel **bursts** and **feeding bursts** are carried through unchanged
(read from the loaded report into session state) and contribute to the recomputed aggregates;
they are not re-edited via the slider. `inactiveFirst` is carried through.

**Identity note (documented behavior, no code):** if between the original capture and the edit
the device's `scout_id` was orphaned by `select_scouter` consolidation, the server re-resolves by
`scout_name` (0030/0032) and the row's `scout_id` may change silently. This is accepted per the
architecture; the local report keeps its original `scoutId`/`scoutName` and the server reconciles.

---

## 2. Data model

**No migration needed.** This is the explicit, load-bearing point of the feature.

- `upsert_match_report` (0032) already INSERTs only when no existing revision, and UPDATEs only
  when `v_incoming_rev > v_existing_rev`; an equal/lower incoming revision is a silent no-op. A
  correction sends `row_revision = loaded + 1`, which is strictly greater, so the UPDATE path
  fires and supersede/scout-reresolution logic runs unchanged.
- `mapReport.toUpsertPayload` already serializes `row_revision: r.rowRevision ?? 1` (line 53) and
  `deleted` (line 54). No wire-shape change.
- `LocalMatchReport.rowRevision` already exists (`src/db/types.ts:65`), defaults to 1 on new
  reports, and `withSyncDefaults` backfills it for legacy rows.

**Latest deployed migration is 0032. Do NOT add a 0033+ migration for this feature, and do NOT
mark anything deployed.**

The only `types.ts` change is a documentation comment on `rowRevision` clarifying the protocol
(below) — no schema/shape change.

**`createdAt` is preserved on edit only for stable local sort order in My Data** (the list sorts
`b.createdAt.localeCompare(a.createdAt)`). It has **no effect on the server row or the wire/UPDATE
path**: the upsert RPC (0032) neither reads nor writes `created_at` (it is server-managed —
`default now()` on insert, untouched on UPDATE) and `created_at` is **not** in `mapReport`'s wire
shape. So keeping the original `createdAt` is harmless and correct, but it is not load-bearing for
sync.

**Revision-monotonicity invariant (must be documented, see §4.1):** `markSynced`
(`src/db/localStore.ts:79`) only flips `syncState` — it never copies the server's `row_revision`
back to the local row. So a second edit computes `loaded + 1` from the LOCAL `rowRevision`, which
equals the last value this client itself sent. This stays strictly increasing in the normal flow
(the RPC holds `app.skip_msr_bump='on'` across both the UPDATE and the trailing recompute, so the
BEFORE-UPDATE trigger never double-bumps — confirmed in `0002_triggers.sql` + 0032; the server
stores exactly `v_incoming_rev`). The hidden assumption: **no path bumps the server's `row_revision`
out-of-band for this same row.** A supersede bumps `row_revision+1` on a DIFFERENT (conflicting)
row, not this one, so it does not break the invariant; a manual server edit would. This is in
scope only as a documented invariant + a unit assertion (two consecutive edits → rev 2 then 3, not
2 then 2); reconciling local rowRevision with a higher server revision is explicitly out of scope.

---

## 3. Files to create / modify

| Path | Precise change |
|---|---|
| `src/db/localStore.ts` | Add `export async function getReport(id: string): Promise<LocalMatchReport \| undefined> { const r = await db.reports.get(id); return r ? withSyncDefaults(r) : undefined; }`. Place it next to `listReports`. (`withSyncDefaults` is already defined in this file.) |
| `src/db/types.ts` | On `rowRevision: number;` (line 65) add a comment: client-side mirror of the server `row_revision`. New reports start at 1; a correction (edit + resubmit) MUST set it to the previously-loaded revision + 1 so the revision-guarded `upsert_match_report` UPDATEs rather than no-ops. Note: `markSynced` does NOT copy the server revision back, so `loaded` is the last value THIS client sent; stays monotonic provided nothing bumps this row's server revision out-of-band (see §2). No shape change. |
| `src/capture/useCaptureSession.ts` | (a) Extend `CaptureTarget` with `editingReportId?: string`. (b) Add a load-existing effect: when `target.editingReportId` is set, `getReport(id)` on mount and reconstitute `bursts`, `feedingBursts`, `inactiveFirst`, `deferred` (all `DeferredState` keys) from the loaded report via a **reusable `reconstituteFrom(report)` helper** (so multi-scout-reconciliation can share it rather than fork — see §8); store the loaded `id`, `createdAt`, and `rowRevision` in refs (`editIdRef`, `editCreatedAtRef`, `editRevRef`). Set `hydratedRef.current = true` after. This effect must run INSTEAD of the draft-resume effect when editing (guard the draft-resume `getDraft` branch with `if (target.editingReportId) return;`). (c) Modify `save()`: when `editIdRef.current` is set, reuse that `id`, keep the original `createdAt` (for stable local sort only — NOT sent over the wire; see §2), set `rowRevision: editRevRef.current + 1`, and DO NOT call `deleteDraft` for the live-capture draft key (edit mode never created one). Otherwise behave exactly as today. |
| `src/capture/ScoutHome.tsx` | Parse `?edit=<reportId>` from `useSearchParams`. In a `useEffect` gated on `effective` (scouter resolved) + `searchParams.get('edit')`, call `getReport(editId)`; if found and `syncState !== 'error'`, `setActive({ eventKey, matchKey, scoutId, scoutName, targetTeamNumber, allianceColor, station, editingReportId: r.id })` reconstructed from the report's own fields, force `mode='match'`, and clear the `edit` param from the URL (replace) so a reload/back doesn't re-trigger. **No `deleted` check** (the local row has no `deleted` field — dead code; see §1). If not found/ineligible, ignore (fall through to normal home). Pass `editingReportId` through `CaptureTarget` (already on the type). |
| `src/capture/ScoutHome.tsx` (`CaptureFlow`) | Add `startStage?: 'live' \| 'review'` prop (default `'live'`). Initialize `useState<'live' \| 'review'>(props.startStage ?? 'live')`. When `active.editingReportId` is set, render `CaptureFlow` with `startStage="review"` so edit mode opens straight into Review. **Navigation stays in ScoutHome** (see §1a): do NOT add `useNavigate` inside `CaptureFlow`; branch ScoutHome's `onDone`/`onExit` on `active.editingReportId` to `navigate('/my-data?updated=1')` vs `setActive(null) + refreshLocal()`. |
| `src/capture/ReviewScreen.tsx` | Accept an optional `editingRevision?: number` prop. When set, render the header title as `Editing` and a sub-line `rev {editingRevision} -> {editingRevision + 1}` (`data-testid="review-editing-banner"`) in place of the plain "Review" heading. `onSaved: (id:string)=>void` is unchanged. SAVE button stays the same; the existing in-flight `saving` guard already prevents double-submit. Pass `s` through unchanged. |
| `src/scout/MyDataView.tsx` | Import `useNavigate` (Link already imported). On each `my-data-row`, render an **Edit** button (`data-testid="my-data-edit-<id>"`, `min-h-[44px]`) that navigates to `/scout?edit=<r.id>` when `r.syncState !== 'error'`. For `error` rows show a muted "needs sync fix" label and link to `/sync`. **No `deleted`/"superseded" branch** (the local row has no `deleted` field — dead code; see §1). Optionally show `rev {r.rowRevision}` when `rowRevision > 1` so a corrected report is visibly versioned. Read `?updated=1` (via `useSearchParams`) to render the `my-data-updated-toast`, then strip the param. **Identity note:** `MyDataView` filters by `useSession().scout?.id` (`src/scout/MyDataView.tsx:19-32`), which is NOT event-scoped like ScoutHome's `effective`; after a lead switches the active event, the "mine" set here can diverge from ScoutHome's. Edit eligibility is purely per-report/id-based (`getReport` ignores scout), so editing still works — but do NOT assume a just-edited row reappears in My Data after an event switch (see §7 isolation note). |

**New files:** none.

---

## 4. Core logic

### 4.1 Revision increment (the only new "formula")

```
On save in edit mode:
  rowRevision_new = editRevRef.current + 1     // editRevRef = loaded report's rowRevision (>= 1)
On save in fresh-capture mode:
  rowRevision_new = 1                            // unchanged from today
```

Invariant the client MUST uphold: **never send `row_revision <= existing`.** Because we load the
report's own current revision and add exactly 1, and the server stores whatever the client last
synced, `loaded + 1` is strictly greater than the server's stored revision in the normal case.
(If two devices race-edit the same `id`, the lower-revision write no-ops server-side — acceptable
last-writer-by-revision-wins, same guarantee the new-capture path already relies on.)

**Why monotonic across re-edits (explicit invariant):** `markSynced` (`src/db/localStore.ts:79`)
never copies the server's `row_revision` back into the local row, so the second edit's `loaded`
is the value THIS client last sent. The server stores exactly `v_incoming_rev` (the RPC suppresses
the trigger double-bump via `app.skip_msr_bump='on'`), so local and server stay in lockstep and
`loaded + 1` keeps climbing: edit twice and you get rev 2 then rev 3 (not 2 then 2). This holds as
long as nothing bumps THIS row's server revision out-of-band; a supersede bumps a different row, so
it is safe. Unit case 8 (§7.1) asserts the 2-then-3 sequence to lock this in.

### 4.2 Aggregate recomputation stays identical

`save()` already calls `computeAggregates({ schemaVersion, inactiveFirst, fuelBursts, climbLevel,
autoClimbLevel1 })` and writes `autoFuel/teleopFuelActive/teleopFuelInactive/endgameFuel/
fuelByShift/fuelPoints`. In edit mode the same call runs over the (carried-through) `bursts` plus
the edited `climbLevel`/`autoClimbLevel1`, so the local display aggregates stay correct. **The
server still recomputes from raw fields**, so the client aggregates remain display-only — no
divergence. `mapReport` is untouched, so the single wire shape is preserved.

### 4.3 Draft-key collision avoidance

Edit mode reconstitutes from the **report**, not a draft, and never writes a live-capture draft
(the load-existing effect short-circuits the `getDraft`/`persistDraft`-on-mount path; we do NOT
call `persistDraft` during an edit session, and `save()` skips `deleteDraft`). Therefore an
in-progress NEW draft for the same `matchKey:scoutId:team` is left intact: after finishing an
edit the scout's separate fresh draft still resumes normally. This sidesteps the
`matchKey:scoutId:team` key collision entirely without needing a `:edit` suffix.

> Implementation guard: in `useCaptureSession`, the deferred-state setters (`updateDeferred`,
> `setClimbLevel`, etc.) currently call `persistDraft`. In edit mode they should still update
> React state but skip the `persistDraft` write (early-return inside `persistDraft` when
> `editIdRef.current` is set). This keeps the loaded edit from leaking into the draft store and
> resurrecting later as a phantom new draft.

---

## 5. UI / UX

- **My Data row** (`src/scout/MyDataView.tsx`): add a footer action row to each `my-data-row`.
  - Editable report (`syncState !== 'error'`): `<button data-testid="my-data-edit-<id>">Edit</button>`
    -> `navigate('/scout?edit=' + r.id)`.
  - Show `rev N` chip when `r.rowRevision > 1`.
  - `error` report: muted text "needs sync fix" linking to `/sync`, no edit button.
  - (No `deleted`/"superseded" branch — the local row has no `deleted` field; see §1.)
- **ScoutHome**: edit deep-link is silent — it loads the report and jumps straight into the edit
  Review flow; no extra screen. If the scouter gate isn't satisfied yet (name not picked), the
  `?edit=` param is preserved until `effective` resolves, then the effect fires.
- **ReviewScreen edit banner**: header reads **Editing** with sub-line `rev N -> N+1`
  (`data-testid="review-editing-banner"`). All five steps and SAVE behave as today.
- **Post-save**: ScoutHome navigates to `/my-data?updated=1` (see §1a). `MyDataView` reads the
  `?updated=1` param and shows a transient banner/toast "Report updated"
  (`data-testid="my-data-updated-toast"`), auto-dismiss ~3s, then strips the param. The list
  re-reads reports on mount so the edited row reflects new values immediately. (The revision number
  in the toast is best read from the now-listed row's `rowRevision`, not the URL.)

---

## 6. Offline behavior

Fully offline-capable, consistent with the local-first architecture:
- `getReport` reads IndexedDB (Dexie) — no network.
- The edit Review flow mutates local state and `saveReport` writes IndexedDB with
  `syncState: 'dirty'` — no network.
- Re-upload is handled by the existing sync engine: when connectivity returns,
  `outbox.ts`/`useSync.ts` drains the dirty queue through `upsert_match_report`. The revision
  guard makes re-runs safe, so a flaky reconnect that retries the same corrected report is a
  server no-op on the second attempt.
- Editing a report that was previously `synced` flips it back to `dirty` locally; if the device
  stays offline it simply waits in the queue. No new failure mode.
- Dashboards on OTHER devices won't auto-refresh the corrected values (TanStack Query cache) until
  their next refetch/poll — a known, non-blocking papercut, not addressed here.

---

## 7. Test plan

### 7.1 Unit (Vitest)

New file `src/capture/__tests__/editSession.test.tsx` (or extend
`useCaptureSession.test.tsx`):

1. **`getReport` round-trip**: `saveReport(r)` then `getReport(r.id)` returns the row with
   `withSyncDefaults` applied (`rowRevision` defaulted to 1 for a legacy row missing it).
2. **Edit reconstitutes state**: seed a report with `climbLevel:2`, `defenseDurationMs:5000`,
   `notes:'x'`, `rowRevision:3`, two fuel bursts. Mount `useCaptureSession({ ...target,
   editingReportId: r.id })`; after the load effect, assert `result.current.climbLevel === 2`,
   `defenseDurationMs === 5000`, `notes === 'x'`, `bursts.length === 2`.
3. **Revision bump on save**: from state 2, call `save()`; assert the saved report has the SAME
   `id`, SAME `createdAt`, `rowRevision === 4`, `syncState === 'dirty'`, `syncAttempts === 0`,
   `lastSyncError === null`.
4. **No revision regression guard**: assert `save()` never produces `rowRevision <= loaded` (here
   strictly `loaded + 1`).
5. **No draft leakage**: after an edit `save()`, assert `getDraft('<matchKey>:<scoutId>:<team>')`
   is unchanged (a pre-existing fresh draft for the same key survives; edit wrote no draft).
6. **mapReport carries revision**: `toUpsertPayload(editedReport).row_revision === 4` and
   `deleted === false`. (Add to `src/sync/__tests__/mapReport.test.ts` OR the edit-session file —
   does NOT change `mapReport.ts`; the existing frozen key whitelist at lines 40-49 incl.
   `'row_revision'`/`'deleted'` and the line-205 "no deleted field today" assertion MUST stay
   green, since the wire shape is unchanged.)
7. **Fresh-capture unaffected**: mounting without `editingReportId` still produces a new UUID id
   and `rowRevision === 1` (regression guard on the default path).
8. **Monotonic across re-edits**: from state 2 call `save()` (→ rev 4), then mount a fresh session
   on the SAVED row and `save()` again; assert the second save's `rowRevision === 5` (i.e. each
   edit is `loaded + 1`, strictly increasing — locks in the markSynced invariant from §2/§4.1).
   (With a clean rev-1 seed this is the "2 then 3" sequence; the assertion is that the two
   consecutive edits differ by exactly 1 and never repeat.)

### 7.2 Playwright e2e (`tests/e2e/report-correction.spec.ts`, single-worker, live event)

Mirror `capture.spec.ts` setup. In `beforeAll`, `ensureRosterName(admin, SCOUTER)` to add the new
scouter to the roster (capture.spec does this — the plan's checklist now calls it out). Use the
helpers `setActiveEvent`, `ensureRosterName`, `pickScouter` and constants `E2E_EVENT_KEY`,
`E2E_MATCH_KEY`, `E2E_TEAM` (imported from `global-setup`, as capture.spec does).

**Isolation rationale (explicit):** this spec reuses the same `E2E_MATCH_KEY`/`E2E_TEAM` as
`capture.spec` (offline, deliberately never synced — see its line ~97 comment about colliding with
sync.spec) and `sync.spec`, on the single-worker shared live DB. Safe because the one-active-report
index is per `(match_key, scout_id)`, and this spec uses a **distinct** scouter name
`'E2E Correction Scout'` → distinct `scout_id` → its own active-report slot, so it cannot collide
with the Capture/Sync scouters. Do NOT reuse the Capture/Sync scouter names. `global-teardown`'s
`delete ... eq('event_key', E2E_EVENT_KEY)` already sweeps every scout's rows for the test event,
plus the per-spec `afterAll` below.

Selectors mirror `capture.spec` verbatim: the queued badge text is `↑N` (e.g. `↑1`/`↑0`, an arrow
glyph — `sync-queued`), NOT `up1`/`up0`; the climb button is reached via
`page.getByTestId('review-climb').getByRole('button', { name: '3', exact: true })`.

**Obtaining the client id:** before clicking Edit, read the id off the testid —
`const editId = await page.locator('[data-testid^="my-data-edit-"]').first().getAttribute('data-testid').then(t => t!.replace('my-data-edit-', ''))` — and use it for the server `.eq('id', editId)` query.

Scenario A — **edit + resubmit bumps revision**:
1. `setActiveEvent(admin, E2E_EVENT_KEY)`; `pickScouter(page, SCOUTER)`.
2. Manual pick -> capture -> save a baseline report (reuse the capture.spec live->review->save
   path: `scout-start-capture`, `capture-placement-submit`, `capture-start`, `capture-go`, a
   slider burst, `review-save`). Expect it queues/syncs.
3. Navigate to My Data: `await page.getByTestId('nav-my-data').click()`; expect a `my-data-row`.
4. Read `editId` (per the id note above), then click the first `[data-testid^="my-data-edit-"]`.
   Assert `review-editing-banner` is visible and reads `rev 1 -> 2`.
5. Step to the Climb step, change climb to `3`
   (`page.getByTestId('review-climb').getByRole('button', { name: '3', exact: true }).click()`);
   step to Notes, set a distinctive note; `review-save`.
6. Assert redirect to `/my-data` and `my-data-updated-toast` visible; assert the row now shows a
   `rev 2` chip and the new climb/notes.
7. **Server assertion**: once `sync-queued` returns to `↑0`, query Supabase directly
   (`admin.from('match_scouting_report').select('row_revision, climb_level').eq('id', editId)`);
   assert `row_revision === 2` and `climb_level === 3`, and that the row count for that id is
   exactly 1 (proves the UPDATE path fired, not a duplicate insert).

Scenario B — **idempotent resubmit is a no-op**: re-trigger sync (reload, online) without editing;
assert the server `row_revision` stays `2` and there's still exactly one active row for the
(match, scout) (no `idx_msr_match_scout_active` violation, no duplicate).

Scenario C — **dead-letter rows are not editable**: seed (via local/Dexie eval or by forcing a
sync failure) a report with `syncState:'error'`; assert My Data shows the row but NO
`my-data-edit-` button and shows the "needs sync fix" label. (No `deleted`/"superseded" case — the
local store has no `deleted` field; see §1.)

Scenario D — **offline edit queues**: after baseline save, `page.context().setOffline(true)`,
edit a field, save; assert `sync-indicator` offline badge visible and `sync-queued` shows `↑1`;
go online, assert it drains to `↑0` and server `row_revision === 2`.

### 7.2a Existing tests that MUST stay green (no source change to them required)

- `src/sync/__tests__/mapReport.test.ts` — the frozen wire-key whitelist (lines 40-49, incl.
  `'row_revision'`, `'deleted'`), the line-198 "defaults row_revision to 1" case, and the line-205
  "always sends deleted:false (LocalMatchReport has no deleted field today)" case. This feature
  does NOT touch `mapReport.ts`, so all stay green; case 6 above only *reads* `toUpsertPayload`.
- `src/sync/__tests__/outbox.test.ts` — has a hardcoded expected wire-key list (incl.
  `'row_revision'`, `'deleted'`, ~line 85). Unaffected (mapReport untouched); confirm green after
  the editing path lands.
- `src/capture/__tests__/useCaptureSession.test.tsx` — already modified in the working tree; the
  new edit-mode branches in `save()`/effects are additive and must not regress the fresh-capture
  cases (unit case 7 above is the guard).

### 7.2b CaptureScreen-skip safety check (do this before writing the load effect)

Edit mode renders `CaptureFlow` with `startStage="review"`, so `CaptureScreen.tsx` (the live
screen, currently `M` in the working tree) is never mounted. Confirm nothing in the live screen is
required to initialize session state that `ReviewScreen` reads — specifically the clock /
`teleopClockUnconfirmed` defaults (`save()` reads `clock.state.teleopClockUnconfirmed`). The
loaded report already carries `teleopClockUnconfirmed`; if the live screen is the only thing that
seeds a session field Review depends on, the `reconstituteFrom` helper must set it from the loaded
report. Verify against `useCaptureSession`'s initial state before implementing.

### 7.3 Cleanup

In `afterAll`, delete the test scouter's reports for the test match (admin client), matching the
existing teardown pattern in `global-teardown.ts` / per-spec cleanup.

---

## 8. Conflict surface (other features touching the same files)

| File | Also touched by | Coordination |
|---|---|---|
| `src/scout/MyDataView.tsx` | **scouter-load-accuracy** (per-scout accuracy badges), **multi-scout-reconciliation** (conflicting reports per match) | All three add row-level UI to My Data. Keep the Edit button in a dedicated per-row action footer; reconciliation/accuracy add chips/badges to the row header. Land them in separate additive JSX blocks. |
| `src/capture/useCaptureSession.ts` | **multi-scout-reconciliation** (may load/merge another scout's report into a session), **auto-path-heatmap** (reads `autoPath` but should not write the session) | This feature adds `editingReportId` + a load-existing effect. Reconciliation may want the SAME load-existing primitive — design the `getReport`-on-mount + reconstitute block as a reusable `reconstituteFrom(report)` helper so reconciliation can reuse it rather than fork it. |
| `src/capture/ScoutHome.tsx` | **multi-scout-reconciliation** (entry point to compare/edit), **coverage-gaps** (surfacing unscouted assignments) | All add `useSearchParams` handling / entry points. Namespace params (`?edit=`, distinct from any reconciliation/coverage params). |
| `src/capture/ReviewScreen.tsx` | none of the other 12 expected to touch Review | Low risk; the edit banner is an additive header variant. |
| `src/sync/mapReport.ts` | **export-presets** (reads the wire shape) | NOT modified here. Anything export-related must keep reading the unchanged `toUpsertPayload`. |
| `src/db/localStore.ts` | **multi-scout-reconciliation**, **coverage-gaps**, **dashboard-heartbeat** (may add read helpers) | Only ADD `getReport`; do not change existing helpers. Additive, low collision risk. |

No overlap with defense-analytics, matchup-intelligence, smart-picklist, alliance-simulator,
distribution-trend, match-video (those live in `src/dash/**` / new modules).

**Working-tree warning (current `git status`):** `useCaptureSession.ts`, `ScoutHome.tsx` (+
`CaptureScreen.tsx` which it renders), `mapReport.ts`, `db/types.ts`, `db/localStore.ts`, and
`useCaptureSession.test.tsx` are ALL already `M` (uncommitted). Landing this plan on top risks
merge churn, especially in `useCaptureSession.save()` (this plan rewrites the id/createdAt/
rowRevision construction) and `db/types.ts`. **`mapReport.ts` is dirty but this plan must NOT
change its wire shape** — re-confirm `toUpsertPayload` is byte-unchanged after this work.
Mitigation: write the `getReport`-on-mount + `reconstituteFrom(report)` block as the **shared
primitive from the start** (not a private fork) so multi-scout-reconciliation reuses it; keep the
Edit JSX in a dedicated additive per-row footer; namespace the `?edit=` param.

---

## 9. Step-by-step execution checklist

1. `src/db/localStore.ts`: add `getReport(id)` (returns `withSyncDefaults`-normalized row).
2. `src/db/types.ts`: add the `rowRevision` protocol comment (doc only).
3. `src/capture/useCaptureSession.ts`:
   a. Add `editingReportId?: string` to `CaptureTarget`.
   b. Add refs `editIdRef`, `editCreatedAtRef`, `editRevRef`.
   c. Add a load-existing `useEffect` (runs when `target.editingReportId` set): `getReport`,
      reconstitute `bursts`/`feedingBursts`/`inactiveFirst`/`deferred` (and any session field
      Review depends on that the live screen would otherwise seed — see §7.2b), set refs, set
      `hydratedRef`. Write reconstitution as the **shared `reconstituteFrom(report)` primitive**
      from the start (reconciliation reuses it; see §8) — do NOT fork a private copy.
   d. Guard the draft-resume effect: `if (target.editingReportId) return;`.
   e. Guard `persistDraft`: early-return when `editIdRef.current` is set (no draft writes in edit).
   f. Modify `save()`: in edit mode reuse `editIdRef.current` id + `editCreatedAtRef.current`
      createdAt + `rowRevision = editRevRef.current + 1`; skip `deleteDraft`.
4. `src/capture/ReviewScreen.tsx`: add optional `editingRevision?: number` -> render the
   `review-editing-banner` header variant.
5. `src/capture/ScoutHome.tsx`:
   a. `CaptureFlow`: add `startStage?: 'live' | 'review'` prop; init stage from it; thread
      `editingRevision` into `ReviewScreen` when editing. Do NOT add `useNavigate` here.
   b. Add an `?edit=<id>` effect (gated on `effective`): `getReport`, eligibility check
      (`syncState !== 'error'` ONLY — no `deleted` check), `setActive` with `editingReportId`,
      force match mode, clear the `edit` param.
   c. Render `CaptureFlow` with `startStage="review"` when `active.editingReportId` is set; branch
      ScoutHome's `onDone`/`onExit`: `if (active.editingReportId) navigate('/my-data?updated=1')`
      else `setActive(null); void refreshLocal()` (navigation owned by ScoutHome — §1a).
6. `src/scout/MyDataView.tsx`: import `useNavigate` + `useSearchParams`; add per-row Edit button
   (rows where `syncState !== 'error'`), `rev N` chip, the `error` "needs sync fix" muted label;
   add the `my-data-updated-toast` driven by the `?updated=1` param (strip it after). No
   `deleted`/"superseded" branch.
7. Unit tests `src/capture/__tests__/editSession.test.tsx` (cases 1-8 in section 7.1; case 6 may
   live in `mapReport.test.ts` instead). Run
   `npx vitest run src/capture/__tests__/editSession.test.tsx`.
8. e2e `tests/e2e/report-correction.spec.ts` (scenarios A-D). In `beforeAll` call
   `ensureRosterName(admin, 'E2E Correction Scout')` (mirrors capture.spec) so `pickScouter`
   resolves; mirror capture.spec selectors verbatim (`↑N` badge,
   `review-climb`→`getByRole('button',{name:'3',exact:true})`); read the client id off
   `[data-testid^="my-data-edit-"]` for the server query (§7.2). Run
   `npx playwright test tests/e2e/report-correction.spec.ts`.
9. `npm run typecheck` and `npm test`.
10. **Do NOT** add a migration and **do NOT** touch `mapReport.ts`'s wire shape. Confirm via
    `git diff --stat` that `supabase/migrations/` is untouched.
