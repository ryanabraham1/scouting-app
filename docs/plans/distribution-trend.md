# Distribution (variance) + recent-form trend

Feature: add per-team **distribution** (std-dev, floor/ceiling range) and a
**last-3-matches form trend** (improving / stable / fading) to the dashboard
aggregates, surfaced in **TeamView** and **RankingView**. Purely client-side,
display-only computation over data already read into the dashboard.

---

## 1. Overview & exact user-facing behavior

Today every TeamAgg field is a mean. A team that puts up `{40, 30, 20}` fuel
points and a team that puts up `{31, 30, 29}` both read "30.0" — the dashboard
gives no sense of consistency. This feature adds variance and recent-form so the
lead can distinguish a steady robot from a coin-flip robot.

**TeamView (Team tab):**

1. A new **Distribution** card (inserted after the existing
   "Climb · Defense · Reliability" card, before the Trends card) with three stat
   cells — Fuel points, Climb points, Defense rating — each showing
   `mean ± stdDev` as the value and `min – max` (floor–ceiling) as the hint.
   Example: value `30.0 ± 8.2`, hint `range 20 – 40 · n=3`.
2. A new **Recent Form** card (in the same Distribution card, as a 4th cell or a
   small banner) showing the last-3-matches trend for fuel points:
   - **Improving** — green (`tone="success"`), text `Improving +6.3` (delta of
     last-3 mean vs all-match mean), up-arrow icon.
   - **Fading** — amber (`tone="warning"`), text `Fading −5.1`, down-arrow icon.
   - **Stable** — neutral (`tone="default"`), text `Stable`, no arrow.
   - **Low data** — when `< 3` matches scouted, text `— (need 3 matches)`,
     `tone="default"`, no delta.
3. The existing **Fuel** card "Mean fuel points (raw)" cell gains a `± stdDev`
   suffix in its hint (non-breaking, additive) so variance is visible without
   leaving the fuel context.

**RankingView (Ranking tab):**

1. Four new **compare-panel rows** (only the multi-select compare table, NOT the
   main sortable table, to avoid column bloat on mobile):
   - `Fuel σ` — fuel-points std-dev, `better: 'lower'` (more consistent wins).
   - `Climb σ` — climb-points std-dev, `better: 'lower'`.
   - `Defense σ` — defense-rating std-dev, `better: 'lower'`.
   - `Recent Form` — text label (`Improving`/`Stable`/`Fading`/`—`). **No winner
     flagging** (review med-2): its `value()` returns `null` for every team so no
     cell is ever highlighted best. Rationale: the winner-flag logic
     (RankingView.tsx lines 481-495) greens every cell equal to the max, so a
     `stable` team (proxy 0) would be flagged "winner" over a `fading` team
     (−1), and two `improving` teams would both green — misleading on a text
     label. The label is informative on its own; ordinal "best" is meaningless
     across improving/stable/fading. `get()` still renders the label.
2. No new columns are added to the main sortable rankings table (keeps the
   8-column table unchanged; mobile already hides EPA/TBA columns).

All values degrade to `—` when not finite or when `matchesScouted < 1`.

---

## 2. Data model — NO MIGRATION NEEDED

**No migration is required.** Every input is already present in `MsrRow[]` read
by `useEventReports`:

- `fuel_points`, `defense_rating` — raw per-match scalars.
- Climb points per match are derived from `climb_success` + `climb_level` +
  `auto_climb_level1` via the existing `climbPointsForMatch(r)` helper in
  `aggregate.ts`.
- Chronological order for the last-3 slice comes from `compareMatchKeys`
  (`src/lib/formatMatch.ts`), already used by `TeamTrends`.

Variance and trend are **derived statistics**, not stored. The wire shape
(`mapReport.ts`) is unchanged — no new fields flow client→server. The server RPC
`upsert_match_report` is unchanged. The scoring model (`src/scoring/`) is
unchanged. **DO NOT create migration 0033 for this feature; DO NOT mark anything
deployed.**

---

## 3. Files to create/modify

| Path | Precise change |
| --- | --- |
| `src/dash/aggregate.ts` | Extend the `TeamAgg` interface with 11 fields (below). Add a `stdDev(values, mean)` population-variance helper and a `recentTrend(values)` helper. In `aggregateTeam`, collect three per-match value arrays (`fuelPts`, `climbPts`, `defense`) during the existing single loop, then compute std-dev/min/max + the last-3 fuel trend after the loop. Sort the reports by `compareMatchKeys` for the trend slice. |
| `src/dash/aggregate.ts` constants | Add `export const TREND_WINDOW = 3;` and `export const TREND_STABLE_THRESHOLD = 0.5;` (points). |
| `src/dash/TeamView.tsx` | Add a `fmtPM(mean, sd)` helper (`30.0 ± 8.2`, em-dash when not finite). Add a **Distribution** card (Fuel / Climb / Defense σ stats + Recent Form cell) after the "Climb · Defense · Reliability" card in `TeamDetail`. Append `± σ` to the existing "Mean fuel points (raw)" hint. Import `TrendingUp`/`TrendingDown`/`Minus` icons (TrendingUp already imported; add `TrendingDown`, `Minus`). |
| `src/dash/RankingView.tsx` | Use the existing `fmt` for σ formatting; extend `COMPARE_ROWS` with the four new rows described in §1 (three σ rows + a no-winner `Recent Form` row, `value: () => null`). Add a `trendLabel(agg)` local helper returning the display string (reusing the existing `EM_DASH` for insufficient). No `SortKey`/main-table changes. |
| `src/dash/__tests__/aggregate.test.ts` | Add `describe('distribution + trend')` unit tests (see §7). |
| `src/dash/__tests__/RankingView.test.tsx` | Add a compare-panel test asserting the new σ + Recent Form rows render with correct winners. |
| `src/dash/__tests__/TeamView.test.tsx` | Add a test asserting the Distribution card + Recent Form cell render with the right testids/tones. |
| `tests/e2e/distribution-trend.spec.ts` | **New** Playwright spec (see §7). |

No new non-test source files.

**Verified dependencies NOT modified** (the e2e relies on them; do not change):

- `src/dash/DashboardScreen.tsx` — provides the `dashboard` testid and the
  `Team` / `Ranking` tab roles the e2e navigates by (verified present:
  `getByTestId('dashboard')` target + tab labels). No change; just a runtime
  dependency of §7.3.
- `mapReport.ts`, `src/scoring/*`, `supabase/migrations/*` — explicitly untouched
  (no wire-shape change, no scoring change, NO migration 0033). All new fields are
  derived display stats over data already in `MsrRow`.

---

## 4. Core logic — exact formulas

### 4.1 `TeamAgg` additions (`aggregate.ts`)

```ts
export type TrendDirection = 'improving' | 'stable' | 'fading' | 'insufficient';

export interface TeamAgg {
  // ... existing fields ...

  /** population std-dev of per-match fuel_points (0 when n<2). */
  stdDevFuelPoints: number;
  minFuelPoints: number;
  maxFuelPoints: number;

  /** population std-dev of per-match climb points (climbPointsForMatch). */
  stdDevClimbPoints: number;
  minClimbPoints: number;
  maxClimbPoints: number;

  /** population std-dev of per-match defense_rating. */
  stdDevDefenseRating: number;
  minDefenseRating: number;
  maxDefenseRating: number;

  /** mean fuel_points over the last min(3, n) matches, chronological. */
  recentFuelMean: number;
  /** recentFuelMean - meanFuelPoints (signed; 0 when n<TREND_WINDOW). */
  recentFuelDelta: number;
  /** direction bucket derived from recentFuelDelta + threshold. */
  recentTrend: TrendDirection;
}
```

### 4.2 Std-dev (population variance, single pass over collected arrays)

Use **population** variance (`/n`, not `/(n-1)`) — these are display statistics
over a complete observed set, and `n=1` must yield `0`, not `NaN`. Compute after
the existing loop from arrays collected during it:

```ts
function stdDev(values: number[], mean: number): number {
  const n = values.length;
  if (n < 2) return 0; // single observation (or empty) has zero spread
  let sumSq = 0;
  for (const v of values) {
    const d = v - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}
// Defensive (review low-4): never surface ±Infinity from an empty array.
function safeMin(values: number[]): number {
  return values.length ? Math.min(...values) : 0;
}
function safeMax(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}
```

`min`/`max` go through `safeMin`/`safeMax`. The caller guarantee
(`reports.length >= 1`, enforced by `aggregateEvent`'s grouping — a team key only
exists because it has >= 1 report) means the arrays are non-empty in practice, so
this is purely defensive: a future caller that passes `[]` gets `0` instead of
`Math.min()===Infinity` / `Math.max()===-Infinity` leaking into the UI. `stdDev`
already returns `0` for `n<2` (covers the empty case too). The caller-guarantee is
also asserted in a unit test (§7.1 #2 covers `n=1`; add an explicit comment that
`aggregateTeam` is never reached with `[]`).

Implementation note: extend the existing single `for (const r of reports)` loop
in `aggregateTeam` to also `fuelPts.push(r.fuel_points)`,
`climbPts.push(climbPointsForMatch(r))`, `defense.push(r.defense_rating)`. This
keeps it one pass over `reports` for the sums; the std-dev pass is a second cheap
pass over the small arrays.

### 4.3 Recent-form trend

The chronological order: the input `reports` are NOT guaranteed sorted, so sort a
copy by `compareMatchKeys(a.match_key, b.match_key)` once, take the last
`TREND_WINDOW` (3) `fuel_points`, mean them, compare to the all-match mean.

```ts
function recentTrend(
  sortedFuelPts: number[],
  overallMean: number,
): { mean: number; delta: number; dir: TrendDirection } {
  const n = sortedFuelPts.length;
  if (n < TREND_WINDOW) {
    return { mean: NaN, delta: 0, dir: 'insufficient' };
  }
  const window = sortedFuelPts.slice(n - TREND_WINDOW);
  const mean = window.reduce((a, b) => a + b, 0) / TREND_WINDOW;
  const delta = mean - overallMean;
  let dir: TrendDirection = 'stable';
  if (delta > TREND_STABLE_THRESHOLD) dir = 'improving';
  else if (delta < -TREND_STABLE_THRESHOLD) dir = 'fading';
  return { mean, delta, dir };
}
```

Rationale for "last-3 vs all-match mean" (not first-N or regression): matches the
research recommendation; cheap; the all-match mean is a stable baseline so the
delta directly answers "is the team currently above or below its season-long
average". `TREND_STABLE_THRESHOLD = 0.5` points keeps single-fuel jitter from
flipping the label.

For climb/defense we expose σ + range only (no separate trend) to keep the UI
focused; fuel is the single trended metric (it dominates `scoutingExpectedPoints`
and is what the existing Trends bar chart already plots).

### 4.4 Consistency with mapReport / scoring

Neither is touched. `aggregate.ts` continues to consume frozen `SCORING`
magnitudes through `climbPointsForMatch` and never re-implements scoring. The
`aggregateTeam` pure `(teamNumber, reports) -> TeamAgg` contract is preserved
(only the output type widens — additive, backward-compatible for all existing
callers).

### 4.5 NaN / offline guarding

- `stdDev` returns `0` (not `NaN`) for `n < 2`.
- `recentFuelMean` is `NaN` when `dir === 'insufficient'`; UI renders `—`.
- All UI formatters (`fmt`, new `fmtPM`) already em-dash non-finite input.

---

## 5. UI/UX

### 5.1 TeamView Distribution card

Insert into `TeamDetail` (TeamView.tsx) immediately **after** the
"Climb · Defense · Reliability" `<Card>` (currently ends ~line 718) and
**before** `<TeamTrends matches={matches} />`:

```tsx
{/* Distribution & recent form */}
<Card className="border-zinc-800 bg-zinc-950" data-testid="team-distribution">
  <CardHeader className="space-y-0">
    <CardTitle className="flex items-center gap-2 text-zinc-100">
      <Gauge className="size-5 text-brand" />
      Distribution &amp; Form
    </CardTitle>
  </CardHeader>
  <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
    <Stat
      label="Fuel pts spread"
      value={fmtPM(agg.meanFuelPoints, agg.stdDevFuelPoints)}
      testid="team-dist-fuel"
      hint={`range ${fmt(agg.minFuelPoints)} – ${fmt(agg.maxFuelPoints)} · n=${agg.matchesScouted}`}
      tone="energy"
    />
    <Stat
      label="Climb pts spread"
      value={fmtPM(agg.meanClimbPoints, agg.stdDevClimbPoints)}
      testid="team-dist-climb"
      hint={`range ${fmt(agg.minClimbPoints)} – ${fmt(agg.maxClimbPoints)}`}
    />
    <Stat
      label="Defense spread"
      value={fmtPM(agg.avgDefenseRating, agg.stdDevDefenseRating)}
      testid="team-dist-defense"
      hint={`range ${fmt(agg.minDefenseRating)} – ${fmt(agg.maxDefenseRating)}`}
      tone="brand"
    />
    {/* Recent form */}
    <Stat
      label="Recent form"
      value={recentFormText(agg)}
      testid="team-recent-form"
      tone={recentFormTone(agg)}
      hint={
        agg.recentTrend === 'insufficient'
          ? 'need 3 matches'
          : `last ${Math.min(3, agg.matchesScouted)} vs all`
      }
    />
  </CardContent>
</Card>
```

Helpers in TeamView.tsx:

```ts
function fmtPM(mean: number, sd: number): string {
  if (!Number.isFinite(mean)) return '—';
  return `${mean.toFixed(1)} ± ${Number.isFinite(sd) ? sd.toFixed(1) : '0.0'}`;
}
function recentFormText(agg: TeamAgg): string {
  switch (agg.recentTrend) {
    case 'improving': return `Improving +${agg.recentFuelDelta.toFixed(1)}`;
    case 'fading':    return `Fading ${agg.recentFuelDelta.toFixed(1)}`; // delta already negative
    case 'stable':    return 'Stable';
    default:          return '—';
  }
}
function recentFormTone(agg: TeamAgg): StatTone {
  if (agg.recentTrend === 'improving') return 'success';
  if (agg.recentTrend === 'fading') return 'warning';
  return 'default';
}
```

Optionally prepend a `TrendingUp` / `TrendingDown` / `Minus` icon to the value —
since `Stat` renders `value` as a plain string, the simplest no-refactor path is
text-only with tone color (recommended for v1). Icons are a follow-up that would
require widening `Stat` to accept a leading node.

Also append to the existing Fuel card "Mean fuel points (raw)" `Stat` a `hint`:

```tsx
<Stat
  label="Mean fuel points (raw)"
  value={fmt(agg.meanFuelPoints)}
  testid="team-mean-fuel-points"
  hint={`± ${fmt(agg.stdDevFuelPoints)} σ`}
/>
```

### 5.2 RankingView compare rows

Append to `COMPARE_ROWS` (after the existing `Reliability` / before `EPA`, or at
the end — order is cosmetic). Add the `trendLabel` helper above the array (the
ordinal `trendProxy` is **not** used by the compare table since Recent Form is
no-winner — only add it if a downstream consumer needs it):

```ts
function trendLabel(agg: TeamAgg): string {
  switch (agg.recentTrend) {
    case 'improving': return `Improving +${agg.recentFuelDelta.toFixed(1)}`;
    case 'fading':    return `Fading ${agg.recentFuelDelta.toFixed(1)}`;
    case 'stable':    return 'Stable';
    default:          return EM_DASH;
  }
}
```

(`EM_DASH` is the existing `—` constant already used in RankingView; reuse it
rather than introducing a new literal.)

New `CompareRow` entries. For the σ rows `value` returns the std-dev and the
compare panel flags the **lowest** σ (most consistent) green. For `Recent Form`,
`value` returns `null` for every team (review med-2) so **no cell is flagged** —
the label is rendered by `get()` only:

```ts
{ label: 'Fuel σ',    get: (r) => fmt(r.agg.stdDevFuelPoints),     value: (r) => r.agg.stdDevFuelPoints,     better: 'lower' },
{ label: 'Climb σ',   get: (r) => fmt(r.agg.stdDevClimbPoints),    value: (r) => r.agg.stdDevClimbPoints,    better: 'lower' },
{ label: 'Defense σ', get: (r) => fmt(r.agg.stdDevDefenseRating),  value: (r) => r.agg.stdDevDefenseRating,  better: 'lower' },
{ label: 'Recent Form', get: (r) => trendLabel(r.agg),             value: () => null,                        better: 'higher' },
```

`trendProxy` is therefore unused by the compare table; keep `trendLabel` (used by
`get`). Drop the `trendProxy` helper from §5.2 unless a later feature needs the
ordinal — see updated helper block below.

Because the winner-detection step filters out `null` (`nums = …filter(n => n !==
null)`), a `value()` that always returns `null` yields `best === null` and no cell
is ever bold/green — exactly the intended "label only, no winner" behavior. For
σ rows, an `insufficient`-on-other-metrics team still shows its σ (σ is always
finite, `0` at `n=1`) and competes normally. Each compare row's `<td>` is
rendered by the existing `COMPARE_ROWS.map`; no JSX changes beyond the array. The
existing panel has `data-testid="compare-panel"`; the e2e asserts on text/rows
within it.

### 5.3 States

- Loading: unchanged (TeamView `team-loading`, Ranking `dash-ranking-loading`).
- No reports for team: TeamView renders `team-no-data` branch — Distribution card
  is inside `TeamDetail`, only shown when `agg` exists, so it never renders with
  zero data.
- `n=1`: σ = 0 (shown as `± 0.0`), range = `min – max` identical, Recent Form =
  `—` (insufficient). This is correct and honest.
- `n=2`: σ computed, Recent Form still `—` (need 3).

---

## 6. Offline behavior

No network dependency whatsoever. All inputs come from `useEventReports`, which
reads the TanStack Query cache (persisted to IndexedDB via
`PersistQueryClientProvider`) and falls back to cached reports offline. The
distribution/trend math runs synchronously inside the existing `useMemo`
(`aggregateEvent(reports)` in both views) — it is recomputed on every reports
change and memoized, so an offline reload that rehydrates cached reports produces
full distribution/trend output with zero requests. If reports are entirely
unavailable, both views already show their empty/loading states and the
Distribution card is not reached. No EPA/TBA/Statbotics calls are added, so a
proxy outage has no effect on this feature.

---

## 7. Test plan

### 7.1 Unit — `src/dash/__tests__/aggregate.test.ts`

Add to the existing file (reuse the `row()` factory). **Note:** the existing
`row()` factory defaults `match_key` to `'evt_qm1'` (aggregate.test.ts line 10),
so every report passed to one `aggregateTeam` call would collide on the same key.
The trend/order tests (#4-#7) **must set distinct `match_key`s** (`evt_qm1` …
`evt_qm5`) per row so `compareMatchKeys` produces a real chronological order;
otherwise the last-3 slice is meaningless. Also set `target_team_number` and a
finite `fuel_points` (and `fuel_estimate_confidence: 1` where the mean path needs
it, mirroring the existing tests).

1. **std-dev population formula**: 3 reports with `fuel_points` `{40,30,20}` →
   `meanFuelPoints=30`, `stdDevFuelPoints=Math.sqrt(((10²+0+10²)/3))≈8.165`;
   assert `toBeCloseTo(8.165, 2)`; `minFuelPoints=20`, `maxFuelPoints=40`.
2. **single match → zero spread**: 1 report `fuel_points=25` →
   `stdDevFuelPoints===0`, `min===max===25`, `recentTrend==='insufficient'`,
   `recentFuelMean` is `NaN`.
3. **climb-points σ uses climbPointsForMatch** (review med-3): `climbPointsForMatch`
   is **private** (not exported) in `aggregate.ts`, so the test CANNOT call it —
   it must re-derive expected per-match climb points the SAME way the helper does,
   pulling magnitudes from the imported frozen `SCORING.CLIMB`:
   `pts = (climb_success ? SCORING.CLIMB[climb_level].teleop : 0) +
   (auto_climb_level1 ? SCORING.CLIMB[1].auto : 0)`. Note the auto-climb bonus is
   **independent of the teleop result** (added even when `climb_success===false`)
   — confirmed at aggregate.ts lines 58-61. Seed reports with mixed
   `climb_success`/`climb_level`/`auto_climb_level1`, and **include at least one
   row with `auto_climb_level1=true` AND `climb_success=false`** to lock in the
   auto-bonus-independent-of-teleop behavior. Compute the expected mean + population
   σ from those per-match magnitudes (do not hardcode raw numbers — derive from
   `SCORING.CLIMB` so a scoring-magnitude change re-derives correctly) and assert
   `stdDevClimbPoints` with `toBeCloseTo(…, 4)`.
4. **trend improving**: 5 reports ordered `qm1..qm5` with fuel
   `{10,10,30,30,30}` → all-mean 22, last-3 mean 30, delta `+8 >0.5` →
   `recentTrend==='improving'`, `recentFuelDelta` ≈ 8.
5. **trend fading**: fuel `{40,40,10,10,10}` → delta `−18 < −0.5` → `'fading'`.
6. **trend stable inside threshold**: fuel `{20,20,20.3,20,20}` →
   `|delta| < 0.5` → `'stable'`.
7. **out-of-order input is sorted**: pass reports with `match_key` in scrambled
   order (`qm3`,`qm1`,`qm5`,`qm2`,`qm4`) → result identical to sorted input
   (guards the `compareMatchKeys` sort).

### 7.2 Component — `RankingView.test.tsx` / `TeamView.test.tsx`

- RankingView: render with two seeded teams (one consistent, one swingy), select
  both compare checkboxes. Assert the **winner check on the clean numeric `Fuel σ`
  row** (review med-2): the lower-σ team's cell carries `text-success` and the
  higher-σ team's does NOT. For `Recent Form`, assert the seeded **labels** render
  (`Improving …` / `Stable` / etc.) but assert **no cell carries `text-success`**
  on that row (its `value()` returns `null`, so no winner is ever flagged) — this
  is the regression guard against the misleading green-on-`Stable` behavior.
- TeamView: select a team with ≥3 reports, assert `team-distribution` card,
  `team-dist-fuel` text matches `/\d+\.\d ± \d+\.\d/`, and `team-recent-form`
  shows the expected label + tone class.

### 7.3 Playwright e2e — `tests/e2e/distribution-trend.spec.ts`

Single-worker, against the live `2026casnv` event (mirror
`dashboard.spec.ts` setup: `beforeAll` activates the event; skip when
`VITE_SUPABASE_URL`/`SUPABASE_SECRET_KEY` unset). Use `getByRole('tab', …)` for
tab nav (matches existing spec).

**Team-pick strategy (REVISED — review high-1).** Do NOT pick the first
`team-select` option. `team-select` is populated from `teamsQuery` (the full
event **roster**, sorted ascending by team number — TeamView.tsx lines 973-981),
NOT from scouted teams. The lowest-numbered roster team very likely has zero
scouting reports, so TeamView renders the `team-no-data` branch and the
Distribution card (inside `TeamDetail`, only mounted when `agg` exists) never
appears — the spec would flake/fail depending on roster ordering.

Instead, read the **Ranking** tab first — it lists only scouted teams
(`aggregateEvent` over reports) via `ranking-row-{n}` rows whose team-number cell
is `ranking-team-{n}`. Grab the first such team number and select THAT in
`team-select`. This guarantees `>= 1` report so `TeamDetail` (and the Distribution
card) renders. Prefer the deterministic demo-event path (`2026demo`) which
guarantees multi-match teams — documented as the recommended local run.

```ts
import { test, expect } from '@playwright/test';
// reuse helpers/global-setup pattern from dashboard.spec.ts

const eventKey = '2026casnv';

test('distribution + recent-form surface in Team and Ranking', async ({ page }) => {
  test.skip(!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY, 'needs live env');

  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });

  // --- Ranking tab FIRST: it lists only SCOUTED teams; pick one with data. ---
  await page.getByRole('tab', { name: 'Ranking' }).click();
  await expect(page.getByTestId('dash-ranking')).toBeVisible({ timeout: 15_000 });
  // First scouted team's number (ranking-team-{n} text == the team number).
  const firstRankedTeam = (
    await page.locator('[data-testid^="ranking-team-"]').first().textContent()
  )?.trim();
  expect(firstRankedTeam, 'event has at least one scouted team').toBeTruthy();

  // select the first two compare checkboxes (sufficient to render the panel)
  const checks = page.locator('[data-testid^="cmp-"]');
  await checks.nth(0).check();
  await checks.nth(1).check();
  const panel = page.getByTestId('compare-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Fuel σ');
  await expect(panel).toContainText('Recent Form');
  // Strengthen (review low-6): the Fuel σ row must contain a digit, so a
  // regression that NaNs/zeroes-out σ for every team is caught. Scope to the
  // row (a <tr> whose first <td> is the label) rather than the whole panel.
  const fuelSigmaRow = panel.locator('tr', { hasText: 'Fuel σ' });
  await expect(fuelSigmaRow).toContainText(/\d/);

  // --- Team tab: select the SCOUTED team we found, so TeamDetail mounts. ---
  await page.getByRole('tab', { name: 'Team' }).click();
  const select = page.getByTestId('team-select');
  await expect(select).toBeVisible({ timeout: 15_000 });
  await select.selectOption(firstRankedTeam!);

  // Distribution card renders with mean ± σ and a range hint.
  await expect(page.getByTestId('team-distribution')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('team-dist-fuel')).toContainText('±');
  await expect(page.getByTestId('team-recent-form')).toBeVisible();
  // Recent form is one of the four allowed states.
  await expect(page.getByTestId('team-recent-form'))
    .toContainText(/Improving|Fading|Stable|—/);
});
```

Assertions are tolerant of live data (no hard-coded team numbers/values), so the
spec stays green as `2026casnv` data changes. If the live event has too few
reports for a `Recent Form` other than `—`, the regex still passes on `—`. The
`Fuel σ` digit assertion holds even at `n=1` (σ renders `0`, which contains a
digit). Demo-mode fallback: if live data is sparse, the same spec works after
toggling demo mode in Setup (seeds 2026demo with full multi-match data) — the
recommended local run path; note it in a spec comment.

---

## 8. Conflict surface (other features touching the same files)

`aggregate.ts` and `TeamAgg` are the hot shared surface. Coordinate merge order
with:

| Feature | Shared file(s) | Conflict nature |
| --- | --- | --- |
| **defense-analytics** | `aggregate.ts` (`TeamAgg`, `aggregateTeam`), `TeamView.tsx`, `RankingView.tsx` | HIGH — both widen `TeamAgg` and add Stat cards / compare rows. Land additively; both append fields to the interface and append `COMPARE_ROWS` entries. Resolve by keeping each feature's fields contiguous and re-running the full agg test suite. |
| **matchup-intelligence** | `aggregate.ts` (consumes `TeamAgg`), `RankingView.tsx` | MEDIUM — likely reads σ/trend; ensure this lands first so it can consume `recentTrend`. |
| **smart-picklist** | `aggregate.ts` (consumes `TeamAgg`), possibly `RankingView.tsx` | MEDIUM — picklist scoring may weight by σ/consistency; depends on these fields. |
| **alliance-simulator** | `aggregate.ts` (consumes `TeamAgg`) | LOW-MEDIUM — may use σ for confidence bands; read-only consumer. |
| **coverage-gaps / multi-scout-reconciliation** | `aggregate.ts`, `TeamView.tsx` | LOW — touch report counting / per-scout dedup; coordinate the `aggregateTeam` loop edits (they may also iterate `reports`). |
| **scouter-load-accuracy** | `RankingView.tsx` (possibly) | LOW — different tab focus; minor `COMPARE_ROWS` overlap. |
| **export-presets** | `TeamView.tsx` / dashboard export | LOW — if exports include σ/trend, depends on these fields existing. |
| auto-path-heatmap, dashboard-heartbeat, report-correction, match-video | — | NONE expected (different files/tabs). |

Mitigation (review low-5): this feature is the **producer** of σ/trend on
`TeamAgg`; schedule it **first** — before matchup-intelligence, smart-picklist,
alliance-simulator, and export-presets (all σ/trend *consumers*, which must land
after this producer). defense-analytics is a parallel **producer** that appends to
the **same** `TeamAgg` interface and the **same** `COMPARE_ROWS` array at the same
insertion points — git will NOT auto-merge two appends at a common point. So
sequence defense-analytics **second** and **rebase it onto this feature** so its
`TeamAgg` fields and `COMPARE_ROWS` entries append *after* this feature's
contiguous block (keep each feature's additions grouped and contiguous). After the
second feature merges, re-run `aggregate.test.ts` + `RankingView.test.tsx` +
`TeamView.test.tsx` to confirm no cross-feature regression. These three dash files
(`aggregate.ts`, `TeamView.tsx`, `RankingView.tsx`) are the exact shared surface;
do not run this feature and defense-analytics in parallel on the same worktree.

---

## 9. Step-by-step execution checklist

1. **aggregate.ts** — add `TrendDirection` type + 11 `TeamAgg` fields;
   `export TREND_WINDOW = 3`, `TREND_STABLE_THRESHOLD = 0.5`.
2. **aggregate.ts** — add `stdDev(values, mean)` and `recentTrend(sortedFuelPts,
   overallMean)` helpers.
3. **aggregate.ts** — in `aggregateTeam`: push `fuel_points`,
   `climbPointsForMatch(r)`, `defense_rating` into three arrays during the
   existing loop; after the loop compute the three σ + min/max; sort a copy of
   `reports` by `compareMatchKeys`, build `sortedFuelPts`, call `recentTrend`,
   and populate the new return fields.
4. **aggregate.test.ts** — add the 7 unit cases (§7.1); `npx vitest run
   src/dash/__tests__/aggregate.test.ts`.
5. **TeamView.tsx** — import `TrendingDown`, `Minus`; add `fmtPM`,
   `recentFormText`, `recentFormTone` helpers; insert the Distribution card after
   "Climb · Defense · Reliability"; append `± σ` hint to "Mean fuel points (raw)".
6. **RankingView.tsx** — add `trendLabel` (reusing `EM_DASH`); append the four
   `COMPARE_ROWS` entries (`Fuel σ`/`Climb σ`/`Defense σ` with
   `value: (r) => r.agg.stdDev…`, `better:'lower'`; `Recent Form` with
   `value: () => null` so it is never winner-flagged). No `trendProxy` needed.
7. **Component tests** — extend `RankingView.test.tsx` + `TeamView.test.tsx`
   (§7.2); run them.
8. **typecheck** — `npm run typecheck` (catches any TeamAgg consumer that
   constructs the interface literally — none expected, all build via
   `aggregateTeam`).
9. **e2e** — add `tests/e2e/distribution-trend.spec.ts` (§7.3); run
   `npx playwright test tests/e2e/distribution-trend.spec.ts`.
10. **full unit suite** — `npm test` to confirm no regression in dependent dash
    tests.
11. **NO supabase push / functions deploy** — this feature has no backend
    changes; do not run `supabase db push` and do not create/mark a migration.
