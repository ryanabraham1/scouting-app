# Multi-Scout Reconciliation View

**Feature group:** Analysis depth
**Status:** Planned (not started)
**Migration:** None required (client-side only)

---

## 1. Overview & exact user-facing behavior

### Problem

A `match_scouting_report` row is unique per `(match_key, scout_id)` while active (enforced by
`idx_msr_match_scout_active`). Nothing stops **two different scouts** from each filing an active
report on the **same robot in the same match** — i.e. two rows sharing the same
`(match_key, target_team_number, alliance_color, station)` but different `scout_id`. Today
`aggregateTeam()` silently averages those two rows together. If Scout A logged "L3 climb,
14 fuel points" and Scout B logged "no climb, 8 fuel points" on the same robot, the dashboard
shows the blended `~L1.5 / 11 pts` and the lead has no idea two humans disagreed.

This feature surfaces those disagreements so the lead can flag/trust the right data. It is a
**purely observational, client-side analysis layer** — no schema change, no aggregate-math change,
no resolution/delete action in v1.

### What the lead sees (exact behavior)

1. **MatchView → Reports on this match.** When a selected match contains a robot covered by 2+
   scouts, a **conflict group header chip** renders *above* the affected report tiles:
   `2 scouts · Team 1678 · Blue 2 — conflict` (destructive tone if severe, warning tone if minor,
   neutral "agree" tone if the two reports actually match). The affected report tiles get a colored
   left border + tinted background. Hovering/focusing the chip (or its inline `(i)` button) shows a
   tooltip listing each divergent metric: `Fuel: 14 vs 8 pts · Climb: L3 vs none · Defense: 4 vs 1`.
   Non-conflicting reports render exactly as today.

2. **TeamView → Scouted matches.** Each match row that is part of a multi-scout group gets a
   `ConflictMarker` icon-chip to the left of the match label. A new **"Show conflicts only"** toggle
   above the match list filters the list to just conflicted matches. The team header gains a summary
   pill: `2 multi-scout conflicts` (hidden when zero). When "conflicts only" is on and there are
   none, an empty-state line renders.

3. **ReportDetail (Sheet, opened from either view).** When the opened report is part of a
   multi-scout group, a **"Multi-scout conflict" banner section** renders at the very top:
   `Also scouted by Bria (Blue 2). Compare: Fuel 14 vs 8 · Climb L3 vs none.` with a button per
   sibling report: **"View Bria's report →"** that swaps the Sheet content to the sibling (caller
   passes the group + an `onOpenSibling` callback).

4. **Severity tiers** drive tone and default visibility:
   - **agree** — every compared metric within tolerance → neutral marker, no alarm.
   - **unknown** — two scouts covered the robot but nothing was comparable (all numeric metrics
     missing on a side, no boolean disagreement) → muted "insufficient data to compare" tone, no
     alarm. Distinct from `agree` so a genuine match isn't conflated with absence of evidence.
   - **minor** — at least one metric diverges but below the severe threshold → amber.
   - **severe** — a categorical disagreement (one says no-show, other says played; climb success
     vs failure; fuel spread ≥ severe threshold) → red/destructive.
   `isConflicted` is `minor`/`severe` only. Minor conflicts can be hidden behind the same
   "show conflicts only" filter; severe always show. `agree`/`unknown` are not counted as conflicts.

### Non-goals (v1)

- No "mark canonical / soft-delete the loser" action (tracked as open question; aggregation stays
  unchanged — all active reports are still averaged exactly as today).
- No server-side precomputed conflict table.
- No change to EPA / prediction / ranking math.

---

## 2. Data model

**NO NEW MIGRATION REQUIRED.** This is a client-side analysis layer over data that already exists.

Justification:

- `match_scouting_report` already stores `scout_id`, `target_team_number`, `match_key`,
  `alliance_color`, `station`, and every fuel/climb/defense/foul field per row. The dashboard
  already fetches full rows via `useEventReports()` (used by `MatchView`/`TeamView`).
- The uniqueness index `idx_msr_match_scout_active` is **per scout**, so two scouts producing two
  active rows on the same robot/match is a legal, already-occurring state.
- `mapReport.ts` (the single client wire shape) and the `upsert_match_report` RPC are **untouched** —
  the server still recomputes aggregates from raw fields; we only read what comes back.

Latest deployed migration is **0032**. This feature adds **no** migration. (If a future v2 adds a
server-side conflict-resolution RPC it would be `0033+` and must follow the 0024/0031 RLS pattern
and **must not be marked deployed** — out of scope here.)

---

## 3. Files to create / modify

| Path | Precise change |
|------|----------------|
| `src/dash/reconcile.ts` *(new)* | Pure module. Exports `detectMultiScoutReports(reports: MsrRow[]): MultiScoutGroup[]` (group by composite key, compute divergences, classify severity) and the constants/helpers below. No React, no I/O. |
| `src/dash/types.ts` *(modify)* | Add `ConflictSeverity`, `ConflictDivergences`, and `MultiScoutGroup` types. **Do NOT** add fields to `MsrRow` (keep it the pure wire-row shape). Conflict metadata lives on `MultiScoutGroup`, looked up by report key. |
| `src/dash/useMultiScoutConflicts.ts` *(new)* | Hook `useMultiScoutConflicts(reports)` that memoizes `detectMultiScoutReports` and returns `{ groups, byRobotKey, byReportKey, byTeam }` lookup maps (`byRobotKey: Map<string, MultiScoutGroup>` for MatchView/ReportDetail; `byTeam: Map<number, MultiScoutGroup[]>` for TeamView) + the `robotKey(r)`/`reportKey(r)` helpers for O(1) lookups in render loops. |
| `src/components/ConflictMarker.tsx` *(new)* | Reusable badge/chip with tooltip. Props: `group`, `size?: 'sm'|'md'`, `variant?: 'chip'|'icon'`, `showDetail?: boolean`. Tone derived from `group.severity`. Renders divergence lines from `formatDivergences(group)`. |
| `src/dash/MatchView.tsx` *(modify)* | Compute groups in the parent **scoped to `selectedReports`** (MatchView.tsx:302), NOT the whole-event `reports` array — otherwise `byRobotKey` would span unrelated matches. Pass `byRobotKey` into `MatchDetail`. Rework the existing station-sorted `.map` (MatchView.tsx:174-188) to interleave a group header element keyed by robotKey-first-seen, and tint/border member tiles. **Also disambiguate the per-tile `data-testid`** (see §5 MatchView — currently `match-report-${team}-${station}` collides when two scouts share one robot). |
| `src/dash/__tests__/MatchView.test.tsx` *(modify)* | Update the one existing usage `getByTestId('match-report-254-1')` (line 229) to the new disambiguated id, then add the conflict-header assertion. |
| `src/dash/TeamView.tsx` *(modify)* | Compute conflicts across the whole event once via the hook (near the `aggregateEvent` memo, TeamView.tsx:886); derive the selected team's groups via `byTeam.get(selected)` (no separate per-team detector run). Add a header summary pill, a "Show conflicts only" toggle, a `ConflictMarker` on each conflicted scouted-match row, and an empty state. **Reset `openRow` to `null` when the conflicts-only toggle flips** (filtering reindexes the index-based rows at TeamView.tsx:750-836, so an open row would jump); this keeps existing index testids unchanged — see §5. |
| `src/dash/__tests__/TeamView.test.tsx` *(modify)* | Add conflict-summary/toggle/marker assertions. Existing index selectors (lines 255/299/302) stay valid under reset-on-toggle — no churn needed. |
| `src/dash/ReportDetail.tsx` *(modify)* | Accept optional `conflictGroup?: MultiScoutGroup` + `onOpenSibling?: (r: MsrRow) => void`; render the top "Multi-scout conflict" banner (with `data-testid="report-conflict"` + `data-scout-id`) + sibling buttons when `conflictGroup?.isConflicted`. Existing callers (no props) are unchanged. |
| `src/dash/__tests__/ReportDetail.test.tsx` *(modify)* | Banner + sibling-button + onOpenSibling-callback assertions; no-prop and non-conflicted (`agree`/`unknown`) back-compat. |
| `src/dash/__tests__/reconcile.test.ts` *(new)* | Unit tests for grouping + severity (incl. `agree` vs `unknown`) + divergence math + null guards + fuel-comparand pin. |
| `src/components/__tests__/ConflictMarker.test.tsx` *(new)* | Render tests for tone/variants/inline-detail across `severe`/`minor`/`agree`/`unknown`. |
| `tests/e2e/reconciliation.spec.ts` *(new)* | Playwright e2e (single-worker, live `2026casnv`, **mirrors `admin.spec.ts` scout-seeding, not `dashboard.spec.ts`**): seed `team`+`event_team`+two real `scout` rows+two conflicting reports, assert markers in MatchView/TeamView/ReportDetail, then four-step FK-safe cleanup. |

**Referenced but NOT edited** (no change needed; listed so executors don't accidentally touch them):
- `src/dash/DashboardScreen.tsx` — the e2e navigates tabs via `getByRole('tab', { name: 'Match' })`
  / `'Team'`; the existing labels already match, so no edit.
- `tests/e2e/helpers.ts` — reuse the existing `setActiveEvent` export; no change.
- `src/dash/useEventData.ts` — read-only reference for query shapes (`useEventReports`/`useEventTeams`).
- `src/dash/mapReport.ts`, `src/scoring/*`, `src/dash/aggregate.ts`, `supabase/migrations/*` —
  deliberately untouched (verified). The diff for this feature must show zero changes to these.

---

## 4. Core logic — exact algorithms

### 4.1 Composite key & grouping

```ts
// reconcile.ts
export function reportKey(r: MsrRow): string {
  // Identity of a row for O(1) conflict lookup. (i) index disambiguates the rare
  // case where two same-scout rows survive; we still want a stable per-row key.
  return `${r.match_key}|${r.target_team_number}|${r.alliance_color}|${r.station}|${r.scout_id ?? '∅'}`;
}

function robotKey(r: MsrRow): string {
  return `${r.match_key}|${r.target_team_number}|${r.alliance_color}|${r.station}`;
}
```

`detectMultiScoutReports(reports)`:

1. Filter out `r.deleted === true`. **Belt-and-suspenders, not load-bearing:** the live
   `useEventReports()` query already pre-filters with `.eq('deleted', false)` (useEventData.ts:99),
   so live data never carries deleted rows. The guard exists for QR-merged / local-store rows that
   may include deleted flags. The "Deleted excluded" unit test is the only thing exercising this
   branch — keep it.
2. Group by `robotKey(r)`.
3. **Dedupe by `scout_id` within a group** — keep one row per distinct `scout_id` (latest
   `server_received_at`). Two active rows from the *same* scout are an outbox artifact, not a
   multi-scout disagreement, so they must not produce a false conflict. A `null`/`undefined`
   `scout_id` counts as one distinct "unassigned" scout.
4. Keep only groups whose **distinct scout count ≥ 2**.
5. For each kept group compute `divergences` (§4.2) and `severity` (§4.3).
6. Return `MultiScoutGroup[]`.

Complexity: O(n) over reports (single pass to bucket + per-bucket constant work). Memoized in the
hook so it recomputes only when `reports` identity changes.

### 4.2 Divergence metrics (all null-guarded — partial-data safe)

For a group of `k ≥ 2` deduped reports, compute per-metric spread over **only the reports that have
a usable value** (legacy rows missing a column never trigger a false positive):

**Comparand choice (pin in a test):** fuel divergence compares the server-recomputed
`fuel_points` aggregate, NOT the raw `auto_fuel + teleop_* + endgame_fuel` inputs. Tradeoff:
`fuel_points` is what the dashboard actually displays and averages, so flagging on it matches what
the lead sees — but two scouts can produce slightly different `fuel_points` purely from
confidence/down-weight differences rather than a real disagreement, so small spreads are expected
noise (handled by `FUEL_MINOR_PTS`). This is a deliberate choice; `reconcile.ts` documents it and a
unit test pins `fuel_points` as the comparand so a later refactor can't silently switch to raw inputs.

```ts
const num = (xs: number[]) => xs.filter((x) => Number.isFinite(x));

// fuel_points present on all rows since 0008; still guard.
const fuels = num(reports.map((r) => r.fuel_points));
const fuel_spread = fuels.length >= 2 ? Math.max(...fuels) - Math.min(...fuels) : 0;

// Climb: categorical success disagreement OR level spread among successes.
const climbSuccesses = reports.map((r) => r.climb_success === true);
const climb_success_divergent =
  climbSuccesses.some((x) => x) && climbSuccesses.some((x) => !x);
const climbLevels = num(reports.filter((r) => r.climb_success).map((r) => r.climb_level));
const climb_level_spread = climbLevels.length >= 2 ? Math.max(...climbLevels) - Math.min(...climbLevels) : 0;

const defenses = num(reports.map((r) => r.defense_rating));
const defense_spread = defenses.length >= 2 ? Math.max(...defenses) - Math.min(...defenses) : 0;

// Boolean reliability flags: divergent iff scouts disagree on the flag.
const flagDivergent = (sel: (r: MsrRow) => boolean) => {
  const vs = reports.map(sel);
  return vs.some(Boolean) && vs.some((v) => !v);
};
const no_show_divergent = flagDivergent((r) => r.no_show === true);
const died_divergent     = flagDivergent((r) => r.died === true);
const tipped_divergent   = flagDivergent((r) => r.tipped === true);

// Count how many metrics were actually comparable (≥2 scouts had a usable value).
// Booleans are always comparable across the group; numeric metrics only when ≥2 present.
const comparable_metric_count =
  (fuels.length >= 2 ? 1 : 0) +
  (climbLevels.length >= 2 ? 1 : 0) +
  (defenses.length >= 2 ? 1 : 0) +
  3; // no_show / died / tipped booleans are always defined-vs-default comparable
// climb_success is a tri-state boolean already covered by climb_success_divergent.
```

`ConflictDivergences = { fuel_spread, climb_success_divergent, climb_level_spread, defense_spread,
no_show_divergent, died_divergent, tipped_divergent, comparable_metric_count }`.

**False-negative guard (review point — acknowledged).** Null-guarding each metric prevents a false
*positive* (a missing column never manufactures a spread), but it introduces a false *negative*: if
every comparable numeric metric is missing on one side and the booleans all match, two scouts who
*genuinely* disagree on data we can't see would be labeled `agree`. To avoid silently calling that
"double-covered," when `comparable_metric_count` is effectively zero (no numeric overlap AND no
boolean divergence) the group is classified as a third tier **`unknown`** rather than `agree`. See
§4.3. A dedicated unit test (`all-null-overlap`) pins this behavior.

### 4.3 Severity classification

Tunable thresholds exported as named constants so tests/UI share them:

```ts
export const FUEL_MINOR_PTS = 3;     // below this, fuel agrees
export const FUEL_SEVERE_PTS = 8;    // at/above this, fuel is a severe disagreement
export const DEFENSE_SEVERE = 3;     // defense-rating spread (0..5 scale)

export function classifySeverity(d: ConflictDivergences): ConflictSeverity {
  const severe =
    d.no_show_divergent ||
    d.died_divergent ||
    d.climb_success_divergent ||
    d.fuel_spread >= FUEL_SEVERE_PTS ||
    d.defense_spread >= DEFENSE_SEVERE;
  if (severe) return 'severe';
  const minor =
    d.fuel_spread >= FUEL_MINOR_PTS ||
    d.climb_level_spread >= 1 ||
    d.defense_spread >= 1 ||
    d.tipped_divergent;
  if (minor) return 'minor';
  // No divergence detected. Distinguish a genuine match from "we couldn't compare anything"
  // (every numeric metric missing on a side and no boolean disagreement) — see §4.2 false-negative.
  const noNumericOverlap =
    !(d.fuel_spread > 0) &&
    !(d.climb_level_spread > 0) &&
    !(d.defense_spread > 0) &&
    d.comparable_metric_count <= 3; // only the always-on booleans were comparable
  const noBooleanDivergence =
    !d.no_show_divergent && !d.died_divergent && !d.tipped_divergent && !d.climb_success_divergent;
  if (noNumericOverlap && noBooleanDivergence) return 'unknown';
  return 'agree';
}
```

`isConflicted = severity === 'minor' || severity === 'severe'`. An `agree` group means two scouts
covered the robot and their comparable metrics matched — surfaced neutrally so the lead knows it's
*double-covered*, not flagged as a problem. An `unknown` group means two scouts covered the robot but
nothing comparable existed to confirm agreement — surfaced with a muted "insufficient data to
compare" tone (also `isConflicted === false`, so it does not raise an alarm, but it is visually
distinct from a confirmed agreement).

### 4.4 Consistency with mapReport / scoring

- **`mapReport.ts` untouched.** No new fields cross the wire; the server still recomputes
  aggregates from raw inputs. Conflict detection reads the same `MsrRow` fields already returned.
- **`src/scoring/*` untouched.** Severity thresholds are *display* heuristics, deliberately kept out
  of the frozen `SCORING` magnitudes (which the server duplicates). Climb-level comparison reads
  `climb_level`/`climb_success` directly — same fields `climbPointsForMatch` uses — so no divergence
  from scoring semantics.
- **`aggregate.ts` untouched / backward-compatible.** `aggregateTeam`/`aggregateEvent` keep their
  exact current behavior (all active reports averaged). `RankingView`, `predict.ts`, and TeamView's
  `TeamAgg` stats are unaffected. Reconciliation is a *parallel* read of the same `reports` array.
  (The research note's `aggregateTeamWithReconciliation` is intentionally **not** added — it would
  duplicate aggregation; the divergence layer is self-contained in `reconcile.ts`.)

---

## 5. UI / UX

### Types (`src/dash/types.ts`, appended — `MsrRow` unchanged)

```ts
export type ConflictSeverity = 'agree' | 'unknown' | 'minor' | 'severe';

export interface ConflictDivergences {
  fuel_spread: number;
  climb_success_divergent: boolean;
  climb_level_spread: number;
  defense_spread: number;
  no_show_divergent: boolean;
  died_divergent: boolean;
  tipped_divergent: boolean;
  comparable_metric_count: number;
}

export interface MultiScoutGroup {
  matchKey: string;
  teamNumber: number;
  allianceColor: 'red' | 'blue';
  station: number;
  reports: MsrRow[];          // deduped, one per distinct scout
  scoutIds: (string | null)[];
  severity: ConflictSeverity;
  isConflicted: boolean;      // severity === 'minor' || 'severe'
  divergences: ConflictDivergences;
}
```

### `ConflictMarker.tsx`

- Tone map: `agree → muted/neutral`, `unknown → muted/dashed (insufficient data)`,
  `minor → warning (amber)`, `severe → destructive (red)`.
  Uses existing design tokens (`text-warning`/`bg-warning/10`, `text-destructive`/`bg-destructive/15`,
  `text-muted-foreground`/`border-border` for agree/unknown).
- `variant='chip'`: pill `{n} scouts · {severityLabel}` (used as MatchView group header).
- `variant='icon'`: just the `AlertTriangle` (severe) / `Users` (minor/agree) icon with the tooltip
  (used inline in TeamView match rows).
- Tooltip body from `formatDivergences(group)` → array of lines, e.g.
  `['Fuel: 14 vs 8 pts', 'Climb: L3 vs none', 'Defense: 4 vs 1']`. Built from the deduped reports'
  raw values, not the spread numbers, so the lead sees the actual figures.
- `data-testid="conflict-marker"` + `data-severity={group.severity}` for e2e/unit assertions.
- **No shared tooltip/popover primitive exists.** `src/components/ui/` has only
  `Sheet`/`StatTile`/`card`/`SegmentedToggle`/`button`/`input`/`label` — there is no `Tooltip` or
  `Popover` component to reuse, and the codebase uses plain `title=` on chips today. For v1,
  `ConflictMarker` therefore uses a `title=` attribute for the hover summary **plus an inline,
  click/Enter-toggled expansion** (a sibling `<div>` revealed by local `open` state) for the
  keyboard/touch-accessible divergence detail — NOT a from-scratch floating popover. This keeps the
  component self-contained and accessible without building a new positioning primitive. (The earlier
  "reuse existing popover pattern" framing was wrong — corrected here.) The MatchView header chip and
  the ReportDetail banner already render the divergence lines inline, so the detail is reachable
  without relying on hover anywhere.

### MatchView

- The hook is computed **in the parent (`MatchView`) scoped to `selectedReports`** (the existing
  memo at MatchView.tsx:302), not over the whole-event `reports` array — otherwise `byRobotKey`
  lookups would span unrelated matches. Pass `byRobotKey: Map<string, MultiScoutGroup>` into
  `MatchDetail`.
- **Restructure the existing `.map`** (currently MatchView.tsx:174-188: `reports.slice().sort(by
  station).map((r, i) => <li>…)`). This is not a drop-in — the map must now interleave a group
  header element. Concretely: keep the station sort; as you map, look up each report's group via
  `robotKey(r)`; maintain a `Set<string>` of robotKeys whose header has already been emitted; when a
  report belongs to a group not yet seen, emit the `<ConflictMarker variant="chip">` header `<li>`
  immediately before that report's tile, then mark the robotKey seen. The sibling
  `MatchTimelines`/`MatchVideoCard` elements below the list are untouched.
- Conflicted member tiles get `border-l-4 border-warning` (minor) / `border-destructive` (severe)
  + `bg-warning/5` / `bg-destructive/5`. `agree`/`unknown` member tiles render normally (no border).
- **Disambiguate the per-tile `data-testid`.** Today the tile is
  `data-testid={`match-report-${team}-${station}`}` (MatchView.tsx:188); two scouts on one robot
  produce two `<button>`s with the identical id, which breaks Playwright strict-mode
  (`getByTestId(...).toBeVisible()`/`.click()` throw "resolved to 2 elements"). Change it to
  **`match-report-${team}-${station}-${i}`** (the loop index is already in scope and in the React
  `key`). Audit/update the **only** existing consumer: `MatchView.test.tsx:229`
  (`getByTestId('match-report-254-1')` → `match-report-254-1-0`). No e2e references the old id today;
  the new reconciliation e2e uses the disambiguated form.
- Header chip: `<ConflictMarker variant="chip" group={group} />` with
  `data-testid="match-conflict-{team}-{station}"` (one header per robot, so no index needed).

### TeamView

- Compute `useMultiScoutConflicts(reports)` once near the existing `aggregateEvent` memo
  (TeamView.tsx:886). Derive the selected team's groups by **filtering the event-wide groups to
  `teamNumber === selected`** (`byTeam.get(selected)` from the hook) — do NOT run a second per-team
  detector pass.
- Header: when the selected team has `> 0` conflicted (`minor`/`severe`) groups, render
  `data-testid="team-conflict-summary"` pill: `{count} multi-scout conflict{s}`.
- Toggle: `data-testid="team-conflicts-only"` checkbox above `team-match-list`; when on, filter the
  `teamMatches` memo (TeamView.tsx:886) to rows whose `robotKey` maps to a conflicted group.
- **Fix the index/filter interaction (minimal-blast-radius approach).** Rows are currently
  `team-match-row-${i}` with index-based `open = openRow === i` (TeamView.tsx:750-836). Filtering the
  list reindexes rows, so a row left open would jump to a different match. **Resolve by resetting
  `openRow` to `null` whenever the `team-conflicts-only` toggle flips** (a one-line `onChange`:
  `setConflictsOnly(v); setOpenRow(null);`). This keeps the existing index-based `team-match-row-${i}`
  / `team-match-detail` / `team-match-fullreport-${i}` testids and `openRow` index semantics
  **unchanged**, so the existing `TeamView.test.tsx` selectors (`team-match-row-0` at lines 255/299,
  `team-match-fullreport-0` at 302) keep passing untouched — important because report-correction /
  distribution-trend also edit this same block, and re-keying every row to `robotKey` would force
  those features (and the existing tests) to churn the same lines. The reset-on-toggle fix is
  preferred for that reason. (A stable-robotKey re-key remains a valid alternative but is rejected
  for v1 as higher-churn on a high-contention block.)
- Each conflicted scouted-match row: inline `<ConflictMarker variant="icon" group={group} />`
  (`data-testid="team-conflict-marker"`) left of `formatMatchKeyRaw(m.match_key)`.
- Empty state when toggle on + none: `data-testid="team-conflicts-empty"`.

### ReportDetail

- New optional props `conflictGroup?` + `onOpenSibling?`. When `conflictGroup?.isConflicted`,
  render a top banner section (`data-testid="report-conflict"`, before Identity) with the severity
  marker, the divergence lines, and one **"View {name}'s report →"** button per sibling
  (`data-testid="report-conflict-sibling-{scout_id}"`) calling `onOpenSibling(sibling)`.
- Callers (`MatchView`/`TeamView`) pass the group resolved from `byRobotKey` for `openReport`, plus
  an `onOpenSibling={setOpenReport}` so the Sheet swaps to the sibling in place. Scout-name
  resolution reuses each view's existing `scoutName(id)` map.
- **Sibling-swap is e2e-observable via existing testids — no new fuel testid is needed.**
  ReportDetail has NO `data-testid` on the fuel-points `StatTile` (ReportDetail.tsx:106 is
  untestid'd), so the original plan's `report-fuel` assertion targeted a selector that does not
  exist. Two stable, already-present signals distinguish the two siblings after a swap and should be
  used by the e2e instead:
  1. `report-match-label` is the same, but the `report-flag-no-show` pill carries a
     `data-on` attribute (ReportDetail.tsx:55-63) that flips `"true"` ↔ `"false"` between the two
     seeded rows (A `no_show:false`, B `no_show:true`). Assert `data-on` before/after the swap.
  2. The conflict banner itself (`report-conflict`) re-renders for the new sibling; give each
     sibling button `data-testid="report-conflict-sibling-{scout_id}"` so the e2e can click the
     *other* scout's button and re-assert. To make the swap assertion robust, add
     `data-scout-id={r.scout_id}` to the banner (`report-conflict`) so the test can read which
     report is currently shown. (Cheap, stable, avoids depending on rendered numbers.)

---

## 6. Offline behavior

- Reconciliation is **pure client-side** over the already-cached `useEventReports()` result, which
  is persisted to IndexedDB via the app's `PersistQueryClientProvider`. With **zero network**, the
  last good reports rehydrate and conflicts compute identically — no fetch, no degradation.
- No new queries, no Edge Function, no proxy. Nothing to return an `{ available: false }` sentinel.
- `ConflictMarker` renders from in-memory data only; no images/links that could hang offline.
- When a lead is offline and a new conflicting report arrives later via **QR transfer**, it merges
  into the local store; the next render recomputes groups (the hook's memo invalidates because the
  `reports` array identity changes after the merge). No manual refresh needed.
- All routes already share the single `RouteError` boundary; a throw in reconcile (it won't —
  fully null-guarded) cannot blank the app.

---

## 7. Test plan

### 7.1 Unit — `src/dash/__tests__/reconcile.test.ts`

Use the existing `row(overrides)` factory pattern from `aggregate.test.ts`.

- **No multi-scout:** two reports on different stations / different scouts on different robots →
  `detectMultiScoutReports` returns `[]`.
- **Same scout, two active rows on one robot:** dedupe keeps one → not a conflict → `[]`.
- **Two scouts agree:** identical fuel/climb/defense, different `scout_id` → one group,
  `severity === 'agree'`, `isConflicted === false`.
- **Minor fuel divergence:** fuel 10 vs 12 (`spread 2 < FUEL_MINOR_PTS`? assert boundary) — pick
  values straddling `FUEL_MINOR_PTS`/`FUEL_SEVERE_PTS` and assert `'minor'`.
- **Severe — fuel:** fuel 4 vs 14 (`spread 10 ≥ FUEL_SEVERE_PTS`) → `'severe'`.
- **Severe — climb success disagreement:** A `climb_success:true, level:3`, B `climb_success:false`
  → `climb_success_divergent === true`, `'severe'`.
- **Severe — no-show disagreement:** A `no_show:true`, B `no_show:false` → `'severe'`.
- **Null guards (no false positive):** B has `fuel_estimate_confidence:null` and missing optional
  interval columns but a present `fuel_points` matching A → no throw, no spurious conflict.
- **All-null-overlap (no false negative → `unknown`):** A and B share the robot, all numeric metrics
  (`fuel_points`/`climb_level`/`defense_rating`) are `null` on at least one side so nothing is
  comparable, and no boolean flag diverges → `severity === 'unknown'`, `isConflicted === false`,
  `comparable_metric_count <= 3`. Asserts the false-negative guard from §4.2/§4.3.
- **Fuel comparand pinned:** two reports with identical raw inputs (`auto_fuel`/`teleop_*`/
  `endgame_fuel`) but divergent server `fuel_points` (e.g. 8 vs 16) → conflict fires on
  `fuel_points`, proving `fuel_points` (not the raw inputs) is the comparand. Documents the §4.2
  choice and prevents a silent refactor to raw inputs.
- **Deleted excluded:** a `deleted:true` row never forms/joins a group.
- **Three scouts:** group `reports.length === 3`, spread uses max−min across all three.
- **Threshold constants:** assert `FUEL_MINOR_PTS`/`FUEL_SEVERE_PTS`/`DEFENSE_SEVERE` exported and
  `classifySeverity` honors each branch including `agree` vs `unknown`.

### 7.2 Unit — `src/components/__tests__/ConflictMarker.test.tsx`

- Severe group → `data-severity="severe"`, destructive class present, `AlertTriangle` rendered.
- Minor group → `data-severity="minor"`, warning class.
- Agree group → `data-severity="agree"`, neutral/muted class, no alarm icon.
- Unknown group → `data-severity="unknown"`, muted/dashed class (insufficient-data tone).
- `variant='chip'` shows `2 scouts`; `variant='icon'` shows icon only.
- `formatDivergences` lines appear in the **inline detail** content after clicking/Enter-toggling the
  marker (e.g. text `Fuel: 14 vs 8 pts`) — the detail is an inline expansion, not a floating popover
  (§5); also assert the `title=` attribute carries the summary for the hover path.

### 7.3 Unit — extend `MatchView.test.tsx` / `TeamView.test.tsx` / `ReportDetail.test.tsx`

- **MatchView:** given two conflicting reports on one robot in the selected match, assert
  `getByTestId('match-conflict-{team}-{station}')` visible and the two member tiles (now
  `match-report-{team}-{station}-0` / `-1`) carry the conflict border class. **First update the one
  existing selector at MatchView.test.tsx:229** (`match-report-254-1` → `match-report-254-1-0`) so
  the suite stays green under the disambiguated id.
- **TeamView:** team with one conflicted match → `team-conflict-summary` shows `1 multi-scout
  conflict`; toggling `team-conflicts-only` filters the list to the conflicted row; `team-conflict-
  marker` icon present on it; toggling also collapses any open row (no `team-match-detail`). The
  existing index-based selectors (`team-match-row-0` etc.) remain valid under the reset-on-toggle
  approach (§5) — no edits needed to TeamView.test.tsx:255/299/302.
- **ReportDetail:** passing a conflicted `conflictGroup` renders `report-conflict` banner (with
  `data-scout-id`) + one `report-conflict-sibling-{scout_id}` button per sibling; clicking it fires
  `onOpenSibling` with the sibling row. Passing no group → no banner (back-compat). Passing an
  `agree`/`unknown` group (`isConflicted === false`) → no banner.

### 7.4 Playwright e2e — `tests/e2e/reconciliation.spec.ts`

Single-worker, live remote `2026casnv`. The template to mirror is **`admin.spec.ts`** (which seeds
real `scout` rows), **NOT `dashboard.spec.ts`** (which seeds nothing — citing it was wrong). Reuse
`setActiveEvent` from `tests/e2e/helpers.ts`. Skip if env/migration missing exactly as `admin.spec.ts`
does (`test.skip(!URL || !SECRET, …)` + a `scouter_roster` probe).

**The dropdowns and FKs force real seeding — the sentinel-only approach in the original plan could
not work.** Specifically:
- `match_scouting_report.target_team_number` is `int NOT NULL references team(team_number)`
  (0001_schema.sql:89), so inserting reports for team 9999 raises **23503** unless a `team(9999)`
  row exists first.
- The TeamView `team-select` dropdown is populated from `event_team → team` via `useEventTeams`
  (useEventData.ts:128-147), **not** from reports — so 9999 is never selectable unless an
  `event_team(2026casnv, 9999)` row exists.
- `match_scouting_report.scout_id` is `uuid NOT NULL references scout(id)` (0001_schema.sql:88).
  `scouter_roster` rows are NOT `scout` rows and their ids are invalid `scout_id` FKs — reports must
  reference real `scout.id` UUIDs.

**Setup (`beforeAll`), in FK-safe order:**
```ts
const eventKey = '2026casnv';
const matchKey = `${eventKey}_qm1`;   // qm1 exists on the seeded live event
const team = 9999;                    // sentinel team, cleaned up in afterAll
const station = 2;                     // Blue 2

await setActiveEvent(admin, eventKey);

// 1. team row (FK target for both the report and event_team)
await admin.from('team').upsert({ team_number: team, nickname: 'E2E Sentinel' });
// 2. event_team row so the team is selectable in TeamView's team-select
await admin.from('event_team').upsert({ event_key: eventKey, team_number: team });
// 3. two REAL scout rows (admin.spec.ts:29 pattern) — capture their ids
const scoutIds: string[] = [];
for (let i = 1; i <= 2; i++) {
  const { data, error } = await admin
    .from('scout')
    .insert({ event_key: eventKey, display_name: `E2E Reconcile ${i}`, auth_uid: randomUUID() })
    .select('id').single();
  if (error) throw error;
  scoutIds.push(data.id as string);
}
// 4. two divergent active reports on the SAME robot (Blue 2), distinct scout_id:
//    A {scout_id:scoutIds[0], fuel_points:14, climb_success:true,  climb_level:3, no_show:false}
//    B {scout_id:scoutIds[1], fuel_points:4,  climb_success:false, climb_level:0, no_show:true }
//    (each row also needs event_key, match_key, target_team_number, alliance_color:'blue',
//     station:2, plus NOT-NULL raw fields the schema requires — copy the minimal valid row shape
//     from an existing live report or from mapReport's wire shape.)
const reportIds: string[] = [];
// ...insert both, capturing ids into reportIds...
```

**Scenarios / assertions** (selectors match the disambiguated testids defined in §5):

1. **MatchView conflict chip.**
   - `page.goto('/dashboard')`; open the **Match** tab (`getByRole('tab', { name: 'Match' })`;
     navigation happens through `src/dash/DashboardScreen.tsx`, tab label `Match`).
   - Click the match item for `matchKey`.
   - `expect(page.getByTestId('match-conflict-9999-2')).toBeVisible()`.
   - Marker carries `data-severity="severe"` (no-show + climb disagreement).
   - Both member tiles visible via the **disambiguated** ids:
     `expect(page.getByTestId('match-report-9999-2-0')).toBeVisible()` and `...-1` (the old
     `match-report-9999-2` would resolve to 2 elements and throw under strict mode).

2. **ReportDetail conflict banner + sibling swap.**
   - Click `match-report-9999-2-0` → Sheet opens.
   - `expect(page.getByTestId('report-conflict')).toBeVisible()`.
   - Read the current sibling: `const first = await page.getByTestId('report-conflict')
     .getAttribute('data-scout-id')`.
   - Also capture the `report-flag-no-show` `data-on` value (flips between the two rows).
   - Click the `report-conflict-sibling-{otherScoutId}` button (the sibling whose id ≠ `first`).
   - Assert the swap: `report-conflict`'s `data-scout-id` now ≠ `first`, AND `report-flag-no-show`'s
     `data-on` has flipped. (No `report-fuel` testid exists — do NOT assert on it.)

3. **TeamView conflict marker + filter.**
   - Open the **Team** tab (`getByRole('tab', { name: 'Team' })`); select team `9999` in
     `team-select` (selectable because of the seeded `event_team` row).
   - `expect(page.getByTestId('team-conflict-summary')).toContainText('1 multi-scout conflict')`.
   - Check `team-conflicts-only`; assert the conflicted match row stays, `team-conflict-marker` icon
     is visible, and (because openRow resets on toggle) no `team-match-detail` is open. Uncheck to
     restore the full list.

4. **Cleanup (`afterAll`), in reverse-FK order — the original plan leaked scout/team/event_team rows
   on the shared live DB:**
```ts
await admin.from('match_scouting_report').delete().eq('match_key', matchKey).eq('target_team_number', team);
await admin.from('scout').delete().in('id', scoutIds);
await admin.from('event_team').delete().eq('event_key', eventKey).eq('team_number', team);
await admin.from('team').delete().eq('team_number', team);
```
Leaking the sentinel `team`/`event_team` is especially dangerous: other live specs
(`dashboard.spec.ts`, `simulation.spec.ts`) iterate the event's teams, so a stray 9999 contaminates
them. The four-step teardown above is mandatory.

---

## 8. Conflict surface — overlap with the other 12 features

Files this feature touches and which sibling features also touch them (coordinate / sequence to
avoid merge collisions):

| File | Also touched by | Note |
|------|-----------------|------|
| `src/dash/MatchView.tsx` | **match-video**, **matchup-intelligence**, **auto-path-heatmap** | match-video already lives here (MatchVideoCard); coordinate edits inside `MatchDetail` vs the video card. |
| `src/dash/TeamView.tsx` | **defense-analytics**, **distribution-trend**, **auto-path-heatmap**, **report-correction**, **match-video** | Highest-contention file — TeamView is the deep-dive hub. Land reconcile's match-row marker + toggle as an isolated block near `team-match-list`. |
| `src/dash/ReportDetail.tsx` | **report-correction**, **match-video** | report-correction adds edit/delete actions here; reconcile only adds a top banner + optional props — keep the banner above report-correction's controls. |
| `src/dash/types.ts` | **defense-analytics**, **distribution-trend**, **coverage-gaps**, **report-correction** | Many features append types; reconcile only *appends* (no `MsrRow` edits) so conflicts are trivial. |
| `src/components/ConflictMarker.tsx` *(new)* | **coverage-gaps** (may want a similar marker), **report-correction** | New file — potential reuse target; keep it generic enough that coverage-gaps can pass its own severity. |
| `src/dash/aggregate.ts` | **defense-analytics**, **smart-picklist**, **alliance-simulator**, **scouter-load-accuracy** | reconcile **does not modify** aggregate.ts (deliberately) → zero conflict, but be aware these features mutate it heavily; do not let a rebase pull a reconcile-aggregate change in. |
| `tests/e2e/*.spec.ts` | all e2e-bearing features | New spec file is isolated; but it mutates `2026casnv` under `workers:1` and seeds `scout`/`team`/`event_team`/report rows. It is safe **only** with the four-step FK-safe teardown (§7.4) — leaking a sentinel `team`/`event_team` would contaminate `dashboard.spec.ts`/`simulation.spec.ts`, which iterate the event's teams. |

Lowest-risk landing order relative to siblings: land **report-correction** first if both are in
flight (it owns the heavier ReportDetail/TeamView edits), then layer reconcile's additive blocks on
top. Otherwise reconcile is safe to land independently.

---

## 9. Step-by-step execution checklist

1. **Types:** append `ConflictSeverity`, `ConflictDivergences`, `MultiScoutGroup` to
   `src/dash/types.ts`. Do not touch `MsrRow`.
2. **Core module:** create `src/dash/reconcile.ts` with `reportKey`, `robotKey`, threshold consts,
   `detectMultiScoutReports`, `classifySeverity` (incl. the `unknown` tier — §4.3),
   `formatDivergences`. Document the `fuel_points` comparand choice (§4.2). Keep it pure (no React).
3. **Unit-test the core:** write `src/dash/__tests__/reconcile.test.ts` (§7.1, incl. all-null-overlap
   → `unknown` and the fuel-comparand pin); run `npx vitest run src/dash/__tests__/reconcile.test.ts`
   until green.
4. **Hook:** create `src/dash/useMultiScoutConflicts.ts` memoizing the detector → `{ groups,
   byRobotKey, byReportKey, byTeam, robotKey, reportKey }`.
5. **Component:** create `src/components/ConflictMarker.tsx` (tones for all four tiers, variants,
   `title=` + inline click/Enter-toggled detail, `data-testid="conflict-marker"`/`data-severity`).
   Add `src/components/__tests__/ConflictMarker.test.tsx` (§7.2).
6. **MatchView:** wire the hook in the parent **scoped to `selectedReports`**; pass `byRobotKey` into
   `MatchDetail`; restructure the station-sorted `.map` to interleave the group header (header-once
   per robotKey) + tile tint/border; **disambiguate the tile testid to
   `match-report-${team}-${station}-${i}`**. Update `MatchView.test.tsx:229` to the new id, then add
   the conflict-header assertion.
7. **TeamView:** compute conflicts once via the hook; use `byTeam.get(selected)`; add header summary
   pill, "Show conflicts only" toggle (**reset `openRow` to null on toggle**), per-row icon marker
   (`team-conflict-marker`), empty state. Extend `TeamView.test.tsx` (existing index selectors stay
   valid).
8. **ReportDetail:** add optional `conflictGroup`/`onOpenSibling` props + top banner
   (`report-conflict` with `data-scout-id`, `report-conflict-sibling-{scout_id}` buttons, gated on
   `conflictGroup?.isConflicted`); wire `onOpenSibling={setOpenReport}` and group resolution
   (`byRobotKey`) from both views. Extend `ReportDetail.test.tsx` (no-prop + non-conflicted
   back-compat).
9. **Typecheck + full unit suite:** `npm run typecheck` then `npm test`.
10. **E2E:** create `tests/e2e/reconciliation.spec.ts` (§7.4) **mirroring `admin.spec.ts`** for the
    real-`scout` seeding pattern; seed `team` + `event_team` + two scouts + two reports in FK-safe
    order; run `npx playwright test tests/e2e/reconciliation.spec.ts` against live `2026casnv`;
    confirm the **four-step** FK-safe cleanup in `afterAll` (reports → scouts → event_team → team) so
    no sentinel rows leak onto the shared DB.
11. **No migration / no deploy:** confirm `supabase/migrations/` and `mapReport.ts`/`scoring/*` are
    unchanged in the diff. Nothing to `supabase db push`.
12. **Self-review** against §1 behavior; verify offline path by toggling network in the dev tools
    on `/dashboard` and confirming markers still render from cache.
