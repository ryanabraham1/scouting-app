// src/dash/constants.ts
// Site of record for the analytics tuning constants (contracts §9).

/** Matches-scouted needed to fully trust our scouting data over EPA. */
export const CONFIDENCE_N = 4;

// EPA sanity guardrail on the scouting/EPA blend.
//
// The blend weight `w = min(1, m/CONFIDENCE_N)` trusts scouting purely on sample
// COUNT, so one garbage scouted match (fat-fingered bursts, wrong team, scout
// asleep) can drag a team's expectation far from reality. EPA is an independently
// accurate estimate of a team's point contribution, so when the scouted
// expectation diverges wildly from EPA on a small sample we damp the scouting
// weight — the divergence is more likely bad data than a real breakout. The
// damping buys itself back linearly with matches scouted: consistent evidence
// that a team really does outperform its EPA regains full trust.
//
//   rel       = |scouting - epa| / max(EPA_SANITY_SCALE_FLOOR, |epa|)
//   gap       = max(0, rel - EPA_SANITY_TOLERANCE)
//   agreement = 1 / (1 + EPA_SANITY_SLOPE * gap / m)      // 1 = full trust
//   w         = min(1, m * agreement / CONFIDENCE_N)
//
// Only applies on the blend branch (both sources present); scouting-only and
// EPA-only behavior is unchanged. Damped w also flows into the dashboard
// confidence (meanW), so implausible data honestly reads as low confidence.

/**
 * Relative scouting↔EPA divergence tolerated with NO damping. Scouting
 * legitimately disagrees with EPA (that is its whole value — EPA lags and bakes
 * in schedule context), so divergence up to this fraction of EPA is fully
 * trusted. FLAGGED for tuning against the first real REBUILT event.
 */
export const EPA_SANITY_TOLERANCE = 0.5;

/**
 * How fast per-match trust decays beyond the tolerance band (see formula
 * above). At m=1, a scouted value ~2× EPA keeps only ~25% of its per-match
 * weight; the same divergence over 4 consistent matches keeps ~57%. FLAGGED.
 */
export const EPA_SANITY_SLOPE = 2;

/**
 * Points floor for the divergence denominator so a tiny-EPA (rookie/weak) team
 * doesn't over-trigger the guardrail on a modest absolute difference. FLAGGED.
 */
export const EPA_SANITY_SCALE_FLOOR = 30;

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

/** Margin standard deviation as a fraction of the total predicted alliance score. */
export const WINPROB_SIGMA_FRACTION = 0.11;

/** Floor on the margin SD so low-scoring totals don't produce an over-steep curve. */
export const WINPROB_SIGMA_FLOOR = 12;

/** Probit→logit factor: logistic(1.7·z) ≈ Φ(z), so a logistic curve mimics a normal CDF. */
export const WINPROB_LOGIT_SCALE = 1.7;

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
 * Cadence (ms) for the safety-net TBA results reconcile the dashboard triggers
 * (`sync-event-results`). The tba-webhook lands results in real time; this only
 * backfills anything a dropped/late webhook missed, so it can be relatively slow.
 */
export const RESULTS_RECONCILE_MS = 60_000;

// ===========================================================================
// Component-EPA estimation tuning (component-epa-estimation feature, §6/§11).
//
// The per-alliance auto/fuel/climb breakdown is a presentational DECOMPOSITION
// of `TeamPrediction.expected` (the blended number the dashboard already shows).
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
