# Scouter Load + Accuracy Stats

Workflow / trust feature. Per-scouter match-count **load balancing** view plus an
**agreement-vs-consensus accuracy** signal (computed only where two or more scouts
covered the same robot in the same match) so a lead can spot unreliable scouts.

---

## 1. Overview & exact user-facing behavior

This feature extends the existing **Scouters** dashboard tab (`src/dash/ScoutersTab.tsx`)
in two places:

### 1a. Load summary (event-wide, always visible when an event is set)
A new "Load" summary card at the top of the Scouters tab, above the scouter list. It shows:
- **Total reports** (sum of live reports across all scouters at this event).
- **Active scouters** (count of scouters with `>= 1` report).
- **Mean / Max load** (reports per active scouter), so a lead can see whether work is
  evenly distributed.
- A per-scouter **load bar** in each scouter list row: a small horizontal bar whose width
  is `reportCount / maxLoad`, tinted `warning` when a scouter's load is `>= 1.5×` the mean
  (overloaded) or `text-muted` when `0`. This is a lightweight inline visual; it does not
  replace the existing "{n} reports" count.

### 1b. Accuracy section (per scouter, inside the expanded `ScouterProfile`)
When a scouter row is expanded AND an event is set, a new "Accuracy vs consensus" block
appears **below** the existing reliability flags, but only renders meaningful numbers when
that scouter has `>= 1` *overlap* (a (match, target_team) they scouted that at least one
other scouter also scouted). It shows three agreement percentages:
- **Fuel agreement** — % of this scout's overlapped reports whose `fuel_points` is within
  tolerance of the consensus mean.
- **Climb agreement** — % of overlapped reports whose `(climb_success, climb_level)` equals
  the consensus mode.
- **Defense agreement** — % of overlapped reports whose `defense_rating` is within `±1` of
  the consensus mode.
- An **overall accuracy** chip = mean of the three available signals, rendered as a colored
  badge: green `>= 0.8`, amber `0.6–0.8`, red `< 0.6`.

States:
- **No event set**: the Load card and Accuracy block are hidden; the existing
  `scouters-no-event` notice already covers this.
- **Event set, scouter has 0 overlaps**: Accuracy block renders a muted
  "No overlapping coverage — accuracy needs two scouts on the same robot" message
  (`data-testid="scouter-accuracy-none"`).
- **Event set, 1–2 overlaps**: numbers render but with a **provisional** warning badge
  ("provisional — only N overlaps") because low samples are noisy. Full confidence at
  `>= 3` overlaps.
- **`no_show` / `died` reports** are excluded from the *fuel* and *climb* consensus and
  agreement entirely (ground truth is undefined when one scout says no-show and another
  reports a score). They still count toward load.

Nothing about capture, sync, or scoring changes; this is a **read-only display feature**
computed client-side from already-fetched reports.

---

## 2. Data model

**No migration is needed.** Every field required already exists on `MsrRow`
(`src/dash/types.ts`) and is delivered by `useEventReports` via `select('*')`:
`scout_id`, `match_key`, `target_team_number`, `fuel_points`, `climb_level`,
`climb_success`, `defense_rating`, `no_show`, `died`, `tipped`, `deleted`,
`fuel_estimate_confidence`. The latest deployed migration is **0032**; this feature adds
**no** `supabase/migrations/0033*` file and requires **no** `db push` / `functions deploy`.
`mapReport.ts` and the `upsert_match_report` RPC are **not touched** (no wire-shape change),
so the single-source-of-truth invariant is preserved trivially.

---

## 3. Files to create / modify

| Path | Precise change |
| --- | --- |
| `src/dash/aggregate.ts` | Add exported types `ScouterLoadAgg`, `ScouterAccuracyAgg`, `EventScouterStats`. Add pure fns `aggregateScouterLoad(reports: MsrRow[]): EventScouterStats` and `aggregateScouterAccuracy(reports: MsrRow[]): Map<string, ScouterAccuracyAgg>`. Add internal helpers `buildOverlapIndex`, `mode`, and accuracy tolerance constants. No change to existing `aggregateTeam`/`aggregateEvent`. |
| `src/dash/ScoutersTab.tsx` | (a) Add a `useMemo` computing `scouterLoad` (from `aggregateScouterLoad(reports)`) and `accuracyByScout` (from `aggregateScouterAccuracy(reports)`), both gated on `eventKey != null`. (b) Render a new `ScouterLoadCard` above the scouter list. (c) Add an inline load bar to each list row. (d) Pass the merged scouter's `scoutIds` + `accuracyByScout` into `ScouterProfile`, and render a new `ScouterAccuracy` sub-component below the reliability-flags block. |
| `src/dash/__tests__/scouterAccuracy.test.ts` | **New.** Unit tests for `aggregateScouterLoad` and `aggregateScouterAccuracy` (overlap detection, consensus, tolerances, thresholds, edge cases). |
| `tests/e2e/scouter-load-accuracy.spec.ts` | **New.** Playwright e2e against the live `2026casnv` event. Imports `setActiveEvent` from `tests/e2e/helpers.ts` and uses the service-role admin client (as `dashboard.spec.ts` does) to (1) manage the shared `is_active` singleton and (2) **seed a deterministic scout overlap** (a 2nd report for an already-scouted (match,team) under a different scout_id), since the demo event has zero overlaps. Cleans up + restores `2026casnv` in `afterAll`. Verifies the Load card, real accuracy numbers on the seeded overlap, graceful degradation, and the no-event hidden state. |

Read-only dependencies the e2e relies on (not edited): `tests/e2e/helpers.ts`
(`setActiveEvent`), `src/components/ui/IconTabs.tsx` (role=tab + visible label →
accessible name), `src/dash/DashboardScreen.tsx` (`?tab=scouters` routing), and
`supabase/functions/seed-demo/index.ts` (confirms demo's one-report-per-(match,team)
shape → zero overlaps).

The accuracy constants and tolerances are also factored into `aggregate.ts` (not a new
file) to keep the single aggregation module authoritative.

---

## 4. Core logic — exact formulas / algorithms

All logic is **pure** and lives in `src/dash/aggregate.ts`. It reuses the existing
deleted-row exclusion convention (`useEventReports` already filters `deleted=false`, but
the aggregate also self-guards `r.deleted === true` like `aggregateEvent` does).

### 4a. Types

```ts
export interface ScouterLoadAgg {
  scoutId: string;
  reportCount: number;   // live reports authored by this scout_id
  matches: number;       // distinct match_key
  teams: number;         // distinct target_team_number
}

export interface EventScouterStats {
  byScout: Map<string, ScouterLoadAgg>;
  totalReports: number;
  activeScouts: number;  // scouts with reportCount >= 1
  meanLoad: number;      // totalReports / activeScouts (0 when none)
  maxLoad: number;       // max reportCount across scouts (0 when none)
}

export interface ScouterAccuracyAgg {
  scoutId: string;
  overlaps: number;          // # of this scout's reports that share (match,team) with >=1 other scout
  // RAW counters — exposed so the UI can SUM across the multiple scout_ids that
  // map to one display name and then divide, rather than (incorrectly) averaging
  // two pre-divided rates. (review: med — re-deriving a summed rate from two rates
  // is impossible without the counts.)
  fuelAgree: number;   fuelElig: number;
  climbAgree: number;  climbElig: number;
  defenseAgree: number; defenseElig: number;
  // Convenience rates for the single-scout_id case (UI may use these directly
  // when a name has exactly one scout_id). null when the matching *Elig is 0.
  fuelAgreeRate: number | null;
  climbAgreeRate: number | null;
  defenseAgreeRate: number | null;
  overallAgreeRate: number | null;  // mean of the non-null signal rates
  provisional: boolean;             // overlaps < ACCURACY_MIN_OVERLAPS
}
```

The raw counters are the source of truth; the `*Rate` fields are derived
(`agree/elig`, or `null` when `elig === 0`). A pure helper `mergeAccuracy(aggs:
ScouterAccuracyAgg[]): ScouterAccuracyAgg | null` (also exported from
`aggregate.ts`) sums the six counters plus `overlaps` across a name's scout_ids
and re-derives the rates from the summed counts — this is what the UI calls so
multi-`scout_id` names are exact, not fake-averaged.

### 4b. `aggregateScouterLoad` — O(n)

```
for each report r (skip r.deleted === true, skip r.scout_id == null):
  agg = byScout.get(r.scout_id) || {scoutId, reportCount:0, matchSet:Set, teamSet:Set}
  agg.reportCount += 1
  agg.matchSet.add(r.match_key)
  agg.teamSet.add(r.target_team_number)
finalize: matches = matchSet.size, teams = teamSet.size
totalReports = sum reportCount
activeScouts = count(reportCount >= 1)
meanLoad = activeScouts ? totalReports / activeScouts : 0
maxLoad  = max reportCount (0 if none)
```

### 4c. `aggregateScouterAccuracy` — O(n) build + O(Σ group²) compare

Performance: group with a **single Map** keyed by `` `${match_key}::${target_team_number}` ``
(avoids O(n²) pairwise scanning of the full report list). Overlap groups are tiny (FRC
robots are scouted by at most a handful of scouts), so the inner compare is effectively O(n).

```
1. buildOverlapIndex(reports):
     Map<groupKey, MsrRow[]>  // skip deleted; keep ALL (no_show/died included here)
2. For each group with length >= 2 (an overlap):
     // Consensus is computed over the OTHER scouts only? No — over the FULL group
     // (including this scout) to keep it deterministic and order-independent.
     // Eligibility: fuel/climb consensus excludes no_show||died reports.
     scored = group.filter(r => !r.no_show && !r.died)
     fuelConsensus   = mean(scored.fuel_points)                    // null if scored empty
     climbConsensus  = mode(scored.map(r => `${r.climb_success?1:0}:${r.climb_level}`))
     defenseConsensus= mode(group.map(r => r.defense_rating))      // defense always rated
     for each report r in group (attribute to r.scout_id):
        register that r.scout_id has an overlap (overlaps += 1)
        // fuel
        if !(r.no_show||r.died) && fuelConsensus != null:
           agree if |r.fuel_points - fuelConsensus| <= max(FUEL_ABS_TOL, FUEL_REL_TOL*fuelConsensus)
        // climb
        if !(r.no_show||r.died) && climbConsensus != null:
           agree if `${r.climb_success?1:0}:${r.climb_level}` === climbConsensus
        // defense
        if defenseConsensus != null:
           agree if |r.defense_rating - defenseConsensus| <= DEFENSE_TOL
3. Per scout: accumulate the raw `{fuelAgree,fuelElig,climbAgree,climbElig,
   defenseAgree,defenseElig,overlaps}` counters. Finalize each rate =
   agree/elig (null if elig==0). overallAgreeRate = mean of the non-null signal
   rates (null if all null). provisional = overlaps < ACCURACY_MIN_OVERLAPS.
```

`mergeAccuracy([...])` (for a name with multiple scout_ids) sums all six counters
+ overlaps, then finalizes rates from the summed counters using the identical
agree/elig formula — never averages two rates.

### 4d. Constants (exported from `aggregate.ts`)

```
ACCURACY_MIN_OVERLAPS = 3      // below this, mark provisional
FUEL_ABS_TOL          = 5      // fuel_points absolute floor
FUEL_REL_TOL          = 0.10   // 10% of consensus mean
DEFENSE_TOL           = 1      // defense_rating ordinal 0..3, within ±1 agrees
```

> `defense_rating` domain is **0|1|2|3** — verified in
> `src/capture/useCaptureSession.ts` (`defenseRating: 0 | 1 | 2 | 3`) and
> seed-demo clamps to `0..3`. A value of 5 cannot occur in real or demo data, so
> all fixtures/consensus examples below stay in 0..3. (review: med fix.)

`mode(values)`: returns the most frequent value; ties broken by the **smallest** value
(deterministic). Returns `null` for an empty input.

### 4e. Consistency with mapReport / scoring
Not touched. This module only **reads** `MsrRow` fields the server already populates; it
computes no score that needs to match the RPC. The frozen `SCORING` magnitudes are not used
here (agreement is about scout-to-scout consistency, not points), so there is no duplication
risk with the server recompute.

---

## 5. UI / UX

All changes are inside the **Dashboard → Scouters** tab. No new route, no router change, so
the shared `RouteError` boundary continues to cover it.

### 5a. `ScouterLoadCard` (new component in `ScoutersTab.tsx`)
Rendered between the add-scouter form and the scouter list, only when `eventKey != null` and
not `eventLoading`. Uses the existing `Card` / `StatTile` primitives:
- `data-testid="scouter-load-card"`
- StatTiles: `Total reports`, `Active scouters`, `Mean / scout` (`fmt(meanLoad)`),
  `Max / scout`.
- Icons reuse `ClipboardList`, `Users` (already imported); add `Gauge` and `Target` from
  `lucide-react`.

### 5b. Inline load bar (in each `roster-list` row)
Inside the existing scouter list `<li>`, under the name/report-count button, render a thin
bar `data-testid={`scouter-load-bar-${u.name}`}` with inline `width: ${pct}%` where
`pct = maxLoad ? 100 * reportCount / maxLoad : 0`. Tint: `bg-warning/60` if
`reportCount >= 1.5 * meanLoad && meanLoad > 0`, else `bg-brand/50`. Only when `eventKey`.

### 5c. `ScouterAccuracy` (new sub-component in `ScoutersTab.tsx`)
Rendered inside `ScouterProfile`, after the `scouter-flags` block. Receives a single
already-merged `ScouterAccuracyAgg | null` for the selected scouter. The call site
(in `ScoutersTab`) computes it as
`mergeAccuracy(selectedEntry.scoutIds.map((id) => accuracyByScout.get(id)).filter(Boolean))`
so a name mapping to multiple `scout_id`s sums the raw counters and re-derives rates
exactly (never averages two rates). `mergeAccuracy([])` / all-missing → `null`.
- Wrapper `data-testid="scouter-accuracy"`.
- When `agg == null || agg.overlaps === 0`: render
  `data-testid="scouter-accuracy-none"` muted message.
- Else: three labeled percentages
  (`data-testid="scouter-accuracy-fuel|climb|defense"`), an overall badge
  `data-testid="scouter-accuracy-overall"` colored by threshold, and a
  `data-testid="scouter-accuracy-provisional"` warning chip when `agg.provisional`.
- Each `null` signal rate shows `—`.

Compute `scouterLoad` and `accuracyByScout` once with `useMemo([reports])` near the existing
`countByScout` memo, so the O(n) work runs once per fetch, not per render.

---

## 6. Offline behavior

- `useEventReports` is a TanStack Query whose cache is persisted to IndexedDB
  (`PersistQueryClientProvider` in `App.tsx`). On an offline reload the last fetched reports
  rehydrate, so the Load card and Accuracy block compute from cached data with **zero
  network**. All math is pure/synchronous — no fetch of its own.
- When `eventKey == null` (no active event), both new sections are hidden and the existing
  `scouters-no-event` notice shows. No throw, no blank screen.
- When reports are still loading (`eventLoading`), the existing `scouter-loading` indicator
  shows and the new cards are not rendered yet.
- A scout with zero overlaps gets the graceful `scouter-accuracy-none` message rather than
  `NaN`/blank — degradation is explicit.

---

## 7. Test plan

### 7a. Unit — `src/dash/__tests__/scouterAccuracy.test.ts`
Build minimal `MsrRow` fixtures with a small factory (only the fields the fns read).

`aggregateScouterLoad`:
1. Counts reports, distinct matches, distinct teams per `scout_id`.
2. Excludes `deleted === true` rows and `scout_id == null` rows.
3. `meanLoad`/`maxLoad`/`activeScouts` correct; empty input → all zeros, no `NaN`.

`aggregateScouterAccuracy`:
4. **Overlap detection**: two scouts on same (match, team) → both get `overlaps = 1`; a
   solo (match, team) contributes `0` overlaps.
5. **Fuel agreement**: consensus mean; a scout within `max(5, 10%)` agrees, one outside
   disagrees → correct `fuelAgreeRate`.
6. **Climb mode**: 3 scouts, two say `(success,L2)`, one says `(fail,L0)` → consensus is
   `1:2`; the two agree, the third disagrees.
7. **Defense ±1**: five overlapping reports with ratings `0,1,1,2,3` → consensus
   mode `1` (1 occurs twice). Ratings `0,1,1,2` agree (within ±1 of 1); the `3`
   disagrees (distance 2). All values are in the real 0..3 domain.
8. **Provisional flag**: `overlaps < 3` → `provisional === true`; `>= 3` → `false`.
9. **no_show/died exclusion**: a no-show report is excluded from fuel/climb eligibility
   (its rates `null` if it's the scout's only overlap) but still counts in defense consensus
   only if rated; ground-truth-undefined case does not throw.
10. **Tie-break**: `mode` ties resolve to the smallest value (deterministic).
11. **All-null signals** (single eligible field everywhere null) → `overallAgreeRate === null`.
12. **`mergeAccuracy`**: two aggs for the same name (e.g. fuel 1/2 and 2/3) → merged
    `fuelAgreeRate === 3/5` (summed counters, NOT the average of 0.5 and 0.667). `mergeAccuracy([])`
    → `null`. overlaps sum correctly; a merged result with overlaps `>= 3` is non-provisional.

> Note: the **provisional vs full-confidence** branch (step 8) and any agreement
> *number* is reachable only in these unit tests. The demo event (`2026demo`) seeds
> exactly one report per (match, target_team) — see seed-demo `for (const seat of seats)`
> with a single round-robin `scoutId` — so it has **zero scout overlaps**. The e2e
> therefore cannot reach `overlaps >= 1` from demo data alone; it must seed overlaps
> explicitly (§7b) or assert only the graceful-degradation path.

### 7b. Playwright e2e — `tests/e2e/scouter-load-accuracy.spec.ts`
Single-worker (project config already `workers: 1`). The suite shares one live remote DB
and the **global `event.is_active` singleton** (CLAUDE.md), so this spec manages activation
**explicitly** with the service-role admin client and **restores it in `afterAll`** to avoid
stomping sibling specs (mirror `tests/e2e/dashboard.spec.ts` setup + `tests/e2e/helpers.ts`
`setActiveEvent`).

Setup mirrors `dashboard.spec.ts`:
- `loadEnv({ path: '.env.local' })`; build `admin = createClient(URL, SECRET, …)`;
  `test.skip(!URL || !SECRET, …)` and the `scouter_roster` probe skip.
- `beforeAll`: nothing global; each scenario sets its own activation state.
- `afterAll`: clean up the seeded overlap rows (delete by the synthetic `id`s we inserted)
  and restore the original active event to `2026casnv` via `setActiveEvent(admin, '2026casnv')`
  so the shared singleton is left in the state sibling specs expect.

> **Demo has zero overlaps.** `2026demo` seeds exactly one `match_scouting_report` per
> (match_key, target_team_number). To exercise real accuracy numbers the e2e must INSERT a
> second report for an already-scouted (event_key, match_key, target_team_number) under a
> different `scout_id`. We do NOT claim demo overlaps exist. (review: high fix (a).)

**Tab navigation** is state-driven via `IconTabs` (role=tab buttons with visible labels),
not per-tab routing. Two equivalent, verified ways to reach the tab:
- `await page.goto('/dashboard?tab=scouters')` (DashboardScreen `initialTab()` resolves
  `?tab=scouters`), or
- `await page.getByRole('tab', { name: 'Scouters' }).click()` (IconTabs renders the label
  text alongside the icon → accessible name `Scouters`; same precedent as dashboard.spec.ts
  `getByRole('tab', { name: 'Next Match' })`).
Use `page.goto('/dashboard?tab=scouters')` as the primary selector (no demo-toggle UI needed).

Scenario A — Load card renders (uses the existing `2026casnv` data, which has real reports):
- `await setActiveEvent(admin, '2026casnv')`.
- `await page.goto('/dashboard?tab=scouters')`; `await expect(page.getByTestId('dash-scouters')).toBeVisible()`.
- `await expect(page.getByTestId('scouter-load-card')).toBeVisible({ timeout: 15_000 })`.
- Assert the `Total reports` StatTile shows a numeric value `> 0` (parse the rendered number).

Scenario B — Accuracy renders REAL numbers on a seeded overlap:
- Pick one already-played report from `2026casnv`: `const base = (await admin.from('match_scouting_report')
  .select('*').eq('event_key','2026casnv').eq('deleted', false).limit(1).single()).data`
  (`select('*')` so we can clone it and satisfy all NOT NULL columns without guessing the schema).
- Find a SECOND, different `scout_id` at the event (query `scout` for another `id`, distinct
  from `base.scout_id`). Build the insert as `{ ...base }` with: a fresh `id` (uuid we keep for
  cleanup), `scout_id` = the second scout, `deleted: false`, and deliberately divergent
  `fuel_points`/`climb_*`/`defense_rating` so consensus + agreement are non-trivial. Drop any
  DB-generated columns from the clone (`created_at`/`updated_at` — let defaults apply). Record
  the inserted `id` for `afterAll` cleanup (`admin.from('match_scouting_report').delete().eq('id', id)`).
  - Note: the live unique index `idx_msr_match_scout_active` is per (match, **scout**), so two
    DIFFERENT scout_ids on the same (match, team) is allowed — this is exactly the overlap case.
- `await page.goto('/dashboard?tab=scouters')`; open the overlapped scouter row via
  `page.getByTestId('scouter-open-<name>')` (resolve `<name>` from the scout's display_name),
  wait for `scouter-profile`.
- `await expect(page.getByTestId('scouter-accuracy')).toBeVisible()`.
- `await expect(page.getByTestId('scouter-accuracy-overall')).toBeVisible()` and assert its
  text matches a `%`. (Because we seeded the overlap, this is the real-number path — not the
  degraded one.) The provisional chip MAY be present (only ~1 overlap), which is fine.

Scenario C — Graceful degradation with no overlaps:
- Without seeding (or on a scouter with no overlap), open a scouter row and assert EITHER
  `scouter-accuracy-overall` OR `scouter-accuracy-none` is visible — the section degrades,
  never blanks. (Covers the empty path on real, non-seeded data.)

Scenario D — No active event (managed singleton, not a fresh-state assumption):
- `await admin.from('event').update({ is_active: false }).neq('event_key', '__none__')`
  (clear ALL active flags). This is the only race-safe way to reach a no-event state on the
  shared single-worker DB; `afterAll` restores `2026casnv`.
- `await page.goto('/dashboard?tab=scouters')`.
- `await expect(page.getByTestId('scouters-no-event')).toBeVisible()`.
- `await expect(page.getByTestId('scouter-load-card')).toHaveCount(0)`.

Run: `npx playwright test tests/e2e/scouter-load-accuracy.spec.ts`.

---

## 8. Conflict surface (other features touching the same files)

`aggregate.ts` and `ScoutersTab.tsx` are the touched files. Among the 13 features, expect
merge conflicts / coordination with:

| Feature | Shared file | Nature of conflict |
| --- | --- | --- |
| **multi-scout-reconciliation** | `aggregate.ts`, `ScoutersTab.tsx` | **HIGH.** Also detects (match, team) multi-scout overlaps and consensus. This feature defines `buildOverlapIndex` + `mode` ONCE; reconciliation must **import** them, not re-declare, and must agree on the consensus definition. **Sequencing requirement:** the orchestrator MUST run reconciliation AFTER this feature lands, not in the same parallel batch — otherwise both declare `buildOverlapIndex`/`mode` and will both conflict AND diverge. |
| **defense-analytics** | `aggregate.ts` | MEDIUM. Adds defense aggregation fns to the same module; only import/section conflicts, no logic overlap. Append, don't reorder. |
| **distribution-trend** | `aggregate.ts` | MEDIUM. Likely adds per-team distribution helpers in the same file. Append-only to minimize conflicts. |
| **coverage-gaps** | `aggregate.ts`, `ScoutersTab.tsx` | MEDIUM. Coverage-gap (which matches/teams are unscouted) overlaps the *load* concept; keep `aggregateScouterLoad` focused on per-scout counts and let coverage-gaps own the schedule-vs-scouted diff. |
| **report-correction** | `ScoutersTab.tsx` (via `ReportDetail`) | LOW. Editing a report from the detail sheet; no direct overlap with the new memos. |
| smart-picklist / alliance-simulator / matchup-intelligence / dashboard-heartbeat / auto-path-heatmap / match-video / export-presets | — | LOW/NONE. Different tabs/modules (`predict.ts`, `PicklistView`, `MatchView`, etc.). |

Mitigation: keep all new logic **appended** at the end of `aggregate.ts`, export shared
helpers (`buildOverlapIndex`, `mode`) so reconciliation/defense-analytics reuse rather than
re-declare them, and confine `ScoutersTab.tsx` edits to the new memos + two new
sub-components.

---

## 9. Step-by-step execution checklist

1. **`aggregate.ts` — types & constants.** Append `ScouterLoadAgg`, `EventScouterStats`,
   `ScouterAccuracyAgg`, and the `ACCURACY_MIN_OVERLAPS / FUEL_ABS_TOL / FUEL_REL_TOL /
   DEFENSE_TOL` constants. Export all.
2. **`aggregate.ts` — helpers.** Add exported `mode<T>(values: T[]): T | null` (smallest-on-tie)
   and exported `buildOverlapIndex(reports: MsrRow[]): Map<string, MsrRow[]>`
   (`` `${match_key}::${target_team_number}` ``, skip `deleted`).
3. **`aggregate.ts` — `aggregateScouterLoad`.** Implement per §4b (O(n), Set-based distinct
   counts, no `NaN` on empty).
4. **`aggregate.ts` — `aggregateScouterAccuracy` + `mergeAccuracy`.** Implement
   `aggregateScouterAccuracy` per §4c. Per scout, accumulate the raw
   `{fuelAgree, fuelElig, climbAgree, climbElig, defenseAgree, defenseElig, overlaps}`
   counters, then finalize the derived rates. Return `Map<scout_id, ScouterAccuracyAgg>`
   with the raw counters exposed (per §4a). Also add and export
   `mergeAccuracy(aggs: ScouterAccuracyAgg[]): ScouterAccuracyAgg | null` that sums the
   six counters + overlaps and re-derives rates (returns `null` for `[]`). The UI maps a
   scouter name → its `scoutIds` and calls `mergeAccuracy` when a name has multiple ids.
5. **Unit tests.** Write `src/dash/__tests__/scouterAccuracy.test.ts` per §7a;
   `npx vitest run src/dash/__tests__/scouterAccuracy.test.ts` until green.
6. **`ScoutersTab.tsx` — memos.** Next to `countByScout`, add
   `const scouterStats = useMemo(() => eventKey ? aggregateScouterLoad(reports) : null, [eventKey, reports])`
   and `const accuracyByScout = useMemo(() => eventKey ? aggregateScouterAccuracy(reports) : new Map(), [eventKey, reports])`.
7. **`ScoutersTab.tsx` — `ScouterLoadCard`.** Add the component and render it gated on
   `eventKey && !eventLoading` with the four StatTiles (§5a). Import `Gauge`, `Target`.
8. **`ScoutersTab.tsx` — load bar.** Add the inline bar to each list row (§5b).
9. **`ScoutersTab.tsx` — `ScouterAccuracy`.** Add the sub-component (§5c); in `ScouterProfile`
   accept a new `accuracy: ScouterAccuracyAgg | null` prop and render it after
   `scouter-flags`. At the call site, derive the per-name agg via
   `mergeAccuracy(selectedEntry.scoutIds.map((id) => accuracyByScout.get(id)).filter(Boolean))`
   — `mergeAccuracy` (added in step 4) sums the raw counters across the name's
   scout_ids and re-derives rates, so multi-`scout_id` names are exact.
10. **`npm run typecheck`** and **`npx vitest run src/dash`** — fix until green.
11. **Playwright.** Write `tests/e2e/scouter-load-accuracy.spec.ts` per §7b;
    `npx playwright test tests/e2e/scouter-load-accuracy.spec.ts`.
12. **No backend deploy.** Confirm no file was added under `supabase/migrations/`. Do **not**
    run `supabase db push` / `functions deploy`; do **not** touch `mapReport.ts`. Frontend
    ships via Vercel on merge to `main`.
