# match13.com "xP" and match prediction — reverse-engineering notes

Date: 2026-09-21. Source material: the Chief Delphi thread
(chiefdelphi.com/t/match13-com-new-stats-website/524226), the public read-API
Dart client (github.com/Project516/match13_client, with live fixtures), the
site's shipped JS bundles (the Hypothetical / ranking-sim / bracket-sim code runs
client-side), and the server-rendered TanStack payloads of event, match and team
pages (`moves` = per-team pre/post ratings for every match). Model version
string in the payload: `modelVersion: "xp-10"`.

Everything in **Confirmed** is read straight from code or data. Everything in
**Inferred** is a regression fit on the per-match `moves` (Chezy Champs 2026cc,
86 matches, and 2026casnv, 89 matches) and should be treated as ±.

---

## 1. What the author says (thread)

- "Model is a different architecture than existing ones (closest to EPA) … it
  also operates in point space." Explicitly optimised for **win / RP prediction
  rate**, not point-estimate error.
- "xP basically has two sub-models, **xP-fast** and **xP-slow** … Fast is more
  reactive and updates quickly to team surges in performance. Slow reacts more
  cautiously and is much longer horizon."
- The engine detects "weird" matches (blank-team offseason fillers, DQ/surrogate)
  and gives them zero xP movement.
- 2015 gets a game-specific variant. Offseason RP thresholds are handled per event.
- Benchmarks (2023–2026, winner accuracy): a modest edge over Statbotics EPA;
  the author says EPA is "very hard to beat" and the gains are on RP forecasting.

## 2. Confirmed: data model (API + payload fields)

Per team-event: `xpStart`, `xpEnd`, `xpMean`, `xpMax`, `xpFast`, `xpSlow`,
`xAuto`, `xTele`, `xEnd`, `xVar`, `xRp1..3`, `sos`, plus Statbotics `epa`,
TBA `opr`/`dpr` side by side. Per match: `pred.{red,blue}Score`,
`pred.{red,blue}Var`, `pred.{red,blue}Rp1..3`, `pred.winProb`, and `moves[]`
with `{auto,teleop,endgame,xp}{Before,After}` for all six teams.

Invariants observed:

- `xp = xAuto + xTele + xEnd` exactly.
- Between in-season events `xpStart(next) == xpEnd(prev)` exactly — **no
  inter-event shrink**. Offseason (scope `all`) is a separate rating stream.
- `xVar` is **constant per team for the whole season** (254: 1376.6 at every
  2026 event). It is a season-level residual variance, not a per-match Kalman
  variance. Different value in the offseason stream.
- `normXp = 1500 + 250 · (xp − scoreMean/3) / scoreSd` (checked to 4 decimals
  on 2025 and 2026). This is what "compare across seasons" uses.
- 2026 component definitions (from the match `detail` table vs TBA breakdown):
  `auto` = `hubScore.autoPoints` (= `totalAutoPoints − autoTowerPoints`),
  `teleop` = `hubScore.teleopPoints` (= `totalTeleopPoints − endGameTowerPoints`:
  transition + all four shifts + endgame-period fuel), `endgame` =
  `totalTowerPoints`. Note TBA's `totalAutoPoints`/`totalTeleopPoints` already
  include the tower points, so the three sum to the no-foul score only with the
  tower subtracted (verified on all 36,582 alliance results of 2026). Fouls
  excluded: updates are against `no_foul_points`
  (= `totalPoints − foulPoints − adjustPoints`).

## 3. Confirmed: win-probability / prediction math (client code)

This is the code the site runs for the Hypothetical tool, ranking simulator and
bracket simulator; the server's stored `pred.*` uses the same shape.

```
allianceScore   = Σ xp_i                      (three teams)
allianceVar     = Σ max(0, xVar_i)
sigma           = max( sqrt(varRed + varBlue) · marginSdCorr,
                       sigmaFloorFrac · scoreSd )
z               = (redScore − blueScore) / sigma
logit           = linkBias + link[0]·z + link[1]·z·isElims + link[2]·z·isChamps
P(red wins)     = 1 / (1 + e^(−logit))
Best-of-3 series: p_series = p² · (3 − 2p)
```

Per-year calibration (server-provided, `winProbCalibration` v2):

| year | scoreMean | scoreSd | link[0] | link[1] (elims) | link[2] (champs) | bias |
|---|---|---|---|---|---|---|
| 2023 | 69.83 | 27.42 | 1.4238 | −0.1287 | −0.1690 | +0.0085 |
| 2024 | 41.40 | 18.45 | 1.2809 | −0.0269 | +0.0862 | −0.0092 |
| 2025 | 76.72 | 33.85 | 1.4303 | +0.2131 | −0.1116 | −0.0251 |
| 2026 (season) | 119.45 | 85.10 | 1.4854 | +0.1017 | −0.1347 | +0.0069 |
| 2026 (all/offseason) | 119.45 | 85.10 | 1.4695 | +0.0986 | −0.0592 | +0.0166 |

`marginSdCorr = 1`, `sigmaFloorFrac = 0.02` every year. `scoreMean/scoreSd` are
the mean/SD of alliance scores for the year. `link[0] ≈ 1.4–1.5` is the
key number: with a properly estimated sigma the logistic slope is *not* the
1.0 a Gaussian-margin model would imply, i.e. the model is deliberately more
confident than "difference / sqrt(sum of variances)" and this is fit per year.

Fallback when a team has no `xVar`: `(0.24 · scoreSd)²` per team.

Ranking-point probability for an alliance from per-team `xRp_k`:

```
P_alliance(RP_k) = sigmoid( 4 + Σ_i logit(clamp(xRp_k,i, 0.001, 0.999)) )
```

(the code is `ji(Σ Mi(p_i))` with `Mi(p) = 0.5 + logit(p)/4`,
`ji(t) = sigmoid(4(t − 0.5))`; algebraically the line above.) Per-team `xRp`
therefore is *not* "P(team's alliance gets the RP)" but a contribution whose
logit sums — a value of 0.5 for all three teams gives P = 0.98, and the
observed `xRp` values (0.05–0.9) sit where that makes the alliance numbers
sensible. Stored server RPs for a hypothetical are combined with the
"reference" prediction through `logit(a) + logit(b) − logit(ref)`.

Ranking simulation: Monte Carlo (default 1 000 iterations client-side, 25 000
server-side per the `sim` endpoint): per match draw win with `winProb`, each
bonus RP independently with `P_alliance(RP_k)`, tiebreakers drawn as
`max(0, mean + sd·Φ⁻¹(u))` with the year's tiebreak slots (2026: Avg Match
(clean), Avg Auto Fuel, Avg Tower); then sort by the year's ranking rules.

## 4. Inferred: the rating update

Fit on `moves` (per team `Δxp = xpAfter − xpBefore`, alliance residual
`resid = no_foul_points − Σ xpBefore`), all six teams updated from the same
pre-match snapshot:

| dataset | level | Σ(alliance Δ) fit | R² |
|---|---|---|---|
| 2026casnv (week 2) | quals | `0.377·resid + 0.067·Σxp + 3.3` | 0.955 |
| 2026casnv | elims | `0.117·resid` | 0.915 |
| 2026cc (offseason, veterans) | quals | `0.227·resid − 0.088·Σxp + 32` | 0.976 |
| 2026cc | elims | `0.083·resid − 0.032·Σxp + 11` | 0.983 |

Per component (2026cc quals): `ΔAuto ≈ 0.20·(auto − Σauto_i)`,
`ΔTele ≈ 0.21·(teleop − Σtele_i)`, `ΔEnd = 0.2087·(tower − Σend_i)` (R² 0.994,
zero intercept). **Each component is its own EPA stream updated on its own
residual**; `xp` is their sum. The opponent's residual has zero weight (no
margin term, same as Statbotics for modern games).

Reading of the coefficients:

- Alliance-level gain ~0.38 early season → ~0.22 late season, elims ≈ ⅓ of
  quals. That is Statbotics' `percent_func` (`(2/3)·clamp(0.5 − (N−6)/30, 0.3,
  0.5)` = 0.333 → 0.200) and `ELIM_WEIGHT = 1/3`, to within noise. The core
  recurrence is EPA.
- Per-team split is roughly a third each but tilts toward lower-rated /
  higher-variance teams: per-team fit
  `Δ_i = (0.117 − 0.00025·xp_i)·resid + 0.0166·xp_i − 0.030·Σxp + 8.4`
  (R² 0.984). The `Σxp` / intercept terms are what the single-`xp` regression
  can't see: `xp` is a blend of two sub-models with different predictions.
- **Fast/slow blend**: `xpEnd ≈ w·xpFast + (1−w)·xpSlow` with `w ≈ 0.80`
  (0.795–0.805 for most team-events; 0.82–0.85 for 254 early season, drifting
  to 0.795 by week 8). Fast ≈ a high-gain EPA, slow ≈ a low-gain one; the
  displayed `xp` is dominated by fast. `xpMean` is the mean of the in-event
  trajectory, `xpMax` its max.
- Season-opening prior (first `xpStart` of the year, z-space using the year's
  `scoreMean/3`, `scoreSd`): `z_2026 ≈ 0.74·z_2025 + 0.07` (R² 0.77, n=36).
  Adding 2024/2023 barely helps (R² 0.81). Teams with one prior year land at
  z≈0 regardless of that year; a true rookie (11247) opened at 38.2 ≈
  `scoreMean/3 − 0.02·scoreSd`. Some outliers (5026, 2813, 6238) opened well
  above their 2025 season rating, consistent with the prior also consuming fall
  2025 offseason results (scope `all`). Statbotics uses the same
  percentile-carry idea, so this is again EPA-shaped with different weights.
- `xVar` is a per-team season constant in the 800–3000 range for 2026
  (sqrt ≈ 28–54 pts). It is plausibly the variance of the team's own
  attributed residuals across the season (weaker, streakier teams have larger
  values) but I could not pin the exact estimator.

Caveat on stored `pred.*`: on both events, `pred.redScore` does not equal the
`moves` Σ xpBefore (e.g. casnv qm1: Σxp 133 vs pred 12.3). The preds are
frozen at the time they were made by an earlier model run, while the ratings
have since been recomputed by xp-10 — so historical `pred` fields are *not*
usable to fit the score model, and the site's own displayed "predicted vs
actual" on old matches is a mixed-version artefact. Chezy (fresh) preds are
within ±10 % of Σxp.

## 5. Where it differs from Statbotics EPA (the actual "secret sauce")

1. **Calibrated logistic with elims/champs slope terms** fit per year, and the
   sigma built from per-team `xVar` instead of a year constant. This is where
   the win-probability gain comes from; the point model is EPA.
2. **Two-speed rating (fast/slow, ~80/20 blend)**, shown separately in the UI.
3. **Per-team RP contribution values combined in logit space**, giving alliance
   RP probabilities that feed a full Monte-Carlo ranking sim.
4. Component streams (auto / teleop / endgame) with 2026-correct definitions
   (teleop includes endgame-period hub fuel; endgame = tower only).
5. No inter-event shrink in-season; a multi-year prior at season start.

## 6. What to copy into this app

Current state: `src/dash/localEpa.ts` is the Statbotics scalar port (same
`percent_func`, `ELIM_WEIGHT`, no-foul scores), `src/dash/predict.ts` uses
`logistic(WINPROB_LOGIT_SCALE·(R−B)/sigma)` with
`sigma = max(floor, 0.11·(R+B))`, and the auto/fuel split that the strategy
whiteboard and `MatchupCharts` draw is a *fitted fraction of the total*
(`resolveComponentBreakdown`), not a real component EPA. The Tier-2 seam
(`parseRebuiltBreakdown`, `ENABLE_REAL_BREAKDOWN=false`) guesses key names.

Recommended, in order of payoff / effort:

1. **Real component EPAs (auto / teleop / endgame)** — flip the Tier-2 seam on
   with the now-confirmed 2026 keys:
   `auto = totalAutoPoints`, `teleop = totalTeleopPoints`,
   `endgame = totalTowerPoints`, no-foul = `totalPoints − foulPoints −
   adjustPoints` (all verified live via `tba-proxy` on 2026casnv_qm1). Run the
   existing recurrence three times on the three residuals; overall EPA stays
   the sum, so nothing downstream changes numerically except the split becomes
   real. This is the `xAuto/xTele/xEnd` the user asked for and it slots into
   `ComponentBreakdown.auto/fuel` (+ a new `endgame`) that the whiteboard uses.
2. **Win probability**: replace the `0.11·(R+B)` sigma with
   `sqrt(Σ var_i)` where `var_i` is each team's running residual variance
   (EWMA of `(attributed residual)²`), floored at `0.02·scoreSd`, and a logit
   slope `≈1.45` (start with match13's 2026 `link[0]=1.485`, `elims +0.10`).
   Cheap, and it is the part with measured accuracy gain.
3. **Fast/slow**: run the recurrence twice with `percent` scaled ×1.6 and ×0.4
   (approximately) and display `0.8·fast + 0.2·slow`; expose both as columns.
   Mostly a UI/insight feature ("who is surging"), small accuracy effect.
4. RP model: per-team RP contribution as an EPA on the RP indicator, combined
   with `sigmoid(4 + Σ logit)`; then the ranking sim. Bigger job; only worth it
   if we want rank forecasting on the dashboard.

Keep `seasonEpa.ts` behaviour (season-wide, no inter-event shrink) — match13
does the same.

## 7. Backtest of candidate changes (2026-09-21)

Data: every played official 2026 match with a score breakdown (215 events,
18,291 matches, fetched through `tba-proxy`). Two harnesses:

- **Causal replay** (all 18,291 matches): predict each match from the ratings
  as of that moment, then update. Same recurrence as `computeLocalEpa`
  (verified to reproduce it to 1e-13 at gain 1, tilt 0).
- **Production-shaped sample** (every 20th match, n=910): recompute the season
  EPA from scratch over all prior matches with the real `computeLocalEpa`
  (recency tilt 0.5 as shipped) and score with the real `predictMatch`.

Logistic slopes were fit on the first half of the season and scored on the
second half (out-of-sample). Metrics: win accuracy, Brier, log-loss, mean
absolute error of the alliance no-foul score.

| variant (causal replay, quals) | acc | Brier | log-loss | score MAE |
|---|---|---|---|---|
| A. shipped before: Statbotics port, sigma 0.11·total, slope 1.7 | 77.60 | 0.1588 | 0.5132 | 53.00 |
| slope refit only (0.91) | 77.58 | 0.1506 | 0.4582 | 53.00 |
| + per-team running-variance sigma (match13 style), refit | 77.63 | 0.1513 | 0.4654 | 53.00 |
| + constant sigma = season SD, refit | 77.58 | 0.1520 | 0.4686 | 53.00 |
| + gain ×1.25, slope 0.85 **(shipped)** | 77.64 | 0.1505 | 0.4590 | 51.43 |
| + gain ×1.5 | 77.75 | 0.1510 | 0.4618 | 50.62 |
| + fast/slow 2.0/0.5 blend, w 0.8 (match13 style) | 77.99 | 0.1516 | 0.4641 | 50.84 |
| + elim weight 1 instead of ⅓ | 77.50 | 0.1517 | 0.4676 | 52.89 |

2nd-half-of-season log-loss (out of sample): 0.4849 before → 0.4368 shipped.

Production-shaped sample, real app code, old vs new constants:

| | acc | Brier | log-loss | score MAE | auto MAE (alliance) |
|---|---|---|---|---|---|
| old (gain 1, slope 1.7, fitted-fraction split) | 79.07 | 0.1559 | 0.5351 | 53.68 | 12.86 |
| new (gain 1.25, slope 0.85, component EPA split) | 78.52 | 0.1508 | 0.4674 | 52.56 | 12.36 |

(±1.35 pts accuracy is one standard error at n=910; the full replay had
accuracy +0.04.)

What was adopted and why:

1. **Slope 1.7 → 0.85.** The single biggest win (log-loss −11–13%). The old
   value was a probit→logit conversion, never fit; our predictions were about
   twice as confident as the outcomes justified.
2. **EPA gain ×1.25.** −3% score MAE in the replay, calibration unchanged.
3. **Real component EPAs** (auto / teleop / endgame streams on the confirmed
   TBA keys). Alliance-level component MAE only improves ~2–4%, but the split
   is now per-team data rather than one event-wide ratio applied to everyone,
   which is what the whiteboard/matchup views need.

What was tested and **not** adopted:

- match13's per-team variance sigma: worse than the existing `0.11·total`
  sigma on every metric. The heteroscedastic-by-score model already captures
  the uncertainty structure of this game better.
- match13's fast/slow blend: no gain over simply raising the single gain, and
  more state to carry. (Could still be exposed as a "surging" indicator.)
- Match-count-dependent sigma widening: +0.2% log-loss, not worth plumbing.
- Elim weight 1: better on elims, worse on quals; kept Statbotics' ⅓.
