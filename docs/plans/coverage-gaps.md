# Plan — Assignment Coverage-Gap Board (Workflow / Trust)

## 1. Overview & exact user-facing behavior

The lead needs to see, **before** queuing matches, which upcoming match seats have
**no scout assigned**. Today the `AssignmentBoard` (in the dashboard **Setup** tab)
renders a flat list of slots and lets the lead pick a scout per slot, then hit
**Publish**. Unassigned slots are silently filtered out at publish time — a gap is
invisible unless the lead manually scans every dropdown.

This feature adds a **Coverage** summary that surfaces gaps prominently in two places:

1. **Draft coverage (Setup tab, inside `AssignmentBoard`)** — a live banner + per-match
   gap list driven by the in-memory `picks` map. After **Auto-generate**, the lead sees:
   - A headline coverage stat: `Coverage: 142 / 150 seats assigned (8 gaps)`.
   - A red/warning **"Gaps" list** grouped by match, e.g. `qm14 — Blue 3 (team 254) — no scout`.
   - A green "Fully covered" state when there are zero gaps.
   - The banner updates instantly as the lead edits any `slot-select` dropdown (no republish).

2. **Published coverage (Setup tab, same card, "Published" sub-section)** — once assignments
   are published (or on load of an event that already has published assignments), a second
   read-only summary fetched from the server via a new `useEventAssignments(eventKey)` hook
   shows what is **actually live for scouts right now**, so the lead can confirm the draft
   they see matches what scouts will pull. This catches the "I edited but never published"
   divergence called out in the research risks.

Exact behavior of the draft banner states:

| State | Trigger | Render |
|---|---|---|
| **Not generated** | `picks` empty, board not generated | Coverage card hidden (nothing to cover yet). |
| **Has gaps** | ≥1 eligible slot with `picks[slotKey] === ''` | Amber banner `N seats unassigned`, expandable per-match gap list. |
| **Fully covered** | every eligible slot has a non-empty `picks` value | Green banner `All N seats covered`. |
| **Diverged** | draft differs from last published set | Inline note `Draft has unpublished changes — Publish to update scouts.` |

A "seat/slot" is the existing `Slot` definition from `AssignmentBoard.tsx`: one per
(matchKey, allianceColor, station) **excluding** own-team slots and empty (null/NaN)
alliance slots — identical to what `slots` already computes. Coverage is always measured
against THAT slot universe, so the denominator never counts seats nobody could scout.

## 2. Data model

**NO MIGRATION REQUIRED.** The `assignment` table (`0001_schema.sql`) already has every
field needed: `id, event_key, match_key, scout_id, alliance_color, station,
target_team_number, source`, with an open `assignment_read_open` SELECT RLS policy (anon
reads allowed). Coverage is derived entirely at query/compute time: a seat is covered iff a
published `assignment` row exists for its (match_key, alliance_color, station) with a
non-null `scout_id`. No new columns, no view, no RPC, no RLS change.

> If a future iteration wants server-side gap reporting, it would be a NEW migration
> numbered **0033+** following the 0024/0031 pattern (additive, `grant execute … to anon,
> authenticated`) and **must NOT be marked deployed** in memory. This plan does not add one.

`mapReport.ts` and the scoring model are **untouched** — coverage reads the `assignment`
table only and never participates in the match-report wire shape or the server-recomputed
aggregates.

## 3. Files to create / modify

| Path | Precise change |
|---|---|
| `src/admin/coverage.ts` (NEW) | Pure module. Exports `Seat` type + `computeCoverage(slots, pickOf)` and `computeCoverageFromAssignments(slots, assignments)`. No React, no Supabase — fully unit-testable. |
| `src/admin/CoverageGapPanel.tsx` (NEW) | Presentational component. Props: `summary: CoverageSummary`, `eventKey: string`, optional `title`, `diverged?: boolean`, `note?: string`. Renders the headline stat, the per-match grouped gap list (amber), the green "all covered" state, the `coverage-published-empty` line when `summary.totalSeats === 0`/no rows, and the `coverage-diverged` note when `diverged`. No data fetching. Used for BOTH draft and published summaries. |
| `src/admin/AssignmentBoard.tsx` (MODIFY) | (a) import `computeCoverage`/`computeCoverageFromAssignments` + `CoverageGapPanel`; (b) `useMemo` a draft `CoverageSummary` from `slots` + `picks` (recomputes on every `setSlot`); (c) render `<CoverageGapPanel summary={draftSummary} … />` directly under the Auto-generate/Publish buttons, gated on `generated`; (d) call `useEventAssignments(eventKey)`, guard `data ?? []`, and render a second published-summary panel; (e) compute a `diverged` boolean (draft slot→scout map ≠ published map) and pass a note; (f) **after a successful `publishAssignments`**, invalidate `['assignments', eventKey]` (or `setQueryData` with the just-published rows) so the published panel + `diverged` flag refresh immediately (see §4). |
| `src/dash/useEventData.ts` (MODIFY) | Add `AssignmentRow` interface + `useEventAssignments(eventKey)` hook: TanStack `useQuery` keyed `['assignments', eventKey]`, `enabled: !!eventKey`, `staleTime: STALE_TIME`, selecting `match_key, scout_id, alliance_color, station, target_team_number` from `assignment` where `event_key = eventKey`. **The `queryFn` wraps the Supabase call in try/catch and returns `[]` on error** (mirroring `useTbaTeam`'s error swallow) so an offline fetch yields an empty array, not `undefined`/error state — the published panel then renders `coverage-published-empty` instead of throwing. Returns `AssignmentRow[]`. |
| `src/dash/SetupTab.tsx` (MODIFY — minimal) | No structural change required; `AssignmentBoard` self-renders coverage. Only change: nothing, unless we surface a top-level "X gaps" pill on the Setup section header (optional, see §5). Pass-through `eventKey`/`matches`/`scouts` already present. |
| `src/admin/__tests__/AssignmentBoard.test.tsx` (MODIFY) | **REQUIRED.** The 5 existing tests render `<AssignmentBoard>` bare with NO `QueryClientProvider` and NO supabase mock; the new `useEventAssignments` `useQuery` would throw `No QueryClient set for useQuery` and break all 5. Fix: add `vi.mock('@/dash/useEventData')` returning a stub `useEventAssignments` (e.g. `() => ({ data: [] })`) so the board has no real query dependency. (We mock the HOOK, not supabase, because the board imports the hook — and the other useEventData exports are unused here. This keeps the tests provider-free and deterministic, matching the file's existing mock-the-collaborator style.) Add one new test asserting the draft `coverage-headline` renders after auto-generate with a known gap (see §7). |
| `src/admin/__tests__/coverage.test.ts` (NEW) | Unit tests for `computeCoverage` / `computeCoverageFromAssignments` (see §7). |
| `tests/e2e/admin.spec.ts` (MODIFY) | Add a coverage-gap e2e case (see §7). Reuses existing seed/teardown in that file. |

No new dashboard tab is added. The board lives where assignment work already happens (Setup
tab), satisfying the goal "show the lead which seats have no scout assigned before they
queue" at the exact point of authoring.

**Render-site provider audit (the new `useQuery` needs a `QueryClient` at every render site):**
`AssignmentBoard` renders in TWO places — `src/dash/SetupTab.tsx` (the dashboard route) and
`src/admin/AdminPage.tsx` (`/admin`). Both routes mount under `App.tsx`'s
`PersistQueryClientProvider`, so the real app always has a client — no provider change needed in
either page. The ONLY provider-less render site is the unit test
`src/admin/__tests__/AssignmentBoard.test.tsx`, which is handled by mocking the hook (see §7).
`AdminPage.test.tsx` stubs the whole `AssignmentBoard`, so it is unaffected.

## 4. Core logic — exact algorithms

All logic is pure and lives in `src/admin/coverage.ts`.

### Types
```ts
import type { AllianceColor } from './types';

export interface Seat {
  matchKey: string;
  allianceColor: AllianceColor;
  station: 1 | 2 | 3;
  targetTeamNumber: number;
}

export interface CoverageGap {
  matchKey: string;
  allianceColor: AllianceColor;
  station: 1 | 2 | 3;
  targetTeamNumber: number;
}

export interface CoverageSummary {
  totalSeats: number;
  coveredSeats: number;
  gapCount: number;
  /** coveredSeats / totalSeats in [0,1]; 1 when totalSeats === 0. */
  coverageRate: number;
  /** Gaps grouped by matchKey, in the slot input order. */
  gapsByMatch: { matchKey: string; gaps: CoverageGap[] }[];
}
```

### `slotKey` (shared with AssignmentBoard)
```ts
export function slotKey(
  s: { matchKey: string; allianceColor: AllianceColor; station: number },
): string {
  return `${s.matchKey}:${s.allianceColor}:${s.station}`;
}
```
This MUST match `AssignmentBoard`'s existing `slotKey` exactly so the draft `picks` map keys
line up. Export it from `coverage.ts` and have `AssignmentBoard` import it (replacing its
local copy) to guarantee one definition.

**Param type MUST stay `station: number` (loose), NOT `Seat`/`station: 1|2|3`.**
`AssignmentBoard.generateFrom` calls `slotKey(a)` where `a` is an `autoAssign` `Assignment`
(whose `station` is the wider `number`); a stricter `1|2|3` param would not typecheck against
that existing call site. The current local `slotKey` already uses `station: number` — keep the
exact same signature when promoting it to `coverage.ts`.

### Draft coverage — `computeCoverage(slots, pickOf)`
`pickOf: (slotKey: string) => string` returns the scout id ('' === unassigned).
```
for each slot s in slots:        // slots == AssignmentBoard's eligible Slot[]
  covered = pickOf(slotKey(s)).trim() !== ''
  if not covered: push s into gaps (preserving order)
totalSeats   = slots.length
coveredSeats = totalSeats - gaps.length
gapCount     = gaps.length
coverageRate = totalSeats === 0 ? 1 : coveredSeats / totalSeats
gapsByMatch  = stable group-by matchKey over gaps (first-seen match order)
```

### Published coverage — `computeCoverageFromAssignments(slots, assignments)`
`assignments: { matchKey; allianceColor; station; scoutId: string | null }[]` (from the hook,
camelCased at the call site).
```
build a Set `coveredKeys` of slotKey(a) for every a where a.scoutId is non-null/non-empty
for each slot s in slots:
  covered = coveredKeys.has(slotKey(s))
  ...same accounting as above...
```
Both functions consume the **same `slots` universe** (derived once in `AssignmentBoard` from
`matches` + `ownTeam`) so draft and published numbers are directly comparable.

### Divergence flag (in `AssignmentBoard`)
```
draftMap     = Map slotKey -> picks[slotKey] (only non-empty)
publishedMap = Map slotKey -> scoutId (from useEventAssignments data ?? [], only non-empty)
diverged = generated && (draftMap.size !== publishedMap.size
            || any slotKey where draftMap.get(k) !== publishedMap.get(k))
```
Only shown after the board has been generated; otherwise the published panel stands alone.

**Post-publish cache refresh (REQUIRED for divergence correctness).** `onPublish` currently
sets local `published` state but does NOTHING to the `['assignments', eventKey]` query. Without
a refresh, the published panel keeps showing pre-publish rows and `diverged` reads TRUE for the
full `staleTime` window even though the lead JUST published — a permanent false "unpublished
changes" note that defeats the feature's stated goal. Fix: in the `onPublish` success path
(after `setPublished(count)`), call
`queryClient.invalidateQueries({ queryKey: ['assignments', eventKey] })`
(via `useQueryClient()`), or `setQueryData(['assignments', eventKey], <just-published rows in
the 5-column shape>)` for an instant optimistic refresh. After this, `publishedMap` re-derives
from the freshly published rows and `diverged` correctly drops to `false`.

**Published rows always have a non-null `scout_id`.** `publishAssignments` filters
`scoutId !== ''` before the `set_assignments` (0009) delete-all-then-insert, so every persisted
`assignment` row carries a real scout. The `scoutId == null/''` guard in
`computeCoverageFromAssignments` is therefore **defensive only** — real published data never
exercises it. Kept anyway (cheap, protects against future direct-insert paths); see test #6/#6b
in §7.

### Consistency with mapReport / scoring
Not touched. Coverage never reads `match_scouting_report`, never calls `upsert_match_report`,
and never participates in `computeAggregates`. The single-wire-shape and server-recompute
invariants are unaffected.

## 5. UI / UX

**Where:** Dashboard → **Setup** tab → existing `Assignments` card (`AssignmentBoard`).
The coverage panel renders inside that card's `CardContent`, between the action buttons row
and the existing `assignment-grid`.

**Components & states:**
- `CoverageGapPanel` (new): a self-contained block.
  - Headline row: `data-testid="coverage-headline"` →
    `Coverage: {coveredSeats} / {totalSeats} seats ({gapCount} gap{plural})`.
  - When `gapCount === 0`: green tone, `data-testid="coverage-all-covered"`, text
    `All {totalSeats} seats covered`.
  - When `gapCount > 0`: amber/warning tone container `data-testid="coverage-gaps"`; below it a
    grouped list — one row per match (`data-testid="coverage-gap-match"`), each gap rendered as a
    chip `data-testid="coverage-gap-seat"` showing `{matchNoShort} · {color} {station} · {team}`
    (match key shortened via the existing `s.matchKey.replace(`${eventKey}_`, '')`).
  - Reuse existing Tailwind tones already in the board: red/blue alliance chips
    (`bg-red-500/15 text-red-400` / `bg-blue-500/15 text-blue-400`); gaps use
    `border-amber-500/40 bg-amber-500/10 text-amber-300` and covered uses
    `text-success`. No new design system primitives — wrap in the existing `Card`-free div
    style used by the slot rows.
- Draft panel: `<CoverageGapPanel summary={draftSummary} eventKey={eventKey} title="Draft coverage" />`
  rendered only when `generated`.
- Published panel: `<CoverageGapPanel summary={publishedSummary} eventKey={eventKey}
  title="Published (live for scouts)" />` rendered whenever `useEventAssignments` has data
  (even before the lead generates a draft — so opening Setup on an existing event immediately
  shows current live coverage).
- Divergence note: when `diverged`, render `data-testid="coverage-diverged"` amber inline text
  `Draft has unpublished changes — Publish to update scouts.` directly under the draft headline.

**Optional (low-cost) Setup-section pill:** none added in this plan to keep scope tight; the
panel inside the card is sufficient and is the natural authoring location.

The `assignment-grid` itself additionally highlights each currently-unassigned row: add
`data-coverage="gap"` and an amber left border to any slot row whose `current === ''`, so the
lead can jump from the gap list to the dropdown visually. (Pure className change on the
existing mapped row in `AssignmentBoard`.)

## 6. Offline behavior

- **Draft coverage is 100% local** — it reads only the in-memory React `picks` map and the
  client-computed `slots`. It works with zero network, instantly, including the moment after
  `Auto-generate` (which itself runs in-browser in `autoAssign.ts`).
- **Published coverage** uses `useEventAssignments`, a TanStack Query. The query client is
  wrapped in `PersistQueryClientProvider` (IndexedDB), so on an offline reload the **last
  fetched** published-assignment set rehydrates and the published panel still renders (clearly
  labeled as last-known). When fully offline with no cached data, the published panel renders a
  neutral `data-testid="coverage-published-empty"` "No published assignments cached" line.
  - **Why it never throws (explicit — a plain `useQuery` does NOT swallow errors).** On an
    offline fetch failure a default TanStack query goes to `isError`/`data === undefined`, NOT
    `data === []`. So calling `computeCoverageFromAssignments(slots, undefined)` would throw.
    We prevent this with BOTH belts:
    1. The hook's `queryFn` catches Supabase errors and returns `[]` (see §3), so `data` is an
       empty array, never `undefined`, on a failed/empty fetch.
    2. The call site in `AssignmentBoard` still defensively passes `data ?? []` and renders
       `coverage-published-empty` when the array is empty.
  - The whole route additionally sits under one `RouteError` boundary as a final safety net.
- Publishing still requires network (the `set_assignments` RPC); when offline the existing
  Publish button error path (`assignments-publish-error`) handles it. The coverage panels do
  not gate on connectivity.

## 7. Test plan

### Unit tests — `src/admin/__tests__/coverage.test.ts` (Vitest)
1. **empty slots** → `computeCoverage([], () => '')` returns
   `{ totalSeats: 0, coveredSeats: 0, gapCount: 0, coverageRate: 1, gapsByMatch: [] }`.
2. **all covered** → 6 slots across 1 match, `pickOf` returns a non-empty id for every key →
   `gapCount === 0`, `coverageRate === 1`, `gapsByMatch === []`.
3. **partial gaps** → 6 slots, 2 with `''` → `gapCount === 2`, `coveredSeats === 4`,
   `coverageRate` ≈ `4/6`; `gapsByMatch` has one entry with both gap seats in input order.
4. **whitespace pick counts as gap** → `pickOf` returns `'   '` → treated as unassigned.
5. **grouping order preserved** → slots from qm1, qm2, qm1 (interleaved) with gaps in each →
   `gapsByMatch` groups by match in first-seen order, gaps within a group keep slot order.
6. **`computeCoverageFromAssignments` defensive null guard** → slots for 1 match; assignments
   cover 4 of 6, one assignment has `scoutId: null` (should NOT count as covered) → `gapCount
   === 2`. NOTE: this exercises a DEFENSIVE path the real publish flow never produces
   (`publishAssignments` filters `scoutId !== ''` before `set_assignments` inserts, so every
   live row has a non-null `scout_id`). The guard is kept for safety; this test documents it.
6b. **production wire shape** → feed assignments shaped EXACTLY as the hook returns them after
   the call-site camel-casing (`{ matchKey, allianceColor, station, scoutId }` from the 5-column
   `match_key, scout_id, alliance_color, station, target_team_number` select, all `scoutId`
   non-null) for 4 of 6 seats → `gapCount === 2`, `coveredSeats === 4`. This mirrors real
   published data so the suite reflects production, not just the dead null branch.
7. **published seat not in slots is ignored** → an assignment for an own-team/extra slot not in
   `slots` does not inflate `coveredSeats` beyond `totalSeats`.
8. **`slotKey` parity** → `slotKey({matchKey:'e_qm1',allianceColor:'blue',station:3})` ===
   `'e_qm1:blue:3'` (locks the format the board depends on).

### Component tests — `src/admin/__tests__/AssignmentBoard.test.tsx` (Vitest, MODIFY)
The existing 5 tests render `<AssignmentBoard>` with NO `QueryClientProvider`. Adding the
`useEventAssignments` `useQuery` to the board makes ALL 5 throw `No QueryClient set for
useQuery` unless we cut the query dependency. Required change:

- Add `vi.mock('@/dash/useEventData', () => ({ useEventAssignments: () => ({ data: [] }) }))`
  at the top with the other `vi.mock`s. (Mock the HOOK, not supabase: the board imports this one
  named export, and a provider-free stub keeps every existing test deterministic and unchanged
  in spirit. `data: []` -> `computeCoverageFromAssignments(slots, [])` -> published panel empty.)
- The 5 existing tests then pass untouched (the board's behavior they assert is unchanged).
- **New test #6:** after `auto-generate` with a mocked `autoAssign` that returns an assignment
  for only 1 of the match's slots, assert `coverage-headline` is visible and `coverage-gaps`
  renders (the unassigned slots are gaps) and `coverage-gap-seat` count > 0. Locks the
  draft-coverage wiring inside the component without a live DB.
- (Optional) a test that, with a fully-covered mocked `autoAssign`, `coverage-all-covered`
  renders and `coverage-gaps` does not.

### Playwright e2e — add to `tests/e2e/admin.spec.ts` (single-worker, live `2026casnv`)
Reuses the file's existing `admin` client, the 3 seeded scouts, and `setActiveEvent`. New test
**after** the existing publish test so a published set exists, OR self-contained.

The e2e drives the REAL `autoAssign` (unit tests mock it, e2e does not), so we **must not**
assume which slot is first, whether the first slot is already assigned, or that a 3-scout pool
leaves zero gaps. Two anti-fragility rules:

1. **No `.or()` of two mutually-exclusive panels** (`coverage-all-covered` vs `coverage-gaps`).
   That OR is a tautology — exactly one always renders — so it verifies nothing. Assert the
   concrete `coverage-headline` GAP COUNT TEXT and its delta instead.
2. **Make the gap deterministic by COUNT, not by guessing the first seat.** Read the headline's
   gap number, force a gap by unassigning a slot that is currently assigned (find the first
   `slot-select` whose value is non-empty), assert the gap count went UP by exactly 1, then
   re-assign it and assert the gap count returned to the original value.

```ts
test('coverage board reflects gap count as the lead edits a slot', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  await setActiveEvent(admin, EVENT);
  await page.goto('/dashboard?tab=setup');
  await expect(page.getByTestId('setup-tab')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('auto-generate-btn').click();
  await expect(page.getByTestId('assignment-grid')).toBeVisible({ timeout: 15_000 });
  const headline = page.getByTestId('coverage-headline');
  await expect(headline).toBeVisible();

  // Parse the baseline gap count straight from the headline text.
  const gapCount = async () => {
    const t = (await headline.textContent()) ?? '';
    const m = t.match(/(\d+)\s+gap/);
    return m ? Number(m[1]) : 0;
  };
  const base = await gapCount();

  // Find a slot that IS currently assigned (non-empty value) and unassign it.
  const selects = page.getByTestId('slot-select');
  const n = await selects.count();
  let assignedIdx = -1;
  for (let i = 0; i < n; i++) {
    if (((await selects.nth(i).inputValue()) ?? '') !== '') { assignedIdx = i; break; }
  }
  expect(assignedIdx).toBeGreaterThanOrEqual(0); // auto-generate assigned at least one seat
  await selects.nth(assignedIdx).selectOption('');           // '' === unassigned

  // Gap count rises by exactly one; the gaps container + a gap chip are now visible.
  await expect.poll(gapCount).toBe(base + 1);
  await expect(page.getByTestId('coverage-gaps')).toBeVisible();
  await expect(page.getByTestId('coverage-gap-seat').first()).toBeVisible();

  // Re-assign to the first real scout -> gap count returns to baseline.
  await selects.nth(assignedIdx).selectOption({ index: 1 }); // first real scout option
  await expect.poll(gapCount).toBe(base);
});
```

A second e2e (optional) asserts the **published** panel via the LIVE DB rather than a
tautology: pre-seed (or reuse the existing publish test's) `assignment` rows through the `admin`
service-role client for a KNOWN set of seats, reload `?tab=setup`, and assert the published
`coverage-headline` shows the EXACT covered/total counts those seeded rows imply (e.g. headline
contains `0 gaps` / `coverage-all-covered` when every slot is seeded, or `K gaps` for a known
partial seed). Concrete counts — never `.or()`.

Run: `npx playwright test tests/e2e/admin.spec.ts` and `npx vitest run src/admin/__tests__/coverage.test.ts`.

### Demo-mode fallback
If `2026casnv` is unavailable in CI, the same flow runs in demo mode: enable demo
(`setup-demo-enable`), then the Setup tab's `AssignmentBoard` works against the seeded
`2026demo` event identically.

## 8. Conflict surface (overlap with the other 12 features)

| File | Also touched by | Mitigation |
|---|---|---|
| `src/dash/useEventData.ts` | **matchup-intelligence**, **smart-picklist**, **alliance-simulator**, **scouter-load-accuracy**, **dashboard-heartbeat**, **distribution-trend**, **auto-path-heatmap** (all add `useEvent*` hooks here) | This feature only **appends** one `useEventAssignments` hook + one interface. No edits to existing hooks. Land as an additive export; merge conflicts are trivial (new function at end of file). Coordinate import ordering only. |
| `src/admin/AssignmentBoard.tsx` | None of the other 12 (assignment authoring is unique to coverage-gaps) | Low conflict risk. |
| `src/admin/__tests__/AssignmentBoard.test.tsx` | None of the other 12 (unique to this feature) | Low conflict risk, BUT this edit is MANDATORY (see §3/§7): without the `vi.mock('@/dash/useEventData')` stub the new hook breaks all 5 existing tests. If a future feature also touches this spec, coordinate the top-of-file `vi.mock` block. |
| `src/dash/SetupTab.tsx` | **export-presets** (may add an export button to Setup); **dashboard-heartbeat** (may add a status pill) | This plan keeps `SetupTab` essentially unchanged (board self-renders), minimizing overlap. If export-presets adds Setup UI, the regions are disjoint. |
| `src/admin/coverage.ts`, `CoverageGapPanel.tsx`, `__tests__/coverage.test.ts` | New files, owned solely by this feature | No conflict. |
| `tests/e2e/admin.spec.ts` | **scouter-load-accuracy** (assignment-balance assertions may extend the same spec) | Append a new `test(...)` block; avoid editing the existing publish test body. |

No overlap with: defense-analytics, report-correction, multi-scout-reconciliation,
match-video (different files / report-side concerns).

## 9. Step-by-step execution checklist

1. **Create `src/admin/coverage.ts`**: define `Seat`, `CoverageGap`, `CoverageSummary`, export
   `slotKey`, `computeCoverage(slots, pickOf)`, `computeCoverageFromAssignments(slots, assignments)`
   per the formulas in §4. Zero React/Supabase imports.
2. **Write `src/admin/__tests__/coverage.test.ts`** (the 8 cases in §7) and run
   `npx vitest run src/admin/__tests__/coverage.test.ts` until green.
3. **Add `useEventAssignments` + `AssignmentRow`** to `src/dash/useEventData.ts` (append at end;
   query key `['assignments', eventKey]`, select the 5 assignment columns, `enabled`/`staleTime`
   mirroring the other hooks). **`queryFn` MUST try/catch the Supabase call and return `[]` on
   error** (so offline yields `[]`, never `undefined`/error). Run `npm run typecheck`.
4. **Create `src/admin/CoverageGapPanel.tsx`**: presentational, props `{ summary, eventKey,
   title, diverged?, note? }`; render headline / all-covered / grouped-gaps with the test ids and
   Tailwind tones from §5. No data fetching.
5. **Modify `src/admin/AssignmentBoard.tsx`**:
   - replace local `slotKey` with the imported one from `coverage.ts` (keep the `station: number`
     signature — §4);
   - `const draftSummary = useMemo(() => computeCoverage(slots, (k) => picks[k] ?? ''), [slots, picks])`;
   - call `useEventAssignments(eventKey)`; **guard `const rows = data ?? []`**; map rows to
     camelCase `{matchKey, allianceColor, station, scoutId}`;
     `const publishedSummary = useMemo(() => computeCoverageFromAssignments(slots, mapped), [slots, mapped])`;
   - compute `diverged` (§4);
   - **in `onPublish` success path, after `setPublished(count)`, call
     `queryClient.invalidateQueries({ queryKey: ['assignments', eventKey] })`** (grab
     `const queryClient = useQueryClient()`) so the published panel + `diverged` refresh
     immediately post-publish (§4);
   - render the draft `CoverageGapPanel` (gated on `generated`) and the published
     `CoverageGapPanel` inside `CardContent` — render `coverage-published-empty` when `rows`
     is empty;
   - add `data-coverage="gap"` + amber left border to unassigned slot rows in the existing grid map.
6. **Update `src/admin/__tests__/AssignmentBoard.test.tsx`** (§7): add the
   `vi.mock('@/dash/useEventData', ...)` stub so the 5 existing tests stay provider-free and pass,
   plus the new draft-coverage test(s). Run `npx vitest run src/admin/__tests__/AssignmentBoard.test.tsx`.
7. **Verify `SetupTab.tsx`** needs no change (board self-renders); confirm props still flow, and
   confirm both `SetupTab` and `AdminPage` render sites sit under `PersistQueryClientProvider`
   (they do — §3 render-site audit).
8. **`npm run typecheck`** and **`npm test`** (unit + DB) — all green.
9. **Add the e2e** to `tests/e2e/admin.spec.ts` (§7, concrete gap-count assertions, no `.or()`)
   and run `npx playwright test tests/e2e/admin.spec.ts` against live `2026casnv` (or demo mode).
10. **Confirm offline degradation manually**: in the dashboard, generate a draft, toggle DevTools
    offline, edit a dropdown — draft coverage still updates; published panel shows cached/empty
    state, no crash.
11. **No migration to push.** Do NOT run `supabase db push` for this feature and do NOT add a
    deploy note to memory. Frontend ships via Vercel on merge to `main`.
