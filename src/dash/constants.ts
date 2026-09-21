// src/dash/constants.ts
// Site of record for the analytics tuning constants (contracts §9).

/**
 * Matches-scouted needed to fully trust the scouting-only prediction fallback
 * (used only for a team with NO match-result EPA, e.g. a rookie at its first
 * event). `w = min(1, m/CONFIDENCE_N)` feeds the match confidence.
 */
export const CONFIDENCE_N = 4;

/**
 * Recency tilt for the in-house (TBA-derived) EPA model. The model processes a
 * team's whole season chronologically; this re-weights each match's update by
 * its recency so a team's CURRENT form counts more than its early-season form,
 * without inflating the overall learning rate. It is a centered tilt: the oldest
 * match updates at `1 - boost/2`, the newest at `1 + boost/2` (avg ≈ 1). 0
 * reproduces the exact Statbotics scalar port; 0.5 ≈ ±25% recency weighting —
 * a moderate bias, not a regime change.
 */
export const EPA_RECENCY_BOOST = 0.5;

/**
 * Learning-rate multiplier on the in-house EPA update (applied on top of the
 * Statbotics `percent_func` schedule). 1 is the exact Statbotics port.
 *
 * Backtested 2026-09-21 on the full 2026 season (18,291 played official
 * matches, causal predict-then-update replay, docs/research/
 * match13-xp-reverse-engineering.md §7): ×1.25 cut the alliance-score MAE
 * from 53.0 to 51.4 (−3.0%) and left win-prob calibration unchanged
 * (Brier 0.1506 → 0.1505); ×1.5 bought another −1.5% MAE but started to hurt
 * calibration (2nd-half log-loss +1.2%); ≥×1.75 is unstable. A high-variance
 * fuel game rewards reacting faster than the 2023-tuned Statbotics schedule.
 */
export const EPA_GAIN = 1.25;

// Win-probability calibration.
//
// Win prob is logistic over the predicted score margin, but the SPREAD of FRC
// match margins grows with the scoring level of the game. A fixed points-based
// steepness (the old WINPROB_K) over-commits in high-scoring games: in REBUILT,
// where an alliance scores ~400, a 20-point edge is a near coin-flip, not an 85%
// lock. So instead of a constant steepness we normalize the margin by an
// estimated match-margin standard deviation derived from the total predicted
// score: sigma ≈ WINPROB_SIGMA_FRACTION * (redScore + blueScore), floored.
//
//   redWinProb = logistic( WINPROB_LOGIT_SCALE * (redScore - blueScore) / sigma )
//
// This self-calibrates across seasons/score scales from the predicted totals.
//
// Calibration evidence (2026-09-21, full-2026-season causal backtest, slope fit
// by logistic regression on the first half of the season and scored on the
// second half — see docs/research/match13-xp-reverse-engineering.md §7):
//   * This "sigma ∝ total" model beat both a constant sigma and a per-team
//     running-variance sigma (match13's approach) on out-of-sample log-loss
//     (0.4355 vs 0.4785 / 0.4526), so the sigma shape is kept as-is.
//   * The old slope 1.7 (a probit→logit conversion, not a fit) was ~2× too
//     confident: the fitted slope is 0.79–0.91 depending on EPA gain. At the
//     shipped EPA_GAIN the fitted value is ~0.8; 0.85 scored best of the
//     candidates tried (2nd-half log-loss 0.4849 → 0.4368, Brier 0.1476 →
//     0.1414, win accuracy unchanged). Elims fit ~+0.15 steeper; not modelled.

/** Margin standard deviation as a fraction of the total predicted alliance score. */
export const WINPROB_SIGMA_FRACTION = 0.11;

/** Floor on the margin SD so low-scoring totals don't produce an over-steep curve. */
export const WINPROB_SIGMA_FLOOR = 12;

/** Logistic slope on the sigma-normalized margin (fitted; see calibration note above). */
export const WINPROB_LOGIT_SCALE = 0.85;

/** Our team: never scouted (EPA-only in predictions, omitted from our auto overlay). */
export const OUR_TEAM = 3256;

/**
 * Poll interval (ms) for LIVE Nexus field status. Nexus reports what is queuing /
 * on the field right now, so the dashboard re-fetches on this cadence to keep the
 * On-Field / Queuing tiles advancing as matches play. Kept short for near-real-time
 * liveness; the nexus-proxy is uncached so every poll reflects the current field.
 */
export const NEXUS_POLL_MS = 10_000;

/**
 * How old a Nexus snapshot may be before we stop treating it as LIVE. With the
 * webhook path the dashboard gets pushed a fresh snapshot on every field change;
 * if the newest snapshot we hold is older than this, the field has likely gone
 * quiet (or the push stopped) and we degrade to the schedule rather than show a
 * frozen "On Field" tile. Generous so normal between-match gaps stay live.
 */
export const NEXUS_STALE_MS = 120_000;

/**
 * Cadence (ms) for the safety-net TBA match reconcile used by the dashboard and
 * Scout Home (`sync-event-results`). The tba-webhook is primary; this backfills
 * missed results and refreshes moving predicted start times.
 */
export const RESULTS_RECONCILE_MS = 60_000;

// ===========================================================================
// Component-EPA estimation tuning (component-epa-estimation feature, §6/§11).
//
// The per-alliance auto/fuel breakdown is a presentational DECOMPOSITION
// of `TeamPrediction.expected` (the number the dashboard already shows).
// It NEVER changes the prediction's score/win-prob (defense is display-only and
// `APPLY_DEFENSE_TO_PREDICTION` defaults OFF). These constants are heuristic and
// FLAGGED for tuning against the first real REBUILT event.
// ===========================================================================

/**
 * Event-wide scouting reports needed before the component split FITS its
 * fraction from scouting means; below this we use the F_DEFAULT cold-start
 * fraction for the no-scouting (EPA) branch. (Per-team scouted teams always use
 * their own means regardless of this gate.)
 */
export const MIN_FIT_REPORTS = 8;

/**
 * Played matches the event needs before an UNSCOUTED team gets an EPA-source
 * component split (rather than `none`/`—`). Mirrors the research mitigation of
 * minimum-match gating so an event with one played match doesn't surface a
 * confident-looking breakdown.
 */
export const MIN_EPA_MATCHES = 2;

/**
 * Typical opponent teleop FUEL points used to convert a scouted defender's
 * suppression FRACTION (`defenderEffectiveness`, 0..1) into points removed from
 * the opposing alliance. 0.30 suppression × this ≈ the points denied. FLAGGED.
 */
export const TYPICAL_OPP_TELEOP_FUEL = 40;

/**
 * Points a maxed-out (10/10) defense_rating maps to when the precise
 * co-occurrence signal (`defenderEffectiveness`) is unavailable. A 5/10 rating
 * maps to half this.
 * Contextless ordinal fallback. FLAGGED.
 */
export const DEFENSE_RATING_MAX_PTS = 20;

/**
 * Whether `predictMatch` subtracts defense from the opposing alliance's score.
 * DEFAULT FALSE for v1: defense is DISPLAY-ONLY; the visible prediction math is
 * unchanged on first ship (components are a pure additive decomposition of the
 * already-shown `expected`). Left as a seam for a future, validated follow-up.
 */
export const APPLY_DEFENSE_TO_PREDICTION = false;
