// src/dash/__tests__/predict.test.ts
import { predictMatch } from '@/dash/predict';
import { CONFIDENCE_N, WINPROB_K } from '@/dash/constants';
import type { TeamAgg } from '@/dash/aggregate';
import type { PredictInput } from '@/dash/predict';

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
    fuelPointsWeighted: 0,
    climbSuccessRate: 0,
    avgClimbLevel: 0,
    meanClimbPoints: 0,
    avgDefenseRating: 0,
    noShowRate: 0,
    diedRate: 0,
    reliability: 1,
    scoutingExpectedPoints,
  };
}

function aggMap(entries: TeamAgg[]): Map<number, TeamAgg> {
  return new Map(entries.map((a) => [a.teamNumber, a]));
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

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

  it('redWinProb matches the logistic of WINPROB_K*(red-blue) and is monotonic', () => {
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
    expect(out.redWinProb).toBeCloseTo(logistic(WINPROB_K * (100 - 40)), 10);
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

  it('CONFIDENCE_N and WINPROB_K are the contract values', () => {
    expect(CONFIDENCE_N).toBe(4);
    expect(WINPROB_K).toBe(0.08);
  });
});
