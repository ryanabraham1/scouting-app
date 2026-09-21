// src/dash/validateVsTba.ts
// Validate-scout-data-vs-TBA feature — PURE, client-side cross-check that the
// points our scouts captured for a played match roughly reconcile with the
// OFFICIAL alliance score TBA reports. Flags matches where the two diverge so a
// lead can spot a missed robot, a fat-fingered fuel count, or a double-count.
//
// NO React, NO I/O. NO new wire fields (mapReport.ts untouched), NO scoring
// duplication — `fuel_points` is the server-recomputed aggregate the dashboard
// already displays. This is a PARALLEL read of the same MsrRow rows + the
// official score off the MatchRow.
//
// IMPORTANT — what this compares (and what it does NOT): our scouted "offensive"
// points = Σ(fuel_points) across the alliance's robots. The OFFICIAL TBA
// score also includes points we never scout (auto mobility, climbs, fouls
// AWARDED from the opposing alliance, etc.), so a scouted sum is expected to run UNDER
// the official total. The tolerances below are therefore generous: this is a
// gross-error sanity check, not an exact reconciliation. The labels say as much.

import type { MsrRow } from './types';

// --- Tunable thresholds (exported so tests + UI share the exact same numbers).
/** Absolute points band: within ± this of the official score is a match. */
export const TBA_VALIDATE_ABS_TOL = 12;
/** Relative band: within ± this fraction of the official score is a match. */
export const TBA_VALIDATE_REL_TOL = 0.15;
/** At/above this fraction of the official score, the gap is a SEVERE divergence. */
export const TBA_VALIDATE_SEVERE_REL = 0.3;
/** A full alliance is 3 robots; fewer scouted → the sum is structurally low. */
export const FULL_ALLIANCE = 3;

/**
 * Severity tier of one alliance's scout-vs-official check.
 *  - `unscored`   — match not played yet (no official score to compare against).
 *  - `unscouted`  — no live scout reports for this alliance.
 *  - `incomplete` — fewer than 3 robots scouted, so the scouted sum is
 *                   structurally low; we report the numbers but don't grade it a
 *                   conflict (a missing robot isn't a data-quality error).
 *  - `match`      — scouted offense reconciles with the official score (within tol).
 *  - `minor`      — outside tolerance, below the severe threshold.
 *  - `severe`     — a large divergence: likely a missed/duplicated robot or a
 *                   badly mis-captured count.
 */
export type TbaValidationSeverity =
  | 'unscored'
  | 'unscouted'
  | 'incomplete'
  | 'match'
  | 'minor'
  | 'severe';

export interface AllianceScoreCheck {
  allianceColor: 'red' | 'blue';
  /** distinct robots (by station) with a live report on this alliance. */
  scoutedRobots: number;
  /** Σ(fuel_points) across the deduped reports — our scouted offense. */
  scoutedOffensePoints: number;
  /** official alliance score off the MatchRow, or null when unplayed. */
  officialScore: number | null;
  /** scoutedOffensePoints − officialScore (null when not comparable). */
  delta: number | null;
  /** tolerance band actually used = max(abs, rel·official); null when N/A. */
  tolerance: number | null;
  severity: TbaValidationSeverity;
}

export interface MatchTbaValidation {
  matchKey: string;
  red: AllianceScoreCheck;
  blue: AllianceScoreCheck;
  /** worst (most severe) of the two alliances — drives the summary chip. */
  worst: TbaValidationSeverity;
  /** at least one alliance produced a gradable check (match / minor / severe). */
  hasComparable: boolean;
}

/** Higher = more attention-worthy. Used to pick the worse of two alliances. */
const SEVERITY_RANK: Record<TbaValidationSeverity, number> = {
  severe: 5,
  minor: 4,
  match: 3,
  incomplete: 2,
  unscouted: 1,
  unscored: 0,
};

/** The more severe of two tiers (ties → first arg). */
function worseOf(a: TbaValidationSeverity, b: TbaValidationSeverity): TbaValidationSeverity {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/**
 * One live report per robot, keyed by station (the robot's slot on the
 * alliance). When 2+ scouts cover the same station, keep the latest by
 * `server_received_at` so a stale duplicate never double-counts the offense.
 * Skips deleted rows (belt-and-suspenders; the dashboard already filters them).
 */
function dedupeByStation(reports: MsrRow[]): MsrRow[] {
  const byStation = new Map<number, MsrRow>();
  for (const r of reports) {
    if (r.deleted === true) continue;
    const prev = byStation.get(r.station);
    if (!prev || (r.server_received_at ?? '') > (prev.server_received_at ?? '')) {
      byStation.set(r.station, r);
    }
  }
  return Array.from(byStation.values());
}

/** Scouted offensive points for one report = fuel_points. */
function offenseOf(r: MsrRow): number {
  return Number.isFinite(r.fuel_points) ? r.fuel_points : 0;
}

/**
 * Grade ONE alliance: sum its deduped robots' offense and compare to the
 * official score. Pure; never throws or returns NaN.
 */
export function checkAlliance(
  allianceColor: 'red' | 'blue',
  reports: MsrRow[],
  officialScore: number | null,
): AllianceScoreCheck {
  const deduped = dedupeByStation(reports);
  const scoutedRobots = deduped.length;
  const scoutedOffensePoints = deduped.reduce((s, r) => s + offenseOf(r), 0);

  // Not played → nothing to compare against.
  if (officialScore == null || !Number.isFinite(officialScore)) {
    return {
      allianceColor,
      scoutedRobots,
      scoutedOffensePoints,
      officialScore: null,
      delta: null,
      tolerance: null,
      severity: 'unscored',
    };
  }

  if (scoutedRobots === 0) {
    return {
      allianceColor,
      scoutedRobots,
      scoutedOffensePoints,
      officialScore,
      delta: null,
      tolerance: null,
      severity: 'unscouted',
    };
  }

  const delta = scoutedOffensePoints - officialScore;
  const tolerance = Math.max(TBA_VALIDATE_ABS_TOL, TBA_VALIDATE_REL_TOL * officialScore);

  // Partial coverage: report the gap but don't grade it a conflict — a missing
  // robot, not a mis-capture. (Still surfaced so the lead sees WHY it's low.)
  if (scoutedRobots < FULL_ALLIANCE) {
    return {
      allianceColor,
      scoutedRobots,
      scoutedOffensePoints,
      officialScore,
      delta,
      tolerance,
      severity: 'incomplete',
    };
  }

  const absDelta = Math.abs(delta);
  let severity: TbaValidationSeverity;
  if (absDelta <= tolerance) severity = 'match';
  else if (absDelta >= TBA_VALIDATE_SEVERE_REL * officialScore) severity = 'severe';
  else severity = 'minor';

  return {
    allianceColor,
    scoutedRobots,
    scoutedOffensePoints,
    officialScore,
    delta,
    tolerance,
    severity,
  };
}

/**
 * Validate one match's scouting against the official TBA result. `reports` is the
 * set of live `match_scouting_report` rows for this match (both alliances);
 * official scores come straight off the already-fetched MatchRow. Pure.
 */
export function validateMatchVsTba(
  matchKey: string,
  reports: MsrRow[],
  officialRedScore: number | null,
  officialBlueScore: number | null,
): MatchTbaValidation {
  const redReports = reports.filter((r) => r.alliance_color === 'red');
  const blueReports = reports.filter((r) => r.alliance_color === 'blue');
  const red = checkAlliance('red', redReports, officialRedScore);
  const blue = checkAlliance('blue', blueReports, officialBlueScore);
  const gradable = (s: TbaValidationSeverity): boolean =>
    s === 'match' || s === 'minor' || s === 'severe';
  return {
    matchKey,
    red,
    blue,
    worst: worseOf(red.severity, blue.severity),
    hasComparable: gradable(red.severity) || gradable(blue.severity),
  };
}

/** Short human label for a tier (chips / banners). */
export function validationLabel(s: TbaValidationSeverity): string {
  switch (s) {
    case 'severe':
      return 'off from official';
    case 'minor':
      return 'slightly off';
    case 'match':
      return 'matches official';
    case 'incomplete':
      return 'partial coverage';
    case 'unscouted':
      return 'not scouted';
    case 'unscored':
    default:
      return 'not played';
  }
}
