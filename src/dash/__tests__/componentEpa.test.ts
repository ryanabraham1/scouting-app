// src/dash/__tests__/componentEpa.test.ts
// Unit tests for the component-EPA estimation feature (component-epa-estimation).
// Covers the pure split + fraction fit + scouting defense (aggregate.ts), the
// {value, source} resolver + predictMatch parity (predict.ts), and the dark,
// flag-OFF Tier-2 breakdown parser (localEpa.ts). The additive sum invariant is
// asserted on UNROUNDED floats only (plan §8/§13).

import { describe, it, expect } from 'vitest';
import {
  aggregateTeamComponentSplit,
  aggregateTeamDefensePts,
  fitComponentFraction,
  F_DEFAULT,
  type ComponentFraction,
  type TeamAgg,
} from '@/dash/aggregate';
import {
  predictMatch,
  resolveComponentBreakdown,
  type PredictInput,
  type TeamPrediction,
} from '@/dash/predict';
import { parseRebuiltBreakdown } from '@/dash/localEpa';
import { SCORING } from '@/scoring';

/**
 * Build a TeamAgg with the fields the component split + defense read; other
 * fields default to 0/null. `scoutingExpectedPoints` is derived (meanFuelPoints)
 * so a test agg is internally consistent with aggregate.ts.
 */
function makeAgg(p: {
  teamNumber?: number;
  matchesScouted?: number;
  meanAutoFuel?: number;
  meanTeleopFuelActive?: number;
  meanTeleopFuelInactive?: number;
  meanEndgameFuel?: number;
  meanFuelPoints?: number;
  meanFuelConfidence?: number;
  avgDefenseRating?: number;
  defenderEffectiveness?: number | null;
  defenseSampleCount?: number;
}): TeamAgg {
  const meanFuelPoints = p.meanFuelPoints ?? 0;
  const meanFuelConfidence = p.meanFuelConfidence ?? 1;
  return {
    teamNumber: p.teamNumber ?? 1,
    matchesScouted: p.matchesScouted ?? 0,
    meanAutoFuel: p.meanAutoFuel ?? 0,
    meanTeleopFuelActive: p.meanTeleopFuelActive ?? 0,
    meanTeleopFuelInactive: p.meanTeleopFuelInactive ?? 0,
    meanEndgameFuel: p.meanEndgameFuel ?? 0,
    meanTotalFuel: 0,
    meanFuelPoints,
    meanFuelConfidence,
    avgDefenseRating: p.avgDefenseRating ?? 0,
    noShowRate: 0,
    diedRate: 0,
    tippedRate: 0,
    incidentMatches: 0,
    reliability: 1,
    scoutingExpectedPoints: meanFuelPoints,
    fuelSuppressionWhileDefended: null,
    defendedSampleMs: 0,
    defenderEffectiveness: p.defenderEffectiveness ?? null,
    defenseSampleCount: p.defenseSampleCount ?? 0,
    stdDevFuelPoints: 0,
    minFuelPoints: 0,
    maxFuelPoints: 0,
    stdDevDefenseRating: 0,
    minDefenseRating: 0,
    maxDefenseRating: 0,
    recentFuelMean: 0,
    recentFuelDelta: 0,
    recentTrend: 'insufficient',
  };
}

const EPS = 1e-9;

describe('aggregateTeamComponentSplit', () => {
  it('decomposes meanFuelPoints by raw auto/teleop proportion', () => {
    // 10 auto fuel, 30 point-scoring teleop fuel (active + endgame).
    const agg = makeAgg({
      matchesScouted: 3,
      meanAutoFuel: 10,
      meanTeleopFuelActive: 25,
      meanEndgameFuel: 5,
      meanFuelPoints: 40,
    });
    const s = aggregateTeamComponentSplit(agg);
    // rawAuto = 10, rawFuel = 30 -> auto share 1/4 of 40 = 10, fuel = 30.
    expect(s.auto).toBeCloseTo(10, 9);
    expect(s.fuel).toBeCloseTo(30, 9);
    // Sums to scoutingExpectedPoints (meanFuelPoints).
    expect(s.auto + s.fuel).toBeCloseTo(agg.scoutingExpectedPoints, 9);
  });

  it('includes legacy inactive-bucket fuel because every observed shot scores', () => {
    // A pre-migration-shaped aggregate may still carry 40 Teleop FUEL in the
    // inactive column. It remains part of the point-scoring Teleop proportion.
    const agg = makeAgg({
      matchesScouted: 3,
      meanAutoFuel: 10,
      meanTeleopFuelActive: 20,
      meanTeleopFuelInactive: 40,
      meanEndgameFuel: 0,
      meanFuelPoints: 70,
    });
    const s = aggregateTeamComponentSplit(agg);
    expect(s.auto).toBeCloseTo(10, 9);
    expect(s.fuel).toBeCloseTo(60, 9);
    expect(s.auto + s.fuel).toBeCloseTo(agg.scoutingExpectedPoints, 9);
  });

  it('the split uses RAW fuel points — fuel_estimate_confidence does NOT down-weight', () => {
    const agg = makeAgg({
      matchesScouted: 2,
      meanAutoFuel: 10,
      meanTeleopFuelActive: 30,
      meanFuelPoints: 40,
      meanFuelConfidence: 0.5, // informational only — must NOT scale the split
    });
    const s = aggregateTeamComponentSplit(agg);
    // RAW 40 split 10:30 -> auto 10, fuel 30 (NOT 5/15 as the old down-weight gave).
    expect(s.auto).toBeCloseTo(10, 9);
    expect(s.fuel).toBeCloseTo(30, 9);
    expect(s.auto + s.fuel).toBeCloseTo(agg.scoutingExpectedPoints, 9);
  });

  it('routes all fuel points to the fuel bucket when raw fuel total is 0', () => {
    const agg = makeAgg({ matchesScouted: 1, meanFuelPoints: 5 });
    const s = aggregateTeamComponentSplit(agg);
    expect(s.auto).toBe(0);
    expect(s.fuel).toBeCloseTo(5, 9);
  });
});

describe('aggregateTeamDefensePts', () => {
  it('uses defenderEffectiveness × typical opponent fuel when present + sampled', () => {
    const agg = makeAgg({ matchesScouted: 3, defenderEffectiveness: 0.3, defenseSampleCount: 2 });
    // 0.3 * TYPICAL_OPP_TELEOP_FUEL(40) = 12.
    expect(aggregateTeamDefensePts(agg)).toBeCloseTo(12, 9);
  });

  it('falls back to the ordinal avgDefenseRating map when no co-occurrence signal', () => {
    const agg = makeAgg({ matchesScouted: 3, avgDefenseRating: 5 });
    // 5/10 * DEFENSE_RATING_MAX_PTS(20) = 10.
    expect(aggregateTeamDefensePts(agg)).toBeCloseTo(10, 9);
  });

  it('returns null when there is no defense sample and no rating', () => {
    expect(aggregateTeamDefensePts(makeAgg({ matchesScouted: 3 }))).toBeNull();
  });

  it('ignores defenderEffectiveness when defenseSampleCount is 0', () => {
    const agg = makeAgg({ matchesScouted: 3, defenderEffectiveness: 0.5, defenseSampleCount: 0 });
    // no sample -> falls through; no rating -> null.
    expect(aggregateTeamDefensePts(agg)).toBeNull();
  });
});

describe('fitComponentFraction', () => {
  it('returns a pair summing to 1 with the expected ratios from scouting means', () => {
    // Each team: auto 10, fuel 30 (40 split 10:30).
    const teams = Array.from({ length: 4 }, (_, i) =>
      makeAgg({
        teamNumber: i + 1,
        matchesScouted: 3,
        meanAutoFuel: 10,
        meanTeleopFuelActive: 30,
        meanFuelPoints: 40,
        meanFuelConfidence: 1,
      }),
    );
    const f = fitComponentFraction(teams);
    expect(f.fAuto + f.fFuel).toBeCloseTo(1, 9);
    // total per team = 40: auto 10/40, fuel 30/40.
    expect(f.fAuto).toBeCloseTo(0.25, 9);
    expect(f.fFuel).toBeCloseTo(0.75, 9);
  });

  it('returns F_DEFAULT when fewer than MIN_FIT_REPORTS reports back the event', () => {
    // Two teams, 2 reports each = 4 < MIN_FIT_REPORTS(8).
    const teams = [
      makeAgg({ teamNumber: 1, matchesScouted: 2, meanAutoFuel: 10, meanFuelPoints: 10 }),
      makeAgg({ teamNumber: 2, matchesScouted: 2, meanAutoFuel: 10, meanFuelPoints: 10 }),
    ];
    expect(fitComponentFraction(teams)).toEqual(F_DEFAULT);
  });

  it('returns F_DEFAULT when scouting is all-zero (T=0 guard)', () => {
    const teams = Array.from({ length: 4 }, (_, i) =>
      makeAgg({ teamNumber: i + 1, matchesScouted: 3 }),
    );
    expect(fitComponentFraction(teams)).toEqual(F_DEFAULT);
  });

  it('is insensitive to SCORING.FUEL_POINTS (ratio split)', () => {
    expect(SCORING.FUEL_POINTS).toBe(1); // current flagged value
    const teams = Array.from({ length: 4 }, (_, i) =>
      makeAgg({
        teamNumber: i + 1,
        matchesScouted: 3,
        meanAutoFuel: 10,
        meanTeleopFuelActive: 30,
        meanFuelPoints: 40,
        meanFuelConfidence: 1,
      }),
    );
    const f = fitComponentFraction(teams);
    // The fraction depends only on the auto:fuel RATIO, not on the FUEL_POINTS
    // multiplier (which cancels in auto/(auto+fuel)).
    expect(f.fAuto).toBeCloseTo(0.25, 9);
    expect(f.fFuel).toBeCloseTo(0.75, 9);
  });
});

describe('resolveComponentBreakdown', () => {
  const F = { fAuto: 0.15, fFuel: 0.85 };

  it('scouting branch: source=scouting, split from agg rescaled to expected', () => {
    const agg = makeAgg({
      matchesScouted: 3,
      meanAutoFuel: 10,
      meanTeleopFuelActive: 30,
      meanFuelPoints: 40,
      meanFuelConfidence: 1,
      defenderEffectiveness: 0.25,
      defenseSampleCount: 2,
    });
    // scoutingExpectedPoints = 40; scouting-only prediction -> expected = 40, k≈1.
    const c = resolveComponentBreakdown(1, agg, 40, F, 'scouting', 5);
    expect(c.source).toBe('scouting');
    expect(c.auto + c.fuel).toBeCloseTo(40, 6);
    expect(c.auto).toBeCloseTo(10, 6);
    expect(c.fuel).toBeCloseTo(30, 6);
    expect(c.defense).toBeCloseTo(0.25 * 40, 6);
    expect(c.provisional).toBe(false);
  });

  it('scouting branch rescales when the prediction blended in EPA (k != 1)', () => {
    const agg = makeAgg({
      matchesScouted: 2,
      meanAutoFuel: 10,
      meanTeleopFuelActive: 30,
      meanFuelPoints: 40,
      meanFuelConfidence: 1,
    });
    // scouting basis = 40; EPA expected = 80. Components must sum to 80.
    const c = resolveComponentBreakdown(1, agg, 80, F, 'epa', 5);
    expect(c.auto + c.fuel).toBeCloseTo(80, 6);
    // proportions preserved: auto 10/40 of 80 = 20.
    expect(c.auto).toBeCloseTo(20, 6);
  });

  it('epa branch: auto+fuel carry full expected via the fitted fraction', () => {
    const c = resolveComponentBreakdown(2, undefined, 100, F, 'epa', 5);
    expect(c.source).toBe('epa');
    expect(c.auto).toBeCloseTo(15, 9);
    expect(c.fuel).toBeCloseTo(85, 9);
    expect(c.auto + c.fuel).toBeCloseTo(100, 6);
    expect(c.defense).toBeNull();
    expect(c.provisional).toBe(true);
  });

  it('none branch: below MIN_EPA_MATCHES gate -> all zero, source none', () => {
    const c = resolveComponentBreakdown(2, undefined, 100, F, 'epa', 1);
    expect(c.source).toBe('none');
    expect(c.auto).toBe(0);
    expect(c.fuel).toBe(0);
    expect(c.defense).toBeNull();
  });

  it('none branch: prediction source none -> all zero', () => {
    const c = resolveComponentBreakdown(2, undefined, 0, F, 'none', 5);
    expect(c.source).toBe('none');
    expect(c.auto).toBe(0);
    expect(c.fuel).toBe(0);
  });

  it('unscouted team always shows defense — (null)', () => {
    const c = resolveComponentBreakdown(2, undefined, 100, F, 'epa', 5);
    expect(c.defense).toBeNull();
  });
});

describe('predictMatch — component parity & invariants', () => {
  const baseInput = (): PredictInput => ({
    redTeams: [1, 2, 3],
    blueTeams: [4, 5, 6],
    agg: new Map([
      [1, makeAgg({ teamNumber: 1, matchesScouted: 4, meanFuelPoints: 30 })],
      [2, makeAgg({ teamNumber: 2, matchesScouted: 4, meanFuelPoints: 30 })],
    ]),
    epaByTeam: new Map<number, number | null>([
      [3, 40],
      [4, 50],
      [5, 50],
      [6, 50],
    ]),
    statboticsAvailable: true,
  });

  it('without fraction: output byte-identical to legacy (no components attached)', () => {
    const out = predictMatch(baseInput());
    for (const p of [...out.red.teams, ...out.blue.teams]) {
      expect(p.components).toBeUndefined();
    }
  });

  it('with fraction: each team has components; alliance unrounded sum equals score', () => {
    const out = predictMatch({
      ...baseInput(),
      fraction: { fAuto: 0.15, fFuel: 0.85 },
      playedMatches: 5,
    });
    // auto+fuel always carry the full `expected` so the alliance decomposes to
    // its score.
    const partsSum = (c: NonNullable<TeamPrediction['components']>): number =>
      c.auto + c.fuel;
    for (const p of [...out.red.teams, ...out.blue.teams]) {
      expect(p.components).toBeDefined();
      const c = p.components!;
      if (c.source !== 'none') {
        expect(partsSum(c)).toBeCloseTo(p.expected, 6);
      }
    }
    const redSum = out.red.teams.reduce(
      (s, p) => s + (p.components ? partsSum(p.components) : 0),
      0,
    );
    expect(redSum).toBeCloseTo(out.red.score, 6);
  });

  it('scouted team is scouting-sourced; unscouted team is epa-sourced', () => {
    const out = predictMatch({
      ...baseInput(),
      fraction: { fAuto: 0.15, fFuel: 0.85 },
      playedMatches: 5,
    });
    const team1 = out.red.teams.find((p) => p.teamNumber === 1)!; // scouted
    const team3 = out.red.teams.find((p) => p.teamNumber === 3)!; // epa-only
    expect(team1.components?.source).toBe('scouting');
    expect(team3.components?.source).toBe('epa');
    expect(team3.components?.provisional).toBe(true);
  });

  it('APPLY_DEFENSE_TO_PREDICTION=false: scores identical with and without fraction', () => {
    const withoutFrac = predictMatch(baseInput());
    const withFrac = predictMatch({
      ...baseInput(),
      fraction: { fAuto: 0.15, fFuel: 0.85 },
      playedMatches: 5,
    });
    expect(withFrac.red.score).toBeCloseTo(withoutFrac.red.score, EPS);
    expect(withFrac.blue.score).toBeCloseTo(withoutFrac.blue.score, EPS);
    expect(withFrac.redWinProb).toBeCloseTo(withoutFrac.redWinProb, EPS);
  });
});

describe('resolveComponentBreakdown — component EPA branch', () => {
  it('uses the team\'s own component EPA (rescaled to expected) instead of the fitted fraction', () => {
    const fraction = { fAuto: 0.5, fFuel: 0.5 } as ComponentFraction;
    const out = resolveComponentBreakdown(
      254, undefined, 300, fraction, 'epa', 99,
      { auto: 60, teleop: 130, endgame: 10 }, // sums to 200 → rescale ×1.5
    );
    expect(out.source).toBe('epa');
    expect(out.provisional).toBe(false);
    expect(out.auto).toBeCloseTo(90, 10);
    expect(out.fuel).toBeCloseTo(210, 10); // teleop 195 + endgame 15
    expect(out.endgame).toBeCloseTo(15, 10);
    expect(out.auto + out.fuel).toBeCloseTo(300, 10);
  });

  it('falls back to the fitted fraction when the component EPA is null or degenerate', () => {
    const fraction = { fAuto: 0.25, fFuel: 0.75 } as ComponentFraction;
    const viaFraction = resolveComponentBreakdown(254, undefined, 100, fraction, 'epa', 99, null);
    expect(viaFraction.auto).toBeCloseTo(25, 10);
    expect(viaFraction.provisional).toBe(true);
    const degenerate = resolveComponentBreakdown(254, undefined, 100, fraction, 'epa', 99, { auto: 0, teleop: 0, endgame: 0 });
    expect(degenerate).toEqual(viaFraction);
  });

  it('predictMatch threads componentEpaByTeam into each team\'s breakdown', () => {
    const out = predictMatch({
      redTeams: [1],
      blueTeams: [2],
      agg: new Map(),
      epaByTeam: new Map([[1, 120], [2, 80]]),
      componentEpaByTeam: new Map([[1, { auto: 40, teleop: 80, endgame: 0 }], [2, null]]),
      statboticsAvailable: true,
      fraction: { fAuto: 0.5, fFuel: 0.5 } as ComponentFraction,
      playedMatches: 99,
    });
    expect(out.red.teams[0].components?.auto).toBeCloseTo(40, 10);
    expect(out.red.teams[0].components?.provisional).toBe(false);
    expect(out.blue.teams[0].components?.auto).toBeCloseTo(40, 10); // 0.5 × 80 via fraction
    expect(out.blue.teams[0].components?.provisional).toBe(true);
  });
});

describe('parseRebuiltBreakdown (2026 REBUILT score_breakdown)', () => {
  // Live TBA 2026casnv_qm1 blue (401 pts, no fouls) with tower points added so
  // every branch of the arithmetic is exercised.
  const alliance = (o: Record<string, unknown>) => ({
    totalAutoPoints: 57, // 42 hub + 15 auto tower
    autoTowerPoints: 15,
    totalTeleopPoints: 389, // 359 hub + 30 endgame tower
    endGameTowerPoints: 30,
    totalTowerPoints: 45,
    totalPoints: 446,
    foulPoints: 0,
    adjustPoints: 0,
    ...o,
  });

  it('splits auto / teleop / endgame so they sum to the no-foul score', () => {
    const out = parseRebuiltBreakdown({
      score_breakdown: { red: alliance({}), blue: alliance({ totalAutoPoints: 42, autoTowerPoints: 0, totalTowerPoints: 30, totalPoints: 431 }) },
    });
    expect(out).toEqual({
      red: { auto: 42, teleop: 359, endgame: 45 },
      blue: { auto: 42, teleop: 359, endgame: 30 },
    });
    expect(out!.red.auto + out!.red.teleop + out!.red.endgame).toBe(446);
    expect(out!.blue.auto + out!.blue.teleop + out!.blue.endgame).toBe(431);
  });

  it('treats absent tower fields as zero but rejects a missing total', () => {
    const noTower = alliance({ autoTowerPoints: undefined, endGameTowerPoints: undefined, totalTowerPoints: 0 });
    delete (noTower as Record<string, unknown>).autoTowerPoints;
    delete (noTower as Record<string, unknown>).endGameTowerPoints;
    expect(parseRebuiltBreakdown({ score_breakdown: { red: noTower, blue: noTower } })?.red).toEqual({
      auto: 57,
      teleop: 389,
      endgame: 0,
    });
    const noTeleop = alliance({});
    delete (noTeleop as Record<string, unknown>).totalTeleopPoints;
    expect(parseRebuiltBreakdown({ score_breakdown: { red: noTeleop, blue: alliance({}) } })).toBeNull();
  });

  it('returns null (never throws) on null / non-object / schema-drifted input', () => {
    expect(parseRebuiltBreakdown(null)).toBeNull();
    expect(parseRebuiltBreakdown(42)).toBeNull();
    expect(parseRebuiltBreakdown('x')).toBeNull();
    expect(() => parseRebuiltBreakdown(undefined)).not.toThrow();
    expect(
      parseRebuiltBreakdown({
        score_breakdown: { red: { autoFuelPoints: 18, teleopFuelPoints: 71 }, blue: alliance({}) },
      }),
    ).toBeNull();
  });
});
