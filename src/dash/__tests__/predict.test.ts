// src/dash/__tests__/predict.test.ts
import { predictMatch } from '@/dash/predict';
import {
  CONFIDENCE_N,
  EPA_SANITY_TOLERANCE,
  EPA_SANITY_SLOPE,
  EPA_SANITY_SCALE_FLOOR,
  WINPROB_SIGMA_FRACTION,
  WINPROB_SIGMA_FLOOR,
  WINPROB_LOGIT_SCALE,
} from '@/dash/constants';
import type { TeamAgg } from '@/dash/aggregate';
import type { PredictInput } from '@/dash/predict';

/** Mirror of predict.ts's scale-aware win-prob, for exact-value assertions. */
function expectedWinProb(redScore: number, blueScore: number): number {
  const sigma = Math.max(WINPROB_SIGMA_FLOOR, WINPROB_SIGMA_FRACTION * (redScore + blueScore));
  const z = (WINPROB_LOGIT_SCALE * (redScore - blueScore)) / sigma;
  return 1 / (1 + Math.exp(-z));
}

/** Build a TeamAgg stub: only the fields predict reads matter. */
function agg(teamNumber: number, matchesScouted: number, scoutingExpectedPoints: number): TeamAgg {
  return {
    teamNumber,
    matchesScouted,
    meanAutoFuel: 0,
    meanTeleopFuelActive: 0,
    meanTeleopFuelInactive: 0,
    meanEndgameFuel: 0,
    meanTotalFuel: 0,
    meanFuelPoints: 0,
    meanFuelConfidence: 0,
    climbSuccessRate: 0,
    avgClimbLevel: 0,
    meanClimbPoints: 0,
    avgDefenseRating: 0,
    noShowRate: 0,
    diedRate: 0,
    tippedRate: 0,
    incidentMatches: 0,
    reliability: 1,
    scoutingExpectedPoints,
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
  };
}

function aggMap(entries: TeamAgg[]): Map<number, TeamAgg> {
  return new Map(entries.map((a) => [a.teamNumber, a]));
}


describe('predictMatch — per-team blend cases', () => {
  it('blends scouting and EPA when both present (w = min(1, m/CONFIDENCE_N))', () => {
    const input: PredictInput = {
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 2, 30)]), // m=2 -> w = 2/4 = 0.5
      epaByTeam: new Map<number, number | null>([[1, 50]]),
      statboticsAvailable: true,
    };
    const out = predictMatch(input);
    const t = out.red.teams[0];
    expect(t.w).toBeCloseTo(0.5, 10);
    expect(t.source).toBe('blend');
    // 0.5*30 + 0.5*50 = 40
    expect(t.expected).toBeCloseTo(40, 10);
  });

  it('caps w at 1 when matchesScouted >= CONFIDENCE_N', () => {
    const input: PredictInput = {
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 8, 30)]), // m=8 -> w capped at 1
      epaByTeam: new Map<number, number | null>([[1, 50]]),
      statboticsAvailable: true,
    };
    const t = predictMatch(input).red.teams[0];
    expect(t.w).toBe(1);
    expect(t.source).toBe('blend');
    // 1*30 + 0*50 = 30
    expect(t.expected).toBeCloseTo(30, 10);
  });

  it('uses scouting only (w=1) when Statbotics is unavailable, ignoring the EPA map', () => {
    const input: PredictInput = {
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 2, 30)]),
      epaByTeam: new Map<number, number | null>([[1, 999]]), // present but must be ignored
      statboticsAvailable: false,
    };
    const t = predictMatch(input).red.teams[0];
    expect(t.source).toBe('scouting');
    expect(t.w).toBe(1);
    expect(t.expected).toBeCloseTo(30, 10);
  });

  it('uses scouting only (w=1) when EPA is null but team is scouted', () => {
    const input: PredictInput = {
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 2, 30)]),
      epaByTeam: new Map<number, number | null>([[1, null]]),
      statboticsAvailable: true,
    };
    const t = predictMatch(input).red.teams[0];
    expect(t.source).toBe('scouting');
    expect(t.w).toBe(1);
    expect(t.expected).toBeCloseTo(30, 10);
  });

  it('uses EPA only (w=0) for an unscouted team (m=0)', () => {
    const input: PredictInput = {
      redTeams: [3256],
      blueTeams: [],
      agg: aggMap([]), // no agg for 3256
      epaByTeam: new Map<number, number | null>([[3256, 45]]),
      statboticsAvailable: true,
    };
    const t = predictMatch(input).red.teams[0];
    expect(t.source).toBe('epa');
    expect(t.w).toBe(0);
    expect(t.expected).toBeCloseTo(45, 10);
  });

  it('falls back to 0/none when neither scouting nor EPA is available', () => {
    const input: PredictInput = {
      redTeams: [9999],
      blueTeams: [],
      agg: aggMap([]),
      epaByTeam: new Map<number, number | null>(),
      statboticsAvailable: true,
    };
    const t = predictMatch(input).red.teams[0];
    expect(t.source).toBe('none');
    expect(t.expected).toBe(0);
    expect(t.w).toBe(0);
  });

  it('falls back to none for a scouted team when statbotics is down and... still scouting', () => {
    // sanity: an unscouted team with statbotics down -> epa forced null -> none
    const input: PredictInput = {
      redTeams: [42],
      blueTeams: [],
      agg: aggMap([]),
      epaByTeam: new Map<number, number | null>([[42, 60]]),
      statboticsAvailable: false,
    };
    const t = predictMatch(input).red.teams[0];
    expect(t.source).toBe('none');
    expect(t.expected).toBe(0);
  });
});

describe('predictMatch — EPA sanity guardrail on the blend', () => {
  /** Mirror of predictTeam's guardrail math, for exact-value assertions. */
  function guarded(scouting: number, epa: number, m: number) {
    const scale = Math.max(EPA_SANITY_SCALE_FLOOR, Math.abs(epa));
    const rel = Math.abs(scouting - epa) / scale;
    const gap = Math.max(0, rel - EPA_SANITY_TOLERANCE);
    const agreement = 1 / (1 + (EPA_SANITY_SLOPE * gap) / m);
    const w = Math.min(1, (m * agreement) / CONFIDENCE_N);
    return { agreement, w, expected: w * scouting + (1 - w) * epa };
  }

  const blend = (scouting: number, epa: number, m: number) =>
    predictMatch({
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, m, scouting)]),
      epaByTeam: new Map<number, number | null>([[1, epa]]),
      statboticsAvailable: true,
    }).red.teams[0];

  it('divergence within tolerance is fully trusted (agreement = 1, w unchanged)', () => {
    // 60 vs EPA 50 -> rel 0.2 < tolerance -> the legacy w = m/CONFIDENCE_N.
    const t = blend(60, 50, 1);
    expect(t.epaAgreement).toBe(1);
    expect(t.w).toBeCloseTo(1 / CONFIDENCE_N, 10);
    expect(t.expected).toBeCloseTo(0.25 * 60 + 0.75 * 50, 10);
  });

  it('one wild scouted match is anchored to EPA instead of dominating the blend', () => {
    // 300 pts scouted once vs EPA 80: rel = 2.75. The undamped blend would be
    // 0.25*300 + 0.75*80 = 135; the guardrail keeps the estimate near EPA.
    const t = blend(300, 80, 1);
    const g = guarded(300, 80, 1);
    expect(t.epaAgreement).toBeCloseTo(g.agreement, 10);
    expect(t.w).toBeCloseTo(g.w, 10);
    expect(t.expected).toBeCloseTo(g.expected, 10);
    expect(t.expected).toBeLessThan(100); // vs 135 undamped
    expect(t.w).toBeLessThan(1 / CONFIDENCE_N); // damped below the legacy m/N weight
    expect(t.source).toBe('blend');
  });

  it('a suspiciously LOW scouted value (scout asleep) is damped symmetrically', () => {
    // 5 pts scouted once vs EPA 100: undamped 0.25*5 + 0.75*100 = 76.25.
    const t = blend(5, 100, 1);
    expect(t.expected).toBeCloseTo(guarded(5, 100, 1).expected, 10);
    expect(t.expected).toBeGreaterThan(76.25); // pulled back toward EPA
    expect(t.epaAgreement!).toBeLessThan(1);
  });

  it('consistent evidence buys trust back: same divergence at m=4 keeps most of its weight', () => {
    // 180 vs EPA 100 (rel 0.8) — one match is heavily damped, four consistent
    // matches are mostly believed (a real breakout, not bad data).
    const one = blend(180, 100, 1);
    const four = blend(180, 100, 4);
    expect(one.epaAgreement!).toBeLessThan(four.epaAgreement!);
    expect(four.epaAgreement!).toBeGreaterThan(0.8);
    expect(four.w).toBeCloseTo(guarded(180, 100, 4).w, 10);
    expect(four.expected).toBeGreaterThan(160); // close to the scouted 180
    expect(one.expected).toBeLessThan(four.expected);
  });

  it('uses the scale floor for tiny-EPA teams so modest gaps do not over-trigger', () => {
    // EPA 10 with scouting 40: divergence is measured against the 30-pt floor
    // (rel 1.0), not against EPA itself (which would read rel 3.0).
    const t = blend(40, 10, 1);
    expect(t.epaAgreement).toBeCloseTo(guarded(40, 10, 1).agreement, 10);
    const relFloored = Math.abs(40 - 10) / EPA_SANITY_SCALE_FLOOR;
    const gapFloored = relFloored - EPA_SANITY_TOLERANCE;
    expect(t.epaAgreement).toBeCloseTo(1 / (1 + EPA_SANITY_SLOPE * gapFloored), 10);
  });

  it('non-blend sources carry no epaAgreement and are untouched', () => {
    // Scouting-only (EPA null): there is nothing to cross-check against.
    const t = predictMatch({
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 1, 300)]),
      epaByTeam: new Map<number, number | null>([[1, null]]),
      statboticsAvailable: true,
    }).red.teams[0];
    expect(t.source).toBe('scouting');
    expect(t.epaAgreement).toBeUndefined();
    expect(t.expected).toBeCloseTo(300, 10);
    expect(t.w).toBe(1);
  });

  it('damped w flows into match confidence (implausible data reads as low confidence)', () => {
    const wild = predictMatch({
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 1, 300)]),
      epaByTeam: new Map<number, number | null>([[1, 80]]),
      statboticsAvailable: true,
    });
    const sane = predictMatch({
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 1, 90)]),
      epaByTeam: new Map<number, number | null>([[1, 80]]),
      statboticsAvailable: true,
    });
    expect(wild.confidence).toBeLessThan(sane.confidence);
  });
});

describe('predictMatch — alliance scores & win prob', () => {
  const fullInput = (statboticsAvailable: boolean): PredictInput => ({
    redTeams: [1, 2, 3],
    blueTeams: [4, 5, 6],
    agg: aggMap([
      agg(1, 2, 20),
      agg(2, 2, 20),
      agg(3, 2, 20),
      agg(4, 2, 20),
      agg(5, 2, 20),
      agg(6, 2, 20),
    ]),
    epaByTeam: new Map<number, number | null>([
      [1, 40],
      [2, 40],
      [3, 40],
      [4, 40],
      [5, 40],
      [6, 40],
    ]),
    statboticsAvailable,
  });

  it('alliance score is the sum of team expected values', () => {
    const out = predictMatch(fullInput(true));
    // each team: 0.5*20 + 0.5*40 = 30 -> 3 teams = 90
    expect(out.red.score).toBeCloseTo(90, 10);
    expect(out.blue.score).toBeCloseTo(90, 10);
    expect(out.red.score).toBeCloseTo(
      out.red.teams.reduce((s, t) => s + t.expected, 0),
      10,
    );
  });

  it('redWinProb is 0.5 at equal scores', () => {
    expect(predictMatch(fullInput(true)).redWinProb).toBeCloseTo(0.5, 10);
  });

  it('redWinProb matches the scale-aware logistic of the margin and is monotonic', () => {
    const input: PredictInput = {
      redTeams: [1],
      blueTeams: [4],
      agg: aggMap([agg(1, 4, 100), agg(4, 4, 40)]), // red 100, blue 40
      epaByTeam: new Map<number, number | null>(),
      statboticsAvailable: true,
    };
    const out = predictMatch(input);
    expect(out.red.score).toBeCloseTo(100, 10);
    expect(out.blue.score).toBeCloseTo(40, 10);
    expect(out.redWinProb).toBeCloseTo(expectedWinProb(100, 40), 10);
    expect(out.redWinProb).toBeGreaterThan(0.5); // stronger red

    // swapping makes blue stronger -> redWinProb < 0.5 and symmetric
    const swapped = predictMatch({ ...input, redTeams: [4], blueTeams: [1] });
    expect(swapped.redWinProb).toBeLessThan(0.5);
    expect(swapped.redWinProb).toBeCloseTo(1 - out.redWinProb, 10);
  });

  it('redWinProb stays within [0,1]', () => {
    const input: PredictInput = {
      redTeams: [1],
      blueTeams: [4],
      agg: aggMap([agg(1, 4, 100000), agg(4, 4, 0)]),
      epaByTeam: new Map<number, number | null>(),
      statboticsAvailable: true,
    };
    const p = predictMatch(input).redWinProb;
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});

describe('predictMatch — confidence', () => {
  const fullInput = (statboticsAvailable: boolean): PredictInput => ({
    redTeams: [1, 2, 3],
    blueTeams: [4, 5, 6],
    agg: aggMap([
      agg(1, 2, 20),
      agg(2, 2, 20),
      agg(3, 2, 20),
      agg(4, 2, 20),
      agg(5, 2, 20),
      agg(6, 2, 20),
    ]),
    epaByTeam: new Map<number, number | null>([
      [1, 40],
      [2, 40],
      [3, 40],
      [4, 40],
      [5, 40],
      [6, 40],
    ]),
    statboticsAvailable,
  });

  it('confidence is meanW when Statbotics is up', () => {
    // all w = 0.5 -> meanW = 0.5, * 1
    expect(predictMatch(fullInput(true)).confidence).toBeCloseTo(0.5, 10);
  });

  it('confidence drops (knocked down by 0.85) when Statbotics is unavailable', () => {
    // statbotics down -> epa null -> scouting-only -> all w = 1, meanW = 1, * 0.85
    const up = predictMatch(fullInput(true)).confidence;
    const down = predictMatch(fullInput(false)).confidence;
    expect(down).toBeCloseTo(0.85, 10);
    // statbotics-down confidence reflects the 0.85 knockdown factor
    expect(down).toBeLessThan(1);
    // explicitly different from the up case
    expect(down).not.toBeCloseTo(up, 5);
  });

  it('confidence is clamped to [0,1]', () => {
    const c = predictMatch(fullInput(true)).confidence;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});

describe('predictMatch — robustness', () => {
  it('never throws on unknown / missing teams and empty alliances', () => {
    const input: PredictInput = {
      redTeams: [11111, 22222],
      blueTeams: [],
      agg: new Map(),
      epaByTeam: new Map<number, number | null>(),
      statboticsAvailable: true,
    };
    expect(() => predictMatch(input)).not.toThrow();
    const out = predictMatch(input);
    expect(out.red.score).toBe(0);
    expect(out.blue.score).toBe(0);
    expect(out.redWinProb).toBeCloseTo(0.5, 10);
    expect(out.red.teams.every((t) => t.source === 'none')).toBe(true);
  });

  it('CONFIDENCE_N and the win-prob calibration are the contract values', () => {
    expect(CONFIDENCE_N).toBe(4);
    expect(WINPROB_SIGMA_FRACTION).toBe(0.11);
    expect(WINPROB_SIGMA_FLOOR).toBe(12);
    expect(WINPROB_LOGIT_SCALE).toBe(1.7);
    expect(EPA_SANITY_TOLERANCE).toBe(0.5);
    expect(EPA_SANITY_SLOPE).toBe(2);
    expect(EPA_SANITY_SCALE_FLOOR).toBe(30);
  });

  it('a 21-pt margin in a high-scoring game is a near coin-flip, not a lock', () => {
    // The motivating case: 2026casnv qual 70, ~426 vs ~405. The old fixed-K curve
    // returned ~84%; the scale-aware curve should be much closer to even.
    const input: PredictInput = {
      redTeams: [1],
      blueTeams: [4],
      agg: aggMap([agg(1, 4, 426), agg(4, 4, 405)]),
      epaByTeam: new Map<number, number | null>(),
      statboticsAvailable: true,
    };
    const p = predictMatch(input).redWinProb;
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThan(0.66);
  });

  // Regression: a persisted React Query cache from before Map serialization was
  // handled rehydrates epaByTeam as a plain object, which has no `.get`.
  // predictMatch must coerce it instead of throwing "epaByTeam.get is not a function".
  it('tolerates epaByTeam rehydrated as a plain object (corrupt persisted cache)', () => {
    const input = {
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 2, 30)]),
      // Plain object, not a Map — string keys as JSON.parse would produce.
      epaByTeam: { '1': 50 } as unknown as PredictInput['epaByTeam'],
      statboticsAvailable: true,
    } as PredictInput;
    expect(() => predictMatch(input)).not.toThrow();
    const t = predictMatch(input).red.teams[0];
    expect(t.source).toBe('blend');
    expect(t.expected).toBeCloseTo(40, 10); // 0.5*30 + 0.5*50
  });
});
