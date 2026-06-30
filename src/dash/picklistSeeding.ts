// src/dash/picklistSeeding.ts
// Pure picklist seeding: rank every aggregated team by a chosen metric (desc,
// ties → ascending team number — identical to RankingView), filter by a minimum
// matches-scouted threshold, take the top N, and return ordered PicklistEntry
// rows with the coaching flags (tier/note/tierType/dnp) at their defaults. The
// EPA each row sorts by is resolved via the SHARED `resolveRowEpa` so the seed
// order can never drift from the ranking-table order.

import type { TeamAgg } from '@/dash/aggregate';
import type { PicklistEntry } from '@/dash/picklistClient';
import { compareDesc, resolveRowEpa, type RankSortKey } from '@/dash/sorting';

export interface SeedOptions {
  aggs: TeamAgg[];
  sortKey: RankSortKey;
  topN: number;
  minMatches?: number; // default 0
  epaByTeam?: Map<number, number | null>;
  epaAvailable?: boolean; // mirror RankingView's epaQuery.data.available === true
  epaFromScouting?: boolean; // mirror RankingView's !epaAvailable
}

export function seedPicklist(opts: SeedOptions): PicklistEntry[] {
  const {
    aggs,
    sortKey,
    topN,
    minMatches = 0,
    epaByTeam,
    epaAvailable = false,
    epaFromScouting = false,
  } = opts;

  // Resolve the EPA each row sorts by via the SHARED helper so the seed order is
  // byte-identical to the RankingView table (no hand-rolled expression here —
  // that divergence is exactly what resolveRowEpa exists to prevent).
  const inputs = aggs
    .filter((agg) => agg.matchesScouted >= minMatches)
    .map((agg) => ({
      agg,
      epa: resolveRowEpa({ agg, epaByTeam, epaAvailable, epaFromScouting }),
    }));

  inputs.sort((a, b) => compareDesc(a, b, sortKey)); // desc, tie → asc teamNumber

  const n = Math.max(1, Math.min(Math.trunc(topN), 60)); // clamp 1..60
  return inputs.slice(0, n).map((inp) => ({
    teamNumber: inp.agg.teamNumber,
    tier: null,
    note: null,
    tierType: null,
    dnp: false,
  }));
}
