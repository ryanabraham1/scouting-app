# Defense Effectiveness Analytics — Implementation Plan

## 1. Overview & exact user-facing behavior

Add two NEW, purely-derived defense metrics computed from data we already capture
(timestamped `defended_intervals` / `defense_intervals` + `fuel_bursts`). No new capture,
no new columns, no migration.

Metric A — **Defended Fuel Suppression** (per scouted team, "how much does this team's
fuel output drop while being defended?"):

- Compares the team's fuel-burst rate (balls/sec) inside `defended_intervals` windows vs.
  outside them, expressed as a **percentage drop**.
- Surfaced as `fuelSuppressionWhileDefended` (a 0..1 fraction; 0.30 means "this team
  shoots 30% slower while being defended"). Negative values are possible (team shoots
  *faster* while defended) and are shown verbatim (e.g. `-12%`).
- When a team has no `defended_intervals` across all its reports, or has no undefended
  baseline bursts, the metric is `null` and renders as `—` (em dash). It is NEVER NaN.

Metric B — **Defender Effectiveness** (per defending team, "when THIS team plays defense,
how much do its victims' fuel rates drop?"):

- For each report where the scouted team played defense (`defense_intervals` non-empty),
  cross-reference the *opponent alliance's* scouted reports in the same match. For each
  opponent, measure the opponent's fuel-burst rate during the time windows this team was
  playing defense vs. the opponent's rate outside those windows. Average the suppression
  the defending team imposed across all opponents/matches.
- Surfaced as `defenderEffectiveness` (a 0..1 fraction; higher = better defender). `null`
  when the team never played defense, or no opponent reports overlap, renders as `—`.
- **Statistical caveat (must be surfaced in the UI):** this is a *co-occurrence* estimate.
  The baseline (opponent rate outside this team's defense windows) can still include time
  when OTHER defenders were defending the same victim, so under heavy double-teaming the
  per-defender figure is confounded. We therefore (a) show the sample size in the Stat
  `hint` (`defenseSampleCount` opponents) and (b) render `—` instead of a number when
  `defenseSampleCount < DEF_EFF_MIN_SAMPLE` (= 2) so a single-opponent observation is never
  shown as authoritative, and (c) the TeamView Stat's tooltip/`hint` text explicitly calls
  it an estimate confounded by simultaneous defenders. The raw `defenderEffectiveness`
  field is still computed for `defenseSampleCount === 1` (it's a real signal in Compare),
  but the headline Stat/column gate display behind the min-sample threshold.

User-facing surfaces:

- **TeamView** (`/dashboard` → Team tab): two new `Stat` cards in the existing
  "Climb · Defense · Reliability" card — "Defended fuel ↓" and "Defender effect" — beside
  the existing "Avg defense". Each shows a percentage, an `est`/sample hint
  (`n=<intervals>`), or `—` with a tooltip when unavailable.
- **TeamView → Last match timeline**: the existing `TeamTimeline` already draws `defended`
  and `defense` segments. We add a thin caption under the timeline summarizing the
  computed suppression for that single report when it has defended intervals (read-only,
  no new component).
- **RankingView** (`/dashboard` → Ranking tab): two new sortable columns — column headers
  "Def ↓" (`SortKey 'fuelSuppression'`) and "Defender" (`SortKey 'defenderEffectiveness'`)
  — and two new rows in the Compare panel. Both hidden on narrow screens with
  `hidden sm:table-cell` — matching the EXACT breakpoint the existing EPA/TBA columns use
  (`RankingView.tsx` lines 351/430/440 use `sm:`, not `md:`) so defense columns hide/show
  in lockstep with EPA/TBA. Both still appear in the Compare panel regardless of viewport.
  The two Compare-panel rows use the **exact** labels `'Def ↓'` and `'Defender'` (these
  literal strings are pinned so the e2e text assertions in §7 match — do not rename them).

Everything degrades to `—` and never throws; legacy reports (pre-0010, no intervals)
simply contribute nothing.

## 2. Data model

**NO MIGRATION REQUIRED.** All inputs already exist and are read by the dashboard today:

- `fuel_bursts: BurstRow[]` — `{ startMs, endMs, rate, window }` (added 0010).
- `defended_intervals: IntervalRow[]` — `{ startMs, endMs, phase }` (added 0010).
- `defense_intervals: IntervalRow[]` — `{ startMs, endMs, phase }` (added 0010).
- `match_key`, `alliance_color`, `target_team_number` — needed to join opponents.

These are already declared optional/nullable in `MsrRow` (`src/dash/types.ts` lines 54–57)
and selected via `SELECT *` by `useEventReports`. Server-side recompute is intentionally
**out of scope**: both metrics are pure functions of already-synced raw fields, the
dashboard already loads every event report for `aggregateEvent`, and adding an RPC would
introduce a migration with no correctness benefit (the math is identical client-side and
the dashboard is the only consumer). If a future server consumer needs it, that becomes
migration `0033+` and is explicitly **NOT** marked deployed — but this plan ships zero SQL.

Time model (must match `matchTimeline.ts`): auto occupies `[0, AUTO_MS)`; teleop bursts
and intervals are offset by `AUTO_MS`. A burst's absolute start is
`b.window === 'auto' ? b.startMs : AUTO_MS + b.startMs`; an interval's absolute start is
`i.phase === 'auto' ? i.startMs : AUTO_MS + i.startMs`.

**Single source of the offset convention.** `matchTimeline.ts` currently keeps
`burstAbsStart`/`intervalAbsStart` PRIVATE (only `AUTO_MS`/`TELEOP_MS`/`MATCH_MS` are
exported — verified `matchTimeline.ts` lines 11, 25, 28). To avoid silently re-implementing
(and later drifting from) that convention, this plan **exports the two helpers from
`matchTimeline.ts`** and imports them into `defenseAnalytics.ts`:

```ts
// matchTimeline.ts — change `function` to `export function`
export function burstAbsStart(b: BurstRow): number { ... }      // line 25
export function intervalAbsStart(i: IntervalRow): number { ... } // line 28
```

This is a pure widening of visibility (no behavior change, no new symbol name collision —
they were already module-internal), and it is recorded in §3/§8 as an additional edit to
`matchTimeline.ts` so the conflict scheduler treats it as a shared-file touch. The
`defenseAnalytics.test.ts` "auto window not offset / teleop offset by AUTO_MS" cases (§7)
then double as a parity guard against the timeline's drawn segments.

## 3. Files to create / modify

| Path | Precise change |
| --- | --- |
| `src/dash/matchTimeline.ts` | Widen visibility ONLY: change `function burstAbsStart` (line 25) and `function intervalAbsStart` (line 28) to `export function …`. No behavior change. This makes the offset convention a single source imported by `defenseAnalytics.ts` (see §2). |
| `src/dash/defenseAnalytics.ts` (NEW) | Pure helpers. Import `burstAbsStart`/`intervalAbsStart`/`AUTO_MS`/`MATCH_MS` from `matchTimeline.ts`. Export `burstAbsRange(b)` / `intervalAbsRange(i)` (absolute ms ranges built on the imported helpers), `overlapMs(a,b)`, `weightedRate(bursts, windows)` (returns `{insideRate, outsideRate, insideDur, outsideDur}`), `clampSuppression(x)`, `suppressionFromBursts(bursts, defendedWindows): number \| null` (Metric A core), `defenderEffectivenessForMatch(defenseWindows, opponentReports): {sum,count} \| null`, and the **single** `pctSigned(x: number): string` formatter (imported by both RankingView and TeamView so there is exactly one definition and one glyph). No React, no I/O. |
| `src/dash/aggregate.ts` | (a) Extend `TeamAgg` (after line 31, near `avgDefenseRating`) with `fuelSuppressionWhileDefended: number \| null`, `defendedSampleMs: number`, `defenderEffectiveness: number \| null`, `defenseSampleCount: number`. (b) `aggregateTeam` computes Metric A from each report's `fuel_bursts` + `defended_intervals` (pooled across the team's matches — see §4). (c) Add a NEW exported fn `attachDefenderEffectiveness(aggs: Map<number,TeamAgg>, reports: MsrRow[]): void` that does the cross-team Metric B pass (needs all reports, not just one team's). (d) `aggregateEvent` calls `attachDefenderEffectiveness` before returning so the map is fully populated. |
| `src/dash/types.ts` | No type change strictly required (`BurstRow`/`IntervalRow` already correct). Add a short doc comment block above `MsrRow` noting the four jsonb fields now feed defense analytics. |
| `src/dash/RankingView.tsx` | (a) Add `'fuelSuppression'` and `'defenderEffectiveness'` to `SortKey` (line 39). (b) Add `case`s in `sortValue` (lines 87–110) — NOTE `sortValue` is a `switch` with no `default`, so adding `SortKey` members WITHOUT cases is a `typecheck` error (good guard); coordinate ordering with other Ranking features so two don't add cases on the same line. `null` sorts to bottom — both metrics higher-is-better so `?? Number.NEGATIVE_INFINITY`. (c) Add two `columns` entries (line 263) with `hidden sm:table-cell` (matches the existing EPA/TBA `sm:` breakpoint — lines 351/430/440). (d) Add two `<td>` cells in the row body (after the Defense `<td>`, ~line 418), `className: 'hidden px-2 py-2 tabular-nums sm:table-cell'`, test ids `def-supp-${t}` / `defender-${t}`, rendering `pctSigned(...)` or the existing `EM_DASH` constant (line 28) for `null` — reuse `EM_DASH`, do not introduce a second dash glyph. `import { pctSigned } from '@/dash/defenseAnalytics'`. (e) Add two `COMPARE_ROWS` (line 124) with the literal labels `'Def ↓'` and `'Defender'`, `better:'higher'`, `value` returning the fraction or `null`, `get` returning `pctSigned(x)` or `EM_DASH`. |
| `src/dash/TeamView.tsx` | Add two `<Stat>` cards in the "Climb · Defense · Reliability" `CardContent` (after the "Avg defense" Stat, ~line 702): `team-defended-suppression` and `team-defender-effectiveness`. `import { pctSigned } from '@/dash/defenseAnalytics'` (the single shared definition — do NOT add a TeamView-local copy). Show `pctSigned(value)` or `—`, with `hint` = sample size. Optionally add a one-line caption under the `<TeamTimeline report=… />` call site (`TeamView.tsx` line 384, inside the `team-last-match` card — there is no `LastMatchNode` symbol) summarizing the single report's suppression (compute via `suppressionFromBursts`), `data-testid="team-last-match-suppression"`. |
| `src/dash/__tests__/defenseAnalytics.test.ts` (NEW) | Unit tests for the pure helpers (see §7). |
| `src/dash/__tests__/aggregate.test.ts` | Add a `describe('defense analytics')` block covering Metric A pooling, Metric B opponent join, and all null/edge cases (see §7). NO factory change needed — the existing `row(overrides: Partial<MsrRow>)` (line 6) already accepts `fuel_bursts`/`defended_intervals`/`defense_intervals`/`match_key`/`alliance_color` via the `Partial<MsrRow>` spread; just pass them as overrides. |
| `tests/e2e/dashboard.spec.ts` | Add an e2e scenario asserting the new Ranking columns sort and the Team-tab Stat cards render (see §7). |

`mapReport.ts` and `src/scoring/*` are **NOT touched** — these metrics are display-only
derivations of already-synced raw fields; the wire shape and server recompute are
unchanged, preserving the "mapReport is the single wire shape" and "scoring recomputed
server-side" invariants.

## 4. Core logic — exact formulas / algorithms

### Shared primitives (`defenseAnalytics.ts`)

```
AUTO_MS, MATCH_MS, burstAbsStart, intervalAbsStart imported from matchTimeline
  (matchTimeline re-exports AUTO_MS/TELEOP_MS from @/capture/clock and, per §2/§3,
   now also EXPORTS burstAbsStart/intervalAbsStart — single source of the offset).

burstAbsRange(b): { start: burstAbsStart(b), end: burstAbsStart(b)+(b.endMs-b.startMs) }
intervalAbsRange(i): same using intervalAbsStart, length = i.endMs-i.startMs
overlapMs(a, b): max(0, min(a.end,b.end) - max(a.start,b.start))

DEF_EFF_MIN_SAMPLE = 2   // min opponents observed before the headline display trusts Metric B
```

A `rate` on a burst is balls/sec sustained over `[start,end)`. We measure a robot's
fuel-throughput inside a set of windows as a **duration-weighted mean rate**, splitting
each burst's contribution by how much of it falls inside vs. outside the windows:

```
weightedRate(bursts, windows):
  insideBallTime = 0, insideDur = 0, outsideBallTime = 0, outsideDur = 0
  for b in bursts:
    r = burstAbsRange(b); dur = r.end - r.start
    if dur <= 0: continue
    inDur = sum over w in windows of overlapMs(r, w)   // clamp so inDur <= dur
    inDur = min(inDur, dur)
    outDur = dur - inDur
    insideBallTime  += b.rate * (inDur/1000);  insideDur  += inDur
    outsideBallTime += b.rate * (outDur/1000); outsideDur += outDur
  return {
    insideRate:  insideDur  > 0 ? insideBallTime  / (insideDur/1000)  : null,
    outsideRate: outsideDur > 0 ? outsideBallTime / (outsideDur/1000) : null,
    insideDur, outsideDur,
  }
```

(Because `weightedRate` is `Σ rate·dur / Σ dur`, it correctly handles overlapping bursts
of different rates and partial-overlap intervals — the documented correlation strategy.)

### Metric A — Defended Fuel Suppression (per scouted team)

Pooled across all of the team's reports (more samples = stabler estimate), NOT averaged
per-match (a 1-burst match shouldn't weigh as much as a busy one):

```
aggregateTeam pooling:
  defendedBT_in = 0, defendedDur_in = 0   // ball-time/dur while defended
  baseBT = 0, baseDur = 0                 // ball-time/dur while NOT defended
  for r in reports:
    if !Array.isArray(r.fuel_bursts) or r.fuel_bursts empty: continue
    windows = (r.defended_intervals ?? []).map(intervalAbsRange)
    wr = weightedRate(r.fuel_bursts, windows)
    accumulate wr.insideBallTime/insideDur into defended*, outside into base*

  insideRate  = defendedDur_in > 0 ? defendedBT_in/(defendedDur_in/1000) : null
  outsideRate = baseDur      > 0 ? baseBT/(baseDur/1000)             : null

  fuelSuppressionWhileDefended =
    (insideRate != null && outsideRate != null && outsideRate > 0)
      ? clampSuppression((outsideRate - insideRate) / outsideRate)
      : null
  defendedSampleMs = defendedDur_in   // for the n= hint / confidence gating
```

`clampSuppression(x)` clamps to `[-1, 1]` (a >100% increase or impossible <-100% is
capped) — keeps display sane; do NOT clamp to `[0,1]` because a negative (defended team
shot *more*) is a real, interesting signal. **Null when**: no defended intervals, OR no
undefended baseline bursts (defended entire match), OR no bursts at all. This resolves the
"defended entire match → NaN" risk by returning `null`.

### Metric B — Defender Effectiveness (per defending team)

Run once over the whole event in `attachDefenderEffectiveness`:

```
1. Index reports by match_key -> { red: MsrRow[], blue: MsrRow[] } (skip deleted).
2. For each report `d` (the would-be defender) with non-empty defense_intervals:
     defenseWindows = d.defense_intervals.map(intervalAbsRange)
     opponents = reports in same match on the OPPOSITE alliance_color
     for each opponent group keyed by target_team_number:
       pick ONE report per opponent team: prefer the report with the MOST
         fuel_bursts (richest data); skip if no_show OR died (unreliable victim).
       if opponent has no fuel_bursts: skip
       wr = weightedRate(opponent.fuel_bursts, defenseWindows)
       if wr.insideRate != null && wr.outsideRate != null && wr.outsideRate > 0:
         supp = clampSuppression((wr.outsideRate - wr.insideRate)/wr.outsideRate)
         accumulate per defender team: sumSupp += supp; count += 1
3. For each team agg:
     defenderEffectiveness = count>0 ? sumSupp/count : null
     defenseSampleCount   = count   // opponents observed under defense
```

This measures suppression of opponents *specifically during this team's defense windows*
(not raw opponent total). It does NOT fully de-confound simultaneous defenders: the
victim's "outside this team's windows" baseline can still overlap *another* defender's
windows, so under double-teaming each defender's figure is a co-occurrence estimate, not an
isolated causal effect. We mitigate, not eliminate, this: (i) `defenseSampleCount` is
exposed so consumers see how thin the sample is, and (ii) the headline Stat/column render
`—` until `defenseSampleCount >= DEF_EFF_MIN_SAMPLE` (the raw fraction is still stored for
Compare). `no_show`/`died` opponents are filtered (unreliable victims are excluded rather
than counted as "suppressed"). One report per opponent (richest) avoids double counting
multi-scout duplicates.

### Definition resolutions (closing the research gaps)

- "Output drops" = **percentage reduction in balls/sec rate** (Metric A), i.e.
  `(undefended_rate - defended_rate) / undefended_rate`. Rate-based, not absolute, so
  it's comparable across teams with different volumes.
- "Effective defending" = suppression imposed on opponents **during this team's own
  defense windows only** (Metric B), not the opponent's whole-match total.
- Window mapping uses **per-burst duration-weighted overlap with defended/defense
  intervals** (precise), not coarse shift-bucket ratios — this is why we don't need
  `windows.ts`/`SHIFT_BOUNDS` here.

## 5. UI/UX

**TeamView** (`src/dash/TeamView.tsx`) — inside the existing
`<Card>` titled "Climb · Defense · Reliability", `CardContent` is a
`grid grid-cols-2 sm:grid-cols-3`. Add after the "Avg defense" `Stat`:

```tsx
<Stat
  label="Defended fuel ↓"
  value={agg.fuelSuppressionWhileDefended == null ? '—' : pctSigned(agg.fuelSuppressionWhileDefended)}
  testid="team-defended-suppression"
  hint={agg.fuelSuppressionWhileDefended == null ? 'no defended intervals' : `from ${Math.round(agg.defendedSampleMs/1000)}s defended`}
  tone={agg.fuelSuppressionWhileDefended != null && agg.fuelSuppressionWhileDefended > 0.15 ? 'warning' : 'default'}
/>
<Stat
  label="Defender effect"
  // gated: a single-opponent observation is not shown as authoritative (see §1/§4)
  value={
    agg.defenderEffectiveness == null || agg.defenseSampleCount < DEF_EFF_MIN_SAMPLE
      ? '—'
      : pctSigned(agg.defenderEffectiveness)
  }
  testid="team-defender-effectiveness"
  hint={
    agg.defenderEffectiveness == null
      ? 'never played defense'
      : `vs ${agg.defenseSampleCount} opp. · co-occurrence estimate`
  }
  tone={
    agg.defenderEffectiveness != null &&
    agg.defenseSampleCount >= DEF_EFF_MIN_SAMPLE &&
    agg.defenderEffectiveness > 0.15
      ? 'success'
      : 'default'
  }
/>
```

`pctSigned` is imported from `defenseAnalytics.ts` — it is the SINGLE definition shared by
RankingView and TeamView (no TeamView-local copy). Its body is
`(x) => `${x >= 0 ? '' : '−'}${Math.round(Math.abs(x) * 100)}%`` and it uses the Unicode
minus `−` (U+2212) consistently. For `null`/unavailable cells, code renders the existing
`EM_DASH` constant — `pctSigned` is never called with `null`. No test asserts on an
ASCII-hyphen `-12%`; negative-display tests assert the `−` (U+2212) form produced by
`pctSigned`.

Optional timeline caption under the `<TeamTimeline report=… />` call site (`TeamView.tsx`
line 384, inside the `team-last-match` card — there is no `LastMatchNode` symbol): if the
report has `defended_intervals`, compute `suppressionFromBursts(report.fuel_bursts, windows)`
and render a `data-testid="team-last-match-suppression"` line: "Fuel ↓ 28% while defended
this match" or hide when `null`.

**RankingView** (`src/dash/RankingView.tsx`) — two new columns appended after "Defense",
`className: 'hidden sm:table-cell'` (matches the existing EPA/TBA `sm:` breakpoint — lines
351/430/440 — so phones stay readable and the defense columns appear/hide in lockstep with
EPA/TBA); sortable like the rest. Render the existing `EM_DASH` for `null` (no second dash
glyph). The "Defender" column also renders `EM_DASH` when
`defenseSampleCount < DEF_EFF_MIN_SAMPLE` (display gating; the value still exists for
Compare). Two new Compare rows with the pinned labels `'Def ↓'` and `'Defender'` so they
always appear in the side-by-side even when the columns are hidden on the table. Cell test
ids: `def-supp-${t}`, `defender-${t}`. Sort-header test ids: `sort-fuelSuppression`,
`sort-defenderEffectiveness` (auto-generated by the existing `sort-${col.key}` pattern,
line 356 — so the `SortKey`/`col.key` values MUST be exactly `fuelSuppression` and
`defenderEffectiveness` to match the e2e selectors in §7).

States: loading/empty states unchanged (the existing `dash-ranking-loading` /
`dash-ranking-empty` cover them). When every team's metric is `null` (e.g. no intervals
scouted yet), the columns simply show `—` everywhere and sorting is a stable no-op
(team-number tiebreak).

## 6. Offline behavior

Fully offline-safe — both metrics are pure functions over `useEventReports` data, which is
already served from the persisted TanStack Query / IndexedDB cache when the network is
down. No new fetch, no Edge Function, no Supabase call. With zero connectivity the
dashboard rehydrates the last cached reports and computes defense analytics exactly as it
would online. If a report lacks intervals (legacy/pre-0010 or not re-scouted), it
contributes nothing and the metric degrades to `—` — never an error, preserving the shared
`RouteError` boundary's promise that one screen can't blank the app.

## 7. Test plan

### Unit — `src/dash/__tests__/defenseAnalytics.test.ts` (new)

1. `overlapMs` — disjoint → 0; partial → correct ms; nested → inner length.
2. `burstAbsRange`/`intervalAbsRange` — auto window not offset; teleop offset by `AUTO_MS`.
3. `weightedRate` — single burst fully inside one window → `insideRate==rate`,
   `outsideRate==null`; burst split 50/50 across a window edge → inside/outside durations
   each half, rates equal `rate`.
4. `suppressionFromBursts` — undefended rate 10, defended rate 6 → `0.4`; defended rate >
   undefended → negative; no defended windows → `null`; defended entire match (no outside
   bursts) → `null`; empty bursts → `null`.
5. `clampSuppression` — caps at `±1`.

### Unit — extend `src/dash/__tests__/aggregate.test.ts`

Add `describe('defense analytics')`:

1. **Metric A pooling** — team with 2 reports: report1 undefended bursts rate 10 + a
   defended interval over a rate-5 burst; report2 similar → pooled
   `fuelSuppressionWhileDefended ≈ 0.5`, `defendedSampleMs > 0`.
2. **Metric A null** — team reports have `fuel_bursts` but no `defended_intervals` →
   `fuelSuppressionWhileDefended === null`.
3. **Metric A null (defended whole match)** — only defended bursts, no baseline → `null`.
4. **Legacy rows** — `fuel_bursts`/`defended_intervals` `undefined` → `null`, no throw.
5. **Metric B join** — match `2026x_qm1`: red team A has `defense_intervals` overlapping
   blue team B's high-rate bursts; B's rate drops inside A's defense window →
   A.`defenderEffectiveness > 0`, A.`defenseSampleCount === 1`.
6. **Metric B excludes no_show/died opponents** — B has `died:true` → A's defender effect
   `null` (only victim filtered out).
7. **Metric B multi-scout dedupe** — two reports for opponent B (one rich, one sparse) →
   only the richer is used; `defenseSampleCount` counts B once.
8. **Metric B null** — team never played defense → `defenderEffectiveness === null`,
   `defenseSampleCount === 0`.
9. **Metric B min-sample gating** — a team with exactly one observed opponent has
   `defenderEffectiveness != null` and `defenseSampleCount === 1` (raw value computed), so
   downstream display gating (`< DEF_EFF_MIN_SAMPLE`) is a UI concern, not a compute one.
   Assert the agg still carries the raw value at count 1.
10. `aggregateEvent` end-to-end populates both fields on every team in the map.

Use the existing `row(overrides: Partial<MsrRow>)` factory in `aggregate.test.ts` (line 6)
as-is — it ALREADY accepts `fuel_bursts` / `defended_intervals` / `defense_intervals` /
`match_key` / `alliance_color` via the `Partial<MsrRow>` spread. NO factory change is
required; just pass the jsonb fields as overrides. (Earlier drafts said to "extend the
factory" — that was inaccurate and would add redundant plumbing.)

### Playwright e2e — extend `tests/e2e/dashboard.spec.ts`

Single-worker against live `2026casnv` (already the file's `eventKey`). Defense data may be
sparse on the live event, so assert **presence + interaction**, not specific numbers.

CRITICAL (do not skip): the dashboard reads the global `event.is_active` singleton, so the
new test MUST be self-contained exactly like the existing test in this file — it must NOT
inherit active-event state from a prior test (that is order-coupled and breaks on reorder).
It therefore repeats the per-test `test.skip(!URL || !SECRET, …)` guard and calls
`await setActiveEvent(admin, eventKey)` immediately before `page.goto('/dashboard')`. The
text assertions on `'Def ↓'` / `'Defender'` are valid because §1/§3/§5 pin those exact
COMPARE_ROWS label strings.

```ts
test('defense analytics surface in Ranking and Team tabs', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  await setActiveEvent(admin, eventKey);        // do NOT rely on a prior test's is_active
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('tab', { name: 'Ranking' }).click();
  await expect(page.getByTestId('dash-ranking')).toBeVisible({ timeout: 25_000 });
  // New sortable headers exist and are clickable (md+ viewport).
  await page.setViewportSize({ width: 1280, height: 900 });
  const defSupp = page.getByTestId('sort-fuelSuppression');
  await expect(defSupp).toBeVisible();
  await defSupp.click();                       // sort by suppression
  await expect(page.getByTestId('sort-defenderEffectiveness')).toBeVisible();

  // Open a team from the ranking, assert the two Stat cards render (value or —).
  const firstTeamBtn = page.locator('[data-testid^="ranking-team-"]').first();
  await firstTeamBtn.click();
  await expect(page.getByTestId('team-detail')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('team-defended-suppression')).toBeVisible();
  await expect(page.getByTestId('team-defender-effectiveness')).toBeVisible();

  // Compare panel shows the new rows when two teams are selected.
  await page.getByRole('tab', { name: 'Ranking' }).click();
  const boxes = page.locator('[data-testid^="cmp-"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const cmp = page.getByTestId('compare-panel');
  await expect(cmp).toContainText('Def ↓');
  await expect(cmp).toContainText('Defender');
});
```

Assertions are resilient (visibility + text, not magnitudes) because the live singleton
event's defense coverage varies. If demo mode is preferred, the same selectors apply after
toggling demo (`2026demo`) in the Setup tab.

## 8. Conflict surface (vs. the other 12 planned features)

Shared-file collisions to sequence around:

- **`src/dash/aggregate.ts`** — also touched by **smart-picklist** (reads `TeamAgg`),
  **alliance-simulator** (consumes aggregates), **matchup-intelligence**,
  **coverage-gaps**, **distribution-trend** (may add per-team stats), and
  **multi-scout-reconciliation** (may change how reports are grouped). HIGH conflict: this
  feature ADDS fields to `TeamAgg` and a new `attachDefenderEffectiveness` pass. Land this
  early or coordinate the `TeamAgg` interface edit. Keep additions append-only at the
  bottom of the interface to minimize merge churn.
- **`src/dash/RankingView.tsx`** — also touched by **smart-picklist** (sort by pick
  score), **distribution-trend**, **export-presets** (column export), **coverage-gaps**.
  MEDIUM conflict on `SortKey`, `columns`, `COMPARE_ROWS`, and the row `<td>` block — all
  list-append edits; conflicts are mechanical.
- **`src/dash/TeamView.tsx`** — also touched by **matchup-intelligence**,
  **auto-path-heatmap** (auto path viz), **match-video**, **multi-scout-reconciliation**,
  **report-correction**, **distribution-trend**. MEDIUM: we add Stat cards in the
  Climb/Defense card and an optional caption under `TeamTimeline`; auto-path-heatmap and
  match-video edit the `team-last-match` card / `<TeamTimeline>` call site (line ~384) too
  — coordinate that block.
- **`src/dash/types.ts`** — comment-only change here; many features extend `MsrRow`.
  LOW conflict.
- **`src/dash/matchTimeline.ts`** — we make ONE small edit: widen `burstAbsStart`/
  `intervalAbsStart` (lines 25/28) from `function` to `export function` so the offset
  convention has a single source (§2/§3). **auto-path-heatmap** may also edit this file.
  LOW conflict (a 1-token visibility change on two specific lines; no signature/behavior
  change), but it IS now a shared-file touch — coordinate with auto-path-heatmap.
- **`tests/e2e/dashboard.spec.ts`** — append-only new `test(...)`; **smart-picklist**,
  **coverage-gaps**, **dashboard-heartbeat** also append. LOW (separate test blocks).

No overlap with: **scouter-load-accuracy** (scouter tab), **dashboard-heartbeat** (sync
status). New file `src/dash/defenseAnalytics.ts` is uniquely ours.

## 9. Step-by-step execution checklist

0. In `src/dash/matchTimeline.ts`, change `function burstAbsStart` (line 25) and
   `function intervalAbsStart` (line 28) to `export function …` (visibility only).
1. Create `src/dash/defenseAnalytics.ts` importing `burstAbsStart`/`intervalAbsStart`/
   `AUTO_MS`/`MATCH_MS` from `@/dash/matchTimeline`, with `burstAbsRange`,
   `intervalAbsRange`, `overlapMs`, `weightedRate`, `clampSuppression`,
   `DEF_EFF_MIN_SAMPLE`, `pctSigned`, `suppressionFromBursts(bursts, defendedWindows)`, and
   `defenderEffectivenessForMatch(...)`. Pure, no React/I-O.
2. Write `src/dash/__tests__/defenseAnalytics.test.ts`; run `npx vitest run
   src/dash/__tests__/defenseAnalytics.test.ts` until green.
3. Extend `TeamAgg` in `src/dash/aggregate.ts` (append four fields). Implement Metric A
   pooling in `aggregateTeam`. Add `attachDefenderEffectiveness(aggs, reports)` and call
   it at the end of `aggregateEvent`.
4. Extend `src/dash/__tests__/aggregate.test.ts` with the `describe('defense analytics')`
   block, passing the jsonb fields as overrides to the EXISTING `row(...)` factory (no
   factory change). Run `npx vitest run src/dash/__tests__/aggregate.test.ts`.
5. RankingView: add `SortKey` members (`fuelSuppression`, `defenderEffectiveness`),
   `sortValue` cases (no `default` — typecheck enforces exhaustiveness), two `columns`
   entries (`hidden sm:table-cell`, matching EPA/TBA), two `<td>` cells (render `EM_DASH`
   for `null`; "Defender" cell also `EM_DASH` when `defenseSampleCount < DEF_EFF_MIN_SAMPLE`),
   two `COMPARE_ROWS` (literal labels `'Def ↓'` / `'Defender'`). `import { pctSigned } from
   '@/dash/defenseAnalytics'`. Add `def-supp-${t}` / `defender-${t}` cell test ids.
6. TeamView: add the two `Stat` cards (import `pctSigned`/`DEF_EFF_MIN_SAMPLE` from
   `defenseAnalytics`, gate the Defender Stat behind the min-sample threshold), and the
   optional timeline caption under the `<TeamTimeline>` call site (line ~384).
7. `src/dash/types.ts`: add the doc comment noting the four fields feed analytics.
8. Run `npm run typecheck` and the full `npm test`; fix fallout.
9. Add the e2e scenario to `tests/e2e/dashboard.spec.ts`; run `npx playwright test
   tests/e2e/dashboard.spec.ts` (single-worker, live `2026casnv`).
10. Manual smoke: `npm run dev`, open `/dashboard` → Ranking (sort the two new columns,
    select two teams → Compare shows Def ↓ / Defender) → Team (two Stat cards render with
    value or `—`). Confirm offline reload (devtools offline) still renders the metrics
    from cache.
11. NO migration, NO `supabase db push`, NO functions deploy. NO memory deploy note.
