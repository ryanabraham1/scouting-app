// src/dash/aggregate.ts
// Pure aggregation over match_scouting_report rows (contracts §2).
// Uses frozen scoring magnitudes from @/scoring (never re-implemented here).

import { SCORING } from '@/scoring';
import type { MsrRow } from './types';

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
  /** mean fuel_estimate_confidence (0..1) */
  meanFuelConfidence: number;
  /** meanFuelPoints * meanFuelConfidence (rate-FUEL down-weight) */
  fuelPointsWeighted: number;
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
  /** clamp01(1 - (noShowRate + diedRate)) */
  reliability: number;
  /** per-match expected, OUR data, FUEL down-weighted: fuelPointsWeighted + meanClimbPoints */
  scoutingExpectedPoints: number;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Teleop climb points for a single match (success-gated; level 0 -> 0). */
function climbPointsForMatch(r: MsrRow): number {
  if (!r.climb_success) return 0;
  const lvl = r.climb_level as 1 | 2 | 3;
  const entry = (SCORING.CLIMB as Record<number, { auto: number; teleop: number }>)[lvl];
  return entry ? entry.teleop : 0;
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

  for (const r of reports) {
    sumAuto += r.auto_fuel;
    sumTeleopActive += r.teleop_fuel_active;
    sumTeleopInactive += r.teleop_fuel_inactive;
    sumEndgame += r.endgame_fuel;
    sumTotal += r.auto_fuel + r.teleop_fuel_active + r.teleop_fuel_inactive + r.endgame_fuel;
    sumFuelPoints += r.fuel_points;
    sumFuelConfidence += r.fuel_estimate_confidence;
    if (r.climb_success) climbSuccessCount += 1;
    sumClimbLevel += r.climb_level;
    sumClimbPoints += climbPointsForMatch(r);
    sumDefense += r.defense_rating;
    if (r.no_show) noShowCount += 1;
    if (r.died) diedCount += 1;
  }

  const meanFuelPoints = sumFuelPoints / n;
  const meanFuelConfidence = sumFuelConfidence / n;
  const fuelPointsWeighted = meanFuelPoints * meanFuelConfidence;
  const meanClimbPoints = sumClimbPoints / n;
  const noShowRate = noShowCount / n;
  const diedRate = diedCount / n;

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
    fuelPointsWeighted,
    climbSuccessRate: climbSuccessCount / n,
    avgClimbLevel: sumClimbLevel / n,
    meanClimbPoints,
    avgDefenseRating: sumDefense / n,
    noShowRate,
    diedRate,
    reliability: clamp01(1 - (noShowRate + diedRate)),
    scoutingExpectedPoints: fuelPointsWeighted + meanClimbPoints,
  };
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
  return result;
}
