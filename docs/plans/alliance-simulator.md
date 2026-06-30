# Alliance Simulator — Implementation Plan

Feature owner: Strategy / coaching. Status: planned. Target branch: feature branch off `main`.

## 1. Overview & exact user-facing behavior

A new **Alliance** tab on the Lead Dashboard (`/dashboard?tab=alliance`). The lead drive
coach picks **any 3 teams** at the active event and sees (instantly for teams whose EPA is
already cached; an unscouted team picked for the first time while online incurs a brief EPA
fetch — see §2):

1. **Projected alliance score** — the sum of the 3 teams' per-team expected points using the
   *exact* same blend math as the next-match prediction (`predictMatch`), shown as a point
   estimate with a **confidence badge** (`blend` / `scouting` / `epa` / `mixed`) and a
   per-source breakdown chip per team.
2. **Projected win probability vs an opponent tier** — the user picks a comparison baseline:
   `Top alliance`, `Median alliance`, or a free-form 3-team opponent pick. Win prob is computed
   by feeding the picked alliance as `redTeams` and the baseline as `blueTeams` into
   `predictMatch` and reading `redWinProb`. Two consistency rules:
   - **Define Top/Median over the same EPA-aware expected points used for the score card**, NOT
     raw `scoutingExpectedPoints`. Rank candidate teams by the per-team `expected` that
     `predictMatch`/`predictTeam` produces (so EPA-only / unscouted-but-EPA teams are eligible
     and the baseline is consistent with the projected-score number). `Top alliance` = the 3
     highest expected; `Median alliance` = 3 teams around the median expected.
   - **Exclude already-picked teams from the auto Top/Median baseline.** `predictMatch` does not
     dedupe red vs blue (`src/dash/predict.ts`), so picking the top 3 and then choosing the Top
     baseline would otherwise put the same teams on both sides → a meaningless self-vs-self
     ~50%. Build the auto baseline from candidates **minus the current picks**. If exclusion
     leaves < 3 candidates (tiny event), render the win-prob as "—" with a short note rather
     than a degenerate matchup. For the **custom** baseline, if the user manually overlaps a
     picked team, surface a small inline note ("baseline overlaps your picks") instead of
     blocking.
3. **Role-gap analysis table** — one row per role (Auto, Fuel scoring, Defense, Climb L1,
   Climb L2/L3) with a per-team status cell (✓ strong / ~ partial / · none) and a single
   plain-English **gap summary** line, e.g. *"No dedicated defender; double L3 climb
   available."* Note: the **"two feeders, no primary scorer"** style gap is **pit-dependent**
   — "feeder" is read from pit `matchStrategy.includes('feed')`, which only exists when a pit
   row was scouted. At a fresh / match-only event (0 pit rows — the common offline-first
   reality, see migration history 0021/0023) the feeder count is always 0 and this specific
   gap line will not fire. That absence is **expected behavior, not a bug** on match-only
   events; the climb/defense/fuel/data gaps below derive from match aggregates and still fire.

Exact behaviors:

- **Selection UI**: a searchable team list. The list must render **even when the event has 0
  scouted reports** (the live e2e event `2026casnv` has 0 baseline reports — see §7.2). So the
  picker team list is the **UNION of three sources**, deduped + sorted ascending by team
  number: (a) every scouted team (`aggregateEvent(reports)` keys), (b) the event roster from
  `useEventTeams(eventKey)` (`event_team` join — may be sparse/empty), and (c) every team
  number appearing in the match schedule (`useEventMatches(eventKey)` red1/red2/red3 +
  blue1/blue2/blue3). Source (c) guarantees buttons render at a real event even with 0 reports
  and 0 `event_team` rows. Tapping a team toggles it into the alliance, capped at 3. Selecting a 4th is blocked
  (the unselected checkboxes go disabled at cap, mirroring RankingView's `MAX_COMPARE`).
  The **same team cannot be picked twice** (it is a toggle on a unique team number).
- **Empty/partial states**: with 0–2 teams picked, the score/role panels show a prompt
  ("Pick 3 teams to simulate an alliance"). With exactly 3, all panels render.
- **Unscouted team**: a picked team with `matchesScouted === 0` still contributes via EPA
  (source `epa`) — this requires the view to include the selected team in the `useEventEpa`
  `teamNumbers` union (§2), otherwise its EPA is never fetched and it falls to 0. It
  contributes 0 with an explicit "no data" chip only if neither EPA nor scouting exists. Its
  role cells all read `· unknown` and it is named in the gap summary ("Team 1234: no scouting
  or EPA data").
- **No pit report**: role cells fall back to match-derived heuristics only (see §4); a small
  "match-only" chip flags teams with no pit data so the coach knows the role read is coarse.
- **Reset**: a "Clear" button empties the selection.
- Read-only. Nothing is written to the server or local DB. Pure client computation.

## 2. Data model

**No migration is needed.** Every input already exists and is already fetched:

- Match aggregates come from `aggregateEvent(reports)` over `match_scouting_report`
  (`useEventReports`), producing `TeamAgg` (`src/dash/aggregate.ts`) with
  `scoutingExpectedPoints`, `meanClimbPoints`, `climbSuccessRate`, `avgClimbLevel`,
  `meanFuelPoints`, `fuelPointsWeighted`, `avgDefenseRating`, `reliability`,
  `matchesScouted`.
- EPA per team comes from the existing `useEventEpa(teamNumbers, eventKey, matches)` hook
  (`EventEpa { epaByTeam, available, source }`). **`teamNumbers` is NOT just the scouted set.**
  Copying RankingView here would be wrong (`src/dash/RankingView.tsx:187-192` keys EPA off
  `aggregateEvent` results = scouted teams only). An UNSCOUTED picked team must still get an
  EPA fetch so it can contribute via the `epa` source (§1). Follow the TeamView pattern
  instead (`src/dash/TeamView.tsx:874-876`, which feeds the *selected* team into
  `useEventEpa`): pass the **UNION of** (a) scouted team numbers + (b) the up-to-3 currently
  selected team numbers + (c) any teams in the active baseline (Top/Median/custom picks). Each
  new pick re-keys the `['epa','event',eventKey,...]` query (the team list is part of the key),
  which triggers a cached/network refetch — fine offline (rehydrated cache) but it means a pick
  of a brand-new unscouted team is **not strictly instant** the first time online (a brief EPA
  fetch); the §1 "instantly" claim is relaxed to "instant for already-fetched teams".
- Pit capability/role data comes from the existing `pit_scouting_report` table via the
  existing `useTeamPit(eventKey, teamNumber)` shape (`TeamPit`), with capability keys
  `climb_l1` / `climb_l2` / `climb_l3` / `auto` / `defense` and `matchStrategy` keys
  `score` / `feed` / `defend` / `cycle` / `support` (from `src/pit/PitScoutScreen.tsx`).

Because the simulator needs pit data for **3 selected teams at once**, add a small batch
hook `useEventPits(eventKey)` in `src/dash/useTeamPit.ts` that selects all
`pit_scouting_report` rows for the event in one query and returns
`Map<number, TeamPit>`. This reuses the existing per-row normalizers
(`normalizeCapabilities`, `normalizeBatteries`, `normalizeDimensions`,
`normalizeStartPosition`) — extract them so both `useTeamPit` and `useEventPits` share them.
No schema change; same columns, same RLS (open read RLS already in place per 0009/0023).

The view additionally consumes existing read hooks for the picker team list (no new hooks
needed for these): `useEventTeams(eventKey)` (roster) and `useEventMatches(eventKey)` (match
schedule, also already needed to feed `useEventEpa` its `matches` arg for local-EPA fallback).

**Canonical shared API for the pit batch hook** (pin the signatures now so parallel features —
coverage-gaps / multi-scout-reconciliation / distribution-trend — import rather than redefine
with a clashing shape):

```ts
export function rowToTeamPit(row: Record<string, unknown>): TeamPit;        // shared normalizer
export function useEventPits(eventKey: string | null | undefined):
  UseQueryResult<Map<number, TeamPit>>;                                     // keyed Map, NOT array
```

Any other feature wanting batch pit reads must import these exact exports. Do not introduce a
second `useEventPits` returning an array — the canonical return is `Map<number, TeamPit>`.

**mapReport.ts / scoring are NOT touched.** The simulator is display-only and consumes
already-computed aggregates; the server-side scoring recompute is irrelevant here.

## 3. Files to create / modify

| Path | Precise change |
| --- | --- |
| `src/dash/allianceSimulator.ts` | **NEW.** Pure module. Exports `simulateAlliance(input)` returning `AllianceSimulation`, plus `classifyRoles(agg, pit)` and `summarizeGaps(roleReads)`. No React, no I/O. |
| `src/dash/AllianceSimulatorView.tsx` | **NEW.** React view (structure mirrors `RankingView`): team multi-select (cap 3), projected-score card, win-prob-vs-baseline card with baseline picker, role-gap table, per-team source/match-only chips. Uses `useEventReports`, `useEventEpa` (with the **union** `teamNumbers` of §2, not the scouted-only set), `useEventPits`, `useEventTeams`, `useEventMatches`. Passes `statboticsAvailable: epaQuery.data?.available === true` to `predictMatch` (§4.2). |
| `src/dash/useTeamPit.ts` | **MODIFY.** Extract the 4 inline normalizers to module scope; add `useEventPits(eventKey): UseQueryResult<Map<number, TeamPit>>` selecting all event pit rows in one query (`queryKey: ['event-pits', eventKey]`, `staleTime: 60_000`). |
| `src/dash/DashboardScreen.tsx` | **MODIFY.** Add `'alliance'` to the `Tab` union; add `{ key: 'alliance', label: 'Alliance', icon: Users, needsEvent: true }` to `TABS` (import `Users` from `lucide-react`); import `AllianceSimulatorView`; add `{tab === 'alliance' && <AllianceSimulatorView eventKey={eventKey} />}` inside the data-gated `<section>`. |
| `src/dash/__tests__/allianceSimulator.test.ts` | **NEW.** Pure-module unit tests for `simulateAlliance` / `classifyRoles` / `summarizeGaps` (see §7.1). |
| `src/dash/__tests__/AllianceSimulatorView.test.tsx` | **NEW.** Component render test for the view (selection state, baseline picker, EPA-degradation banner). Mirror the existing fixture/render harness in `src/dash/__tests__/RankingView.test.tsx` / `NextMatchView.test.tsx` (mock the query hooks). The view is the larger, riskier file — a pure-module test alone leaves its selection/baseline/banner logic untested (see §7.3). |
| `tests/e2e/alliance-simulator.spec.ts` | **NEW.** Playwright e2e against live `2026casnv` (see §7.2). |

## 4. Core logic — exact formulas / algorithms

All in `src/dash/allianceSimulator.ts`. Pure, deterministic, never throws on missing data.

### 4.1 Types

```ts
export type RoleStatus = 'strong' | 'partial' | 'none' | 'unknown';
export type SourceTag = 'blend' | 'scouting' | 'epa' | 'none';

export interface TeamRoleRead {
  teamNumber: number;
  matchesScouted: number;
  hasPit: boolean;
  source: SourceTag;          // expected-points source (from predictTeam)
  expected: number;           // per-team expected points
  roles: {
    auto: RoleStatus;
    fuel: RoleStatus;
    defense: RoleStatus;
    climbL1: RoleStatus;
    climbL23: RoleStatus;     // L2 or L3 climb
  };
}

export interface RoleGap { kind: 'gap' | 'surplus' | 'note'; text: string; }

export interface AllianceSimulation {
  teamReads: TeamRoleRead[];          // length 3 (or fewer while building)
  projectedScore: number;             // sum of expected
  scoreSource: 'blend' | 'scouting' | 'epa' | 'mixed' | 'none';
  confidence: number;                 // mean per-team w (predictMatch.confidence semantics)
  redWinProb: number | null;          // vs the chosen baseline; null if no baseline
  gaps: RoleGap[];                    // ordered, human-readable
}
```

### 4.2 Projected score and win prob — REUSE `predictMatch`

The simulator does **not** re-implement the blend. It calls `predictMatch` from
`src/dash/predict.ts` so the alliance score is consistent with the Next Match tab to the
penny:

```ts
const pred = predictMatch({
  redTeams: pickedTeams,          // the 3 selected
  blueTeams: baselineTeams,       // [] when no baseline chosen yet
  agg, epaByTeam, statboticsAvailable,
});
projectedScore = pred.red.score;
confidence    = pred.confidence;
redWinProb    = baselineTeams.length === 3 ? pred.redWinProb : null;
```

`scoreSource` is `'blend'` if every team is `blend`, the single source if all 3 agree,
`'none'` if all 3 are `none`, else `'mixed'`. Per-team `expected`/`source` are taken from
`pred.red.teams[i]`. This is exact reuse — win prob inherits the existing self-calibrating
`WINPROB_SIGMA_FRACTION` normalization (§ `src/dash/constants.ts`), accepted as a display
estimate.

**Baseline construction** (the `blueTeams` for win prob) follows §1 point 2: rank candidate
teams by the EPA-aware per-team `expected` (cheaply obtained by calling `predictTeam` /
reading a single-team `predictMatch` over the candidate set, NOT by raw
`scoutingExpectedPoints`), exclude the current picks, then take top-3 (`Top`) or the 3 around
the median (`Median`). A pure helper `pickBaseline(kind, candidates, picks, agg, epaByTeam,
statboticsAvailable): number[]` lives in `allianceSimulator.ts` and is unit-tested. `custom`
baseline teams come straight from the mini-picker.

`statboticsAvailable` **must** be passed from the view as `epaQuery.data?.available === true`
— **exactly** what NextMatchView does (`src/dash/NextMatchView.tsx:647` passes `epa.available`).
This is load-bearing for the headline "matches Next Match to the penny" promise:
`useEventEpa` sets `available: true` for BOTH a `'statbotics'` source AND a `'local'`
(match-result) EPA source (`src/dash/useEventData.ts:362-363`). `predictTeam`
(`src/dash/predict.ts:55`) NULLS OUT all EPA when `statboticsAvailable === false`, so if we
instead gated on `source === 'statbotics'`, every event running on **local** EPA (the common
offline / Statbotics-down case) would silently drop EPA from the simulator blend while
NextMatch kept it — diverging the two scores. Do **not** use `source === 'statbotics'` for the
`predictMatch` input. The `source === 'statbotics'` check is reserved for **banner copy only**
(the EPA-degradation banner / chip wording, mirroring RankingView's `epaSource` at
`src/dash/RankingView.tsx:197`).

### 4.3 Role classification — `classifyRoles(agg, pit)`

Thresholds chosen conservatively (the open question in research, resolved here). **Pit
capability is authoritative when present; match aggregates confirm/upgrade.** A role is:

- `'unknown'` when there is no pit report AND `matchesScouted === 0`.
- otherwise computed from the rules below.

Constants (define at top of `allianceSimulator.ts`, exported for the unit test):

```ts
const FUEL_STRONG = 30;   // meanFuelPoints >= 30 → strong fuel scorer
const FUEL_PARTIAL = 10;  // >= 10 → partial
const DEFENSE_STRONG = 3.5;   // avgDefenseRating (0..5) >= 3.5 → strong defender
const DEFENSE_PARTIAL = 2;    // >= 2 → partial
const CLIMB_RATE_CONFIRM = 0.5; // climbSuccessRate >= 0.5 confirms a pit-claimed climb
const CLIMB_L23_POINTS = 18;    // meanClimbPoints >= 18 implies a habitual L2/L3 climb
```

Per role:

- **auto**: pit `capabilities.includes('auto')` OR `agg.meanAutoFuel > 0` (use TeamAgg's
  `meanAutoFuel` — a clean auto-only signal). `strong` when both pit-claimed AND
  `meanAutoFuel >= 5`; `partial` when only one signal; else `none`. **Do NOT** use
  `meanClimbPoints` as an auto signal: `TeamAgg.meanClimbPoints` folds **both** teleop climb
  and the auto-climb bonus together (`src/dash/aggregate.ts:107,124,129`), so it is not an
  auto-only signal and would misclassify pure teleop climbers as auto-capable. The only clean
  auto signals available without adding a new aggregate field are pit `capabilities` +
  `meanAutoFuel`.
- **fuel**: from `agg.meanFuelPoints`: `>= FUEL_STRONG` → strong, `>= FUEL_PARTIAL` →
  partial, `> 0` → partial, else `none`. Pit `score`/`cycle` strategy bumps a `none` (with
  0 matches) up to `partial` (pit-claimed, unverified).
- **defense**: pit `capabilities.includes('defense')` or `matchStrategy.includes('defend')`
  combined with `agg.avgDefenseRating`: `>= DEFENSE_STRONG` → strong; `>= DEFENSE_PARTIAL`
  OR (pit-claimed defender with no match data) → partial; else `none`. A team whose
  `matchStrategy.includes('feed')` (feeder) is recorded for the gap summary but does NOT
  count as a defender.
- **climbL1**: pit `capabilities.includes('climb_l1')`; `strong` when confirmed by
  `climbSuccessRate >= CLIMB_RATE_CONFIRM` AND `avgClimbLevel >= 1`; `partial` when pit-only
  or low success; `none` otherwise. Match-only fallback: `avgClimbLevel >= 1 &&
  climbSuccessRate >= CLIMB_RATE_CONFIRM` → at least `partial`.
- **climbL23**: pit `capabilities.includes('climb_l2') || climb_l3`; `strong` when
  pit-claimed AND (`meanClimbPoints >= CLIMB_L23_POINTS` OR `avgClimbLevel >= 2`); `partial`
  when pit-claimed but unconfirmed by matches; match-only `strong`/`partial` when
  `meanClimbPoints >= CLIMB_L23_POINTS`; else `none`.

These are heuristics by design (research risk noted). Thresholds live as named module
constants so they are trivially tunable and unit-tested; a future Setup-tab override is
explicitly out of scope (deferred per research open question).

### 4.4 Gap summary — `summarizeGaps(reads)`

Produces an ordered `RoleGap[]` from the 3 `TeamRoleRead`s:

- Count `strong`+`partial` per role across the alliance.
- **Climb**: if zero team has `climbL23 !== 'none'` → gap `"No L2/L3 climber"`. If two+
  teams have `climbL23 === 'strong'` → note `"Double high climb available"`. If no team has
  any climb at all (L1 or L23) → gap `"No climber — 0 endgame points"`.
- **Defense**: if zero defenders → gap `"No dedicated defender"`. If 2+ feeders and 0 scorers
  → gap `"Two feeders, no primary scorer"`. **Feeder count is pit-dependent** — it is read
  from pit `matchStrategy.includes('feed')`, which only exists when a pit row was scouted, so
  on match-only events (0 pit rows) the feeder count is always 0 and this gap will not fire
  (expected; flagged in §1). It is intentionally **not** synthesized from match aggregates: a
  "low fuel + low climb + present" heuristic conflates a feeder with a weak/struggling robot
  and would produce false feeder gaps, so we keep the feeder signal honest (pit-only) rather
  than guess. The "primary scorer" half (the `0 scorers` condition) **is** match-derived
  (`fuel >= partial` from aggregates), so the gap is purely pit-feeder-gated.
- **Fuel**: if zero `fuel >= partial` → gap `"No reliable fuel scorer"`.
- **Reliability**: if any team `reliability < 0.7` → note `"Team N reliability risk
  (no-show/died)"`.
- **Data**: list any team with `source === 'none'` as a gap `"Team N: no data"`; flag
  match-only teams in a single trailing note.
- If no gaps fire, emit one `note`: `"Balanced alliance — all core roles covered."`

`gaps` are rendered top-to-bottom (`gap` red, `surplus`/`note` muted/green).

## 5. UI / UX

Lives entirely in the dashboard's shared `RouteError` boundary (it is one tab of
`DashboardScreen`, which is wrapped by the router's single `errorElement`). Dark theme,
shadcn `Card` primitives, matching RankingView's visual language.

Layout (top to bottom inside `data-testid="dash-alliance"`):

1. **Selection card** (`data-testid="alliance-picker"`): a text filter input
   (`data-testid="alliance-search"`) + a scrollable list of teams (scouted teams first,
   then roster-only). Each row is a toggle button `data-testid="alliance-pick-{team}"` with
   an aria-pressed state; disabled at cap when not already selected. A "Clear"
   (`data-testid="alliance-clear"`) button. A selected-chips strip showing the 3 picks.
2. **Projected score card** (`data-testid="alliance-score-card"`), shown only with 3 picks:
   big number `data-testid="alliance-score"`, a source badge
   `data-testid="alliance-score-source"`, and 3 per-team chips
   `data-testid="alliance-team-chip-{team}"` each showing expected pts + source.
3. **Win-prob card** (`data-testid="alliance-winprob-card"`): a baseline segmented control
   (`data-testid="alliance-baseline-top|median|custom"`); when `custom`, a second mini
   3-team picker. Renders `data-testid="alliance-winprob"` as a percentage, or "—" when no
   baseline / insufficient data.
4. **Role-gap table** (`data-testid="alliance-roles"`): rows Auto / Fuel / Defense /
   Climb L1 / Climb L2-3; columns = the 3 teams. Cells show ✓ (strong, success token),
   ~ (partial, warning token), · (none, muted), ? (unknown). Below it, the gap list
   `data-testid="alliance-gaps"` with one `data-testid="alliance-gap-{i}"` per line.

States:
- Loading: reuse RankingView's loading card pattern (`alliance-loading`).
- No event: handled upstream by DashboardScreen's `dashboard-no-event` (the actual testid at
  `src/dash/DashboardScreen.tsx:111` — do NOT reference `dash-no-event`, which does not exist
  and would silently never match in a test). The alliance tab is `needsEvent: true`, so it only
  renders inside the data-gated `<section>` that already gates on `eventKey`.
- Fewer than 3 picked: `data-testid="alliance-prompt"` "Pick 3 teams to simulate."
- EPA banner: same warning banner as RankingView when EPA is local/in-house.

All interactive elements meet the 44px min touch target already used in RankingView.

## 6. Offline behavior

Fully offline-capable, degrading exactly like the rest of the dashboard:

- `useEventReports`, `useEventPits`, `useEventEpa` are TanStack Query hooks whose cache is
  persisted to IndexedDB via `PersistQueryClientProvider` (App.tsx). An offline reload
  rehydrates the last good reports/pit/EPA, so the simulator computes from cache with zero
  network.
- EPA degrades through the existing chain: Statbotics → local match-result EPA → in-house
  scouting estimate. `simulateAlliance` consumes whatever `epaByTeam`/`source` is present;
  `predictMatch` already handles `statboticsAvailable === false` and unknown teams without
  throwing.
- No pit rows (offline before any pit sync, or pit scouting skipped) → role reads fall back
  to match-only heuristics and teams are flagged "match-only"; the feature still renders.
- The entire `simulateAlliance` computation is synchronous and pure — no awaits, no I/O — so
  it runs identically online and offline. No writes occur, so there is nothing to queue.

## 7. Test plan

### 7.1 Unit tests — `src/dash/__tests__/allianceSimulator.test.ts` (Vitest)

Build small `TeamAgg` fixtures (factory with overrides) and `TeamPit` fixtures.

- **score = sum of predictMatch expected**: 3 scouted teams with known
  `scoutingExpectedPoints` and no EPA → `projectedScore` equals the sum and equals
  `predictMatch(...).red.score` (assert exact reuse, not a reimplementation).
- **blend vs scouting source**: with `matchesScouted >= CONFIDENCE_N` and EPA present,
  per-team `source === 'blend'` and `scoreSource === 'blend'`; with EPA absent,
  `source === 'scouting'`.
- **mixed source**: one team scouting-only + one blend + one epa-only → `scoreSource === 'mixed'`.
- **win prob**: picked alliance strictly stronger than baseline → `redWinProb > 0.5`;
  symmetric weaker → `< 0.5`; `null` when fewer than 3 baseline teams.
- **pickBaseline excludes picks + ranks by EPA-aware expected**: given candidates and a picked
  set, `pickBaseline('top', ...)` returns the top-3 **expected** (predictTeam-derived, not raw
  `scoutingExpectedPoints`) with NO overlap with the picks; returns `< 3` (→ view shows "—")
  when exclusion leaves too few candidates; `median` returns teams around the median expected.
- **classifyRoles thresholds**: table-driven assertions at each boundary —
  `meanFuelPoints` 9.9/10/29.9/30 → none/partial/partial/strong; `avgDefenseRating`
  1.9/2/3.4/3.5 → none/partial/partial/strong; `climbL23` from pit `climb_l3` + 
  `meanClimbPoints` 17.9/18 → partial/strong; pit-claimed climb with 0 matches → partial.
- **unknown roles**: team with no pit and `matchesScouted === 0` → all roles `'unknown'`,
  source `'none'`.
- **gap summaries**: 
  - two feeders + one scorer-less → gap text includes "feeders";
  - no L2/L3 climber → "No L2/L3 climber";
  - all roles covered → single "Balanced alliance" note;
  - team with no data → "no data" gap naming the team number.
- **purity**: calling `simulateAlliance` twice with the same input yields deep-equal output;
  never throws when `agg` is empty or `epaByTeam` is a plain object (mirror `asEpaMap`
  tolerance — pass `epaByTeam` as `{}`).

Run: `npx vitest run src/dash/__tests__/allianceSimulator.test.ts`.

### 7.2 Playwright e2e — `tests/e2e/alliance-simulator.spec.ts`

Single-worker, live remote (`workers: 1` config already enforced), against `2026casnv`.
Follows `dashboard.spec.ts`: skip if env unset, probe `scouter_roster`, set active event via
`setActiveEvent(admin, '2026casnv')`. Read-only — no DB cleanup needed.

**Important — `2026casnv` has 0 baseline `match_scouting_report` rows** (see
`tests/e2e/simulation.spec.ts:11`). The pick buttons therefore come from the roster /
match-schedule union (§1/§2), **not** from scouted teams. Do NOT assume `>= 3` (or `>= 4`)
pick buttons exist; **assert `await picks.count()` and skip with a clear message if too few**,
so the run is deterministic on the shared single-worker live DB and never false-passes. (Do not
seed `event_team` rows on the shared live DB — keep this spec read-only as the file header
requires.)

```ts
const picks = page.locator('[data-testid^="alliance-pick-"]');
const n = await picks.count();
test.skip(n < 4, `2026casnv has only ${n} pickable teams — need >= 4 for cap test`);
```

Scenario A — *simulate a 3-team alliance*:
```
await setActiveEvent(admin, '2026casnv');
await page.goto('/dashboard');
await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
await page.getByRole('tab', { name: 'Alliance' }).click();
await expect(page.getByTestId('dash-alliance')).toBeVisible({ timeout: 25_000 });
// prompt shown before 3 picks
await expect(page.getByTestId('alliance-prompt')).toBeVisible();
// pick the first 3 teams from the union list (roster/schedule-sourced; not scouted —
// 2026casnv has 0 reports). Guard count first:
const picks = page.locator('[data-testid^="alliance-pick-"]');
test.skip((await picks.count()) < 4, 'need >= 4 pickable teams for the full e2e');
await picks.nth(0).click();
await picks.nth(1).click();
await picks.nth(2).click();
// score + role table appear
await expect(page.getByTestId('alliance-score')).toBeVisible({ timeout: 15_000 });
await expect(page.getByTestId('alliance-score-source')).toBeVisible();
await expect(page.getByTestId('alliance-roles')).toBeVisible();
// score is a finite non-negative number
const txt = await page.getByTestId('alliance-score').innerText();
expect(Number(txt.replace(/[^\d.]/g, ''))).toBeGreaterThanOrEqual(0);
```

Scenario B — *cap at 3 + clear*:
```
// a 4th pick is blocked: the 4th unselected button is disabled
const fourth = picks.nth(3);
await expect(fourth).toBeDisabled();
await page.getByTestId('alliance-clear').click();
await expect(page.getByTestId('alliance-prompt')).toBeVisible();
```

Scenario C — *win prob vs baseline*:
```
// re-pick 3, choose Top baseline, assert a win-prob percentage renders
await picks.nth(0).click(); await picks.nth(1).click(); await picks.nth(2).click();
await page.getByTestId('alliance-baseline-top').click();
await expect(page.getByTestId('alliance-winprob')).toBeVisible();
await expect(page.getByTestId('alliance-winprob')).toContainText('%');
```

Run: `npx playwright test tests/e2e/alliance-simulator.spec.ts`.

### 7.3 Component render test — `src/dash/__tests__/AllianceSimulatorView.test.tsx` (Vitest + RTL)

Mirror the fixture/render harness in `src/dash/__tests__/RankingView.test.tsx` /
`NextMatchView.test.tsx` (mock the `useEventData` / `useTeamPit` query hooks with fixtures;
render with a `QueryClientProvider`). Covers the view logic a pure-module test cannot:

- **picker renders with 0 reports**: hooks mocked so `useEventReports` is empty but
  `useEventMatches` returns a schedule → at least 3 `alliance-pick-{team}` buttons render
  (validates the §1/§2 union team-list sourcing).
- **selection + cap**: clicking 3 pick buttons shows `alliance-score`; the 4th unselected
  button is `disabled`; `alliance-clear` resets to `alliance-prompt`.
- **unscouted pick fetches EPA**: assert the mocked `useEventEpa` is called with a
  `teamNumbers` array that **includes** a selected unscouted team (guards the §2 union; this is
  the regression the review flagged — copying RankingView's scouted-only list would silently
  break it).
- **statboticsAvailable wiring**: with the EPA hook returning `{ available: true, source:
  'local' }`, assert the team chips/score reflect a blended (not scouting-only) source —
  guarding that the view passes `available === true`, not `source === 'statbotics'`.
- **EPA degradation banner**: `source === 'local'` renders the in-house-EPA warning banner
  (same copy/condition as RankingView); `source === 'statbotics'` does not.
- **win-prob baseline excludes picks**: selecting the top-3 then choosing `Top` baseline does
  not yield a ~50% self-vs-self; the baseline omits the picked teams (or renders "—" if < 3
  remain).

Run: `npx vitest run src/dash/__tests__/AllianceSimulatorView.test.tsx`.

## 8. Conflict surface (vs the other 12 planned features)

`DashboardScreen.tsx` is the **primary shared file** — every dashboard-tab feature edits the
`Tab` union + `TABS` array + the conditional render block. These features all add tabs and
will collide on the SAME three edit sites in `DashboardScreen.tsx`:

- **defense-analytics**, **matchup-intelligence**, **smart-picklist**, **coverage-gaps**,
  **dashboard-heartbeat**, **scouter-load-accuracy**, **distribution-trend**,
  **auto-path-heatmap**, **multi-scout-reconciliation**, **match-video**, **export-presets**
  — if any of these add a dashboard tab, they touch `Tab`, `TABS`, and the render switch.
  → Mitigation: land tab additions as small, additive, append-only edits (add to the END of
  the `TABS` array and a new `&&` line); resolve merge order by serializing the
  `DashboardScreen.tsx` edits in the execution batch.

Secondary shared files:
- `src/dash/useTeamPit.ts` — **coverage-gaps**, **multi-scout-reconciliation**, and
  **distribution-trend** may also want batch pit/report reads. The extracted normalizers +
  `useEventPits` are additive, but this is a **HIGH** collision risk if two features add a
  `useEventPits` with different return shapes (e.g. `Map` vs array). **The canonical exports
  are pinned now** (see §2): `export function useEventPits(eventKey):
  UseQueryResult<Map<number, TeamPit>>` and `export function rowToTeamPit(row): TeamPit`. Other
  features MUST import these exact exports rather than redefine — do NOT add a second array-shaped
  `useEventPits`. This is the canonical shared API.
- `src/dash/predict.ts` & `src/dash/aggregate.ts` — **matchup-intelligence** and
  **defense-analytics** read the same `predictMatch`/`TeamAgg`. This feature only *consumes*
  them and adds nothing, so it is read-only on those modules → low conflict, but if
  matchup-intelligence changes `predictMatch`'s signature, re-verify the simulator call site.
- `src/dash/constants.ts` — win-prob constants are shared; this feature reads them, does not
  change them.

No conflict with `mapReport.ts`, the sync engine, QR, or any migration (none added).

## 9. Step-by-step execution checklist

1. Branch off `main` (e.g. `feat/alliance-simulator`). Do NOT touch deployed migrations.
2. In `src/dash/useTeamPit.ts`: lift `normalizeCapabilities`, `normalizeBatteries`,
   `normalizeDimensions`, `normalizeStartPosition` to module scope (no behavior change), add
   the canonical shared `export function rowToTeamPit(row): TeamPit` mapper, refactor
   `useTeamPit` to use it, then add the canonical `export function useEventPits(eventKey):
   UseQueryResult<Map<number, TeamPit>>` from one event-scoped query
   (`queryKey: ['event-pits', eventKey]`, `staleTime: 60_000`). Keep the return a `Map`, not an
   array (pinned API — §2/§8).
3. Create `src/dash/allianceSimulator.ts`: types from §4.1, exported threshold constants,
   `classifyRoles`, `summarizeGaps`, and `simulateAlliance` that delegates the score/win-prob
   math to `predictMatch`. No React, no async.
4. Write `src/dash/__tests__/allianceSimulator.test.ts` (§7.1); run
   `npx vitest run src/dash/__tests__/allianceSimulator.test.ts` until green.
5. Create `src/dash/AllianceSimulatorView.tsx` (§5): wire `useEventReports` →
   `aggregateEvent`, `useEventPits`, plus `useEventTeams` + `useEventMatches` for the picker
   team-list **union** (scouted ∪ roster ∪ schedule teams — §1/§2, so the list renders with 0
   reports). Build the `useEventEpa` `teamNumbers` as the **union of scouted + selected +
   baseline picks** (§2 — NOT scouted-only; do not copy RankingView here). Pass
   `statboticsAvailable: epaQuery.data?.available === true` (NOT `source === 'statbotics'`) into
   the `predictMatch`/`simulateAlliance` call (§4.2). Reserve `source === 'statbotics'` purely
   for the EPA-degradation banner copy. Selection state (cap 3); baseline picker that excludes
   already-picked teams (§1 point 2 / §4.2 `pickBaseline`); render score / win-prob / role / gap
   panels with the testids in §5. Match RankingView's loading/empty/EPA-banner patterns.
6. Write `src/dash/__tests__/AllianceSimulatorView.test.tsx` (§7.3) mirroring
   `RankingView.test.tsx` / `NextMatchView.test.tsx`; run
   `npx vitest run src/dash/__tests__/AllianceSimulatorView.test.tsx` until green.
7. Edit `src/dash/DashboardScreen.tsx`: import `Users` from `lucide-react`; add
   `'alliance'` to `Tab`; append `{ key: 'alliance', label: 'Alliance', icon: Users,
   needsEvent: true }` to the END of `TABS`; import `AllianceSimulatorView`; add
   `{tab === 'alliance' && <AllianceSimulatorView eventKey={eventKey} />}` **inside** the
   data-gated `<section>` (`src/dash/DashboardScreen.tsx:115-123`), as the last `&&` line.
   These three edit sites are append-only to minimize collision with other tab features.
8. `npm run typecheck` and `npm test` — fix any fallout.
9. Write `tests/e2e/alliance-simulator.spec.ts` (§7.2). Run with the dev server up:
   `npx playwright test tests/e2e/alliance-simulator.spec.ts` (single worker, live
   `2026casnv`).
10. Manual smoke in `npm run dev`: pick 3, verify score matches a hand-blend, toggle
    baselines, confirm offline (devtools offline + reload) still renders from cache.
11. Open PR. **No `supabase db push`, no `functions deploy`, no migration** — pure client
    feature. Do not mark any migration deployed.
