# Component EPA Estimation — Per-Alliance Scoring Breakdown (auto / fuel / climb / defense)

Status: PLAN (not yet implemented). No migration unless a user approves the optional server path in §10.

> **Review-applied revision (2026-06-29).** A risk review found the original residual-defense
> model circular and the data-flow assumptions mismatched against the real EPA architecture. This
> revision: (1) makes **defense scouting-only for v1** (drops the circular EPA-residual defense
> path from the shipped scope — see §7); (2) corrects the data-flow to a **dedicated event-wide
> `computeLocalEpa` pass** instead of the per-team season pools that actually exist (§1, §3, §9);
> (3) drops the dead `computeComponentEpas(matches, scalarEpa)` map and splits components directly
> off `TeamPrediction.expected` (the basis the UI already shows), so the Statbotics-vs-TBA scale
> mismatch can't occur (§3, §6); (4) scopes Tier-2 breakdown extraction to **single-event raw JSON**
> only (§3B, §4, §9); (5) corrects the MatchView scope from "add a card" to "introduce the whole
> EPA+prediction stack" (§2, §12); (6) states the additive invariant on **unrounded** values with an
> explicit e2e tolerance (§8, §13); (7) derives the scouting split from the **same `fuelPointsWeighted`
> basis** the prediction uses, not raw `FUEL_POINTS` counts (§3A, §6); and (8) skips the e2e
> deterministically on an empty event (§13). The defense-model choice and the optional server path
> are the two human-approval gates (§11, §16).

## 0. Goal & scope

Estimate **per-alliance scoring components** even with **zero scouting data**, preferring scouting
when it exists. Concretely, for each team we surface four numbers, each tagged with its data source:

1. **auto** points — robot's auto-period contribution.
2. **fuel** points — teleop fuel scoring (the active + inactive HUB fuel windows, collapsed to one
   teleop-fuel figure; see §5 for why we don't try to split active/inactive from TBA).
3. **climb / endgame** points — endgame climb contribution.
4. **defense** — how much this team *suppresses the opposing alliance's* points (a subtraction, not
   an addition to its own alliance — see §7). **v1 scope: defense is SCOUTING-ONLY.** A team with no
   scouted defense data shows `—`. There is no results-derived ("EPA") defense estimate in v1 — see
   §7 for why the previously-planned opponent-score-residual model was dropped as circular.

These appear as a per-alliance component breakdown in the **Match tab** (`MatchView`), are reused by
the **prediction** (`predict.ts` / `NextMatchView`), and degrade gracefully offline and when TBA is
down.

### The hard constraint that shapes everything

The local `match` table stores **only total `actual_red_score` / `actual_blue_score`** — no
component breakdown. `localEpa.ts`'s header says component EPA "isn't available client-side." The TBA
research says the **raw TBA `score_breakdown` JSON exists** and could be extracted client-side via
`tba-proxy`, BUT:

- The exact 2026 REBUILT `score_breakdown` field names are **unconfirmed in live data** (no 2026
  event has published matches we can inspect yet — see §11 open questions).
- Active/inactive HUB status (the defining 2026 mechanic) is **not** reliably in `score_breakdown`.

So this plan uses a **two-tier sourcing design**:

- **Tier 1 (ships now, no migration, no TBA-schema dependency): proportional split.** Split each
  team's **already-computed `TeamPrediction.expected`** (the blended scouting+EPA number the rest of
  the dashboard already shows) into auto/fuel/climb using **a fixed proportional split that is re-fit
  from scouting data when scouting exists**. This works the instant the app has played-match results
  + (optionally) scouting, and has zero dependency on unconfirmed TBA breakdown keys. **Defense in
  Tier 1 is scouting-only** (`agg.defenderEffectiveness` / `avgDefenseRating`), not results-derived.
- **Tier 2 (opt-in, behind a feature flag, lights up once TBA keys are confirmed): breakdown
  extraction.** A defensive `parseRebuiltBreakdown()` reads `score_breakdown` if present and the keys
  match; otherwise it returns `null` and Tier 1 is used. No code path *depends* on Tier 2 existing.

This keeps shipping velocity high and never blocks on TBA's unconfirmed schema, while leaving a clean
seam to upgrade accuracy later.

---

## 1. Overview of the data flow

**Important architectural correction.** The real codebase has **no shared cross-team scalar-EPA Map
computed from one event-wide `MatchRow[]`.** `useEventEpa` → `seasonEpaForTeam` runs PER TEAM, each
calling `fetchSeasonMatchRows([team], …)` (single-element array) and `computeLocalEpa` over THAT
team's own season-union match set, then `.get(team)`. The six teams in a match are therefore
decomposed over six *different* match pools, and the scalar it returns is usually **Statbotics**
(`seasonEpaForTeam` prefers `parseStatboticsTeamYear`; `computeLocalEpa` is only the offline
fallback). So we deliberately do **not** try to build component values from that per-team season EPA.

Tier 1 splits **`TeamPrediction.expected`** — the single blended number the dashboard already shows
for each team — using a fraction `f=(fAuto,fFuel,fClimb)` fitted from event-wide scouting (or
`F_DEFAULT` when scouting is thin). The fraction is the only new "intelligence"; there is **no
separate EPA-derived component map** (the original `computeComponentEpas(matches, scalarEpa)` is
dropped — after the §6 rescale to `expected` it was dead intermediate computation that also mixed
the Statbotics scalar with a TBA-fit fraction).

```
scouting reports (MsrRow[])                 TeamPrediction.expected  (from predictMatch,
        │                                    blended scouting+EPA — basis the UI shows)
        ▼                                                  │
aggregateEvent → TeamAgg/team                              │
        │                                                  │
        ├── fitComponentFraction(aggs) ─→ f=(fAuto,fFuel,fClimb)   (event-wide; F_DEFAULT cold-start)
        │                                                  │
        └── aggregateTeamComponentBreakdown(agg)           │
              → {auto,fuel,climb} scouting basis,          │
                defense (scouting-only: defenderEffectiveness / avgDefenseRating)
                                   │                        │
                                   ▼                        ▼
        resolveComponentBreakdown(team, agg, f, expected)
            │  source = scouting (matchesScouted>0)  ──→ split from agg means, RESCALED to expected
            │           else epa (expected present)  ──→ split expected by f
            │           else none                    ──→ all '—'
            │  defense = scouting-only (agg) or null('—')
            ▼
        ComponentBreakdown { auto, fuel, climb, defense, source: 'scouting'|'epa'|'none' }
            │
        ┌───┴───────────────────────────────────────┐
        ▼                                           ▼
  predict.ts (TeamPrediction.components)      MatchView "Scoring estimate" card
        ▼
  NextMatchView per-team component lines
```

Tier 2 (dark, single-event only) adds a results-derived split via `parseRebuiltBreakdown` over the
**raw single-event JSON** from `fetchEventMatchesCached(eventKey)` — see §3B/§4/§9. It is the only
place a dedicated event-scoped `computeLocalEpa` pass appears, and it stays behind a flag until the
2026 keys are confirmed.

New computation is **pure** and lives alongside `localEpa.ts` / `aggregate.ts`. The view-layer hook
(`useEventComponentEpas`) mirrors `useEventEpa`'s caching/persistence; in v1 it returns only the
fitted fraction + scouting-defense map (no per-team EPA-component map and no defense-residual map).

---

## 2. Exact UI — Match tab (`src/dash/MatchView.tsx`)

> **Scope correction.** `MatchView.tsx` today imports only `useEventMatches` / `useEventReports` /
> `useEventScouts` — it has **no EPA or prediction at all** (only `NextMatchView` does). "Add a card"
> therefore actually means **introducing the entire EPA+prediction stack** into this view: select the
> six teams of the *selected* `MatchRow`, call `useEventEpa(sixTeams, eventKey)` +
> `useEventComponentEpas(sixTeams, eventKey)` + `predictMatch(...)`, mirroring NextMatchView's
> existing block (`NextMatchView.tsx` ~lines 626–662). Budget for the **added per-match-selection TBA
> fan-out** (six teams' season events+matches, cached/persisted but a real cost on the Match tab) and
> for the **empty-state when no match is selected** (render nothing / the existing match-list pane
> only). This is materially more work and more failure surface than the original "one card" framing.

Add a single new card, **"Scoring estimate"**, rendered in the detail pane of the selected match,
positioned **above** `MatchTimelines` and below `ScoutingStatusCard` (so it reads as a headline
summary before the per-report detail). It shows **both alliances side by side**, each with its three
*additive* components plus a defense line.

### Layout (one card, two alliance columns)

```
┌──────────────────────────────────────────────────────────────────┐
│  📊  Scoring estimate                         estimate · provisional│
├───────────────────────────────┬──────────────────────────────────┤
│  RED  — pred 142               │  BLUE — pred 128                  │
│  ┌─────────────────────────┐   │  ┌─────────────────────────┐     │
│  │ 254  •scouting           │   │  │ 1678 •epa                │     │
│  │  auto 18 · fuel 71 · climb 30 │  auto 12 · fuel 55 · climb 20    │
│  │  defense ↓6 on opp        │   │  defense —                 │     │
│  └─────────────────────────┘   │  └─────────────────────────┘     │
│  …team 2…                       │  …team 2…                        │
│  …team 3…                       │  …team 3…                        │
│  ───────────────────────────   │  ───────────────────────────     │
│  alliance defense: ↓14 on BLUE  │  alliance defense: ↓0 on RED     │
└───────────────────────────────┴──────────────────────────────────┘
   Source legend: ● scouting (green)  ● estimate/EPA (cyan)  ● none (gray)
   Footnote: "Components are estimates derived from results + scouting; auto/fuel/climb
   sum to the predicted alliance score. Defense is the points this team removes from the
   opposing alliance — not added to its own."
```

Rules / details:

- **Per-team line** = `Team# [source-badge]` then `auto N · fuel N · climb N`, then a sub-line
  `defense ↓N on opp` (omitted/`—` when the team has no defense estimate).
- **Source badge** per team, reusing `NextMatchView`'s existing `SOURCE_LABEL` / `SOURCE_CLASS` color
  scheme: green = `scouting`, cyan = `epa`, gray = `none`. The badge reflects the **component source**
  (the worst/most-degraded source across the team's components — i.e. if auto/fuel/climb came from EPA
  but defense from scouting, label `epa`; the badge is informational, not exact-per-field).
- **Card-level chip** in the header: `estimate` always; add `· provisional` when **any** surfaced
  team's estimate is gated low-sample (see §6 gating). Make the whole card visually distinct from
  scouted truth — muted card border, the word "estimate" in the title — so a lead never confuses an
  estimated 71 fuel pts with a measured one.
- **Alliance footer**: sum of the three additive components is shown as the alliance "pred" in the
  column header (and must equal the prediction's alliance score for that match — see §8 invariant).
  The **alliance defense** line is the sum of member defense suppression imposed on the *other*
  alliance.
- **Empty live event** (no matches played, no scouting): every team renders `auto — · fuel — · climb —`
  and `defense —`, badge `none`, and the card shows a single muted line "No results or scouting yet —
  estimates appear once matches are played." (This is the state the Playwright e2e asserts; see §12.)

`data-testid` hooks to add (for the e2e + unit-rendering):
`dash-match-estimate` (card), `dash-match-estimate-team-{team}` (per-team line),
`dash-match-estimate-auto-{team}` / `-fuel-{team}` / `-climb-{team}` / `-defense-{team}`,
`dash-match-estimate-source-{team}`, `dash-match-estimate-empty` (the no-data line).

### `NextMatchView` (smaller change, reuse the same resolver)

Extend `TeamRowView` to render a third muted line under the existing `scouted / climb / defense`
chips: `auto N · fuel N · climb N` with the same per-component values from `resolveComponentBreakdown`.
Keep it inline (one extra `text-xs` row), not a sub-card, to preserve the broadcast density. Add
`data-testid="dash-next-components-{team}"`. The existing `dash-next-team-expected` total stays and
**must equal** `auto+fuel+climb` for that team (§8 invariant).

---

## 3. Component math — proportional split of the predicted total

There is **no per-component EPA recurrence in v1.** We split the team's existing blended prediction
total `expected` by a fitted fraction. This cannot violate the additive invariant (§8) and never
mixes the Statbotics scalar with a TBA-fit fraction (the bug the original `computeComponentEpas`
introduced).

### 3A. Proportional split (Tier 1 — ships now)

Define a **global component fraction triple** `f = (fAuto, fFuel, fClimb)` with `fAuto+fFuel+fClimb=1`.
Then for a team with predicted total `expected`:

```
auto  = fAuto  * expected
fuel  = fFuel  * expected
climb = fClimb * expected
```

This trivially satisfies `auto+fuel+climb = expected` (§8 invariant) for every team. (When the team
*has* scouting, the split instead comes directly from that team's own scouted means and is then
rescaled to `expected`; the fraction `f` only governs the **no-scouting** EPA-source teams. See §6.)

**Fitting `f` (used for the no-scouting branch):**

- **If scouting exists for the event** (≥ `MIN_FIT_REPORTS`, e.g. 8 reports across the event), fit `f`
  from the *event-wide scouting means*, **using the SAME quantities that feed
  `scoutingExpectedPoints` in `aggregate.ts`** so the split shares the prediction's basis. Concretely,
  `scoutingExpectedPoints = fuelPointsWeighted + meanClimbPoints`, where `fuelPointsWeighted =
  meanFuelPoints * meanFuelConfidence` (a confidence-down-weighted figure — **not** raw fuel counts ×
  `FUEL_POINTS`). So:

  ```
  // Decompose fuelPointsWeighted by the team's auto/teleop-fuel proportion, so the
  // confidence down-weighting the dashboard applies is preserved in every bucket:
  rawAuto  = meanAutoFuel * FUEL_POINTS
  rawFuel  = (meanTeleopFuelActive + meanTeleopFuelInactive + meanEndgameFuel) * FUEL_POINTS
  fuelTot  = rawAuto + rawFuel            // guard 0 -> all weighted fuel to fuel bucket
  autoPts  = fuelPointsWeighted * (rawAuto / fuelTot)     // auto FUEL share of weighted fuel
  fuelPts  = fuelPointsWeighted * (rawFuel / fuelTot)
  climbPts = meanClimbPoints              // already points; auto-climb bonus lands here
  // event-wide fraction = mean of each bucket over scouted teams, normalized:
  T = mean(autoPts) + mean(fuelPts) + mean(climbPts)
  f = (mean(autoPts)/T, mean(fuelPts)/T, mean(climbPts)/T)   // guard T>0 -> F_DEFAULT
  ```

  This makes the per-team scouting split (§6) and the fitted fraction `f` share **one basis**
  (`scoutingExpectedPoints`), so the §6 rescale is a no-op-scale on scouted teams rather than papering
  over a basis mismatch, and the split does **not** silently break if `SCORING.FUEL_POINTS` changes
  from its currently-flagged value of `1`.

  **`auto` is auto FUEL only.** The L1 auto-climb bonus (`SCORING.CLIMB[1].auto`, ~15 pts) lands in
  `meanClimbPoints` (per `climbPointsForMatch`) and is therefore counted as **climb**, not auto. This
  must be stated in the UI footnote (§2), not only a code comment, so a lead reading "auto 18" knows
  auto-climb points are excluded from that figure.

- **Else (no/low scouting)** use a **fixed REBUILT default split** `F_DEFAULT`, a constant in
  `localEpa.ts` (initial guess `fAuto=0.15, fFuel=0.55, fClimb=0.30`, FLAGGED for tuning — see §11).
  This is the cold-start fallback so a brand-new event with no scouting still produces a plausible
  breakdown.

`fitComponentFraction(aggs)` is a **pure** function returning `f`; unit-tested in isolation. There is
**no** `computeComponentEpas(matches, scalarEpa)` function — the split happens inside
`resolveComponentBreakdown` against `expected`.

### 3B. Per-component recurrence over SINGLE-EVENT raw breakdown (Tier 2 — when TBA keys confirmed)

> **Scope correction.** `MatchRow` (and thus `fetchSeasonMatchRows` output) has **no
> `score_breakdown` field** — `tbaMatchesToRows` drops it on conversion. So a per-component recurrence
> cannot run over the season `MatchRow[]`. Tier 2 is therefore **single-event only**: it consumes the
> **raw objects** from `fetchEventMatchesCached(eventKey)` (which *do* include `score_breakdown`) and
> runs a **dedicated event-scoped `computeLocalEpa` pass** distinct from the season EPA the prediction
> uses. A season-wide raw-breakdown recurrence would need a brand-new per-team raw fan-out and is **out
> of scope** for both v1 and Tier 2 unless explicitly added later.

When `parseRebuiltBreakdown` yields real per-alliance component scores for a single event, build an
event-only `MatchRow`-like set carrying per-component alliance scores and run **the same recurrence
three times** (once per component) plus once for the scalar. Then **renormalize** so
`auto+fuel+climb` equals the independently-computed event-scalar `E` (divide each by their sum,
multiply by `E`). This is strictly more accurate (no global-fraction assumption) but is single-event,
depends on confirmed keys, and stays dark behind a flag.

Implementation: factor the core loop of `computeLocalEpa` into an internal
`runEpaRecurrence(matches, scoreOf: (m)=>{red,blue})` so the scalar path and each component path reuse
it. Low risk, pure refactor, covered by existing localEpa tests. (This refactor is the only part of
Tier 2 worth landing early, since it's a behavior-preserving cleanup of the existing scalar path.)

---

## 4. Climb / endgame estimate

- **Tier 1 (no breakdown):** climb is `fClimb * expected` (§3A) for no-scouting teams, or the team's
  own scouted `meanClimbPoints` rescaled to `expected` when scouted. When scouting exists, `fClimb` is
  fitted from real `meanClimbPoints`, so the climb estimate is scouting-informed even for unscouted
  teams (they inherit the event-wide climb fraction). This is the only client-side option without
  breakdown data and is honest about being an estimate.
- **Tier 2 (breakdown confirmed, SINGLE-EVENT only):** read the endgame/tower/climb point field from
  `score_breakdown` in the **raw `fetchEventMatchesCached(eventKey)` JSON** (candidate keys per TBA
  research: `endgameClimbPoints`, `endgamePoints`, `autoClimbPoints` for the auto L1 bonus).
  `parseRebuiltBreakdown` returns `{ auto, fuelTeleop, climb }` per alliance or `null`. Climb then
  flows through the 3B event-scoped per-component recurrence (not the season pool). **Defensive
  parsing**: every key access is `finiteOrNull`-guarded; a missing/renamed key makes the whole parse
  return `null` and we silently fall back to Tier 1. Never throw on TBA schema drift (§ risk).
- Per-robot vs per-alliance climb (open question §11): `parseRebuiltBreakdown` aggregates to the
  **alliance** level regardless (sum the three robot values if per-robot), because the EPA recurrence
  attributes the alliance residual across teams itself.

---

## 5. Why fuel is one number (active/inactive not split from TBA)

The active/inactive HUB distinction is **not** recoverable from TBA `score_breakdown` (research risk:
"Active/inactive HUB status … is NOT in score_breakdown"). Therefore the **EPA-derived** fuel
component is a single `fuel` figure (teleop active+inactive+endgame fuel collapsed). When the source is
**scouting**, we *do* have `meanTeleopFuelActive` / `meanTeleopFuelInactive` separately on `TeamAgg`,
but for a uniform UI and a clean blend we still surface one combined `fuel` number (summing the three
scouting fuel means × `FUEL_POINTS`). Splitting active/inactive in the UI is explicitly out of scope
(can be a later enhancement gated on FMS game state). Auto fuel is its own `auto` component.

---

## 6. The "prefer scouting, else estimate" resolver

New pure function in `predict.ts`:

```ts
export interface ComponentBreakdown {
  auto: number;
  fuel: number;
  climb: number;
  defense: number;            // points removed from the OPPOSING alliance (>=0); 0 when unknown
  source: 'scouting' | 'epa' | 'none';
  provisional: boolean;       // true when surfaced from a low-sample estimate (gating, §6)
}

export function resolveComponentBreakdown(
  teamNumber: number,
  agg: TeamAgg | undefined,
  expected: number,                      // the team's TeamPrediction.expected (the basis we split)
  fraction: { fAuto: number; fFuel: number; fClimb: number }, // from fitComponentFraction (no-scouting branch)
  predictionSource: TeamPrediction['source'], // 'blend' | 'scouting' | 'epa' | 'none' — drives our label + gate
): ComponentBreakdown
```

The resolver takes **`expected`** (the already-blended total) and the fitted `fraction`. It does NOT
take an `epaComponents` map (deleted — see §3) and does NOT take a results-derived defense estimate
(dropped — see §7). The old `statboticsAvailable` parameter is removed (it was unused for components).

Resolution order (label mirrors the prediction source so the two never disagree):

1. **scouting** when `agg && agg.matchesScouted > 0`:
   - Split is taken from this team's own scouted means on the `scoutingExpectedPoints` basis
     (§3A formulas: `autoPts`, `fuelPts` from decomposed `fuelPointsWeighted`, `climbPts =
     meanClimbPoints`), then **rescaled to `expected`** (below).
   - `defense` = **scouting-only** defender points (see §7 scouting branch) or `null` when no defense
     sample. `source='scouting'`. `provisional=false` (we trust scouted observations at any m>0,
     matching `predictTeam`).
2. **epa** when no scouting but `expected > 0` and the event has `>= MIN_EPA_MATCHES` played matches:
   - `auto = fAuto*expected`, `fuel = fFuel*expected`, `climb = fClimb*expected`.
   - `defense = null` (`—`): **there is no results-derived defense in v1** (§7). `source='epa'`.
   - `provisional=true` (estimate from an event-wide fraction, no per-team component observation).
3. **none**: all `—`, `defense=null`, `source='none'`, `provisional=false`. Used when `expected<=0`,
   below `MIN_EPA_MATCHES`, or the prediction source is `'none'`.

**Rescale (scouting branch only — and a no-op-scale by construction):** after computing the scouted
split, rescale so the three components sum exactly to `expected`:

```
s = auto+fuel+climb
if s>0: k = expected/s; auto*=k; fuel*=k; climb*=k
else:   distribute expected by fraction (then by F_DEFAULT if fraction degenerate)
```

Because the scouted split is built on the **same `scoutingExpectedPoints` basis** that
`predictTeam`'s scouting term uses, `k≈1` when the prediction is scouting-only, and `k` is exactly the
blend ratio when the prediction blended in EPA — so the components reconcile to the displayed total
with no hidden basis mismatch. The **epa** branch is already exact-by-construction (`f` sums to 1), so
no rescale needed there. Defense is **never** rescaled (orthogonal subtraction; §8).

### Gating (sample thresholds)

- **EPA component split** is only surfaced (`source='epa'` rather than `'none'`) when the event has
  `>= MIN_EPA_MATCHES` played matches (e.g. 2). This matches the research mitigation ("require
  minimum-match gating"). Below it, no-scouting teams show `—`.
- **Scouting defense** is surfaced only when `agg.defenseSampleCount >= 1` (and, for the
  fuel-co-occurrence path, `agg.defenderEffectiveness != null`); otherwise `defense=null` → `—`.
  There is **no** `DEFENSE_MIN_OPPONENTS` residual gate in v1 (the residual path is gone).

---

## 7. DEFENSE model — SCOUTING-ONLY for v1 (results-residual path dropped)

**Chosen model: scouting co-occurrence (`defenderEffectiveness`), with a `defense_rating` ordinal
fallback. No results-derived ("EPA") defense in v1.** Teams with no scouted defense data show `—`.

### Why the opponent-score-residual model was dropped (the review's blocking issue)

The original plan computed defense as `shortfall = max(0, expectedA - actualA)` where
`expectedA = sum of alliance A's scalar local EPAs`. This is **circular**: `computeLocalEpa`'s entire
update rule (`localEpa.ts` lines ~232–245) drives `sum(teamEPA)` toward each alliance's **actual**
score every match (`err = ownScore - ownEPA`, applied with a learning rate). So "expected alliance
score" tracks "actual alliance score" *by construction* — the residual the plan called "defense" is
just EPA estimation **lag/noise** (a team that recently improved, an early-season team, a
high-variance team), not opponent suppression. Worse, `max(0, …)` keeps only the negative-noise tail,
so **every** team accrues a positive "defense" number purely from EPA undershoot — there is no zero
baseline. This would surface plausible-looking `↓N` defense values for teams that never play defense.

A correct results-based estimate would require (a) a **pre-match EPA snapshot held out of that
match's update**, (b) **per-event zero-mean normalization** so only relative under/over-performance
counts, and (c) **validation against scouted `defenderEffectiveness` on a real event before
shipping** — plus the event-wide match set that, per §1, does not exist today. That is a research
project, not a v1 feature. **It is explicitly out of scope.** (If a future iteration wants it, it is
listed as an open decision in §11 and must clear (a)–(c) before shipping.)

### v1 formula (scouting-only) — in `resolveComponentBreakdown`'s scouting branch

When `agg.matchesScouted > 0`, layer:

1. If `agg.defenderEffectiveness != null && agg.defenseSampleCount >= 1`: map the suppression fraction
   to points via a typical opponent fuel rate —
   `defensePts = defenderEffectiveness * TYPICAL_OPP_TELEOP_FUEL` (constant FLAGGED for tuning, §11),
   so 0.30 suppression ≈ 0.30 × that constant. This is the precise co-occurrence signal (needs scouted
   `defense_intervals` + opponent `fuel_bursts`).
2. Else fall back to the ordinal map:
   `defensePts = agg.avgDefenseRating / 3 * DEFENSE_RATING_MAX_PTS` (e.g. `DEFENSE_RATING_MAX_PTS = 20`),
   so a 1.5/3 rating ≈ 10 pts.
3. Else (`defenseSampleCount === 0` and no rating) → `defense = null` → renders `—`.

A team with **no scouting at all** (`source='epa'` / `'none'`) always shows `defense —`. This is
honest: we have no client-side, non-circular way to estimate suppression from TBA results alone.

### Stated limits (UI footnote + code comment)

- The scouting co-occurrence path only covers **fuel suppression** (not denied climbs/cycles) and
  needs scouted defense intervals.
- The ordinal fallback is contextless (a consensus rating, not measured points).
- Defense is a **subtraction from the opposing alliance**, displayed `↓N on opp`, and is **not added**
  to this team's own auto/fuel/climb (§8).

---

## 8. Invariants & how the prediction uses components

1. **Additive sum invariant (UNROUNDED only):** for every team, the **float** values satisfy
   `auto + fuel + climb == TeamPrediction.expected` (enforced by the §6 rescale). This holds **before
   display rounding only.** The UI rounds `expected` with `round()` (NextMatchView ~line 235) and will
   round each component independently, so the **rounded** parts frequently will NOT sum to the rounded
   total (e.g. `round(18.4)+round(71.4)+round(30.4)=18+71+30=119` vs `round(120.2)=120`). Unit tests
   assert the invariant on the **pre-round floats** (within float epsilon). Do **not** assert exact
   equality of rounded sums anywhere. (Optionally display one decimal to reduce visible drift; not
   required.)
2. **Alliance sum invariant (unrounded):** sum of a team-column's three components over its three
   teams == `MatchPrediction.{red|blue}.score`, on floats. Follows from (1).
3. **Defense is orthogonal:** defense never enters the additive sum. Prediction *use* of defense is
   **opt-in and conservative**: extend `predictMatch` to (optionally, behind a constant
   `APPLY_DEFENSE_TO_PREDICTION`, default **false** for v1) subtract a fraction of an alliance's total
   member-defense from the *opposing* alliance's predicted score. We default it OFF so the visible
   prediction math is unchanged on first ship. Because v1 defense is **scouting-only**, turning it on
   would only ever move the prediction on events with scouted defense data; it stays a follow-up. This
   keeps the change non-regressive (existing prediction tests stay green).

`TeamPrediction` gains an optional field so existing fixtures keep type-checking:

```ts
export interface TeamPrediction {
  teamNumber: number;
  expected: number;
  w: number;
  source: 'blend' | 'scouting' | 'epa' | 'none';
  components?: ComponentBreakdown;   // OPTIONAL — additive auto/fuel/climb sum to `expected` (unrounded)
}
```

`predictMatch` accepts an optional `fractionByTeam` / `fraction` input (the fitted `f`), and when
provided attaches `components` to each `TeamPrediction` via `resolveComponentBreakdown` (which it can
call *after* computing each `expected`, so the rescale targets the final blended total). When omitted,
behavior is byte-identical to today. **Note:** `predictMatch` does NOT need a separate components map
or a defense-residual map (both dropped, §3/§7) — only the scouting `agg` it already receives plus the
fitted `fraction`. Scouting-defense is read straight off `agg` inside the resolver.

---

## 9. Data sourcing — client-side, NO migration

Everything is computed **client-side** from data the app already fetches:

- **Scouting**: `useEventReports` → `aggregateEvent` → `TeamAgg` (already fetched for the dashboard).
  This is the **only** input the v1 component split + scouting-defense need beyond the prediction's
  `expected`. **No new TBA fetch is introduced by the v1 component layer** — the fitted fraction and
  scouting defense come entirely from `TeamAgg`, and `expected` comes from the prediction the view
  already computes.
- **The prediction `expected`**: produced by the existing `useEventEpa` + `predictMatch` path. (On the
  **Match tab** this stack is newly introduced — see §2 scope correction — so the *Match tab* does add
  the existing per-six-teams `useEventEpa` fan-out, which is the season EPA cost, not a new endpoint.)
- **New hook** `useEventComponentEpas(teamNumbers, eventKey)` — a small hook (NOT a clone of the EPA
  fan-out):
  - queryKey `['epa','event-components', eventKey, sortedTeams.join(',')]`.
  - reads `useEventReports`-derived aggregates (passed in or re-fetched via the cached `['reports',
    eventKey]` query), runs **`fitComponentFraction`** + builds the **scouting-defense map**, returns
    `{ fraction: {fAuto,fFuel,fClimb}, defenseByTeam: Map<number, number|null>, available }`.
  - It does **not** run `computeLocalEpa` and does **not** fan out to TBA in v1.
  - **Map rehydration:** `defenseByTeam` is a Map nested inside the returned object. queryPersist's
    `replacer`/`reviver` (`src/lib/queryPersist.ts` lines 62–83) are recursive JSON hooks, so a Map
    nested inside a plain object **is** tagged and survives the round-trip — verified. **Defensively**,
    every consumer of `defenseByTeam` must still coerce with an `instanceof Map` guard (mirroring
    `predict.ts`'s `asEpaMap`, lines 86–96, which exists precisely because Map rehydration has bitten
    this codebase before). Prefer returning the fraction as a **plain object** (not a Map) to sidestep
    the issue for that field entirely.
- **Tier-2 breakdown extraction** is client-side and **single-event only**: `parseRebuiltBreakdown`
  reads the raw objects from `fetchEventMatchesCached(eventKey)` (which include `score_breakdown`).
  This is the ONE place an event-scoped `computeLocalEpa` pass runs (§3B). Still **no migration**.
  Season-wide raw breakdown is NOT reused from the season recurrence (`MatchRow` drops
  `score_breakdown`) and is out of scope.

**No DB migration is required for the shipped feature.** See §10 for the optional server path and the
gate on it.

---

## 10. Optional server-side path (NOT chosen; needs user approval if ever pursued)

Per the TBA research, an alternative is importing `score_breakdown` into new `match` columns at sync
time. **We are NOT doing this for v1.** If a future need arises (e.g. server-recompute parity for
component EPA, or wanting the breakdown without each client fanning out to TBA), the migration would
be **0035** and is written below **for reference only — DO NOT APPLY without explicit user approval**:

```sql
-- supabase/migrations/0035_match_score_breakdown.sql
-- DRAFT — NOT DEPLOYED. Requires user approval (adds columns + a sync-event-results write path).
-- Adds per-alliance component score columns extracted from TBA score_breakdown.
-- Read RLS unchanged; updates remain idempotent per (match_key) via the existing upsert.
alter table public.match
  add column if not exists red_auto_score    integer,
  add column if not exists blue_auto_score   integer,
  add column if not exists red_teleop_fuel   integer,
  add column if not exists blue_teleop_fuel  integer,
  add column if not exists red_climb_points  integer,
  add column if not exists blue_climb_points integer,
  add column if not exists breakdown_synced_at timestamptz;
-- sync-event-results would extract alliances[color].score_breakdown and upsert these.
-- Client componentEpaFromBreakdown() would read them when present, else fall back to Tier 1.
```

**Flag for the user:** adopting §10 means (a) a new migration numbered 0035 that must be reviewed and
pushed (`supabase db push`), (b) editing `sync-event-results` + redeploying it, and (c) confirming the
exact 2026 `score_breakdown` keys first. None of this is needed to ship the client-only feature.

---

## 11. Open decisions / things to confirm

- **[HUMAN GATE] Defense model.** v1 ships **scouting-only** defense (`—` when unscouted); the
  results-residual path was dropped as circular (§7). Confirm this is acceptable, OR explicitly approve
  the larger follow-up that adds a *correct* results-based estimate (held-out pre-match snapshot +
  per-event zero-mean normalization + validation against scouted `defenderEffectiveness` before
  shipping). Do **not** ship the original `max(0, expected-actual)/3` formula.
- **Default component split `F_DEFAULT` (`0.15/0.55/0.30`)** is a guess — should be tuned against the
  first real REBUILT event (or 2024/2025 analogues). FLAGGED.
- **Defense calibration constants** (`TYPICAL_OPP_TELEOP_FUEL`, `DEFENSE_RATING_MAX_PTS`) are
  heuristic — confirm with the user / tune empirically. (`DEFENSE_MIN_OPPONENTS` is **removed** — it
  only gated the dropped residual path.)
- **Whether prediction should subtract defense** (`APPLY_DEFENSE_TO_PREDICTION`, default false;
  scouting-fed only in v1).
- **Exact 2026 TBA `score_breakdown` keys** — unconfirmed; Tier 2 stays dark until validated against a
  real played event (`2026...`). Per-robot vs per-alliance climb granularity also unknown.
- **[HUMAN GATE] Whether the optional server migration (§10) is acceptable at all.** Not needed for v1.

---

## 12. Files to create / modify

| File | Action | What |
|---|---|---|
| `src/dash/localEpa.ts` | modify | Fix the outdated header comment. **(Tier-2/cleanup only)** factor the recurrence loop into `runEpaRecurrence`. Add `parseRebuiltBreakdown(json)` (Tier 2, single-event raw JSON, returns null on schema mismatch). **No** `computeComponentEpas` and **no** `computeDefenseResidual` (both dropped, §3/§7). |
| `src/dash/aggregate.ts` | modify | Add pure helpers: `aggregateTeamComponentSplit(agg): {auto,fuel,climb}` on the **`scoutingExpectedPoints` basis** (decompose `fuelPointsWeighted` by the rawAuto/rawFuel proportion; `climb=meanClimbPoints` — §3A), and `aggregateTeamDefensePts(agg): number|null` (scouting-only: `defenderEffectiveness`→pts or `avgDefenseRating` ordinal, §7). Add `F_DEFAULT` + `fitComponentFraction(aggs): {fAuto,fFuel,fClimb}` (event-wide, `F_DEFAULT` when < `MIN_FIT_REPORTS` or degenerate). |
| `src/dash/predict.ts` | modify | Add `ComponentBreakdown` interface + `resolveComponentBreakdown(team, agg, expected, fraction, source)`; add optional `components?` to `TeamPrediction`; extend `PredictInput`/`predictMatch` with optional `fraction` (no-op when omitted) — attach `components` per team after computing `expected`. Add `APPLY_DEFENSE_TO_PREDICTION` const (default false). **No** `componentsByTeam`/`defenseByTeam` inputs. |
| `src/dash/useEventData.ts` | modify | Add `useEventComponentEpas(teamNumbers, eventKey)` returning `{ fraction: {fAuto,fFuel,fClimb} (plain object), defenseByTeam: Map<number,number\|null>, available }`. Reads the cached `['reports', eventKey]` aggregates; **does not** fan out to TBA or run `computeLocalEpa`. |
| `src/dash/MatchView.tsx` | modify | **Introduce the EPA+prediction stack here (it currently has none).** For the selected match's six teams: `useEventEpa(sixTeams, eventKey)` + `useEventComponentEpas(sixTeams, eventKey)` + `predictMatch(...)` (mirror NextMatchView ~lines 626–662). Render the "Scoring estimate" card (§2) + the listed `data-testid`s. Handle the **no-match-selected** empty state. |
| `src/dash/NextMatchView.tsx` | modify | Wire `useEventComponentEpas`; pass `fraction` into `predictMatch`; render the extra component line in `TeamRowView` with `dash-next-components-{team}`. |
| `src/dash/constants.ts` | modify | Add `MIN_FIT_REPORTS`, `MIN_EPA_MATCHES`, `TYPICAL_OPP_TELEOP_FUEL`, `DEFENSE_RATING_MAX_PTS`, `APPLY_DEFENSE_TO_PREDICTION`. (No `DEFENSE_MIN_OPPONENTS`.) |
| `src/dash/__tests__/componentEpa.test.ts` | create | Unit tests for `fitComponentFraction`, `aggregateTeamComponentSplit`, `aggregateTeamDefensePts`, `resolveComponentBreakdown`, invariants (§13). |
| `tests/e2e/component-estimate.spec.ts` | create | Playwright scenario tolerant of an empty live event (§13). |
| `supabase/migrations/0035_match_score_breakdown.sql` | **DRAFT ONLY** | Reference SQL (§10). **Do NOT create/apply unless the user approves the server path.** |

---

## 13. Tests

### Unit (`src/dash/__tests__/componentEpa.test.ts`, Vitest)

1. **`fitComponentFraction`**: from synthetic `TeamAgg`s with known auto/fuel/climb means (on the
   `scoutingExpectedPoints` basis), returns a triple summing to 1 with the expected ratios; returns
   `F_DEFAULT` when reports < `MIN_FIT_REPORTS`; guards `T=0` (all-zero scouting) → `F_DEFAULT`. Assert
   it is **insensitive to `SCORING.FUEL_POINTS`** (since the split decomposes `fuelPointsWeighted`).
2. **`aggregateTeamComponentSplit`** + **`aggregateTeamDefensePts`**: split sums to the team's
   `scoutingExpectedPoints` (within epsilon) before any rescale; defense uses `defenderEffectiveness`
   when present, else the ordinal map, else `null`.
3. **`resolveComponentBreakdown`**:
   - scouting present (m>0) → `source==='scouting'`, split from `TeamAgg` on `scoutingExpectedPoints`
     basis, **rescaled to `expected`** (k≈1 in the scouting-only-prediction case).
   - no scouting, `expected>0`, ≥ `MIN_EPA_MATCHES` → `source==='epa'`, split by `fraction`,
     `defense===null`.
   - neither (or below gate) → `source==='none'`, all components `0`/`—`.
   - **rescale invariant (UNROUNDED):** `auto+fuel+climb ≈ expected` within float epsilon in every
     non-`none` branch.
4. **`predictMatch` parity**: called without `fraction` → output byte-identical to current (regression
   guard); called with it → each `TeamPrediction.components` present and alliance **unrounded** sum
   equals `score`. `APPLY_DEFENSE_TO_PREDICTION=false` → scores unchanged vs no-defense.
5. **`parseRebuiltBreakdown`** (Tier 2): a fixture with the inferred keys parses to finite numbers; a
   fixture with renamed/missing keys returns `null` (no throw); a `null`/non-object input returns
   `null`. (Single-event raw JSON shape.)

### Playwright (`tests/e2e/component-estimate.spec.ts`)

Hits the real remote (single-worker, like the other live specs). Must tolerate the **empty live
event** (no played matches, possibly no scouting):

- Navigate to the dashboard, open the **Match tab**. If `match-none`/no selectable match is shown
  (empty schedule on the live event), call **`test.skip(true, 'no match on live event')`** with that
  logged reason — a green run on an empty event must be **distinguishable** from a real assertion, not
  a vacuous pass. (Optionally seed demo mode `2026demo` per memory for a deterministic non-empty path.)
- Select the first match. Assert the `dash-match-estimate` card renders and the word **"estimate"** is
  visible (never assert a specific points value).
- Assert **either** per-team component lines render with finite `N`-style text **or** the
  `dash-match-estimate-empty` "No results or scouting yet" line is shown — both are valid for an
  unplayed event. The test asserts the *contract* (card present + labeled + no crash), not numbers.
- Open the **Next Match** view (skip likewise if `dash-next-no-match`). Assert `dash-next-components-{team}`
  exists for teams that have a row. **Rounding tolerance:** when both the per-team total and its
  component line are numeric, assert `|round(expected) - (round(auto)+round(fuel)+round(climb))| <= 3`
  (±1 per component, i.e. ±#components) — NOT exact equality, since independent rounding drifts. The
  exact additive invariant is checked on **unrounded** floats by the unit tests, not here. Tolerate
  `—` when `source==='none'`.

This mirrors the resilience of existing specs like `dashboard.spec.ts` / `matchview-search.spec.ts`
which assert structure on a possibly-empty live DB.

---

## 14. Offline / TBA-down degradation

- **TBA down**: `expected` degrades through the existing `useEventEpa`/`predictMatch` path (EPA→null,
  prediction falls to scouting or `none`). The component split rides on whatever `expected` resolves
  to; the v1 component layer adds **no** TBA call of its own, so there is nothing extra to fail. Card
  renders; teams show scouting components or `—`. No crash.
- **Statbotics down**: irrelevant to the split — components are a proportion of `expected`, whatever
  basis produced it. The fitted `fraction` is scouting-derived; defense is scouting-derived. No
  `statboticsAvailable` threading is needed (the resolver no longer takes it).
- **Fully offline reload**: `useEventComponentEpas` returns a plain-object `fraction` (no Map
  rehydration concern) and a `defenseByTeam` Map that round-trips via queryPersist's recursive
  replacer/reviver (nested-Map tagging verified, §9); consumers still apply an `instanceof Map` guard.
  The last good breakdown shows; scouting components come from the persisted `reports` query.
- **Empty live event**: §2 empty state + §13 e2e tolerance (with deterministic `test.skip`).

---

## 15. Sequencing

1. `aggregate.ts`: `aggregateTeamComponentSplit` (on the `scoutingExpectedPoints` basis) +
   `aggregateTeamDefensePts` (scouting-only) + `F_DEFAULT` + `fitComponentFraction`. Unit-test these
   pure fns first. **No** `computeComponentEpas` and **no** `computeDefenseResidual` (both dropped,
   §3/§7).
2. `predict.ts`: `ComponentBreakdown` + `resolveComponentBreakdown(team, agg, expected, fraction,
   source)` + optional `fraction` input on `predictMatch` (regression test parity — byte-identical when
   omitted) + `APPLY_DEFENSE_TO_PREDICTION` const (default false). No componentsByTeam/defenseByTeam
   inputs.
3. `useEventData.ts`: `useEventComponentEpas` (returns plain-object `fraction` + `defenseByTeam` Map;
   does NOT fan out to TBA or run `computeLocalEpa` in v1).
4. `MatchView.tsx`: **introduce** the `useEventEpa` + `useEventComponentEpas` + `predictMatch` stack
   for the selected match's six teams (it has none today — §2 scope) + the Scoring-estimate card +
   no-match-selected empty state.
5. `NextMatchView.tsx`: wire `useEventComponentEpas`, pass `fraction` into `predictMatch`, render the
   component line in `TeamRowView`.
6. e2e spec last (empty-event-tolerant with `test.skip`, §13).
7. **Tier-2 / cleanup, independent track:** `localEpa.ts` header fix + the behavior-preserving
   `runEpaRecurrence` refactor (keep existing localEpa tests green) + `parseRebuiltBreakdown`
   (single-event raw JSON, returns `null` on schema mismatch). All additive and dark behind a flag;
   can land anytime since nothing in steps 1–6 depends on it.

No `mapReport.ts` / wire-shape change. No scoring-magnitude duplication (reuses `SCORING.FUEL_POINTS`
+ existing `meanClimbPoints`). Prediction math contract (`phase3-contracts.md §3`) is preserved
because component output is additive-decomposition only and defense application defaults OFF.
