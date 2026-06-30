// Pure coverage-gap computation for assignment authoring. No React, no Supabase.
// Surfaces which upcoming match seats have NO scout assigned, both for the live
// draft (in-memory picks) and the published set (server assignment rows).
import type { AllianceColor } from './types';

export interface Seat {
  matchKey: string;
  allianceColor: AllianceColor;
  station: 1 | 2 | 3;
  targetTeamNumber: number;
}

export interface CoverageGap {
  matchKey: string;
  allianceColor: AllianceColor;
  station: 1 | 2 | 3;
  targetTeamNumber: number;
}

export interface CoverageSummary {
  totalSeats: number;
  coveredSeats: number;
  gapCount: number;
  /** coveredSeats / totalSeats in [0,1]; 1 when totalSeats === 0. */
  coverageRate: number;
  /** Gaps grouped by matchKey, in the slot input order. */
  gapsByMatch: { matchKey: string; gaps: CoverageGap[] }[];
}

/**
 * Stable key for a seat. MUST stay `station: number` (loose) — `AssignmentBoard`
 * calls this with an `autoAssign` `Assignment` whose `station` is the wider
 * `number`, and a stricter `1|2|3` param would not typecheck against that call.
 */
export function slotKey(s: {
  matchKey: string;
  allianceColor: AllianceColor;
  station: number;
}): string {
  return `${s.matchKey}:${s.allianceColor}:${s.station}`;
}

/** Group an ordered list of gaps by matchKey, preserving first-seen match order. */
function groupByMatch(gaps: CoverageGap[]): { matchKey: string; gaps: CoverageGap[] }[] {
  const order: string[] = [];
  const byMatch = new Map<string, CoverageGap[]>();
  for (const g of gaps) {
    let bucket = byMatch.get(g.matchKey);
    if (!bucket) {
      bucket = [];
      byMatch.set(g.matchKey, bucket);
      order.push(g.matchKey);
    }
    bucket.push(g);
  }
  return order.map((matchKey) => ({ matchKey, gaps: byMatch.get(matchKey) as CoverageGap[] }));
}

function summarize(slots: readonly Seat[], gaps: CoverageGap[]): CoverageSummary {
  const totalSeats = slots.length;
  const gapCount = gaps.length;
  const coveredSeats = totalSeats - gapCount;
  return {
    totalSeats,
    coveredSeats,
    gapCount,
    coverageRate: totalSeats === 0 ? 1 : coveredSeats / totalSeats,
    gapsByMatch: groupByMatch(gaps),
  };
}

/**
 * Draft coverage from the in-memory picks map. `pickOf(slotKey)` returns the
 * scout id assigned to a seat ('' / whitespace === unassigned).
 */
export function computeCoverage(
  slots: readonly Seat[],
  pickOf: (key: string) => string,
): CoverageSummary {
  const gaps: CoverageGap[] = [];
  for (const s of slots) {
    const covered = (pickOf(slotKey(s)) ?? '').trim() !== '';
    if (!covered) {
      gaps.push({
        matchKey: s.matchKey,
        allianceColor: s.allianceColor,
        station: s.station,
        targetTeamNumber: s.targetTeamNumber,
      });
    }
  }
  return summarize(slots, gaps);
}

/**
 * Published coverage from server assignment rows (camelCased at the call site).
 * A seat is covered iff a published assignment row exists for its
 * (matchKey, allianceColor, station) with a non-null/non-empty scoutId.
 */
export function computeCoverageFromAssignments(
  slots: readonly Seat[],
  assignments: readonly {
    matchKey: string;
    allianceColor: AllianceColor;
    station: number;
    scoutId: string | null;
  }[],
): CoverageSummary {
  const coveredKeys = new Set<string>();
  for (const a of assignments) {
    if ((a.scoutId ?? '').trim() !== '') {
      coveredKeys.add(slotKey(a));
    }
  }
  const gaps: CoverageGap[] = [];
  for (const s of slots) {
    if (!coveredKeys.has(slotKey(s))) {
      gaps.push({
        matchKey: s.matchKey,
        allianceColor: s.allianceColor,
        station: s.station,
        targetTeamNumber: s.targetTeamNumber,
      });
    }
  }
  return summarize(slots, gaps);
}
