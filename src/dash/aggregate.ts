// src/dash/aggregate.ts
// Pure aggregation over match_scouting_report rows (contracts §2).
// Uses frozen scoring magnitudes from @/scoring (never re-implemented here).

import { SCORING } from '@/scoring';
import type { MsrRow, MatchScoutCoverage, ScoutLite } from './types';
import {
  clampSuppression,
  defenderEffectivenessForMatch,
  intervalAbsRange,
  weightedRate,
} from '@/dash/defenseAnalytics';
import { compareMatchKeys } from '@/lib/formatMatch';
import {
  MIN_FIT_REPORTS,
  TYPICAL_OPP_TELEOP_FUEL,
  DEFENSE_RATING_MAX_PTS,
} from '@/dash/constants';

/** Recent-form trend buckets (distribution-trend feature). */
export type TrendDirection = 'improving' | 'stable' | 'fading' | 'insufficient';

/** Number of trailing (chronological) matches used for the recent-form trend. */
export const TREND_WINDOW = 3;
/** Min |delta| (points) before a trend is labelled improving/fading vs stable. */
export const TREND_STABLE_THRESHOLD = 0.5;

export interface TeamAgg {
  teamNumber: number;
  matchesScouted: number;
  meanAutoFuel: number;
  meanTeleopFuelActive: number;
  meanTeleopFuelInactive: number;
  meanEndgameFuel: number;
  /** mean of (auto + teleopActive + teleopInactive + endgame) per match */
  meanTotalFuel: number;
  /** mean fuel_points (RAW, not down-weighted) */
  meanFuelPoints: number;
  /** mean fuel_estimate_confidence (0..1) — a DATA-QUALITY flag only (surfaces the
   *  rate-FUEL chip); no longer down-weights any points. */
  meanFuelConfidence: number;
  /** count(climb_success) / matchesScouted */
  climbSuccessRate: number;
  /** mean climb_level */
  avgClimbLevel: number;
  /** mean of per-match climb points: SCORING.CLIMB[level].teleop when climb_success, else 0 */
  meanClimbPoints: number;
  /** mean defense_rating */
  avgDefenseRating: number;
  noShowRate: number;
  diedRate: number;
  /** fraction of scouted matches the robot tipped over (a softer incident than
   *  no-show/died). Surfaced in the reliability breakdown; does NOT change the
   *  `reliability` scalar (which feeds matchup guidance) to keep that stable. */
  tippedRate: number;
  /** count of scouted matches with ANY incident (no-show OR died OR tipped). */
  incidentMatches: number;
  /** clamp01(1 - (noShowRate + diedRate)) */
  reliability: number;
  /** per-match expected from OUR scouted data: meanFuelPoints + meanClimbPoints (RAW). */
  scoutingExpectedPoints: number;

  // --- Defense analytics (display-only, derived from raw bursts/intervals) -----
  /**
   * Metric A — Defended Fuel Suppression: fraction drop in this team's fuel-burst
   * rate while inside its `defended_intervals` windows vs. outside (pooled across
   * all the team's reports). 0.30 = "shoots 30% slower while defended"; negatives
   * (shot faster) are real and kept. null when no defended intervals / no baseline
   * bursts / no bursts at all. Never NaN.
   */
  fuelSuppressionWhileDefended: number | null;
  /** Total ms of defended burst time pooled across reports (Metric A sample size). */
  defendedSampleMs: number;
  /**
   * Metric B — Defender Effectiveness: mean suppression this team imposed on its
   * opponents' fuel rates during the team's own `defense_intervals` windows
   * (co-occurrence estimate; see defenseAnalytics / plan §4). Higher = better
   * defender. null when the team never played defense or no opponent overlapped.
   * Populated by `attachDefenderEffectiveness`, not `aggregateTeam`.
   */
  defenderEffectiveness: number | null;
  /** Opponents observed under this team's defense (Metric B sample size / gating). */
  defenseSampleCount: number;

  // --- Distribution + recent-form trend (display-only derived statistics) ------
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

  /** mean fuel_points over the last min(TREND_WINDOW, n) matches, chronological. */
  recentFuelMean: number;
  /** recentFuelMean - meanFuelPoints (signed; 0 when n<TREND_WINDOW). */
  recentFuelDelta: number;
  /** direction bucket derived from recentFuelDelta + threshold. */
  recentTrend: TrendDirection;
}

/**
 * meanFuelConfidence below this surfaces the rate-FUEL low-confidence chip.
 * Shared by TeamView and NextMatchView so the chip fires at one threshold
 * everywhere. Purely a display gate — confidence never weights points.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Mean of a 0–3 super-scout rating across a team's RATED matches (0 / null
 * excluded), as "2.3/3"; "—" when no match was rated. Pure over the team's
 * reports — the super-scout averages are deliberately kept OFF `TeamAgg`
 * (no new aggregate field / fixture churn). Shared by TeamView and the
 * Strategy tab's team cards.
 */
export function ratedMeanText(
  matches: MsrRow[],
  sel: (m: MsrRow) => number | null | undefined,
): string {
  const vals = matches
    .map(sel)
    .filter((v): v is number => typeof v === 'number' && v > 0);
  if (vals.length === 0) return '—';
  return `${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)}/3`;
}

/**
 * Population std-dev (`/n`, not `/(n-1)`) — these are display statistics over a
 * complete observed set, and n=1 must yield 0, not NaN.
 */
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

// Defensive (never surface ±Infinity from an empty array; aggregateTeam is never
// reached with [] — the caller groups by team so a key only exists with >=1 row).
function safeMin(values: number[]): number {
  return values.length ? Math.min(...values) : 0;
}
function safeMax(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}

/**
 * Recent-form trend: mean of the last TREND_WINDOW fuel points (chronological)
 * vs the all-match mean. `insufficient` until at least TREND_WINDOW matches.
 */
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

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Climb points for a single match: the success-gated teleop/endgame climb PLUS
 * the auto-climb bonus. A level-1 auto climb (auto_climb_level1) scores the auto
 * bonus regardless of the teleop climb outcome — it was previously dropped, so
 * auto climbs went uncounted in scoutingExpectedPoints.
 *
 * Exported so the TBA-validation module (`validateVsTba.ts`) reuses the SAME
 * per-match climb math when summing a scouted alliance's offensive points —
 * never re-implementing the frozen `SCORING.CLIMB` magnitudes.
 */
export function climbPointsForMatch(r: MsrRow): number {
  const climb = SCORING.CLIMB as Record<number, { auto: number; teleop: number }>;
  let pts = 0;
  if (r.climb_success) {
    const entry = climb[r.climb_level as 1 | 2 | 3];
    if (entry) pts += entry.teleop;
  }
  // Auto-period level-1 climb bonus (independent of the teleop climb result).
  if (r.auto_climb_level1) {
    pts += climb[1].auto;
  }
  return pts;
}

/**
 * Aggregate the (already team-filtered, non-deleted) reports for one team.
 * Caller guarantees reports.length >= 1.
 */
export function aggregateTeam(teamNumber: number, reports: MsrRow[]): TeamAgg {
  const n = reports.length;

  let sumAuto = 0;
  let sumTeleopActive = 0;
  let sumTeleopInactive = 0;
  let sumEndgame = 0;
  let sumTotal = 0;
  let sumFuelPoints = 0;
  let sumFuelConfidence = 0;
  let climbSuccessCount = 0;
  let sumClimbLevel = 0;
  let sumClimbPoints = 0;
  let sumDefense = 0;
  let noShowCount = 0;
  let diedCount = 0;
  let tippedCount = 0;
  let incidentCount = 0;

  // Distribution: per-match value arrays collected during the single loop.
  const fuelPts: number[] = [];
  const climbPts: number[] = [];
  const defense: number[] = [];

  // Metric A pooling: ball-time/duration while defended vs. baseline (undefended).
  let defendedBallTimeIn = 0;
  let defendedDurIn = 0;
  let baseBallTime = 0;
  let baseDur = 0;

  for (const r of reports) {
    sumAuto += r.auto_fuel;
    sumTeleopActive += r.teleop_fuel_active;
    sumTeleopInactive += r.teleop_fuel_inactive;
    sumEndgame += r.endgame_fuel;
    sumTotal += r.auto_fuel + r.teleop_fuel_active + r.teleop_fuel_inactive + r.endgame_fuel;
    sumFuelPoints += r.fuel_points;
    // Coalesce legacy NULL confidence to the documented 0.3 so the rate-FUEL
    // low-confidence chip still fires for pre-0008 rows. Display flag only —
    // confidence no longer weights any points. (0008 backfills the column.)
    sumFuelConfidence += r.fuel_estimate_confidence ?? 0.3;
    if (r.climb_success) climbSuccessCount += 1;
    sumClimbLevel += r.climb_level;
    const cp = climbPointsForMatch(r);
    sumClimbPoints += cp;
    sumDefense += r.defense_rating;
    fuelPts.push(r.fuel_points);
    climbPts.push(cp);
    defense.push(r.defense_rating);
    if (r.no_show) noShowCount += 1;
    if (r.died) diedCount += 1;
    if (r.tipped) tippedCount += 1;
    if (r.no_show || r.died || r.tipped) incidentCount += 1;

    // Metric A: pool this report's defended/undefended fuel ball-time.
    if (Array.isArray(r.fuel_bursts) && r.fuel_bursts.length > 0) {
      const windows = (r.defended_intervals ?? []).map(intervalAbsRange);
      const wr = weightedRate(r.fuel_bursts, windows);
      defendedBallTimeIn += wr.insideBallTime;
      defendedDurIn += wr.insideDur;
      baseBallTime += wr.outsideBallTime;
      baseDur += wr.outsideDur;
    }
  }

  const insideRate = defendedDurIn > 0 ? defendedBallTimeIn / (defendedDurIn / 1000) : null;
  const outsideRate = baseDur > 0 ? baseBallTime / (baseDur / 1000) : null;
  const fuelSuppressionWhileDefended =
    insideRate != null && outsideRate != null && outsideRate > 0
      ? clampSuppression((outsideRate - insideRate) / outsideRate)
      : null;

  const meanFuelPoints = sumFuelPoints / n;
  const meanFuelConfidence = sumFuelConfidence / n;
  const meanClimbPoints = sumClimbPoints / n;
  const noShowRate = noShowCount / n;
  const diedRate = diedCount / n;

  // Distribution: population std-dev + floor/ceiling per metric.
  const stdDevFuelPoints = stdDev(fuelPts, meanFuelPoints);
  const stdDevClimbPoints = stdDev(climbPts, meanClimbPoints);
  const avgDefenseRating = sumDefense / n;
  const stdDevDefenseRating = stdDev(defense, avgDefenseRating);

  // Recent form: sort a copy by play order, slice the trailing window of fuel.
  const sortedFuelPts = reports
    .slice()
    .sort((a, b) => compareMatchKeys(a.match_key, b.match_key))
    .map((r) => r.fuel_points);
  const trend = recentTrend(sortedFuelPts, meanFuelPoints);

  return {
    teamNumber,
    matchesScouted: n,
    meanAutoFuel: sumAuto / n,
    meanTeleopFuelActive: sumTeleopActive / n,
    meanTeleopFuelInactive: sumTeleopInactive / n,
    meanEndgameFuel: sumEndgame / n,
    meanTotalFuel: sumTotal / n,
    meanFuelPoints,
    meanFuelConfidence,
    climbSuccessRate: climbSuccessCount / n,
    avgClimbLevel: sumClimbLevel / n,
    meanClimbPoints,
    avgDefenseRating,
    noShowRate,
    diedRate,
    tippedRate: tippedCount / n,
    incidentMatches: incidentCount,
    reliability: clamp01(1 - (noShowRate + diedRate)),
    scoutingExpectedPoints: meanFuelPoints + meanClimbPoints,
    fuelSuppressionWhileDefended,
    defendedSampleMs: defendedDurIn,
    // Metric B is filled by attachDefenderEffectiveness (needs cross-team reports).
    defenderEffectiveness: null,
    defenseSampleCount: 0,
    // Distribution + recent-form trend.
    stdDevFuelPoints,
    minFuelPoints: safeMin(fuelPts),
    maxFuelPoints: safeMax(fuelPts),
    stdDevClimbPoints,
    minClimbPoints: safeMin(climbPts),
    maxClimbPoints: safeMax(climbPts),
    stdDevDefenseRating,
    minDefenseRating: safeMin(defense),
    maxDefenseRating: safeMax(defense),
    recentFuelMean: trend.mean,
    recentFuelDelta: trend.delta,
    recentTrend: trend.dir,
  };
}

/**
 * A zeroed TeamAgg for a team with NO scouting reports — used by views that list
 * EVERY event team (e.g. the Ranking tab's EPA-only rows). All means/rates are 0,
 * distribution stats 0, defense/suppression null, trend 'insufficient'. Mirrors
 * `aggregateTeam`'s n=0 output WITHOUT the divide-by-zero (aggregateTeam divides
 * by the report count).
 */
export function emptyTeamAgg(teamNumber: number): TeamAgg {
  return {
    teamNumber,
    matchesScouted: 0,
    meanAutoFuel: 0,
    meanTeleopFuelActive: 0,
    meanTeleopFuelInactive: 0,
    meanEndgameFuel: 0,
    meanTotalFuel: 0,
    meanFuelPoints: 0,
    meanFuelConfidence: 0,
    climbSuccessRate: 0,
    avgClimbLevel: 0,
    meanClimbPoints: 0,
    avgDefenseRating: 0,
    noShowRate: 0,
    diedRate: 0,
    tippedRate: 0,
    incidentMatches: 0,
    reliability: 0,
    scoutingExpectedPoints: 0,
    fuelSuppressionWhileDefended: null,
    defendedSampleMs: 0,
    defenderEffectiveness: null,
    defenseSampleCount: 0,
    stdDevFuelPoints: 0,
    minFuelPoints: 0,
    maxFuelPoints: 0,
    stdDevClimbPoints: 0,
    minClimbPoints: 0,
    maxClimbPoints: 0,
    stdDevDefenseRating: 0,
    minDefenseRating: 0,
    maxDefenseRating: 0,
    recentFuelMean: 0,
    recentFuelDelta: 0,
    recentTrend: 'insufficient',
  };
}

/**
 * Metric B — Defender Effectiveness pass over the WHOLE event. Mutates the aggs
 * map in place: for each report where a team played defense, measure how much its
 * opponents' fuel rates dropped during that team's defense windows, averaged
 * across opponents/matches. Needs all reports (not one team's), so it runs after
 * `aggregateTeam`. Co-occurrence estimate; consumers gate on `defenseSampleCount`.
 */
export function attachDefenderEffectiveness(
  aggs: Map<number, TeamAgg>,
  reports: MsrRow[],
): void {
  // Index live reports by match, then by alliance color.
  const byMatch = new Map<string, { red: MsrRow[]; blue: MsrRow[] }>();
  for (const r of reports) {
    if (r.deleted === true) continue;
    let bucket = byMatch.get(r.match_key);
    if (!bucket) {
      bucket = { red: [], blue: [] };
      byMatch.set(r.match_key, bucket);
    }
    bucket[r.alliance_color].push(r);
  }

  // Accumulate per defending team across all its defense reports/opponents.
  const acc = new Map<number, { sum: number; count: number }>();

  for (const bucket of byMatch.values()) {
    for (const color of ['red', 'blue'] as const) {
      const oppColor = color === 'red' ? 'blue' : 'red';
      const opponents = bucket[oppColor];
      if (opponents.length === 0) continue;

      // One report per opponent team: prefer the richest (most fuel_bursts),
      // skip unreliable victims (no_show / died).
      const bestByOpp = new Map<number, MsrRow>();
      for (const o of opponents) {
        if (o.no_show || o.died) continue;
        const burstCount = Array.isArray(o.fuel_bursts) ? o.fuel_bursts.length : 0;
        if (burstCount === 0) continue;
        const prev = bestByOpp.get(o.target_team_number);
        const prevCount = prev && Array.isArray(prev.fuel_bursts) ? prev.fuel_bursts.length : -1;
        if (!prev || burstCount > prevCount) bestByOpp.set(o.target_team_number, o);
      }
      if (bestByOpp.size === 0) continue;
      const oppReports = Array.from(bestByOpp.values());

      for (const d of bucket[color]) {
        const intervals = d.defense_intervals;
        if (!Array.isArray(intervals) || intervals.length === 0) continue;
        const defenseWindows = intervals.map(intervalAbsRange);
        const res = defenderEffectivenessForMatch(defenseWindows, oppReports);
        if (!res) continue;
        const entry = acc.get(d.target_team_number);
        if (entry) {
          entry.sum += res.sum;
          entry.count += res.count;
        } else {
          acc.set(d.target_team_number, { sum: res.sum, count: res.count });
        }
      }
    }
  }

  for (const [teamNumber, agg] of aggs) {
    const entry = acc.get(teamNumber);
    if (entry && entry.count > 0) {
      agg.defenderEffectiveness = entry.sum / entry.count;
      agg.defenseSampleCount = entry.count;
    } else {
      agg.defenderEffectiveness = null;
      agg.defenseSampleCount = 0;
    }
  }
}

/**
 * Aggregate all reports for an event, grouped by target_team_number.
 * Skips deleted rows; only produces entries for teams with >= 1 live report.
 */
export function aggregateEvent(reports: MsrRow[]): Map<number, TeamAgg> {
  const byTeam = new Map<number, MsrRow[]>();
  for (const r of reports) {
    if (r.deleted === true) continue;
    const bucket = byTeam.get(r.target_team_number);
    if (bucket) bucket.push(r);
    else byTeam.set(r.target_team_number, [r]);
  }

  const result = new Map<number, TeamAgg>();
  for (const [teamNumber, teamReports] of byTeam) {
    result.set(teamNumber, aggregateTeam(teamNumber, teamReports));
  }
  // Cross-team Metric B pass (needs all reports), filling the map in place.
  attachDefenderEffectiveness(result, reports);
  return result;
}

// ===========================================================================
// Component split + scouting-defense (component-epa-estimation feature, §3A/§7).
//
// Pure helpers over already-aggregated `TeamAgg`. They feed `predict.ts`'s
// `resolveComponentBreakdown`, which presentationally decomposes a team's blended
// `expected` into auto/fuel/climb. NO scoring magnitudes are re-implemented — the
// split reuses `SCORING.FUEL_POINTS` + the existing `meanFuelPoints` /
// `meanClimbPoints` already on `TeamAgg`. Defense is SCOUTING-ONLY (no
// results-residual path; that was dropped as circular — plan §7).
// ===========================================================================

export interface ComponentSplit {
  auto: number;
  fuel: number;
  climb: number;
}

export interface ComponentFraction {
  fAuto: number;
  fFuel: number;
  fClimb: number;
}

/**
 * Cold-start REBUILT component fraction used for the no-scouting (EPA) branch
 * when the event has too little scouting to fit one. NOTE: `fClimb` is NO LONGER
 * read by the breakdown resolver — climb is surfaced ONLY from real scouting
 * (`resolveComponentBreakdown` re-normalizes the auto:fuel ratio and shows climb
 * as "—" for unscouted teams, rather than fabricating ~30% climb). `fClimb` is
 * kept only so the fitted fraction shape stays whole. FLAGGED (plan §3A/§11).
 */
export const F_DEFAULT: ComponentFraction = { fAuto: 0.15, fFuel: 0.55, fClimb: 0.3 };

/**
 * Decompose ONE team's scouting into auto / teleop-fuel / climb points on the
 * SAME basis the prediction's scouting term uses (`scoutingExpectedPoints =
 * meanFuelPoints + meanClimbPoints`). The RAW `meanFuelPoints` is split by the
 * team's auto-vs-teleop FUEL proportion, so the split is INSENSITIVE to
 * `SCORING.FUEL_POINTS` (it's a ratio). `climb` is `meanClimbPoints` (already
 * points; the L1 auto-climb bonus lands here, NOT in auto — surfaced as a UI
 * footnote, plan §3A/§4).
 *
 * `auto + fuel + climb === scoutingExpectedPoints` (within float epsilon) by
 * construction. Returns all-zero for a team with no scouting.
 */
export function aggregateTeamComponentSplit(agg: TeamAgg): ComponentSplit {
  const fp = SCORING.FUEL_POINTS;
  const rawAuto = agg.meanAutoFuel * fp;
  // ONLY point-scoring fuel: `meanFuelPoints` (the basis being split) counts
  // active windows exclusively, so inactive-shift fuel must not enter the
  // ratio — it earned zero of the points being attributed, and including it
  // skewed the auto share low for every feed-heavy team.
  const rawFuel = (agg.meanTeleopFuelActive + agg.meanEndgameFuel) * fp;
  const fuelTot = rawAuto + rawFuel;
  const fuelBasis = agg.meanFuelPoints;
  // Guard a zero FUEL total: route all fuel points to the fuel bucket so we
  // never divide by zero (and never silently shift it into auto).
  const autoPts = fuelTot > 0 ? fuelBasis * (rawAuto / fuelTot) : 0;
  const fuelPts = fuelTot > 0 ? fuelBasis * (rawFuel / fuelTot) : fuelBasis;
  return { auto: autoPts, fuel: fuelPts, climb: agg.meanClimbPoints };
}

/**
 * Scouting-only defender suppression in points (plan §7). Precise co-occurrence
 * signal (`defenderEffectiveness` × typical opponent fuel) when present + gated
 * by `defenseSampleCount`; else the contextless ordinal `avgDefenseRating` map;
 * else `null` (renders `—`). NEVER results-derived — there is no non-circular,
 * client-side way to estimate suppression from TBA totals alone.
 */
export function aggregateTeamDefensePts(agg: TeamAgg): number | null {
  if (agg.defenderEffectiveness != null && agg.defenseSampleCount >= 1) {
    return agg.defenderEffectiveness * TYPICAL_OPP_TELEOP_FUEL;
  }
  if (agg.matchesScouted > 0 && agg.avgDefenseRating > 0) {
    return (agg.avgDefenseRating / 3) * DEFENSE_RATING_MAX_PTS;
  }
  return null;
}

/**
 * Fit the event-wide component fraction `f=(fAuto,fFuel,fClimb)` (sums to 1) from
 * the scouted teams' component means (on the `scoutingExpectedPoints` basis).
 * Used ONLY for the no-scouting (EPA) split branch — scouted teams use their own
 * means. Returns {@link F_DEFAULT} when fewer than `MIN_FIT_REPORTS` reports back
 * the event, or when the fitted total is degenerate (all-zero scouting). Pure.
 */
export function fitComponentFraction(aggs: Iterable<TeamAgg>): ComponentFraction {
  let totalReports = 0;
  let sumAuto = 0;
  let sumFuel = 0;
  let sumClimb = 0;
  let scoutedTeams = 0;
  for (const agg of aggs) {
    if (agg.matchesScouted <= 0) continue;
    totalReports += agg.matchesScouted;
    const s = aggregateTeamComponentSplit(agg);
    sumAuto += s.auto;
    sumFuel += s.fuel;
    sumClimb += s.climb;
    scoutedTeams += 1;
  }
  if (scoutedTeams === 0 || totalReports < MIN_FIT_REPORTS) return F_DEFAULT;
  const meanAuto = sumAuto / scoutedTeams;
  const meanFuel = sumFuel / scoutedTeams;
  const meanClimb = sumClimb / scoutedTeams;
  const T = meanAuto + meanFuel + meanClimb;
  if (!(T > 0)) return F_DEFAULT;
  return { fAuto: meanAuto / T, fFuel: meanFuel / T, fClimb: meanClimb / T };
}

// ===========================================================================
// Scouter load + accuracy-vs-consensus (scouter-load-accuracy feature).
//
// Read-only display statistics computed client-side from already-fetched
// MsrRow rows. NO migration, NO wire-shape change, NO scoring duplication —
// agreement is scout-to-scout consistency, not points. Appended below the
// team-aggregate logic so reconciliation / defense-analytics reuse the
// `mode` + `buildOverlapIndex` helpers rather than re-declaring them.
// ===========================================================================

/** Below this overlap count, accuracy numbers are flagged provisional (noisy). */
export const ACCURACY_MIN_OVERLAPS = 3;
/** fuel_points absolute tolerance floor (within ± of consensus mean agrees). */
export const FUEL_ABS_TOL = 5;
/** fuel_points relative tolerance — 10% of the consensus mean. */
export const FUEL_REL_TOL = 0.1;
/** defense_rating ordinal (0..3) — within ±1 of consensus mode agrees. */
export const DEFENSE_TOL = 1;

/** Per-scout load: how much work this scout_id authored at the event. */
export interface ScouterLoadAgg {
  scoutId: string;
  reportCount: number; // live reports authored by this scout_id
  matches: number; // distinct match_key
  teams: number; // distinct target_team_number
}

/** Event-wide load summary across all scout_ids. */
export interface EventScouterStats {
  byScout: Map<string, ScouterLoadAgg>;
  totalReports: number;
  activeScouts: number; // scouts with reportCount >= 1
  meanLoad: number; // totalReports / activeScouts (0 when none)
  maxLoad: number; // max reportCount across scouts (0 when none)
}

/**
 * Per-scout agreement vs the consensus of all scouts who covered the same
 * (match, target_team). RAW counters are the source of truth; the `*Rate`
 * fields are derived (agree/elig, null when elig===0) so the UI can SUM the
 * counters across the multiple scout_ids that map to one display name and
 * re-derive an exact rate, rather than (incorrectly) averaging two pre-divided
 * rates (`mergeAccuracy`).
 */
export interface ScouterAccuracyAgg {
  scoutId: string;
  overlaps: number; // # of this scout's reports sharing (match,team) with >=1 other scout
  fuelAgree: number;
  fuelElig: number;
  climbAgree: number;
  climbElig: number;
  defenseAgree: number;
  defenseElig: number;
  fuelAgreeRate: number | null;
  climbAgreeRate: number | null;
  defenseAgreeRate: number | null;
  overallAgreeRate: number | null; // mean of the non-null signal rates
  provisional: boolean; // overlaps < ACCURACY_MIN_OVERLAPS
}

/**
 * Most frequent value; ties broken by the SMALLEST value (deterministic,
 * order-independent). Returns null for empty input.
 */
export function mode<T>(values: T[]): T | null {
  if (values.length === 0) return null;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && best != null && v < best)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Group live reports by `${match_key}::${target_team_number}` so multi-scout
 * coverage of one robot lands in one bucket. Skips deleted rows; keeps
 * no_show/died (eligibility is applied per-signal, not at the index). A single
 * Map keeps this O(n) instead of O(n²) pairwise scanning.
 */
export function buildOverlapIndex(reports: MsrRow[]): Map<string, MsrRow[]> {
  const idx = new Map<string, MsrRow[]>();
  for (const r of reports) {
    if (r.deleted === true) continue;
    const key = `${r.match_key}::${r.target_team_number}`;
    const bucket = idx.get(key);
    if (bucket) bucket.push(r);
    else idx.set(key, [r]);
  }
  return idx;
}

/** Per-scout load + event-wide summary. O(n). No NaN on empty input. */
export function aggregateScouterLoad(reports: MsrRow[]): EventScouterStats {
  const work = new Map<string, { reportCount: number; matchSet: Set<string>; teamSet: Set<number> }>();
  for (const r of reports) {
    if (r.deleted === true) continue;
    if (r.scout_id == null) continue;
    let agg = work.get(r.scout_id);
    if (!agg) {
      agg = { reportCount: 0, matchSet: new Set(), teamSet: new Set() };
      work.set(r.scout_id, agg);
    }
    agg.reportCount += 1;
    agg.matchSet.add(r.match_key);
    agg.teamSet.add(r.target_team_number);
  }

  const byScout = new Map<string, ScouterLoadAgg>();
  let totalReports = 0;
  let maxLoad = 0;
  for (const [scoutId, agg] of work) {
    byScout.set(scoutId, {
      scoutId,
      reportCount: agg.reportCount,
      matches: agg.matchSet.size,
      teams: agg.teamSet.size,
    });
    totalReports += agg.reportCount;
    if (agg.reportCount > maxLoad) maxLoad = agg.reportCount;
  }
  const activeScouts = byScout.size;
  const meanLoad = activeScouts > 0 ? totalReports / activeScouts : 0;
  return { byScout, totalReports, activeScouts, meanLoad, maxLoad };
}

/** Finalize a raw counter set into derived rates + provisional flag. */
function finalizeAccuracy(
  scoutId: string,
  raw: {
    overlaps: number;
    fuelAgree: number;
    fuelElig: number;
    climbAgree: number;
    climbElig: number;
    defenseAgree: number;
    defenseElig: number;
  },
): ScouterAccuracyAgg {
  const fuelAgreeRate = raw.fuelElig > 0 ? raw.fuelAgree / raw.fuelElig : null;
  const climbAgreeRate = raw.climbElig > 0 ? raw.climbAgree / raw.climbElig : null;
  const defenseAgreeRate = raw.defenseElig > 0 ? raw.defenseAgree / raw.defenseElig : null;
  const signals = [fuelAgreeRate, climbAgreeRate, defenseAgreeRate].filter(
    (x): x is number => x != null,
  );
  const overallAgreeRate =
    signals.length > 0 ? signals.reduce((a, b) => a + b, 0) / signals.length : null;
  return {
    scoutId,
    overlaps: raw.overlaps,
    fuelAgree: raw.fuelAgree,
    fuelElig: raw.fuelElig,
    climbAgree: raw.climbAgree,
    climbElig: raw.climbElig,
    defenseAgree: raw.defenseAgree,
    defenseElig: raw.defenseElig,
    fuelAgreeRate,
    climbAgreeRate,
    defenseAgreeRate,
    overallAgreeRate,
    provisional: raw.overlaps < ACCURACY_MIN_OVERLAPS,
  };
}

/**
 * Agreement-vs-consensus accuracy per scout_id, computed only over (match,team)
 * groups covered by >= 2 scouts. Consensus is over the FULL group (including
 * this scout) so it is order-independent. no_show/died reports are excluded
 * from the fuel + climb consensus and eligibility (ground truth undefined), but
 * still count toward defense consensus when rated. O(n) build + O(Σ group²)
 * compare (groups are tiny).
 */
export function aggregateScouterAccuracy(reports: MsrRow[]): Map<string, ScouterAccuracyAgg> {
  const idx = buildOverlapIndex(reports);
  const raw = new Map<
    string,
    {
      overlaps: number;
      fuelAgree: number;
      fuelElig: number;
      climbAgree: number;
      climbElig: number;
      defenseAgree: number;
      defenseElig: number;
    }
  >();
  const ensure = (scoutId: string) => {
    let r = raw.get(scoutId);
    if (!r) {
      r = {
        overlaps: 0,
        fuelAgree: 0,
        fuelElig: 0,
        climbAgree: 0,
        climbElig: 0,
        defenseAgree: 0,
        defenseElig: 0,
      };
      raw.set(scoutId, r);
    }
    return r;
  };

  for (const group of idx.values()) {
    if (group.length < 2) continue; // not an overlap

    const scored = group.filter((r) => !r.no_show && !r.died);
    const fuelConsensus =
      scored.length > 0
        ? scored.reduce((a, r) => a + r.fuel_points, 0) / scored.length
        : null;
    const climbConsensus = mode(
      scored.map((r) => `${r.climb_success ? 1 : 0}:${r.climb_level}`),
    );
    const defenseConsensus = mode(group.map((r) => r.defense_rating));

    for (const r of group) {
      if (r.scout_id == null) continue;
      const acc = ensure(r.scout_id);
      acc.overlaps += 1;

      // Fuel — exclude no_show/died from eligibility.
      if (!(r.no_show || r.died) && fuelConsensus != null) {
        acc.fuelElig += 1;
        const tol = Math.max(FUEL_ABS_TOL, FUEL_REL_TOL * fuelConsensus);
        if (Math.abs(r.fuel_points - fuelConsensus) <= tol) acc.fuelAgree += 1;
      }
      // Climb — exclude no_show/died from eligibility.
      if (!(r.no_show || r.died) && climbConsensus != null) {
        acc.climbElig += 1;
        if (`${r.climb_success ? 1 : 0}:${r.climb_level}` === climbConsensus) {
          acc.climbAgree += 1;
        }
      }
      // Defense — always rated; ±1 of consensus mode agrees.
      if (defenseConsensus != null) {
        acc.defenseElig += 1;
        if (Math.abs(r.defense_rating - defenseConsensus) <= DEFENSE_TOL) {
          acc.defenseAgree += 1;
        }
      }
    }
  }

  const out = new Map<string, ScouterAccuracyAgg>();
  for (const [scoutId, r] of raw) out.set(scoutId, finalizeAccuracy(scoutId, r));
  return out;
}

/**
 * Sum the raw counters + overlaps across the scout_ids that map to one display
 * name and re-derive the rates from the summed counts — NEVER averages two
 * pre-divided rates. Returns null for [] (or all-missing). The scoutId of the
 * merged result is the first input's, purely for shape; callers key by name.
 */
export function mergeAccuracy(aggs: ScouterAccuracyAgg[]): ScouterAccuracyAgg | null {
  if (aggs.length === 0) return null;
  const sum = {
    overlaps: 0,
    fuelAgree: 0,
    fuelElig: 0,
    climbAgree: 0,
    climbElig: 0,
    defenseAgree: 0,
    defenseElig: 0,
  };
  for (const a of aggs) {
    sum.overlaps += a.overlaps;
    sum.fuelAgree += a.fuelAgree;
    sum.fuelElig += a.fuelElig;
    sum.climbAgree += a.climbAgree;
    sum.climbElig += a.climbElig;
    sum.defenseAgree += a.defenseAgree;
    sum.defenseElig += a.defenseElig;
  }
  return finalizeAccuracy(aggs[0].scoutId, sum);
}

// ===========================================================================
// Alliance matchup synthesis (matchup-intelligence feature).
//
// Pure, display-only heuristics over already-aggregated `TeamAgg` values: turn
// the two alliances' aggregates into short imperative coaching bullets. No new
// scored quantity, no scoring duplication, no server compute — thresholds are
// DISPLAY heuristics (not SCORING magnitudes), so the client-display-only /
// server-recompute boundary is untouched. Appended below the team aggregates.
// ===========================================================================

export type TacticSeverity = 'high' | 'med';

export interface Tactic {
  teamNumber: number; // the robot the tactic is about (0 = alliance-wide rollup)
  kind: 'climb' | 'feed' | 'fuel' | 'defense' | 'fragile';
  severity: TacticSeverity;
  text: string; // imperative coaching phrase
}

export interface AllianceGuidance {
  threats: Tactic[]; // what to WATCH (their strengths)
  exploits: Tactic[]; // what to EXPLOIT (their weaknesses)
  scouted: boolean; // false when no team on the alliance has matchesScouted > 0
}

export interface MatchupGuidance {
  red: AllianceGuidance;
  blue: AllianceGuidance;
}

// Thresholds tuned for REBUILT magnitudes (SCORING.CLIMB L3 teleop = 30). These
// are DISPLAY heuristics, NOT scoring values.
const RELIABLE_CLIMB_RATE = 0.6; // climbSuccessRate
const HIGH_CLIMB_LEVEL = 2.5; // avgClimbLevel
const UNRELIABLE_CLIMB_RATE = 0.4;
const HEAVY_FEED_FUEL = 25; // meanTeleopFuelInactive
const LOW_FUEL_PTS = 30; // meanFuelPoints per match
const STRONG_DEFENSE = 1.5; // avgDefenseRating (0-3)
const FRAGILE_RELIABILITY = 0.6; // reliability = clamp01(1 - noShowRate - diedRate)

function pctText(x: number): string {
  return `${Math.round(x * 100)}%`;
}

const SEVERITY_RANK: Record<TacticSeverity, number> = { high: 0, med: 1 };

/** Stable sort: high before med, then ascending team number. Cap at 4. */
function rankTactics(tactics: Tactic[]): Tactic[] {
  return tactics
    .slice()
    .sort((a, b) => {
      const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (s !== 0) return s;
      return a.teamNumber - b.teamNumber;
    })
    .slice(0, 4);
}

/** Synthesize coaching bullets for one alliance from its (up-to-3) team aggs. */
function guidanceForAlliance(aggs: (TeamAgg | undefined)[]): AllianceGuidance {
  const scouted = aggs.some((a) => a != null && a.matchesScouted > 0);
  const threats: Tactic[] = [];
  const exploits: Tactic[] = [];

  // Only consider teams with at least one scouted match.
  const live = aggs.filter((a): a is TeamAgg => a != null && a.matchesScouted > 0);

  for (const a of live) {
    const t = a.teamNumber;

    // --- THREATS (their strengths to WATCH) ---
    if (a.climbSuccessRate >= RELIABLE_CLIMB_RATE && a.avgClimbLevel >= HIGH_CLIMB_LEVEL) {
      threats.push({
        teamNumber: t,
        kind: 'climb',
        severity: 'high',
        text: `Contest ${t}'s L${Math.round(a.avgClimbLevel)} climb`,
      });
    }
    if (a.meanTeleopFuelInactive >= HEAVY_FEED_FUEL) {
      threats.push({
        teamNumber: t,
        kind: 'feed',
        severity: 'med',
        text: `Deny the feed lane — ${t} feeds heavily`,
      });
    }
    if (a.avgDefenseRating >= STRONG_DEFENSE) {
      threats.push({
        teamNumber: t,
        kind: 'defense',
        severity: 'med',
        text: `${t} plays defense (${a.avgDefenseRating.toFixed(1)}/3) — protect our shooter`,
      });
    }
    if (a.meanFuelPoints >= 2 * LOW_FUEL_PTS) {
      threats.push({
        teamNumber: t,
        kind: 'fuel',
        severity: 'high',
        text: `${t} is a heavy scorer (~${Math.round(a.meanFuelPoints)} fuel pts) — pressure their cycle`,
      });
    }

    // --- EXPLOITS (their weaknesses to EXPLOIT) ---
    if (a.reliability < FRAGILE_RELIABILITY) {
      exploits.push({
        teamNumber: t,
        kind: 'fragile',
        severity: 'high',
        text: `${t} is fragile (${pctText(a.reliability)} reliable) — pressure early`,
      });
    }
    if (a.climbSuccessRate < UNRELIABLE_CLIMB_RATE) {
      exploits.push({
        teamNumber: t,
        kind: 'climb',
        severity: 'med',
        text: `${t} rarely climbs (${pctText(a.climbSuccessRate)}) — they may forfeit endgame`,
      });
    }
    if (a.meanFuelPoints < LOW_FUEL_PTS) {
      exploits.push({
        teamNumber: t,
        kind: 'fuel',
        severity: 'med',
        text: `${t} scores little fuel (~${Math.round(a.meanFuelPoints)} pts) — leans on climb/defense`,
      });
    }
  }

  // Alliance-level rollup (added once, not per team): no defenders anywhere.
  if (live.length > 0 && live.every((a) => a.avgDefenseRating < 0.5)) {
    exploits.push({
      teamNumber: 0,
      kind: 'defense',
      severity: 'med',
      text: 'Weak defense across the alliance — free shooting lanes',
    });
  }

  return { threats: rankTactics(threats), exploits: rankTactics(exploits), scouted };
}

/**
 * Synthesize tactical guidance for both alliances. Pure; reads only `TeamAgg`.
 * Each arg is the up-to-3 aggregates for that alliance; `undefined` entries
 * (unscouted teams) are skipped so the synthesis degrades gracefully.
 */
export function synthesizeMatchupGuidance(
  redAggs: (TeamAgg | undefined)[],
  blueAggs: (TeamAgg | undefined)[],
): MatchupGuidance {
  return {
    red: guidanceForAlliance(redAggs),
    blue: guidanceForAlliance(blueAggs),
  };
}

// ===========================================================================
// Scout heartbeat / data-freshness coverage (dashboard-heartbeat feature).
//
// Pure, display-only aggregation of the report stream + scout roster: "who has
// reported on a match, when did the last report land, who hasn't reported yet".
// NO scored quantity is produced (so the server-recompute invariant is
// irrelevant), NO wire-shape change, NO scoring duplication. Read-only over
// already-persisted columns (`scout_id`, `server_received_at`, `station`,
// `match_key`, `deleted`). The sibling coverage-gaps feature imports
// `eventScoutCoverage` rather than forking — DO NOT change these signatures
// without updating that consumer.
// ===========================================================================

/** Default station cap: a full 6-station match (3 per alliance). */
export const COVERAGE_STATION_CAP = 6;

/**
 * Largest parseable `server_received_at` among `rows`, kept as the raw ISO
 * string so the formatter stays the single time source. Skips nullish/garbage
 * stamps (QR-ingested / merged rows can surface `undefined` despite the static
 * non-nullable type). Returns null when no row has a parseable stamp.
 */
function maxReceivedAt(rows: MsrRow[]): string | null {
  let bestIso: string | null = null;
  let bestMs = -Infinity;
  for (const r of rows) {
    const iso = r.server_received_at ?? null;
    if (iso == null) continue;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      bestIso = iso;
    }
  }
  return bestIso;
}

/**
 * Compute coverage for ONE match's already-bucketed reports. Internal so the
 * event-level loop reuses it (O(reports + matches·scouts) rather than
 * re-scanning all reports per match). `bucket` is the live (non-deleted) rows
 * for `matchKey`.
 */
/**
 * Distinct scouter identities by display name (case/space-insensitive). A single
 * person can have more than one `scout` row (a duplicate/stale identity from
 * name re-pick or two-device sign-in), so counting raw rows over-states how many
 * scouters there actually are. Deduping by name matches the roster the lead sees.
 */
function distinctScouterCount(scouts: ScoutLite[]): number {
  const names = new Set<string>();
  // Null/blank name → fall back to the unique id so anomalous unnamed rows stay
  // distinct (matching the old raw-row count) while real duplicate names collapse.
  for (const s of scouts) names.add((s.display_name ?? s.id).trim().toLowerCase());
  return names.size;
}

function coverageFromBucket(
  bucket: MsrRow[],
  matchKey: string,
  scouts: ScoutLite[],
  stationCap: number,
): MatchScoutCoverage {
  const reportedScoutIds = new Set<string>();
  // Station numbers are 1|2|3 PER ALLIANCE — key by alliance+station or red 1
  // and blue 1 collapse into one entry and coverage tops out at 3/6 forever.
  const stations = new Set<string>();
  let unattributed = 0;
  for (const r of bucket) {
    if (r.scout_id == null) unattributed += 1;
    else reportedScoutIds.add(r.scout_id);
    if (r.station != null) stations.add(`${r.alliance_color}:${r.station}`);
  }
  const missingScouts: ScoutLite[] = scouts
    .filter((s) => !reportedScoutIds.has(s.id))
    .map((s) => ({ id: s.id, display_name: s.display_name }));
  // Count by distinct SCOUTER (display name), not raw scout rows: a person can
  // own >1 scout row (duplicate/stale identity), which would otherwise inflate
  // the "X/Y scouts" denominator above the roster the lead actually sees.
  const nameById = new Map(scouts.map((s) => [s.id, (s.display_name ?? s.id).trim().toLowerCase()]));
  const reportedNames = new Set<string>();
  for (const id of reportedScoutIds) reportedNames.add(nameById.get(id) ?? id);
  return {
    matchKey,
    scoutsCovered: reportedNames.size,
    scoutsTotal: distinctScouterCount(scouts),
    lastReportAt: maxReceivedAt(bucket),
    reportedScoutIds: Array.from(reportedScoutIds),
    missingScouts,
    unattributed,
    stationsCovered: Math.min(stationCap, stations.size),
  };
}

/**
 * Per-match scout coverage synthesized from the report stream + roster. Single
 * pass over `reports`, filtering to live rows for `matchKey`. Empty match (no
 * rows) → scoutsCovered:0, lastReportAt:null, missingScouts = all scouts.
 */
export function matchScoutCoverage(
  reports: MsrRow[],
  scouts: ScoutLite[],
  matchKey: string,
  stationCap: number = COVERAGE_STATION_CAP,
): MatchScoutCoverage {
  const bucket: MsrRow[] = [];
  for (const r of reports) {
    if (r.deleted === true) continue;
    if (r.match_key === matchKey) bucket.push(r);
  }
  return coverageFromBucket(bucket, matchKey, scouts, stationCap);
}

/**
 * Event-wide scout coverage: per-match coverage map + the global freshest
 * `server_received_at` across ALL live reports + the roster size. ONE pass to
 * bucket by match, then `coverageFromBucket` per match. Degrades gracefully on
 * empty inputs (no divide-by-zero; missingScouts/coverageByMatch empty).
 */
export function eventScoutCoverage(
  reports: MsrRow[],
  scouts: ScoutLite[],
  stationCap: number = COVERAGE_STATION_CAP,
): { coverageByMatch: Map<string, MatchScoutCoverage>; lastReportAt: string | null; scoutsTotal: number } {
  const byMatch = new Map<string, MsrRow[]>();
  let globalIso: string | null = null;
  let globalMs = -Infinity;
  for (const r of reports) {
    if (r.deleted === true) continue;
    const bucket = byMatch.get(r.match_key);
    if (bucket) bucket.push(r);
    else byMatch.set(r.match_key, [r]);
    const iso = r.server_received_at ?? null;
    if (iso != null) {
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms) && ms > globalMs) {
        globalMs = ms;
        globalIso = iso;
      }
    }
  }
  const coverageByMatch = new Map<string, MatchScoutCoverage>();
  for (const [matchKey, bucket] of byMatch) {
    coverageByMatch.set(matchKey, coverageFromBucket(bucket, matchKey, scouts, stationCap));
  }
  return { coverageByMatch, lastReportAt: globalIso, scoutsTotal: distinctScouterCount(scouts) };
}
