// src/dash/sorting.ts
// Single source of truth for the shared rank-table sort vocabulary so the
// Ranking table and the picklist seeder cannot drift. RankingView delegates the
// four overlapping numeric columns here, and seedPicklist sorts with the SAME
// comparator + the SAME per-row EPA resolution (`resolveRowEpa`). New rank
// columns added by other features should extend THIS file (not re-inline a
// `switch` case in RankingView.sortValue) to keep the seed and table aligned.

import type { TeamAgg } from '@/dash/aggregate';

/** The seed-able subset of rank columns (numeric, higher-is-better, desc). */
export type RankSortKey =
  | 'scoutingExpectedPoints'
  | 'avgDefenseRating'
  | 'epa';

/** A row's pure agg plus its resolved external/in-house EPA. */
export interface RankInput {
  agg: TeamAgg;
  epa: number | null;
}

/** Numeric value used to sort a row by a given shared key. */
export function rankSortValue(r: RankInput, key: RankSortKey): number {
  switch (key) {
    case 'scoutingExpectedPoints':
      return r.agg.scoutingExpectedPoints;
    case 'avgDefenseRating':
      return r.agg.avgDefenseRating;
    case 'epa':
      // Unknown EPA sorts to the bottom regardless of direction.
      return r.epa ?? Number.NEGATIVE_INFINITY;
  }
}

/** Descending compare with an ascending team-number tiebreak (stable order). */
export function compareDesc(a: RankInput, b: RankInput, key: RankSortKey): number {
  const av = rankSortValue(a, key);
  const bv = rankSortValue(b, key);
  if (av === bv) return a.agg.teamNumber - b.agg.teamNumber;
  return bv - av;
}

/**
 * Single source of truth for per-row EPA resolution, shared by the ranking
 * table, the picklist seed and the draft board so they cannot drift. EPA is
 * match-results-only (in-house model over posted scores, Statbotics when the
 * local model has nothing) — scouting data NEVER substitutes for it; a team
 * with no EPA resolves to `null` ("—"). Scouted expectation is its own metric
 * (`scoutingExpectedPoints`).
 */
export function resolveRowEpa(p: {
  agg: TeamAgg;
  epaByTeam?: Map<number, number | null>;
  epaAvailable: boolean;
}): number | null {
  if (!p.epaAvailable) return null;
  const epa = p.epaByTeam?.get(p.agg.teamNumber) ?? null;
  return epa != null && Number.isFinite(epa) ? epa : null;
}
