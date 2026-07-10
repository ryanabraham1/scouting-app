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
  | 'climbSuccessRate'
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
    case 'climbSuccessRate':
      return r.agg.climbSuccessRate;
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
 * Single source of truth for per-row EPA resolution — copied EXACTLY from the
 * expression RankingView used inline so the ranking table and the seed cannot
 * drift. Best-available EPA: external (Statbotics/local) when present, else our
 * in-house scouting estimate when no external source resolved.
 */
export function resolveRowEpa(p: {
  agg: TeamAgg;
  epaByTeam?: Map<number, number | null>;
  epaAvailable: boolean;
  epaFromScouting: boolean;
}): number | null {
  const external = p.epaAvailable ? p.epaByTeam?.get(p.agg.teamNumber) ?? null : null;
  // Resolve fallback per team. One team having Statbotics/local EPA must not
  // suppress a different, scouted team's usable in-house estimate.
  const epaInHouse = external == null && p.agg.matchesScouted > 0;
  return epaInHouse ? p.agg.scoutingExpectedPoints : external;
}
