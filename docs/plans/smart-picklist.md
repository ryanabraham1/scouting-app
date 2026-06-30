# Smart Picklist Seeding + DNP / Tier Flags

Feature cluster: **Strategy / coaching**. Adds (1) one-click "seed picklist from top N
by metric" and (2) per-team **DNP / avoid** and **first / second pick tier** flags, reusing
the existing `RankingView` sort comparators and the existing `picklist` table + `PicklistView`
UI. No backend changes.

---

## 1. Overview & exact user-facing behavior

On the Dashboard **Picklist** tab (`src/dash/DashboardScreen.tsx` → `PicklistView`), a lead can:

1. **Seed the list.** A new **Seed** button in the card header opens a modal (`PicklistSeedDialog`).
   The lead picks:
   - a **metric**: `Expected Pts` (`scoutingExpectedPoints`), `EPA`, `Climb %`
     (`climbSuccessRate`), or `Defense` (`avgDefenseRating`);
   - a **Top N** count (integer ≥ 1, default `24`, capped at `60`);
   - an optional **min matches scouted** threshold (default `0`) that filters out
     barely-scouted teams before ranking;
   - a **mode**: **Replace** (default) or **Append** (skips teams already in the list).
   Pressing **Seed** ranks every aggregated team by the chosen metric (descending; ties broken
   by ascending team number — identical to `RankingView`), takes the top N after filtering, and
   writes them into the editable picklist as ordered entries with `tier`/`note`/`dnp`/`tierType`
   left at their defaults (`null`/`false`). The list is NOT auto-saved — it lands in the same
   dirty local state as a manual edit, so the lead reviews then presses the existing **Save**.

2. **Flag DNP / avoid.** Each picklist row gets a **DNP toggle** (a `✋`/"DNP" button). When
   on, the row is visually struck-through + tinted red and a **DNP** badge shows. DNP and tier
   are **independent** (a team can be a "do not pick" that was scouted as a strong first-pick).

3. **Set pick tier.** Each row gets a tier-type selector cycling `— → 1st → 2nd → —`
   (`tierType`: `null → 'first' → 'second' → null`), rendered as a colored pill (`1st` = brand,
   `2nd` = amber). This is distinct from the existing free-text `tier` column (which stays for
   ad-hoc labels like "defense bot"). `tierType` is the structured first/second-pick bucket.

4. **Export.** CSV/JSON export includes the new fields (see §3 `exportDash.ts`).

Empty-data behavior: if there is no scouting data, the Seed dialog shows
"No scouting data to seed from." and disables **Seed**. If the chosen metric is **EPA** and no
EPA source resolved, the dialog falls back to in-house `scoutingExpectedPoints` (mirrors
`RankingView`'s `epaFromScouting`) and shows an inline note "EPA unavailable — seeding by
in-house estimate." The Seed still works.

---

## 2. Data model

**No migration needed.** The `picklist` table (migration 0007) stores entries as a
schema-flexible `entries` JSONB array; `getPicklist`/`savePicklist` round-trip the whole array.
Adding `dnp?: boolean` and `tierType?: 'first' | 'second' | null` to each entry object requires
**no DDL and no RLS change** — the change is purely additive JSONB. **No RLS rationale is
asserted here:** the feature inherits whatever `picklist` policy is currently deployed
(`picklistClient.ts` documents it as `is_staff()`-scoped per phase4-contracts §6; this feature
neither relies on nor changes that, since the additive JSONB write goes through the same
existing `savePicklist` upsert that already works today).

Forward/backward compatibility is handled purely client-side with defensive reads:
- On load, never assume the new keys exist: `entry.dnp ?? false`, `entry.tierType ?? null`.
- On save, the full entry object (including the new keys) is serialized back into `entries`.

**Concurrency / last-write-wins risk (documented honestly):** `savePicklist` is a plain
`upsert` on `event_key` with **no revision guard** — unlike `upsert_match_report` /
`upsert_pit_report`, the *whole* `entries` array is overwritten on every save by whichever
device saves last. Consequences for a mixed-version fleet sharing one server picklist row:
- An **old-build device that saves at all** re-serializes its entries WITHOUT the new keys and
  therefore **wipes `dnp`/`tierType` fleet-wide** (not just on rows it edited — the entire array
  is replaced). This is strictly worse than "drops new keys only on edited rows."
- Even two new-build leads editing concurrently clobber each other (last save wins), exactly as
  tier/note behave today.
- **Decision: accept this.** DNP/tier are coaching-convenience flags, not sync-critical data; a
  reseed restores them. We deliberately do **not** add a revision guard or a build-version field
  (out of scope — would require a migration, which this feature explicitly avoids). The risk is
  documented so a follow-up can revisit if leads on multiple devices report lost flags.

> Latest deployed migration is **0032**. This feature adds **no** new migration. If a future
> change here ever needs one it must be numbered **0033+** following the 0024/0031 RLS pattern,
> and it must **NOT** be marked deployed in memory.

---

## 3. Files to create / modify

| Path | Precise change |
|---|---|
| `src/dash/picklistClient.ts` | Extend `PicklistEntry`: add `dnp?: boolean;` and `tierType?: 'first' \| 'second' \| null;`. In `getPicklist`, normalize on read so callers always see booleans/null: `return entries.map((e) => ({ ...e, dnp: e.dnp ?? false, tierType: e.tierType ?? null }))`. `savePicklist` already upserts the whole array — no change beyond the type. |
| `src/dash/sorting.ts` | **NEW FILE.** Extract the shared sort vocabulary so `RankingView` and seeding cannot drift: export `type RankSortKey = 'scoutingExpectedPoints' \| 'climbSuccessRate' \| 'avgDefenseRating' \| 'epa'` (the seed-able subset), a `RankInput` shape `{ agg: TeamAgg; epa: number \| null }`, and `rankSortValue(input: RankInput, key: RankSortKey): number` containing the exact `switch` cases copied from `RankingView.sortValue` (EPA → `epa ?? Number.NEGATIVE_INFINITY`). Also export `compareDesc(a, b, key)` that returns `bv - av` with ascending-teamNumber tiebreak. **Critically, also export `resolveRowEpa({ agg, epaByTeam, epaAvailable, epaFromScouting })`** — the EXACT row-EPA expression `RankingView` uses today (`RankingView.tsx` lines 208-212): `const external = epaAvailable ? (epaByTeam?.get(agg.teamNumber) ?? null) : null; const epaInHouse = external == null && epaFromScouting; return epaInHouse ? agg.scoutingExpectedPoints : external;`. Both `RankingView` AND `seedPicklist` must call this so the seed order can never drift from the ranking-table order. |
| `src/dash/RankingView.tsx` | Refactor its private `sortValue` to delegate to `rankSortValue` from `sorting.ts` for the four overlapping keys (keep `teamNumber`/`matchesScouted`/`meanFuelPoints`/`reliability`/`tbaRank` local). **Also replace the inline row-EPA build (lines 205-218) with a call to `resolveRowEpa`** so the table and the seed use byte-identical EPA resolution. This guarantees the seed ranking == the ranking-table ranking. No UI change. |
| `src/dash/picklistSeeding.ts` | **NEW FILE.** Pure: `seedPicklist(opts: { aggs: TeamAgg[]; sortKey: RankSortKey; topN: number; minMatches?: number; epaByTeam?: Map<number, number \| null>; epaAvailable?: boolean; epaFromScouting?: boolean }): PicklistEntry[]`. Must resolve each row's EPA via `resolveRowEpa` from `sorting.ts` (NOT a hand-rolled expression). See §4 for the algorithm. |
| `src/dash/PicklistSeedDialog.tsx` | **NEW FILE.** Controlled modal. Props: `{ open: boolean; aggs: TeamAgg[]; epaByTeam?: Map<number, number\|null>; epaAvailable: boolean; onSeed: (entries: PicklistEntry[], mode: 'replace' \| 'append') => void; onClose: () => void }`. Metric `<select>`, Top-N `<input type=number>`, min-matches `<input>`, mode radios, Seed/Cancel buttons. Computes `epaFromScouting = !epaAvailable` and calls `seedPicklist({ ..., epaAvailable, epaFromScouting })` (pass BOTH so `resolveRowEpa` matches RankingView exactly). Disables Seed when `aggs.length === 0`. |
| `src/dash/PicklistView.tsx` | (a) Fetch aggregates + EPA: add `useEventReports(eventKey)` → `aggregateEvent` → `aggs`; `useEventMatches`; `useEventEpa(teamNumbers, eventKey, matches)`. **These are TanStack Query hooks — see the test-rewire requirement below; today `PicklistView` uses NO data hooks and `PicklistView.test.tsx` renders it bare with no `QueryClientProvider`, so adding the hooks WILL break all ~11 existing tests unless `useEventData` is mocked first.** (b) Add `seedOpen` state + **Seed** button in `CardHeader` (`data-testid="pick-seed-open"`). (c) Render `<PicklistSeedDialog>` wired to a `handleSeed(entries, mode)` that does replace (`mutate(entries)`) or append (`mutate([...existing, ...entries.filter(not already present)])`). (d) Broaden `updateField` to also accept `'dnp'` (boolean) and `'tierType'` (string\|null) — split into `updateField` (string fields) + `toggleDnp(teamNumber)` + `cycleTier(teamNumber)`. (e) Per-row: DNP toggle button, tier-type pill button, DNP strike-through styling. Read defensively: `e.dnp ?? false`, `e.tierType ?? null`. |
| `src/dash/exportDash.ts` | `picklistToCsv`: change header to `'rank,teamNumber,tier,note,tierType,dnp'`; per row push `[i+1, e.teamNumber, e.tier ?? null, e.note ?? null, e.tierType ?? '', e.dnp ? 'true' : 'false']`. |

---

## 4. Core logic

### `picklistSeeding.ts` — `seedPicklist`

```ts
import type { TeamAgg } from '@/dash/aggregate';
import type { PicklistEntry } from '@/dash/picklistClient';
import { compareDesc, resolveRowEpa, type RankSortKey } from '@/dash/sorting';

export interface SeedOptions {
  aggs: TeamAgg[];
  sortKey: RankSortKey;
  topN: number;
  minMatches?: number;             // default 0
  epaByTeam?: Map<number, number | null>;
  epaAvailable?: boolean;          // mirror RankingView's epaQuery.data.available === true
  epaFromScouting?: boolean;       // mirror RankingView's !epaAvailable
}

export function seedPicklist(opts: SeedOptions): PicklistEntry[] {
  const {
    aggs, sortKey, topN, minMatches = 0,
    epaByTeam, epaAvailable = false, epaFromScouting = false,
  } = opts;

  // Resolve the EPA each row sorts by via the SHARED helper so the seed order is
  // byte-identical to the RankingView table (no hand-rolled expression here —
  // that divergence is exactly what resolveRowEpa exists to prevent).
  const inputs = aggs
    .filter((agg) => agg.matchesScouted >= minMatches)
    .map((agg) => ({
      agg,
      epa: resolveRowEpa({ agg, epaByTeam, epaAvailable, epaFromScouting }),
    }));

  inputs.sort((a, b) => compareDesc(a, b, sortKey)); // desc, tie → asc teamNumber

  const n = Math.max(1, Math.min(Math.trunc(topN), 60)); // clamp 1..60
  return inputs.slice(0, n).map((inp) => ({
    teamNumber: inp.agg.teamNumber,
    tier: null,
    note: null,
    tierType: null,
    dnp: false,
  }));
}
```

### `sorting.ts` — shared comparator (single source of truth)

```ts
import type { TeamAgg } from '@/dash/aggregate';

export type RankSortKey =
  | 'scoutingExpectedPoints' | 'climbSuccessRate' | 'avgDefenseRating' | 'epa';

export interface RankInput { agg: TeamAgg; epa: number | null; }

export function rankSortValue(r: RankInput, key: RankSortKey): number {
  switch (key) {
    case 'scoutingExpectedPoints': return r.agg.scoutingExpectedPoints;
    case 'climbSuccessRate':       return r.agg.climbSuccessRate;
    case 'avgDefenseRating':       return r.agg.avgDefenseRating;
    case 'epa':                    return r.epa ?? Number.NEGATIVE_INFINITY;
  }
}

export function compareDesc(a: RankInput, b: RankInput, key: RankSortKey): number {
  const av = rankSortValue(a, key), bv = rankSortValue(b, key);
  if (av === bv) return a.agg.teamNumber - b.agg.teamNumber; // stable tiebreak
  return bv - av; // descending
}

// Single source of truth for per-row EPA resolution — copied EXACTLY from
// RankingView.tsx lines 208-212 so the ranking table and the seed cannot drift.
export function resolveRowEpa(p: {
  agg: TeamAgg;
  epaByTeam?: Map<number, number | null>;
  epaAvailable: boolean;
  epaFromScouting: boolean;
}): number | null {
  const external = p.epaAvailable ? (p.epaByTeam?.get(p.agg.teamNumber) ?? null) : null;
  const epaInHouse = external == null && p.epaFromScouting;
  return epaInHouse ? p.agg.scoutingExpectedPoints : external;
}
```

`RankingView.tsx` then (1) changes its `sortValue` cases for these four keys to call
`rankSortValue({ agg: row.agg, epa: row.epa }, key)`, leaving the table's other columns
(`teamNumber`, `matchesScouted`, `meanFuelPoints`, `reliability`, `tbaRank`) untouched, and
(2) builds each row's `epa` via `resolveRowEpa(...)` instead of the current inline expression.
Together these are the only edits that prevent the documented "sorting logic duplication" /
"EPA divergence" risk. (Note: `epaInHouse` is still needed in `RankingView` for the "est"
suffix UI — derive it locally as `external == null && epaFromScouting`, or have `resolveRowEpa`
also be mirrored by the existing local `epaInHouse` line; either way the *value* used for
sorting comes from `resolveRowEpa`.)

### Consistency with mapReport / scoring

**Not touched.** Seeding consumes already-computed `TeamAgg` aggregates from `aggregate.ts`
(which itself uses frozen `@/scoring` magnitudes) and the existing `useEventEpa` hook. No raw
report fields, no wire shape, no server recompute is involved. `mapReport.ts` and the scoring
model are out of scope.

---

## 5. UI / UX

- **Where:** Dashboard → **Picklist** tab (`PicklistView`). All additions are inside the
  existing `Card`; no new route, no router change (keeps the single `RouteError` boundary).
- **Header:** add `<Button data-testid="pick-seed-open">Seed</Button>` left of **Save**.
- **Seed dialog (`PicklistSeedDialog`):** a focus-trapped overlay (reuse the project's existing
  dialog/overlay pattern — same `div` overlay style used by other dash modals; no new dep).
  testids: `pick-seed-dialog`, `pick-seed-metric` (select), `pick-seed-topn` (input),
  `pick-seed-minmatches` (input), `pick-seed-mode-replace` / `pick-seed-mode-append` (radios),
  `pick-seed-confirm` (Seed), `pick-seed-cancel`. Shows `pick-seed-epa-note` when EPA falls back.
  Disabled-empty state testid `pick-seed-empty`.
- **Row additions (44px touch targets, dark theme, shadcn):**
  - DNP toggle `data-testid="pick-dnp-${teamNumber}"` — `aria-pressed`, label "DNP". When on,
    add `line-through opacity-60` to the team cell and a red `pick-dnp-badge-${teamNumber}`.
  - Tier pill `data-testid="pick-tier-type-${teamNumber}"` cycling `—`/`1st`/`2nd`
    (brand / amber background). `aria-label="Pick tier for team N"`.
- **States:** loading (existing), empty list (existing `pick-empty`), saved/saveError (existing).
  Seeding sets the list dirty (clears `saved`) exactly like a manual edit.

---

## 6. Offline behavior

- **Seeding is fully offline.** Aggregates come from `useEventReports`, whose query cache is
  persisted to IndexedDB via `PersistQueryClientProvider`; an offline reload rehydrates the last
  good reports and seeding still works.
- **EPA offline:** `useEventEpa` already degrades — Statbotics down → local match EPA → none.
  When `epaAvailable === false`, the dialog sets `epaFromScouting = true` and seeds by in-house
  `scoutingExpectedPoints`, showing `pick-seed-epa-note`. Seeding by EPA never errors offline.
- **Saving offline:** `savePicklist` writes straight to Supabase; with no network it rejects and
  the existing `pick-save-error` surfaces. The seeded entries remain in local component state so
  the lead can retry when back online (matches today's picklist save behavior — there is no local
  outbox for the picklist, and this feature does not add one).
- **DNP / tier edits** live in component state and persist only on **Save**, identical to
  tier/note today.

---

## 7. Test plan

### Unit (Vitest)

**`src/dash/__tests__/picklistSeeding.test.ts` (new)**
- Ranks by `scoutingExpectedPoints` desc; ties broken by ascending team number.
- `topN` truncates correctly; `topN > teams` returns all teams; `topN` clamps to 1..60.
- `minMatches` filters out teams below threshold before ranking.
- `sortKey: 'epa'` with `epaAvailable:true` + `epaByTeam` uses external EPA; a team whose
  `epaByTeam` value is `null` (EPA available but missing for that team) + `epaFromScouting=false`
  sorts to the bottom (`NEGATIVE_INFINITY`) — this mirrors `RankingView` exactly via `resolveRowEpa`.
- `sortKey: 'epa'` with `epaAvailable:false` + `epaFromScouting:true` and empty `epaByTeam` ranks
  by `scoutingExpectedPoints` (fallback path).
- **Divergence guard:** `epaAvailable:true` but a specific team's `epaByTeam` entry is `null` →
  assert `seedPicklist` and a directly-called `resolveRowEpa` agree (same value), and that the
  resulting order matches what `RankingView` would produce for the same inputs.
- Returned entries have `tier:null, note:null, tierType:null, dnp:false`.
- `aggs: []` returns `[]`.

**`src/dash/__tests__/sorting.test.ts` (new)**
- `rankSortValue` returns the agg field for each key; `epa` null → `NEGATIVE_INFINITY`.
- `compareDesc` orders descending and applies the team-number tiebreak.

**`src/dash/__tests__/exportDash.test.ts` (extend)**
- `picklistToCsv` header is `rank,teamNumber,tier,note,tierType,dnp`.
- A row with `dnp:true, tierType:'first'` emits `...,first,true`; defaults emit `...,,false`.

**`src/dash/__tests__/picklistClient.test.ts` (extend)**
- `getPicklist` normalizes legacy entries lacking the keys → `dnp:false, tierType:null`.
- `savePicklist` includes `dnp`/`tierType` in the upserted `entries` payload (mock supabase).

**`src/dash/__tests__/PicklistView.test.tsx` (extend — REQUIRED rewire FIRST)**
- **Before adding any new assertions, add `vi.mock('@/dash/useEventData', ...)` mirroring
  `RankingView.test.tsx` lines 12-17** (mock `useEventReports`, `useEventMatches`, `useEventEpa`,
  and any other named export `RankingView`/`PicklistView` imports from that module). The current
  `PicklistView.test.tsx` renders `<PicklistView eventKey=... />` BARE with no
  `QueryClientProvider` and mocks only `@/dash/picklistClient` + `@/dash/exportDash`; the new hook
  calls would throw "No QueryClient set" and break **all ~11 existing tests** without this mock.
  Either mock `useEventData` (preferred — matches the RankingView pattern, no provider needed) OR
  wrap renders in a `QueryClientProvider`. Pick the mock.
- In `beforeEach`, seed default hook return values (`useEventReports` → `{ data: [], isLoading: false }`,
  `useEventEpa` → `{ data: { epaByTeam: new Map(), available: false } }`, `useEventMatches` →
  `{ data: [], ... }`) so the existing non-seed tests render unchanged.
- Renders Seed button; clicking opens `pick-seed-dialog`.
- `toggleDnp` adds/removes the DNP badge and dirties the list (Save re-enabled / `saved` cleared).
- `cycleTier` cycles `— → 1st → 2nd → —` on repeated clicks.
- Seeding in **replace** mode replaces the list; **append** mode keeps existing + adds new,
  skipping duplicates. (Mock `seedPicklist`/aggregate or provide fixture reports.)

**`src/dash/__tests__/RankingView.test.tsx` (extend, guard the refactor)**
- Existing sort-by-`scoutingExpectedPoints`/`epa`/`climbSuccessRate`/`avgDefenseRating` tests
  still pass after delegating to `rankSortValue` (no behavior change).

### Playwright e2e (`tests/e2e/picklist-seed.spec.ts`, new)

Single-worker (`workers: 1`) against the live remote DB, per existing
`tests/e2e/dashboard.spec.ts` conventions. Reuse helpers in `tests/e2e/helpers.ts`
(`setActiveEvent`).

**Data source — do NOT assume live `2026casnv` has scouting data.** The repo guarantees no
match-scouting rows for `2026casnv`: `global-setup.ts` seeds a *different* synthetic
`E2E_EVENT_KEY` (one match, zero `match_scouting_report` rows) and `dashboard.spec.ts` only adds
team 254 manually, never asserting any aggregate exists. A hard `toHaveCount(8)` against
`2026casnv` would fail (and the Seed button would be disabled via `pick-seed-empty`) if the live
event has < 8 scouted teams. **Choose one of two data strategies and state it in the spec:**
- **Preferred — demo mode.** `demoEvent` (`src/dash/demoEvent.ts`, per CLAUDE.md) has guaranteed
  full scouting data. Enable demo mode (Setup-tab toggle / seed-demo) so aggregates exist; this
  avoids polluting the shared `2026casnv` picklist that `dashboard.spec.ts` also mutates.
- **Alternative — seed real rows.** If running against `2026casnv`, `beforeAll` must insert N
  `match_scouting_report` rows via the admin client and `afterAll` must delete them.

**Shared-state discipline (collision with `dashboard.spec.ts`).** Both specs target the same
`2026casnv` picklist row and flip the global `event.is_active` singleton. Under `workers: 1` files
run serially, but this spec MUST replicate `dashboard.spec.ts`'s exact hooks or it will leave a
polluted picklist that makes `dashboard.spec`'s `entries.some(254)` assertion flaky by file order:
- `beforeAll`: `test.skip(!URL || !SECRET, ...)`, probe migration 0009 (skip if absent),
  `setActiveEvent(admin, '2026casnv')`, `await admin.from('picklist').delete().eq('event_key','2026casnv')`.
- `afterAll`: `await admin.from('picklist').delete().eq('event_key','2026casnv')`.
- Add a comment documenting that this spec shares state with `dashboard.spec.ts` and relies on
  `workers: 1`.

**Tab navigation** (IconTabs renders `role="tab"` buttons; `dash-picklist` is the PANEL testid,
not a clickable tab): in every scenario navigate via
`await page.getByRole('tab', { name: 'Picklist' }).click()` then
`await expect(page.getByTestId('dash-picklist')).toBeVisible()`.

Scenario A — **seed by expected points, replace**:
1. Click `page.getByRole('tab', { name: 'Picklist' })`; await `dash-picklist` visible.
2. `await page.getByTestId('pick-seed-open').click()`; expect `pick-seed-dialog` visible.
3. Select metric `scoutingExpectedPoints` in `pick-seed-metric`; fill `pick-seed-topn` with `8`;
   ensure `pick-seed-mode-replace` checked; click `pick-seed-confirm`.
4. Assert the list has `min(8, scoutedTeams)` rows and the count is monotonic/non-empty — do NOT
   hard-assert `toHaveCount(8)` unless the chosen data strategy guarantees ≥ 8 scouted teams
   (demo mode does). Read the rendered count and assert `count > 0 && count <= 8`.
5. Assert row 1's rank cell shows `1` and order is descending by exp-pts (cross-check against the
   Ranking tab sorted by Exp. Pts, OR assert monotonic via rendered values).

Scenario B — **DNP + tier flags persist a Save round-trip**:
1. With a seeded list, click `pick-dnp-<team>` for the first row; expect `pick-dnp-badge-<team>` visible.
2. Click `pick-tier-type-<team>` once; expect its text to read `1st`.
3. Click `pick-save`; expect `pick-saved` visible.
4. Reload the page, reopen the Picklist tab; assert the DNP badge and `1st` pill are still present
   for that team (verifies JSONB round-trip + defensive read).

Scenario C — **EPA fallback note**:
1. Open the seed dialog, select metric `epa`.
2. If `pick-seed-epa-note` is present (Statbotics offline path), assert its text mentions
   in-house estimate; either way clicking `pick-seed-confirm` produces a non-empty list
   (`pick-row-*` count > 0). (Tolerant of whether the live env has EPA.)

Scenario D — **append mode skips duplicates**:
1. Seed top 4 (replace). Note the rendered team numbers.
2. Reopen dialog, choose `pick-seed-mode-append`, seed top 6.
3. Assert no duplicate `pick-row-<team>` testids and total count == union size
   (`<= min(6, scoutedTeams)` plus the prior 4, deduped).

### Cleanup
The `afterAll` above (`delete picklist where event_key='2026casnv'`) is the cleanup — it mirrors
`dashboard.spec.ts` exactly. If demo mode was toggled on, also reset it in `afterAll`. Do not rely
on an empty-list save; a hard delete is what `dashboard.spec.ts` uses and what avoids cross-spec
pollution.

---

## 8. Conflict surface (overlap with the other 12 features)

Files this feature touches and who else touches them:

| File | Also touched by | Coordination |
|---|---|---|
| `src/dash/exportDash.ts` | **export-presets** (will restructure CSV/JSON export & add preset selection) | HIGH conflict on `picklistToCsv`. Land export-presets-aware: keep the column set additive; if export-presets ships a column registry, register `tierType`/`dnp` there instead of hard-coding the header. Sequence: do whichever lands first, rebase the other onto the final `picklistToCsv` signature. |
| `src/dash/RankingView.tsx` | **defense-analytics**, **distribution-trend** (may add columns/sort keys), **matchup-intelligence** | MEDIUM. My change extracts the 4 shared comparators + `resolveRowEpa` into `sorting.ts` and delegates; new columns those features add are unaffected. **Caveat: the "single source" guarantee only holds if those features ALSO delegate new sort keys to `sorting.ts` rather than re-inlining a `switch` case in `RankingView.sortValue`.** Coordinate so later editors extend `sorting.ts`; if a feature inlines a new key, the seed simply won't offer that key (the seed-able `RankSortKey` subset stays explicit), so divergence is contained, not silent. |
| `src/dash/__tests__/PicklistView.test.tsx` (mock rewire) | none directly, but the `vi.mock('@/dash/useEventData')` pattern is shared knowledge with **matchup-intelligence**/**alliance-simulator** if they also touch this file | LOW. Additive mock; see §7. |
| `src/dash/sorting.ts` (new) | **defense-analytics**, **distribution-trend** (candidates to reuse it) | LOW. Designed as the shared home for rank comparators; additive. |
| `src/dash/PicklistView.tsx` | **alliance-simulator** (may launch a sim from a picklist team), **export-presets** (export buttons) | MEDIUM. Header button area is shared; keep testids unique. Coordinate the `CardHeader` button row layout. |
| `src/dash/aggregate.ts` (`TeamAgg`) — read-only here | **defense-analytics**, **coverage-gaps**, **distribution-trend**, **multi-scout-reconciliation** (may add fields) | LOW. I only consume existing fields; new agg fields are backward compatible. |
| `src/dash/useEventData.ts` (`useEventEpa`) — read-only here | **matchup-intelligence**, **alliance-simulator**, **dashboard-heartbeat** | LOW. Consumed unchanged. |

No overlap with: report-correction, scouter-load-accuracy, auto-path-heatmap, match-video,
dashboard-heartbeat (different files), coverage-gaps (capture-side).

---

## 9. Step-by-step execution checklist

1. **`src/dash/sorting.ts`** — create with `RankSortKey`, `RankInput`, `rankSortValue`,
   `compareDesc`, AND `resolveRowEpa` (exact cases/expression from §4).
2. **`src/dash/RankingView.tsx`** — import from `sorting.ts`; delegate the 4 shared keys in
   `sortValue` AND build each row's `epa` via `resolveRowEpa` (replacing the inline lines 205-218).
   Run `RankingView.test.tsx` — must stay green (pure refactor).
3. **`src/dash/picklistClient.ts`** — extend `PicklistEntry`; normalize defaults in `getPicklist`.
4. **`src/dash/picklistSeeding.ts`** — create `seedPicklist` (§4).
5. **`src/dash/PicklistSeedDialog.tsx`** — create the modal (testids in §5); compute
   `epaFromScouting`; call `seedPicklist`; disable on empty aggs.
6. **`src/dash/__tests__/PicklistView.test.tsx`** — FIRST add `vi.mock('@/dash/useEventData', ...)`
   (mirror `RankingView.test.tsx` lines 12-17) and seed default hook returns in `beforeEach`,
   BEFORE the component starts calling the hooks. Run the existing suite — all ~11 tests must stay
   green with the mock in place (they will throw "No QueryClient set" if you add the hooks first).
7. **`src/dash/PicklistView.tsx`** — wire `useEventReports`/`aggregateEvent`/`useEventMatches`/
   `useEventEpa`; add Seed button + dialog; add `toggleDnp` / `cycleTier`; render DNP badge +
   tier pill with defensive reads; `handleSeed` for replace/append.
8. **`src/dash/exportDash.ts`** — extend `picklistToCsv` header + rows (§3).
9. **Unit tests** — add `picklistSeeding.test.ts`, `sorting.test.ts`; extend `exportDash.test.ts`,
   `picklistClient.test.ts` (and the already-rewired `PicklistView.test.tsx` from step 6 with the
   seed/DNP/tier assertions). Run `npm test`.
10. **`npm run typecheck`** — clean.
11. **e2e** — add `tests/e2e/picklist-seed.spec.ts` (scenarios A–D, demo-mode data + identical
    `beforeAll`/`afterAll` picklist+setActiveEvent discipline as `dashboard.spec.ts`); run
    `npx playwright test tests/e2e/picklist-seed.spec.ts`.
12. **No migration. No `supabase db push`.** Confirm nothing under `supabase/` changed.
13. Frontend deploys via Vercel on merge to `main` — no manual deploy step.
