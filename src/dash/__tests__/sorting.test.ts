// src/dash/__tests__/sorting.test.ts
import { describe, it, expect } from 'vitest';
import type { TeamAgg } from '@/dash/aggregate';
import { rankSortValue, compareDesc, resolveRowEpa } from '@/dash/sorting';

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
    tippedRate: 0,
    incidentMatches: 0,
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

describe('rankSortValue', () => {
  it('returns the agg field for each non-EPA key', () => {
    const a = agg({ scoutingExpectedPoints: 30, climbSuccessRate: 0.75, avgDefenseRating: 4 });
    expect(rankSortValue({ agg: a, epa: 99 }, 'scoutingExpectedPoints')).toBe(30);
    expect(rankSortValue({ agg: a, epa: 99 }, 'climbSuccessRate')).toBe(0.75);
    expect(rankSortValue({ agg: a, epa: 99 }, 'avgDefenseRating')).toBe(4);
  });

  it('returns the resolved epa for the epa key', () => {
    expect(rankSortValue({ agg: agg({}), epa: 55 }, 'epa')).toBe(55);
  });

  it('null epa sorts to NEGATIVE_INFINITY', () => {
    expect(rankSortValue({ agg: agg({}), epa: null }, 'epa')).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('compareDesc', () => {
  it('orders descending by the key', () => {
    const hi = { agg: agg({ teamNumber: 1, scoutingExpectedPoints: 50 }), epa: null };
    const lo = { agg: agg({ teamNumber: 2, scoutingExpectedPoints: 10 }), epa: null };
    expect(compareDesc(hi, lo, 'scoutingExpectedPoints')).toBeLessThan(0);
    expect(compareDesc(lo, hi, 'scoutingExpectedPoints')).toBeGreaterThan(0);
  });

  it('breaks ties by ascending team number', () => {
    const a = { agg: agg({ teamNumber: 254, scoutingExpectedPoints: 20 }), epa: null };
    const b = { agg: agg({ teamNumber: 100, scoutingExpectedPoints: 20 }), epa: null };
    // Equal metric → lower team number first → b - a > 0.
    expect(compareDesc(a, b, 'scoutingExpectedPoints')).toBeGreaterThan(0);
    expect(compareDesc(b, a, 'scoutingExpectedPoints')).toBeLessThan(0);
  });
});

describe('resolveRowEpa', () => {
  const a = agg({ teamNumber: 254, scoutingExpectedPoints: 21 });

  it('uses external EPA when available and present', () => {
    expect(
      resolveRowEpa({
        agg: a,
        epaByTeam: new Map([[254, 60]]),
        epaAvailable: true,
        epaFromScouting: false,
      }),
    ).toBe(60);
  });

  it('falls back per team when the external source is missing that team', () => {
    expect(
      resolveRowEpa({
        agg: a,
        epaByTeam: new Map([[254, null]]),
        epaAvailable: true,
        epaFromScouting: false,
      }),
    ).toBe(21);
  });

  it('falls back to in-house scoutingExpectedPoints when no external source', () => {
    expect(
      resolveRowEpa({
        agg: a,
        epaByTeam: new Map(),
        epaAvailable: false,
        epaFromScouting: true,
      }),
    ).toBe(21);
  });
});
