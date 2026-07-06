// src/dash/tempo.ts
// Cycle-time / tempo analytics (cycle-time feature) — PURE, derived ENTIRELY from
// the timestamped `fuel_bursts` already persisted on every report. NO new wire
// field, NO migration, NO scoring duplication: a "shooting cycle" is one fuel
// burst (a continuous span of scoring at a rate), and the gap between consecutive
// bursts is the robot's reload/travel time — i.e. its cycle time.
//
// Reads the SAME absolute-time model as matchTimeline.ts (`burstAbsStart`) so a
// burst's place on the match clock is computed one way only.

import type { MsrRow, BurstRow } from './types';
import { burstAbsStart, MATCH_MS } from './matchTimeline';

/** Per-team shooting-tempo summary, pooled across the team's scouted matches. */
export interface TeamTempo {
  /** reports that carried at least one fuel burst (the sample size). */
  reportsWithBursts: number;
  /** mean number of shooting bursts (cycles) per match. */
  meanBurstsPerMatch: number;
  /** mean duration of a single continuous shooting burst, ms. */
  meanBurstDurationMs: number;
  /**
   * mean idle gap BETWEEN consecutive bursts, ms — the reload/travel "cycle
   * time". null when no match had 2+ bursts (no gap to measure).
   */
  meanGapMs: number | null;
  /** fraction of the match spent actively shooting (0..1), pooled. */
  activeFraction: number;
}

/** A burst's absolute [start, end] on the match clock; end ≥ start. */
function burstAbsRange(b: BurstRow): { start: number; end: number } {
  const start = burstAbsStart(b);
  const dur = Math.max(0, b.endMs - b.startMs);
  return { start, end: start + dur };
}

export const EMPTY_TEAM_TEMPO: TeamTempo = {
  reportsWithBursts: 0,
  meanBurstsPerMatch: 0,
  meanBurstDurationMs: 0,
  meanGapMs: null,
  activeFraction: 0,
};

/**
 * Compute pooled shooting tempo for one team's reports. Pure; never NaN. Reports
 * with no `fuel_bursts` are skipped (legacy/pre-0010 rows) and do not dilute the
 * means — `reportsWithBursts` reflects the true sample. Returns an all-zero
 * summary when nothing is measurable.
 */
export function computeTeamTempo(reports: MsrRow[]): TeamTempo {
  let reportsWithBursts = 0;
  let totalBursts = 0;
  let totalGap = 0;
  let gapCount = 0;
  let totalActiveMs = 0;

  for (const r of reports) {
    if (r.deleted === true) continue;
    const bursts = Array.isArray(r.fuel_bursts) ? r.fuel_bursts : [];
    if (bursts.length === 0) continue;
    reportsWithBursts += 1;

    // Sort by absolute start so gaps are measured in play order.
    const ranges = bursts.map(burstAbsRange).sort((a, b) => a.start - b.start);
    totalBursts += ranges.length;
    for (const seg of ranges) totalActiveMs += seg.end - seg.start;

    // Gaps between consecutive bursts (clamped to ≥0 so overlapping bursts —
    // possible across windows — never produce a negative "cycle time").
    for (let i = 1; i < ranges.length; i += 1) {
      const gap = ranges[i].start - ranges[i - 1].end;
      if (gap > 0) {
        totalGap += gap;
        gapCount += 1;
      }
    }
  }

  if (reportsWithBursts === 0) return { ...EMPTY_TEAM_TEMPO };

  return {
    reportsWithBursts,
    meanBurstsPerMatch: totalBursts / reportsWithBursts,
    meanBurstDurationMs: totalBursts > 0 ? totalActiveMs / totalBursts : 0,
    meanGapMs: gapCount > 0 ? totalGap / gapCount : null,
    // Clamped: overlapping bursts (possible across windows) sum raw durations,
    // which could push the fraction past 1 and render ">100%" in the UI.
    activeFraction: Math.min(1, totalActiveMs / (reportsWithBursts * MATCH_MS)),
  };
}
