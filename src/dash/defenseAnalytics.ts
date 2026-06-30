// src/dash/defenseAnalytics.ts
// Pure helpers for the two derived defense metrics (display-only; no React, no I/O):
//   Metric A — Defended Fuel Suppression: how much a team's fuel-burst rate drops
//     inside its `defended_intervals` windows vs. outside them.
//   Metric B — Defender Effectiveness: how much a team's defense suppresses its
//     opponents' fuel rates during the team's own `defense_intervals` windows.
//
// Both are pure functions of already-synced raw jsonb fields; the wire shape
// (mapReport.ts) and server recompute are untouched. Everything degrades to
// `null` (rendered as an em dash) and never throws or returns NaN.
//
// The absolute-time offset convention is imported from matchTimeline.ts (its
// SINGLE source) so this module can never drift from the drawn timeline.

import { AUTO_MS, MATCH_MS, burstAbsStart, intervalAbsStart } from '@/dash/matchTimeline';
import type { BurstRow, IntervalRow, MsrRow } from '@/dash/types';

// Re-export so consumers that only need the constants don't import two modules.
export { AUTO_MS, MATCH_MS };

/**
 * Min number of observed opponents before the HEADLINE display (TeamView Stat,
 * RankingView "Defender" column) trusts Metric B. Below this we render `—` —
 * the raw fraction is still computed/stored for the Compare panel. See plan §1/§4:
 * Metric B is a co-occurrence estimate confounded by simultaneous defenders, so a
 * single-opponent observation must not be shown as authoritative.
 */
export const DEF_EFF_MIN_SAMPLE = 2;

/** Absolute-ms [start,end) range of a burst, using the timeline's offset convention. */
export function burstAbsRange(b: BurstRow): { start: number; end: number } {
  const start = burstAbsStart(b);
  return { start, end: start + (b.endMs - b.startMs) };
}

/** Absolute-ms [start,end) range of an interval, using the timeline's offset convention. */
export function intervalAbsRange(i: IntervalRow): { start: number; end: number } {
  const start = intervalAbsStart(i);
  return { start, end: start + (i.endMs - i.startMs) };
}

/** Overlap (ms) between two [start,end) ranges; 0 when disjoint. */
export function overlapMs(
  a: { start: number; end: number },
  b: { start: number; end: number },
): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export interface WeightedRate {
  /** Duration-weighted mean balls/sec INSIDE the windows; null when no inside duration. */
  insideRate: number | null;
  /** Duration-weighted mean balls/sec OUTSIDE the windows; null when no outside duration. */
  outsideRate: number | null;
  /** Total ms of burst time that fell inside the windows. */
  insideDur: number;
  /** Total ms of burst time that fell outside the windows. */
  outsideDur: number;
  /** Ball-time (rate·seconds) accumulated inside — exposed for cross-report pooling. */
  insideBallTime: number;
  /** Ball-time (rate·seconds) accumulated outside — exposed for cross-report pooling. */
  outsideBallTime: number;
}

/**
 * Duration-weighted mean fuel rate inside vs. outside a set of windows.
 * Each burst's contribution is split by how much of it overlaps the windows, so
 * overlapping bursts of different rates and partial-overlap intervals are handled
 * correctly (mean = Σ rate·dur / Σ dur).
 */
export function weightedRate(
  bursts: BurstRow[] | null | undefined,
  windows: Array<{ start: number; end: number }>,
): WeightedRate {
  let insideBallTime = 0;
  let insideDur = 0;
  let outsideBallTime = 0;
  let outsideDur = 0;

  if (Array.isArray(bursts)) {
    for (const b of bursts) {
      const r = burstAbsRange(b);
      const dur = r.end - r.start;
      if (dur <= 0) continue;
      let inDur = 0;
      for (const w of windows) inDur += overlapMs(r, w);
      if (inDur > dur) inDur = dur; // clamp against double-counted overlapping windows
      const outDur = dur - inDur;
      insideBallTime += b.rate * (inDur / 1000);
      insideDur += inDur;
      outsideBallTime += b.rate * (outDur / 1000);
      outsideDur += outDur;
    }
  }

  return {
    insideRate: insideDur > 0 ? insideBallTime / (insideDur / 1000) : null,
    outsideRate: outsideDur > 0 ? outsideBallTime / (outsideDur / 1000) : null,
    insideDur,
    outsideDur,
    insideBallTime,
    outsideBallTime,
  };
}

/**
 * Clamp a suppression fraction to [-1, 1]. A negative value (team shot MORE while
 * defended) is a real signal so we do NOT clamp to [0,1]; we only cap impossible
 * magnitudes for display sanity.
 */
export function clampSuppression(x: number): number {
  if (x < -1) return -1;
  if (x > 1) return 1;
  return x;
}

/**
 * Metric A core, single report: percentage drop in fuel rate while defended.
 * Returns null when there are no defended windows, no undefended baseline bursts,
 * or no bursts at all (never NaN).
 */
export function suppressionFromBursts(
  bursts: BurstRow[] | null | undefined,
  defendedWindows: Array<{ start: number; end: number }>,
): number | null {
  const wr = weightedRate(bursts, defendedWindows);
  if (wr.insideRate == null || wr.outsideRate == null || wr.outsideRate <= 0) return null;
  return clampSuppression((wr.outsideRate - wr.insideRate) / wr.outsideRate);
}

/**
 * Metric B core, single match: sum/count of per-opponent suppression imposed by a
 * defender's `defenseWindows`. `opponentReports` is ONE report per opponent team
 * (already de-duped + no_show/died filtered by the caller). Returns null when no
 * opponent yields a measurable suppression.
 */
export function defenderEffectivenessForMatch(
  defenseWindows: Array<{ start: number; end: number }>,
  opponentReports: MsrRow[],
): { sum: number; count: number } | null {
  let sum = 0;
  let count = 0;
  for (const opp of opponentReports) {
    const supp = suppressionFromBursts(opp.fuel_bursts, defenseWindows);
    if (supp == null) continue;
    sum += supp;
    count += 1;
  }
  return count > 0 ? { sum, count } : null;
}

/**
 * The SINGLE signed-percentage formatter shared by RankingView and TeamView (one
 * definition, one glyph). Uses the Unicode minus `−` (U+2212) for negatives.
 * Never called with null — callers render the EM_DASH constant for unavailable.
 */
export function pctSigned(x: number): string {
  return `${x >= 0 ? '' : '−'}${Math.round(Math.abs(x) * 100)}%`;
}
