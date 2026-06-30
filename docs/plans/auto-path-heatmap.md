# Auto-Path Heatmap — Implementation Plan

Overlay ALL of a team's stored auto routines (normalized start position + drawn path)
as a single density heatmap, so staff can judge auto **consistency** at a glance —
not just the most-recent auto the broadcast view shows.

---

## 1. Overview & exact user-facing behavior

Today the dashboard's `AutoRoutines` component (NextMatchView) renders **one** read-only
polyline + start marker per distinct team, using only that team's MOST RECENT report
with auto data. The drawn auto from earlier matches is invisible. There is no way to see
whether a team runs the SAME auto every match (tight cluster) or improvises (scattered).

This feature adds an **"all autos" heatmap** that stacks every report's
`auto_start_position` + `auto_path` for a single team into one density overlay on the
field image. Density is rendered as alpha-stacked single-hue circles (light → opaque),
so where the team consistently starts/drives is dark, and outliers are faint.

### User-facing behavior

**NextMatchView (broadcast)** — unchanged by default. `AutoRoutines` keeps its current
`'latest'` mode (one polyline per opposing/own team) so the broadcast stays legible. A
small segmented toggle is added to the `AutoRoutines` header:

- **"Latest"** (default): current per-team polyline overlay (existing behavior, pixel-identical).
- **"All (heatmap)"**: replaces the polyline overlays with a per-team heatmap. Because a
  multi-team heatmap is illegible, in this mode the user picks ONE team from a small
  chip row (the same legend chips, now clickable); the heatmap shows only that team's
  stacked autos. Selecting no team shows a faint heatmap of all of them combined.

**TeamView (analysis)** — a new **"Auto consistency"** card (`team-auto-heatmap`) is added
to `TeamDetail`, after the pit card (`{props.pitNode}`, TeamView.tsx ~line 738). It renders
a heatmap of **all** of the selected team's scouted autos at this event (every one of the
team's reports with `auto_path` or `auto_start_position`). The card consumes the
**already-team-filtered** `matches` array `TeamDetail` already receives (`teamMatches` in the
default export, filtered to `target_team_number === selected`), so no re-filtering of the full
`reports` array is needed. Plus:

> **Scope correction (review):** the original plan asserted `reports` and `selectedTeam` are
> "already in scope" inside `TeamDetail`. They are NOT. `TeamDetail` (the function with
> `data-testid="team-detail"`, ~line 598) receives only
> `{ agg, matches, tbaNode, lastMatchNode, epaNode, pitNode, photoNode, scoutName, onOpenReport }`.
> `matches` is ALREADY filtered to the selected team (`teamMatches`, ~line 886); the full
> `reports` array and `selected` team number live only in the `TeamView` default export
> (line 843+). The fix used here: add ONE new prop `teamNumber: number` to `TeamDetail`,
> pass `teamNumber={selected}` from the default export (~line 1001), and feed `matches`
> (already team-scoped) to `AutoHeatmap`. This also means the card renders ONLY for teams
> with match reports (the `agg` truthy branch); see the empty-state note in §5.

- A count line: `"N autos across M matches"` (`team-auto-heatmap-count`).
- A **consistency score** chip (`team-auto-heatmap-consistency`): 0–100%, computed from
  start-position spread (formula in §4). Higher = tighter clustering = more repeatable.
- Empty state (`team-auto-heatmap-empty`): `"No auto paths recorded."` when the team has
  zero reports carrying auto data.

Heatmap is **read-only** (`FieldDiagram mode="view"`), respects the existing `mirror`
flag, and never appears while `FieldDiagram` is in `pick-start`/`draw-path` editing modes.

---

## 2. Data model — NO MIGRATION REQUIRED

All required data already exists and syncs end-to-end. No new migration, RPC, RLS, or
capture change.

- `match_scouting_report.auto_start_position` — JSONB `{x,y}|null`, already mapped to
  `LocalMatchReport.autoStartPosition` and exposed on `MsrRow.auto_start_position`.
- `match_scouting_report.auto_path` — JSONB `[{x,y},…]|null`, exposed on `MsrRow.auto_path`.
- `useEventReports(eventKey)` (`src/dash/useEventData.ts`) already fetches all
  `deleted=false` rows for an event under RLS. Filtering by `target_team_number` and
  non-null auto fields is a pure client transform.

The wire shape (`src/sync/mapReport.ts`) and server-side `upsert_match_report` RPC are
**NOT touched** — this feature only READS already-synced columns. Because nothing about
the upsert shape, scoring inputs, or server aggregate recomputation changes, the
"`mapReport.ts` is the single client wire shape, kept in sync with the RPC" and
"scoring recomputed server-side" constraints are satisfied trivially.

> Do NOT create migration 0033 for this feature. Latest deployed is 0032; this feature
> needs no DB change.

---

## 3. Files to create / modify

| Path | Precise change |
|------|----------------|
| `src/components/HeatmapLayer.tsx` | **NEW.** Pure render helper exporting `heatmapCircles(points, opts)` (returns `{ x, y, r, fillOpacity }[]` in normalized field space) and a `<HeatmapLayer>` React component that takes `points: FieldPoint[]`, `color: string`, `bins?: number`, `pointRadius?: number` and renders one `<g data-testid={...}>` of `<circle>`s with `pointer-events:none`. Density via spatial binning + alpha stacking (§4). No external deps. |
| `src/components/FieldDiagram.tsx` | Extend `FieldDiagramProps` with optional `heatmap?: { points: FieldPoint[]; color?: string } \| null`. Render a new `<g data-testid="${testid}-heatmap" style={{pointerEvents:'none'}}>` as the **FIRST child of the existing `<svg>`** — inserted BEFORE the `<polyline>` at line 177 — only when `heatmap && heatmap.points.length > 0 && mode === 'view'`. SVG paints in document order, so being the first child is what makes the heatmap render UNDER the polyline/marker/overlay siblings; "below" here means earlier-in-document, not a separate z layer. Apply the existing `mx()` mirror transform to every circle's `cx` (points arrive in raw [0,1] space — see §4.4 boundary contract). Reuse `heatmapCircles()` from `HeatmapLayer`. Do NOT change any existing prop behavior. (The pick-start SQUARE marker is an HTML div outside the `<svg>` and is unaffected.) |
| `src/dash/AutoHeatmap.tsx` | **NEW.** `AutoHeatmap({ teamNumber, reports, mirror?, color?, 'data-testid'? })`. `reports` is the **already-team-filtered** array the caller passes (TeamView passes `matches`; AutoRoutines passes the alliance-scoped reports). The component STILL filters defensively by `target_team_number === teamNumber` so it is correct regardless of caller, and applies the shared `hasAutoData(r)` predicate (see §4.1). Memoized: flattens all start positions + path points into one raw-space `FieldPoint[]` (§4.2), computes the consistency score (§4.5), renders `<FieldDiagram mode="view" heatmap={{points, color}} mirror={mirror}/>` + count line (`team-auto-heatmap-count` / for AutoRoutines a generic count) + consistency chip. Empty state when no points. |
| `src/dash/AutoRoutines.tsx` | Add `mode?: 'latest' \| 'all-heatmap'` (default `'latest'`) and `selectedTeam?: number \| null` + `onSelectTeam?` props (mode and selected team are LIFTED to the parent — see NextMatchView row). Add a segmented toggle rendered as a **sibling header ABOVE** the existing field/empty structure — it must NOT alter the `'latest'` render path. In `'latest'` mode the existing `buildRoutines` + overlays + legend + `auto-routines-empty` are byte-for-byte unchanged (acceptance gate: existing AutoRoutines.test.tsx passes UNMODIFIED). In `'all-heatmap'` mode: render legend chips as clickable team selectors (`auto-routines-team-<n>`) and an `<AutoHeatmap>` for the selected team (or combined faint heatmap when none selected). The empty state still renders `auto-routines-empty` when there are no overlays, in EITHER mode. Use the shared `hasAutoData` predicate (§4.1). |
| `src/dash/NextMatchView.tsx` | **Lift `mode` (and `selectedHeatTeam`) state to a single owner.** Add ONE `useState<'latest'\|'all-heatmap'>` near the two-column grid and render ONE shared segmented toggle ABOVE the grid (single, non-duplicated `auto-routines-mode-latest`/`auto-routines-mode-heatmap` testids). Pass `mode` (and a per-column `selectedTeam`/`onSelectTeam` if isolating a team) down through each `AllianceColumn` to its `AutoRoutines`. Default `'latest'` so the broadcast is unchanged on load. Do NOT rename existing `AllianceColumn` props others may extend — only ADD. Rationale for lifting: `AutoRoutines` renders twice (red+blue); per-instance `useState` would duplicate the toggle testids and desync the columns. |
| `src/dash/TeamView.tsx` | (1) Add ONE new prop `teamNumber: number` to the `TeamDetail` prop type (~line 598) and destructure it. (2) Pass `teamNumber={selected}` from the default export's `<TeamDetail ... />` call (~line 1001; `selected` is non-null in that branch). (3) Inside `TeamDetail`, after `{props.pitNode}` (~line 738), add `<Card data-testid="team-auto-heatmap">` rendering `<AutoHeatmap teamNumber={props.teamNumber} reports={props.matches} data-testid="team-auto-heatmap" />`. `props.matches` is already team-scoped. Import `AutoHeatmap`. |
| `src/dash/__tests__/AutoHeatmap.test.tsx` | **NEW.** Unit tests for filtering/grouping, consistency-score formula, empty state, and rendered circle count (see §7). |
| `src/components/__tests__/HeatmapLayer.test.tsx` | **NEW.** Unit tests for `heatmapCircles()` binning + alpha math (pure function, deterministic). |
| `tests/e2e/dashboard.spec.ts` | Add e2e scenarios (§7) for the TeamView heatmap card and the NextMatchView mode toggle. |

---

## 4. Core logic — exact formulas/algorithms

All math is in normalized field space `[0,1]²`. No scoring change, so `compute.ts` /
`mapReport.ts` are untouched.

### 4.1 Shared `hasAutoData` predicate (single source of truth)

The existing `AutoRoutines.hasAuto` (AutoRoutines.tsx line 36) treats a report as having auto
when `auto_start_position != null || auto_path != null` — which counts a non-null but EMPTY
`auto_path` array. The original heatmap `collectPoints` used the stricter
`(auto_path?.length ?? 0) > 0`. These two predicates DISAGREE on edge rows (empty `auto_path`,
null start), so "latest" mode and the heatmap could include/exclude different reports and the
count line could mismatch what "latest" shows.

**Fix (review):** export one shared predicate and use it in BOTH places. Add to
`src/dash/AutoRoutines.tsx` (and import into `AutoHeatmap.tsx`):

```ts
export function hasAutoData(r: MsrRow): boolean {
  return r.auto_start_position != null || (r.auto_path?.length ?? 0) > 0;
}
```

Then refactor `AutoRoutines.buildRoutines` to call `hasAutoData` instead of the local
`hasAuto` (delete the old `hasAuto`). The stricter form is chosen so an empty-path report with
no start contributes zero points to the heatmap AND is not counted as a routine.
**Acceptance note:** the existing `AutoRoutines.test.tsx` rows always set a non-null start +
≥2-point path, so this stricter predicate does not change any existing test's outcome — verify
the 7 existing assertions still pass after the refactor (explicit gate in §9 step 7).

### 4.2 Point collection (`AutoHeatmap`)

```ts
function collectPoints(reports: MsrRow[], teamNumber: number): {
  points: FieldPoint[];      // every start + every path vertex, flattened (RAW [0,1] space)
  starts: FieldPoint[];      // just the start positions (for consistency)
  matchCount: number;        // distinct match_key with auto data
  autoCount: number;         // reports with auto data
} {
  const mine = reports.filter(
    (r) => r.target_team_number === teamNumber && hasAutoData(r),
  );
  const points: FieldPoint[] = [];
  const starts: FieldPoint[] = [];
  for (const r of mine) {
    if (r.auto_start_position) { points.push(r.auto_start_position); starts.push(r.auto_start_position); }
    if (r.auto_path) for (const p of r.auto_path) points.push(p);
  }
  const matchCount = new Set(mine.map((r) => r.match_key)).size;
  return { points, starts, matchCount, autoCount: mine.length };
}
```

### 4.4 Density binning + alpha stacking (`heatmapCircles`)

> **Mirror boundary contract (review):** `heatmapCircles` operates entirely in RAW,
> unmirrored [0,1] space and returns circle centers in raw space. The `mx()` mirror transform
> is applied to each circle's `cx` ONLY at the `FieldDiagram` render boundary (exactly like
> `path`/`overlays` do at lines 185/215). `heatmapCircles` itself NEVER mirrors. This is what
> makes the unit test (§7 #7) well-defined: with `mirror` set, a circle emitted at raw `x`
> renders at `cx === 1 - x` because FieldDiagram mirrors, not the helper.

Native SVG, no canvas, no KDE library. Bin the field into a `bins × bins` grid
(default `bins = 24`), count points per cell, then emit ONE circle per non-empty cell at
the cell center. Opacity scales with the cell's share of the max bin count, so the
busiest region is solid and singletons are faint:

```ts
const BINS = 24;
const MIN_OPACITY = 0.12;   // a single point is still visible
const MAX_OPACITY = 0.85;   // never fully opaque (field stays readable)
const CELL = 1 / BINS;
const R = CELL * 0.75;      // overlap slightly so dense regions blend

function heatmapCircles(points: FieldPoint[], bins = BINS) {
  if (points.length === 0) return [];
  const counts = new Map<string, number>(); // "ix,iy" -> count
  for (const p of points) {
    const ix = Math.min(bins - 1, Math.max(0, Math.floor(p.x * bins)));
    const iy = Math.min(bins - 1, Math.max(0, Math.floor(p.y * bins)));
    const k = `${ix},${iy}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const max = Math.max(...counts.values());
  const out = [];
  for (const [k, c] of counts) {
    const [ix, iy] = k.split(',').map(Number);
    const t = max <= 1 ? 1 : c / max;                         // 0..1 share
    const fillOpacity = MIN_OPACITY + (MAX_OPACITY - MIN_OPACITY) * t;
    out.push({ x: (ix + 0.5) / bins, y: (iy + 0.5) / bins, r: R, fillOpacity });
  }
  return out;
}
```

Default `color = '#22d3ee'` (the same cyan as the primary path) for single-team views.
Single-hue intensity (opacity), never multi-color — addresses the legibility risk.

**Mirror:** `FieldDiagram` applies `mx(x)` to each circle's `cx` exactly like it does for
`path`/`overlays`, so heatmap respects the alliance mirror flag automatically.

**Downsampling guard (perf risk):** if `points.length > 4000`, increase `bins` is NOT
needed — binning already collapses arbitrarily many points into ≤ `bins²` (576) circles,
so render cost is bounded regardless of match count or path length. This is the mitigation
for the "50+ matches / 1000-point path" risk: output is always ≤ 576 circles.

### 4.5 Consistency score (`AutoHeatmap`, TeamView chip)

Measures how tightly the team's **start positions** cluster (the most diagnostic single
signal for "do they run the same auto?"). Use mean Euclidean distance from the centroid,
mapped to 0–100%:

```ts
function consistency(starts: FieldPoint[]): number | null {
  if (starts.length < 2) return null;                 // need ≥2 to compare
  const cx = mean(starts.map((p) => p.x));
  const cy = mean(starts.map((p) => p.y));
  const meanDist = mean(starts.map((p) => Math.hypot(p.x - cx, p.y - cy)));
  // 0 spread -> 100%. Spread of >= SPREAD_FLOOR (0.25 of field) -> 0%.
  const SPREAD_FLOOR = 0.25;
  const score = Math.max(0, 1 - meanDist / SPREAD_FLOOR);
  return Math.round(score * 100);
}
```

`null` (rendered as `—`) when fewer than 2 starts. `SPREAD_FLOOR = 0.25` chosen because a
quarter-field MEAN distance-from-centroid is unambiguously inconsistent. Pure function,
fully unit-tested.

> **Worked examples (review — fixes the §7 #6 self-test):** the score is driven by
> `meanDist` (mean distance from the centroid), NOT the pairwise gap. For TWO starts a gap
> `d` apart on x: centroid is the midpoint, each point is `d/2` from it, so `meanDist = d/2`.
> - 2 identical starts (`d = 0`): `meanDist = 0` → **100%**.
> - 2 starts **0.25 apart** (`d = 0.25`): `meanDist = 0.125` → `1 - 0.125/0.25` = **50%**.
> - 2 starts **0.5 apart** (`d = 0.5`): `meanDist = 0.25` → `1 - 0.25/0.25` = **0%**.
>
> So the unit test (§7 #6) must assert: identical → 100%, **0.5 apart → ~0%** (not 0.25), and
> 0.25 apart → 50%.

---

## 5. UI / UX

### NextMatchView → AutoRoutines

- A SINGLE shared 2-button segmented control (shadcn-styled buttons, 44px touch targets) is
  rendered ABOVE the red/blue alliance grid in `NextMatchView` (NOT inside each
  `AutoRoutines`): **Latest** | **All (heatmap)**. Its `mode` state is lifted to
  `NextMatchView` and passed to both columns, so there is exactly ONE
  `auto-routines-mode-latest`/`auto-routines-mode-heatmap` pair (no per-column duplication)
  and toggling affects both columns at once. Default **Latest** so the broadcast is unchanged
  on load.
- **Latest mode**: pixel-identical to today (multi-team polyline overlays + legend).
- **All (heatmap) mode**: legend chips become buttons (`auto-routines-team-<n>`). Tapping
  one selects that team and renders its `<AutoHeatmap>`; tapping again deselects → faint
  combined heatmap of all alliance teams. A one-line caption explains "tap a team to
  isolate". This avoids the illegible-multi-team-overlay problem.
- The `mirror` behavior already used by `AutoRoutines`/`FieldDiagram` is preserved.

### TeamView → TeamDetail "Auto consistency" card

- New `<Card data-testid="team-auto-heatmap">` placed in `TeamDetail` AFTER `{props.pitNode}`
  (TeamView.tsx ~line 738). NOTE the real anchor: there is no inline "Preferred auto" block in
  `TeamDetail` — pit content is an opaque `props.pitNode` (`<PitPanel>`, testid `team-pit`,
  defined separately), and the "Preferred auto" `FieldDiagram` lives INSIDE `PitPanel`
  (~line 461), not addressable at the `TeamDetail` level. So the documented anchor is
  "immediately after `{props.pitNode}`" (alternatively after the EPA Card at ~line 732).
  Title row: `<Route/>` icon + "Auto consistency".
- Body: `<AutoHeatmap teamNumber={props.teamNumber} reports={props.matches} data-testid="team-auto-heatmap"/>`
  centered with `max-w-[420px]` (matching the pit-auto field), the count line, and the
  consistency chip.
- **Empty-state reachability (review):** `TeamDetail` (and therefore this card) only renders
  in the `agg` truthy branch — i.e. for teams that HAVE match scouting reports (line 993). A
  team with zero match reports renders the `team-no-data` branch (line ~1013), where the card
  is NOT mounted. So `team-auto-heatmap-empty` is reachable only in the narrow case of a team
  that has match reports but where every one of them has null start + empty/no `auto_path`.
  This is acceptable and intentional (we do not add the card to the no-data branch); the e2e
  in §7 accounts for it by selecting a team that definitely has reports.
- Card is event-scoped: shows ALL of the team's autos at this event across every opponent
  (answers the most useful question — does THIS robot run a repeatable auto). Opponent/alliance
  filtering is intentionally out of scope.

### States

- **Loading**: TeamView already gates on `team-loading`; the card mounts with the rest of
  `TeamDetail` once reports resolve.
- **Empty**: `team-auto-heatmap-empty` / `auto-routines-empty`.
- **Editing modes**: heatmap is hidden whenever `FieldDiagram.mode !== 'view'` (guard in
  FieldDiagram), so it never blocks `pick-start`/`draw-path` interaction.

---

## 6. Offline behavior

- Heatmap is computed **100% client-side** from `useEventReports` data, which TanStack
  Query persists to IndexedDB (`PersistQueryClientProvider`). On an offline reload the
  last good reports rehydrate and the heatmap renders from cache — no network needed.
- No new fetches, no edge-function calls, no Statbotics/TBA dependency, so there is
  nothing to degrade: the feature has the same offline reach as the existing TeamView/
  NextMatchView report data.
- If a team has zero cached reports with auto data, the empty state renders (never an
  error), satisfying graceful-degradation. Legacy reports with `null` auto fields are
  filtered out by `collectPoints`.
- Heatmap may be stale while a sync is in flight; reports are immutable post-sync and the
  query invalidates on the normal report refresh, so the heatmap self-updates with no
  special live-update path.

---

## 7. Test plan

### Unit tests (Vitest)

**`src/components/__tests__/HeatmapLayer.test.tsx`** — pure `heatmapCircles()`:
1. Empty input → `[]`.
2. All points in one cell → 1 circle, `fillOpacity === MAX_OPACITY` (max share = 1).
3. Two cells, 3 points in A and 1 in B → 2 circles; A's opacity > B's; B's opacity ≥ `MIN_OPACITY`.
4. Output count is always ≤ `bins²` even for 5000 random points (downsampling/bounded-render guarantee).
5. Circle centers fall at `(ix+0.5)/bins, (iy+0.5)/bins`.

**`src/dash/__tests__/AutoHeatmap.test.tsx`** (mirror the `AutoRoutines.test.tsx` `row()` factory):
1. Renders `team-auto-heatmap` container and the heatmap `<g>` for a team with auto data.
   NOTE the heatmap `<g>` testid is `${testid}-heatmap` → `team-auto-heatmap-heatmap` (because
   `AutoHeatmap` passes `data-testid="team-auto-heatmap"` to `FieldDiagram`), NOT
   `field-diagram-heatmap`. The bare `field-diagram-heatmap` testid only appears when a caller
   passes no `data-testid`.
2. Filters to the target team only (points from other teams excluded — assert via count line).
3. Flattens BOTH start positions and path vertices into the heatmap (count line `"N autos across M matches"`).
4. Skips reports with null `auto_start_position` AND empty/null `auto_path` (uses shared
   `hasAutoData`).
5. Empty state `team-auto-heatmap-empty` when the team has no auto data.
6. Consistency formula (matches §4.5 arithmetic): 2 identical starts → **100%**;
   2 starts **0.5 apart** on x → **~0%**; 2 starts **0.25 apart** → **50%**; <2 starts → `—`.
7. `mirror` flips circle `cx`: pass a single start at known raw `x`, render with `mirror`, and
   assert the circle's `cx` ≈ `1 - x`. This holds because `heatmapCircles` emits raw-space
   centers and `FieldDiagram` applies `mx()` at the render boundary (§4.4 contract).

**`src/dash/__tests__/AutoRoutines.test.tsx`** (RUN UNMODIFIED FIRST, then extend):
8. **ACCEPTANCE GATE:** run the existing file with NO edits — all 7 current assertions (exact
   overlay testids `auto-routines-overlay-*`, the latest path `points='0.9,0.9 0.8,0.8'`,
   `auto-routines-empty` rendered as a direct child, field/legend structure) MUST still pass
   after the mode toggle is added. Only then add cases 9.
9. Default `mode='latest'` (or omitted) renders the existing field/overlays/empty unchanged.
   With `mode='all-heatmap'`: renders clickable `auto-routines-team-<n>` chips; selecting a
   team renders an `AutoHeatmap` (its `team-auto-heatmap` container, or `auto-routines`-scoped
   heatmap `<g>`); existing latest-mode overlay polylines absent. The `auto-routines-empty`
   state still appears when there are no overlays in `all-heatmap` mode too.

**`src/components/__tests__/FieldDiagram.test.tsx`** — this file ALREADY EXISTS; EXTEND it
(its `beforeEach` polyfills `PointerEvent` and stubs `getBoundingClientRect` — keep those for
the new cases). Add:
10. `heatmap` prop renders `<g data-testid="field-diagram-heatmap">` with circles in `mode='view'`,
    as the FIRST child of the `<svg>` (before the polyline).
11. Heatmap `<g>` NOT rendered when `mode='pick-start'` or `'draw-path'` (even with points).
12. Heatmap `<g>` has `pointer-events:none` (z-order/interaction guard).
13. With `mirror` set, a heatmap circle's `cx` ≈ `1 - x` (FieldDiagram applies `mx()`).

### Playwright e2e (`tests/e2e/dashboard.spec.ts`, single-worker, live `eventKey` or demo)

These reuse the existing module-level `admin` client + `setActiveEvent(admin, eventKey)`
pattern from `dashboard.spec.ts` (do NOT hardcode `2026casnv` — use the file's `eventKey`
constant). Append new `test(...)` blocks; do not edit existing ones.

> **Review fixes baked in:** (1) DERIVE the target team at runtime from a report that actually
> has auto data — never hardcode `254` against the shared/mutable live DB (`selectOption` THROWS
> if the value is absent, it does not soft-skip). (2) Wait for `getByTestId('dashboard')` before
> asserting tab content, matching the existing spec. (3) The TeamView card only mounts for teams
> WITH match reports (the `agg` branch), so the chosen team must have reports. (4) The
> NextMatchView toggle is a SINGLE shared control — assert exactly one, no `.first()` papering.

**Scenario A — TeamView auto-consistency card:**
```
await setActiveEvent(admin, eventKey);

// Pick a team that definitely has a report carrying auto data (so TeamDetail mounts
// AND the heatmap, not just the empty branch). Fall back to any reported team.
const { data: autoRows } = await admin
  .from('match_scouting_report')
  .select('target_team_number, auto_start_position, auto_path')
  .eq('event_key', eventKey)
  .eq('deleted', false)
  .limit(500);
const withAuto = (autoRows ?? []).find(
  (r) => r.auto_start_position != null || (Array.isArray(r.auto_path) && r.auto_path.length > 0),
);
const target = withAuto?.target_team_number ?? autoRows?.[0]?.target_team_number;
test.skip(target == null, 'No scouted reports at this event to drive the heatmap.');

await page.goto('/dashboard?tab=team');
await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
await expect(page.getByTestId('dash-team')).toBeVisible({ timeout: 15_000 });
await page.getByTestId('team-select').selectOption(String(target));
await expect(page.getByTestId('team-detail')).toBeVisible({ timeout: 15_000 });

// The new card appears; either a heatmap field or the empty state, never an error.
const card = page.getByTestId('team-auto-heatmap');
await expect(card).toBeVisible();
const hasHeatmap = await page.getByTestId('team-auto-heatmap-heatmap').count();
if (hasHeatmap) {
  await expect(page.getByTestId('team-auto-heatmap-count')).toBeVisible();
  await expect(page.getByTestId('team-auto-heatmap-consistency')).toBeVisible();
} else {
  await expect(page.getByTestId('team-auto-heatmap-empty')).toBeVisible();
}
```

**Scenario B — NextMatchView mode toggle (single shared control):**
```
await setActiveEvent(admin, eventKey);
await page.goto('/dashboard');                       // defaults to next-match
await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
await expect(page.getByTestId('dash-next')).toBeVisible({ timeout: 25_000 });
await expect(page.getByTestId('auto-routines').first()).toBeVisible();

// ONE shared toggle above the alliance grid (not per-column). Default is 'latest'.
await page.getByTestId('auto-routines-mode-heatmap').click();
// In heatmap mode, tapping a team chip isolates it and shows a heatmap layer.
const chip = page.getByTestId(/auto-routines-team-\d+/).first();
if (await chip.count()) {
  await chip.click();
  await expect(page.getByTestId(/-heatmap$/).first()).toBeVisible();
}
// Toggle back to latest restores the broadcast view.
await page.getByTestId('auto-routines-mode-latest').click();
await expect(page.getByTestId('auto-routines-field').first()).toBeVisible();
```

**Assertion discipline:** every scenario tolerates "no auto data at this event" by
branching to the empty state (the live DB is shared/mutable), matching how `dashboard.spec.ts`
already guards its live-data expectations.

---

## 8. Conflict surface (vs the other 12 planned features)

Files this feature touches and who else touches them:

| File | Also touched by | Conflict risk & coordination |
|------|-----------------|------------------------------|
| `src/dash/TeamView.tsx` | **defense-analytics**, **matchup-intelligence**, **distribution-trend**, **multi-scout-reconciliation**, **match-video** (all add cards/sections to `TeamDetail`) | HIGH. All add sibling `<Card>`s into `TeamDetail`. Keep each card a self-contained component with a unique `data-testid`; insert at a distinct, documented anchor (this one: immediately after `{props.pitNode}`, ~line 738 — NOT the non-existent inline "Preferred auto block"). **Compounding hazard:** the correct edit ALSO threads a new `teamNumber` prop into `TeamDetail` (the full `reports`/`selected` are NOT in `TeamDetail` scope). Every other card feature that needs the team number or the full reports array will touch the SAME `TeamDetail` prop-type + call-site lines → land a single shared `TeamDetail` prop-extension first, then add cards one at a time. |
| `src/dash/NextMatchView.tsx` | **matchup-intelligence**, **alliance-simulator**, **dashboard-heartbeat**, **coverage-gaps** (add panels/toggles to alliance columns/header) | MEDIUM. Changes: ONE lifted `mode` state + ONE shared header toggle above the grid, threaded through both `AllianceColumn`s. **Hazard:** `AutoRoutines` renders twice (red+blue); the mode state MUST be lifted (not per-instance) or the toggle testids duplicate and the columns desync — this also avoids conflicting with matchup-intelligence/alliance-simulator edits to `AllianceColumn`. Only ADD `AllianceColumn` props; do not rename existing ones. |
| `src/components/FieldDiagram.tsx` | None of the other 12 (FieldDiagram is capture/pit-shared, not analytics) | LOW. Additive optional `heatmap` prop only; no existing prop semantics change. Safe to land independently. |
| `src/dash/AutoRoutines.tsx` | None expected (auto-specific) | LOW. Owned by this feature. |
| `src/dash/useEventData.ts` | **coverage-gaps**, **scouter-load-accuracy**, **distribution-trend** (may add hooks) | LOW — this feature ADDS no hook, only reads existing `useEventReports`. Conflict only if another feature edits the same lines; we add nothing here. |
| `tests/e2e/dashboard.spec.ts` | **matchup-intelligence**, **alliance-simulator**, **smart-picklist**, others | MEDIUM. Append new `test(...)` blocks; do not edit existing blocks. Keep `setActiveEvent` ordering (single-worker shared event). |

No overlap with **report-correction**, **export-presets**, **smart-picklist** (those touch
sync/RPC/picklist/export paths this feature does not).

**`src/dash/DashboardScreen.tsx` — NO CHANGE.** Confirmed: the NextMatchView mode toggle is
lifted into `NextMatchView` itself (line 116 renders `<NextMatchView eventKey={eventKey} />`),
not the shell; and `?tab=team` already routes to `<TeamView>` (line 117). No shell wiring is
needed, so DashboardScreen is intentionally NOT in the file list.

**Recommended landing order (lowest conflict → highest):**
1. `src/components/FieldDiagram.tsx` (+ extend its existing test) — additive optional prop, LOW.
2. `src/components/HeatmapLayer.tsx` (+ new test) — brand-new file, no conflict.
3. `src/dash/AutoHeatmap.tsx` (+ new test) and the shared `hasAutoData` export in AutoRoutines.
4. `src/dash/AutoRoutines.tsx` (mode toggle) (+ extend its test).
5. `src/dash/NextMatchView.tsx` (lifted toggle) and `src/dash/TeamView.tsx` (card + prop) LAST,
   coordinated one card at a time with the other TeamDetail/AllianceColumn features.

---

## 9. Step-by-step execution checklist

1. **`src/components/HeatmapLayer.tsx`** — implement pure `heatmapCircles(points, bins?)`
   (§4.4, raw-space output — no mirroring in the helper) and the `<HeatmapLayer>` `<g>`
   renderer with `pointer-events:none`. Export both.
2. **`src/components/__tests__/HeatmapLayer.test.tsx`** — unit tests 1–5 (§7). Run
   `npx vitest run src/components/__tests__/HeatmapLayer.test.tsx`.
3. **`src/components/FieldDiagram.tsx`** — add optional `heatmap` prop; render the heatmap
   `<g data-testid="${testid}-heatmap">` as the FIRST child of the existing `<svg>` (before
   the line-177 polyline), only when `mode === 'view'` && points present; apply `mx()` to
   each circle's `cx` at THIS render boundary (helper returns raw space). Verify existing
   FieldDiagram behavior unchanged (run capture + pit specs / existing FieldDiagram tests).
4. **`src/dash/AutoHeatmap.tsx`** — add the shared `hasAutoData` export to AutoRoutines.tsx
   first (§4.1), then implement `collectPoints` + `consistency` (§4.2, §4.5), render
   `FieldDiagram` heatmap + count line + consistency chip + empty state, all memoized.
5. **`src/dash/__tests__/AutoHeatmap.test.tsx`** — tests 1–7 (§7). Run that file.
6. **`src/dash/AutoRoutines.tsx`** — replace local `hasAuto` with the shared `hasAutoData`;
   add `mode`/`selectedTeam`/`onSelectTeam` props + a segmented toggle as a SIBLING HEADER
   above the existing field/empty structure + clickable team chips + `AutoHeatmap` wiring in
   `all-heatmap` mode. Keep the `'latest'` render path (field/legend/empty) byte-for-byte
   equivalent — no changes to the existing overlay/empty-state DOM.
7. **Run `src/dash/__tests__/AutoRoutines.test.tsx` UNMODIFIED first** as an acceptance gate:
   all 7 existing assertions (exact overlay testids, latest path `'0.9,0.9 0.8,0.8'`,
   `auto-routines-empty` as a direct child) MUST still pass after the toggle is added. THEN
   extend the file with tests 8–9 (§7).
8. **`src/dash/NextMatchView.tsx`** — add ONE lifted `mode` state + ONE shared toggle above
   the alliance grid; thread `mode` through both `AllianceColumn`s to `AutoRoutines`; default
   `'latest'`. Single non-duplicated toggle testids. Run `NextMatchView.test.tsx`.
9. **`src/dash/TeamView.tsx`** — import `AutoHeatmap`; add `teamNumber: number` to the
   `TeamDetail` prop type + destructure; pass `teamNumber={selected}` at the `<TeamDetail/>`
   call (~line 1001); add the `team-auto-heatmap` Card in `TeamDetail` AFTER `{props.pitNode}`
   (~line 738), feeding `reports={props.matches}` (already team-scoped). Run `TeamView.test.tsx`.
10. **Add FieldDiagram heatmap tests** (§7 tests 10–12) if a FieldDiagram test file exists;
    otherwise add a small one.
11. **`npm run typecheck`** and **`npm test`** — full unit/DB/function suite green.
12. **Append e2e scenarios A + B** to `tests/e2e/dashboard.spec.ts`. Run
    `npx playwright test tests/e2e/dashboard.spec.ts` (single-worker, live `2026casnv`).
13. **No migration / no deploy.** Confirm `git status` shows no new `supabase/migrations/*`
    and no `mapReport.ts` change. Frontend ships via Vercel on merge to `main`.
