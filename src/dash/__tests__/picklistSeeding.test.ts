// src/dash/__tests__/picklistSeeding.test.ts
import { describe, it, expect } from 'vitest';
import type { TeamAgg } from '@/dash/aggregate';
import { seedPicklist } from '@/dash/picklistSeeding';
import { resolveRowEpa } from '@/dash/sorting';

function agg(overrides: Partial<TeamAgg>): TeamAgg {
  return {
    teamNumber: 254,
    matchesScouted: 3,
    meanAutoFuel: 0,
    meanTeleopFuelActive: 0,
    meanTeleopFuelInactive: 0,
    meanEndgameFuel: 0,
    meanTotalFuel: 0,
    meanFuelPoints: 12.5,
    meanFuelConfidence: 1,
    climbSuccessRate: 0.5,
    avgClimbLevel: 2,
    meanClimbPoints: 8,
    avgDefenseRating: 3,
    noShowRate: 0,
    diedRate: 0,
    reliability: 1,
    scoutingExpectedPoints: 20.5,
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
    ...overrides,
  };
}

describe('seedPicklist', () => {
  it('ranks by scoutingExpectedPoints desc, ties → ascending team number', () => {
    const aggs = [
      agg({ teamNumber: 100, scoutingExpectedPoints: 10 }),
      agg({ teamNumber: 254, scoutingExpectedPoints: 50 }),
      agg({ teamNumber: 1678, scoutingExpectedPoints: 30 }),
      agg({ teamNumber: 9, scoutingExpectedPoints: 30 }), // tie with 1678
    ];
    const out = seedPicklist({ aggs, sortKey: 'scoutingExpectedPoints', topN: 10 });
    expect(out.map((e) => e.teamNumber)).toEqual([254, 9, 1678, 100]);
  });

  it('truncates to topN', () => {
    const aggs = [
      agg({ teamNumber: 1, scoutingExpectedPoints: 5 }),
      agg({ teamNumber: 2, scoutingExpectedPoints: 4 }),
      agg({ teamNumber: 3, scoutingExpectedPoints: 3 }),
    ];
    expect(seedPicklist({ aggs, sortKey: 'scoutingExpectedPoints', topN: 2 }).length).toBe(2);
  });

  it('topN > teams returns all teams', () => {
    const aggs = [agg({ teamNumber: 1 }), agg({ teamNumber: 2 })];
    expect(seedPicklist({ aggs, sortKey: 'scoutingExpectedPoints', topN: 50 }).length).toBe(2);
  });

  it('clamps topN to 1..60', () => {
    const aggs = Array.from({ length: 70 }, (_, i) =>
      agg({ teamNumber: i + 1, scoutingExpectedPoints: 70 - i }),
    );
    expect(seedPicklist({ aggs, sortKey: 'scoutingExpectedPoints', topN: 999 }).length).toBe(60);
    expect(seedPicklist({ aggs, sortKey: 'scoutingExpectedPoints', topN: 0 }).length).toBe(1);
    expect(seedPicklist({ aggs, sortKey: 'scoutingExpectedPoints', topN: -5 }).length).toBe(1);
  });

  it('minMatches filters out teams below threshold before ranking', () => {
    const aggs = [
      agg({ teamNumber: 1, matchesScouted: 1, scoutingExpectedPoints: 99 }),
      agg({ teamNumber: 2, matchesScouted: 5, scoutingExpectedPoints: 10 }),
    ];
    const out = seedPicklist({ aggs, sortKey: 'scoutingExpectedPoints', topN: 10, minMatches: 3 });
    expect(out.map((e) => e.teamNumber)).toEqual([2]);
  });

  it('sortKey epa with epaAvailable + epaByTeam uses external EPA; null sorts to bottom', () => {
    const aggs = [
      agg({ teamNumber: 1, scoutingExpectedPoints: 99 }), // null external → bottom
      agg({ teamNumber: 2, scoutingExpectedPoints: 1 }),
      agg({ teamNumber: 3, scoutingExpectedPoints: 1 }),
    ];
    const epaByTeam = new Map<number, number | null>([
      [1, null],
      [2, 80],
      [3, 40],
    ]);
    const out = seedPicklist({
      aggs,
      sortKey: 'epa',
      topN: 10,
      epaByTeam,
      epaAvailable: true,
      epaFromScouting: false,
    });
    expect(out.map((e) => e.teamNumber)).toEqual([2, 3, 1]);
  });

  it('sortKey epa with epaAvailable:false + epaFromScouting:true ranks by scoutingExpectedPoints', () => {
    const aggs = [
      agg({ teamNumber: 1, scoutingExpectedPoints: 10 }),
      agg({ teamNumber: 2, scoutingExpectedPoints: 40 }),
    ];
    const out = seedPicklist({
      aggs,
      sortKey: 'epa',
      topN: 10,
      epaByTeam: new Map(),
      epaAvailable: false,
      epaFromScouting: true,
    });
    expect(out.map((e) => e.teamNumber)).toEqual([2, 1]);
  });

  it('divergence guard: seed uses the SAME resolveRowEpa value RankingView uses', () => {
    const a1 = agg({ teamNumber: 1, scoutingExpectedPoints: 5 });
    const a2 = agg({ teamNumber: 2, scoutingExpectedPoints: 5 });
    const epaByTeam = new Map<number, number | null>([
      [1, null], // available but missing → NEGATIVE_INFINITY
      [2, 12],
    ]);
    const params = { epaByTeam, epaAvailable: true, epaFromScouting: false } as const;
    // resolveRowEpa agrees per-team.
    expect(resolveRowEpa({ agg: a1, ...params })).toBeNull();
    expect(resolveRowEpa({ agg: a2, ...params })).toBe(12);
    // Seed order matches the EPA resolution (team 2 above team 1).
    const out = seedPicklist({ aggs: [a1, a2], sortKey: 'epa', topN: 10, ...params });
    expect(out.map((e) => e.teamNumber)).toEqual([2, 1]);
  });

  it('returned entries default tier/note/tierType/dnp', () => {
    const out = seedPicklist({ aggs: [agg({ teamNumber: 5 })], sortKey: 'scoutingExpectedPoints', topN: 1 });
    expect(out[0]).toEqual({ teamNumber: 5, tier: null, note: null, tierType: null, dnp: false });
  });

  it('empty aggs returns []', () => {
    expect(seedPicklist({ aggs: [], sortKey: 'scoutingExpectedPoints', topN: 10 })).toEqual([]);
  });
});
