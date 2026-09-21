// src/dash/__tests__/predict.test.ts
import { predictMatch } from '@/dash/predict';
import {
  CONFIDENCE_N,
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


describe('predictMatch — per-team source cases (EPA first, scouting never blends)', () => {
  it('uses EPA alone when both scouting and EPA are present (scouting is ignored)', () => {
    const input: PredictInput = {
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 2, 30)]),
      epaByTeam: new Map<number, number | null>([[1, 50]]),
      statboticsAvailable: true,
    };
    const t = predictMatch(input).red.teams[0];
    expect(t.source).toBe('epa');
    expect(t.w).toBe(1);
    expect(t.expected).toBeCloseTo(50, 10);
  });

  it('still uses EPA alone for a heavily-scouted team (m >= CONFIDENCE_N never buys scouting in)', () => {
    const input: PredictInput = {
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 8, 30)]),
      epaByTeam: new Map<number, number | null>([[1, 50]]),
      statboticsAvailable: true,
    };
    const t = predictMatch(input).red.teams[0];
    expect(t.source).toBe('epa');
    expect(t.expected).toBeCloseTo(50, 10);
  });

  it('falls back to scouting (w = min(1, m/CONFIDENCE_N)) when EPA is unavailable, ignoring the EPA map', () => {
    const input: PredictInput = {
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 2, 30)]),
      epaByTeam: new Map<number, number | null>([[1, 999]]), // present but must be ignored
      statboticsAvailable: false,
    };
    const t = predictMatch(input).red.teams[0];
    expect(t.source).toBe('scouting');
    expect(t.w).toBeCloseTo(2 / CONFIDENCE_N, 10);
    expect(t.expected).toBeCloseTo(30, 10);
  });

  it('falls back to scouting when EPA is null for a scouted team; w caps at 1', () => {
    const input: PredictInput = {
      redTeams: [1],
      blueTeams: [],
      agg: aggMap([agg(1, 8, 30)]),
      epaByTeam: new Map<number, number | null>([[1, null]]),
      statboticsAvailable: true,
    };
    const t = predictMatch(input).red.teams[0];
    expect(t.source).toBe('scouting');
    expect(t.w).toBe(1);
    expect(t.expected).toBeCloseTo(30, 10);
  });

  it('uses EPA (w=1) for an unscouted team (m=0)', () => {
    const input: PredictInput = {
      redTeams: [3256],
      blueTeams: [],
      agg: aggMap([]), // no agg for 3256
      epaByTeam: new Map<number, number | null>([[3256, 45]]),
      statboticsAvailable: true,
    };
    const t = predictMatch(input).red.teams[0];
    expect(t.source).toBe('epa');
    expect(t.w).toBe(1);
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

  it('an unscouted team with EPA unavailable resolves to none', () => {
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

  it('one wild scouted match cannot move an EPA-backed expectation at all', () => {
    const input: PredictInput = {
      redTeams: [1, 2],
      blueTeams: [],
      agg: aggMap([agg(1, 1, 400), agg(2, 1, 0)]),
      epaByTeam: new Map<number, number | null>([[1, 50], [2, 50]]),
      statboticsAvailable: true,
    };
    const out = predictMatch(input);
    expect(out.red.teams[0].expected).toBe(50);
    expect(out.red.teams[1].expected).toBe(50);
    expect(out.red.score).toBe(100);
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

  it('alliance score is the sum of team expected values (EPA-only: 3 × 40)', () => {
    const out = predictMatch(fullInput(true));
    // each team: EPA 40 (scouting 20 ignored) -> 3 teams = 120
    expect(out.red.score).toBeCloseTo(120, 10);
    expect(out.blue.score).toBeCloseTo(120, 10);
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

  it('confidence is meanW (1 for an all-EPA match) when EPA is up', () => {
    expect(predictMatch(fullInput(true)).confidence).toBeCloseTo(1, 10);
  });

  it('confidence drops when EPA is unavailable (scouting fallback w = m/N, then × 0.85)', () => {
    // epa down -> scouting-only -> all w = 2/4 = 0.5, meanW = 0.5, * 0.85
    const up = predictMatch(fullInput(true)).confidence;
    const down = predictMatch(fullInput(false)).confidence;
    expect(down).toBeCloseTo(0.5 * 0.85, 10);
    expect(down).toBeLessThan(up);
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
    // Fitted on the 2026 season backtest (constants.ts); the old 1.7 was ~2× overconfident.
    expect(WINPROB_LOGIT_SCALE).toBe(0.85);
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
    expect(t.source).toBe('epa');
    expect(t.expected).toBeCloseTo(50, 10);
  });
});
