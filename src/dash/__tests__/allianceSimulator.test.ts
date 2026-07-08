// src/dash/__tests__/allianceSimulator.test.ts
import { describe, it, expect } from 'vitest';
import {
  simulateAlliance,
  simulateVersus,
  classifyRoles,
  summarizeGaps,
  pickBaseline,
  FUEL_STRONG,
  FUEL_PARTIAL,
  DEFENSE_STRONG,
  DEFENSE_PARTIAL,
  CLIMB_L23_POINTS,
  type SimulateInput,
} from '@/dash/allianceSimulator';
import { predictMatch } from '@/dash/predict';
import type { TeamAgg } from '@/dash/aggregate';
import type { TeamPit } from '@/dash/useTeamPit';
import { CONFIDENCE_N } from '@/dash/constants';

/** TeamAgg factory: zeroes everything, override per test. */
function agg(overrides: Partial<TeamAgg>): TeamAgg {
  return {
    teamNumber: 1,
    matchesScouted: 1,
    meanAutoFuel: 0,
    meanTeleopFuelActive: 0,
    meanTeleopFuelInactive: 0,
    meanEndgameFuel: 0,
    meanTotalFuel: 0,
    meanFuelPoints: 0,
    meanFuelConfidence: 1,
    climbSuccessRate: 0,
    avgClimbLevel: 0,
    meanClimbPoints: 0,
    avgDefenseRating: 0,
    noShowRate: 0,
    diedRate: 0,
    tippedRate: 0,
    incidentMatches: 0,
    reliability: 1,
    scoutingExpectedPoints: 0,
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

/** TeamPit factory. */
function pit(overrides: Partial<TeamPit>): TeamPit {
  return {
    eventKey: '2026casnv',
    teamNumber: 1,
    drivetrain: null,
    mechanisms: [],
    capabilities: [],
    intakeSources: [],
    visionSystem: null,
    batteryCount: null,
    chargerCount: null,
    batteryBrand: null,
    batteryConnector: null,
    preferredAutoStartPosition: null,
    preferredAutoPath: null,
    matchStrategy: [],
    robotLengthIn: null,
    robotWidthIn: null,
    robotHeightIn: null,
    trenchCapable: false,
    photoPath: null,
    notes: null,
    authorScoutId: null,
    ...overrides,
  };
}

function makeInput(over: Partial<SimulateInput>): SimulateInput {
  return {
    pickedTeams: [],
    baselineTeams: [],
    agg: new Map(),
    epaByTeam: new Map(),
    pits: new Map(),
    statboticsAvailable: false,
    ...over,
  };
}

describe('simulateAlliance — score = sum of predictMatch expected', () => {
  it('projectedScore equals predictMatch(...).red.score (exact reuse, no EPA)', () => {
    const a = new Map<number, TeamAgg>([
      [1, agg({ teamNumber: 1, matchesScouted: 5, scoutingExpectedPoints: 100 })],
      [2, agg({ teamNumber: 2, matchesScouted: 5, scoutingExpectedPoints: 50 })],
      [3, agg({ teamNumber: 3, matchesScouted: 5, scoutingExpectedPoints: 25 })],
    ]);
    const input = makeInput({ pickedTeams: [1, 2, 3], agg: a });
    const sim = simulateAlliance(input);
    const pred = predictMatch({
      redTeams: [1, 2, 3],
      blueTeams: [],
      agg: a,
      epaByTeam: new Map(),
      statboticsAvailable: false,
    });
    expect(sim.projectedScore).toBe(pred.red.score);
    expect(sim.projectedScore).toBeCloseTo(175, 6);
  });
});

describe('source classification', () => {
  it('blend when matchesScouted >= CONFIDENCE_N and EPA present', () => {
    const a = new Map<number, TeamAgg>([
      [1, agg({ teamNumber: 1, matchesScouted: CONFIDENCE_N, scoutingExpectedPoints: 100 })],
      [2, agg({ teamNumber: 2, matchesScouted: CONFIDENCE_N, scoutingExpectedPoints: 90 })],
      [3, agg({ teamNumber: 3, matchesScouted: CONFIDENCE_N, scoutingExpectedPoints: 80 })],
    ]);
    const epa = new Map<number, number | null>([[1, 95], [2, 88], [3, 70]]);
    const sim = simulateAlliance(
      makeInput({ pickedTeams: [1, 2, 3], agg: a, epaByTeam: epa, statboticsAvailable: true }),
    );
    expect(sim.teamReads.every((r) => r.source === 'blend')).toBe(true);
    expect(sim.scoreSource).toBe('blend');
  });

  it('scouting when EPA absent (statbotics unavailable)', () => {
    const a = new Map<number, TeamAgg>([
      [1, agg({ teamNumber: 1, matchesScouted: 3, scoutingExpectedPoints: 100 })],
      [2, agg({ teamNumber: 2, matchesScouted: 3, scoutingExpectedPoints: 90 })],
      [3, agg({ teamNumber: 3, matchesScouted: 3, scoutingExpectedPoints: 80 })],
    ]);
    const epa = new Map<number, number | null>([[1, 95], [2, 88], [3, 70]]);
    const sim = simulateAlliance(
      makeInput({ pickedTeams: [1, 2, 3], agg: a, epaByTeam: epa, statboticsAvailable: false }),
    );
    expect(sim.teamReads.every((r) => r.source === 'scouting')).toBe(true);
    expect(sim.scoreSource).toBe('scouting');
  });

  it('mixed when sources differ (scouting + blend + epa)', () => {
    const a = new Map<number, TeamAgg>([
      // team 1: scouting only (no EPA value)
      [1, agg({ teamNumber: 1, matchesScouted: 3, scoutingExpectedPoints: 100 })],
      // team 2: blend (scouting + EPA)
      [2, agg({ teamNumber: 2, matchesScouted: CONFIDENCE_N, scoutingExpectedPoints: 90 })],
      // team 3: epa only (unscouted)
    ]);
    const epa = new Map<number, number | null>([[2, 88], [3, 70]]);
    const sim = simulateAlliance(
      makeInput({ pickedTeams: [1, 2, 3], agg: a, epaByTeam: epa, statboticsAvailable: true }),
    );
    expect(sim.teamReads[0].source).toBe('scouting');
    expect(sim.teamReads[1].source).toBe('blend');
    expect(sim.teamReads[2].source).toBe('epa');
    expect(sim.scoreSource).toBe('mixed');
  });
});

describe('win prob vs baseline', () => {
  const strong = new Map<number, TeamAgg>([
    [1, agg({ teamNumber: 1, matchesScouted: 5, scoutingExpectedPoints: 120 })],
    [2, agg({ teamNumber: 2, matchesScouted: 5, scoutingExpectedPoints: 110 })],
    [3, agg({ teamNumber: 3, matchesScouted: 5, scoutingExpectedPoints: 100 })],
    [4, agg({ teamNumber: 4, matchesScouted: 5, scoutingExpectedPoints: 30 })],
    [5, agg({ teamNumber: 5, matchesScouted: 5, scoutingExpectedPoints: 25 })],
    [6, agg({ teamNumber: 6, matchesScouted: 5, scoutingExpectedPoints: 20 })],
  ]);

  it('> 0.5 when picked alliance is stronger', () => {
    const sim = simulateAlliance(
      makeInput({ pickedTeams: [1, 2, 3], baselineTeams: [4, 5, 6], agg: strong }),
    );
    expect(sim.redWinProb).not.toBeNull();
    expect(sim.redWinProb as number).toBeGreaterThan(0.5);
  });

  it('< 0.5 when weaker', () => {
    const sim = simulateAlliance(
      makeInput({ pickedTeams: [4, 5, 6], baselineTeams: [1, 2, 3], agg: strong }),
    );
    expect(sim.redWinProb as number).toBeLessThan(0.5);
  });

  it('null when fewer than 3 baseline teams', () => {
    const sim = simulateAlliance(
      makeInput({ pickedTeams: [1, 2, 3], baselineTeams: [4, 5], agg: strong }),
    );
    expect(sim.redWinProb).toBeNull();
  });
});

describe('pickBaseline', () => {
  const a = new Map<number, TeamAgg>([
    [1, agg({ teamNumber: 1, matchesScouted: 5, scoutingExpectedPoints: 100 })],
    [2, agg({ teamNumber: 2, matchesScouted: 5, scoutingExpectedPoints: 90 })],
    [3, agg({ teamNumber: 3, matchesScouted: 5, scoutingExpectedPoints: 80 })],
    [4, agg({ teamNumber: 4, matchesScouted: 5, scoutingExpectedPoints: 70 })],
    [5, agg({ teamNumber: 5, matchesScouted: 5, scoutingExpectedPoints: 60 })],
    [6, agg({ teamNumber: 6, matchesScouted: 5, scoutingExpectedPoints: 50 })],
    [7, agg({ teamNumber: 7, matchesScouted: 5, scoutingExpectedPoints: 40 })],
  ]);
  const candidates = [1, 2, 3, 4, 5, 6, 7];

  it('top excludes picks and returns the top-3 expected', () => {
    const base = pickBaseline('top', candidates, [1, 2], a, new Map(), false);
    // 1 and 2 excluded → top remaining are 3, 4, 5
    expect(base).toEqual([3, 4, 5]);
    expect(base.some((t) => t === 1 || t === 2)).toBe(false);
  });

  it('returns < 3 (empty) when exclusion leaves too few candidates', () => {
    const base = pickBaseline('top', [1, 2, 3, 4], [1, 2], a, new Map(), false);
    // only 3 and 4 remain → cannot field a 3-team baseline
    expect(base.length).toBeLessThan(3);
  });

  it('median returns teams around the median expected', () => {
    const base = pickBaseline('median', candidates, [], a, new Map(), false);
    // 7 candidates → median index 3 (team 4) → centered window [3,4,5]
    expect(base).toEqual([3, 4, 5]);
  });
});

describe('classifyRoles thresholds', () => {
  it('fuel boundaries 9.9/10/29.9/30 → none/partial/partial/strong', () => {
    expect(classifyRoles(agg({ meanFuelPoints: 9.9 }), undefined).fuel).toBe('partial'); // >0 → partial
    expect(classifyRoles(agg({ meanFuelPoints: FUEL_PARTIAL }), undefined).fuel).toBe('partial');
    expect(classifyRoles(agg({ meanFuelPoints: 29.9 }), undefined).fuel).toBe('partial');
    expect(classifyRoles(agg({ meanFuelPoints: FUEL_STRONG }), undefined).fuel).toBe('strong');
    expect(classifyRoles(agg({ meanFuelPoints: 0 }), undefined).fuel).toBe('none');
  });

  it('defense boundaries 1.4/1.5/2.4/2.5 → none/partial/partial/strong (0..3 scale)', () => {
    expect(classifyRoles(agg({ avgDefenseRating: 1.4 }), undefined).defense).toBe('none');
    expect(classifyRoles(agg({ avgDefenseRating: DEFENSE_PARTIAL }), undefined).defense).toBe('partial');
    expect(classifyRoles(agg({ avgDefenseRating: 2.4 }), undefined).defense).toBe('partial');
    expect(classifyRoles(agg({ avgDefenseRating: DEFENSE_STRONG }), undefined).defense).toBe('strong');
  });

  it('climbL23 from pit climb_l3 + meanClimbPoints 17.9/18 → partial/strong', () => {
    const p = pit({ capabilities: ['climb_l3'] });
    expect(classifyRoles(agg({ meanClimbPoints: 17.9, avgClimbLevel: 1 }), p).climbL23).toBe('partial');
    expect(classifyRoles(agg({ meanClimbPoints: CLIMB_L23_POINTS, avgClimbLevel: 1 }), p).climbL23).toBe('strong');
  });

  it('pit-claimed climb with 0 matches → partial', () => {
    const p = pit({ capabilities: ['climb_l1'] });
    expect(classifyRoles(agg({ matchesScouted: 0 }), p).climbL1).toBe('partial');
  });

  it('auto: pit-claimed + meanAutoFuel >= 5 → strong; one signal → partial', () => {
    expect(classifyRoles(agg({ meanAutoFuel: 6 }), pit({ capabilities: ['auto'] })).auto).toBe('strong');
    expect(classifyRoles(agg({ meanAutoFuel: 0 }), pit({ capabilities: ['auto'] })).auto).toBe('partial');
    expect(classifyRoles(agg({ meanAutoFuel: 3 }), undefined).auto).toBe('partial');
    expect(classifyRoles(agg({ meanAutoFuel: 0 }), undefined).auto).toBe('none');
  });
});

describe('unknown roles', () => {
  it('no pit and matchesScouted === 0 → all roles unknown, source none', () => {
    const sim = simulateAlliance(makeInput({ pickedTeams: [99], agg: new Map(), pits: new Map() }));
    const read = sim.teamReads[0];
    expect(read.source).toBe('none');
    expect(read.roles).toEqual({
      auto: 'unknown',
      fuel: 'unknown',
      defense: 'unknown',
      climbL1: 'unknown',
      climbL23: 'unknown',
    });
  });
});

describe('no-scouting role estimate (EPA auto/fuel fallback)', () => {
  const fraction = { fAuto: 0.15, fFuel: 0.55, fClimb: 0.3 };

  it('fills auto/fuel from the EPA estimate for an unscouted team; rest stay unknown', () => {
    const sim = simulateAlliance(
      makeInput({
        pickedTeams: [99],
        epaByTeam: new Map([[99, 50]]),
        statboticsAvailable: true,
        fraction,
        playedMatches: 5,
      }),
    );
    const r = sim.teamReads[0];
    expect(r.source).toBe('epa');
    expect(r.roles.auto).toBe('partial');
    expect(r.roles.fuel).toBe('partial');
    // EPA can't speak to defense/climb — those stay unknown ("?").
    expect(r.roles.defense).toBe('unknown');
    expect(r.roles.climbL1).toBe('unknown');
    expect(r.roles.climbL23).toBe('unknown');
  });

  it('without a fitted fraction the estimate is absent → roles stay unknown', () => {
    const sim = simulateAlliance(
      makeInput({
        pickedTeams: [99],
        epaByTeam: new Map([[99, 50]]),
        statboticsAvailable: true,
        playedMatches: 5,
      }),
    );
    expect(sim.teamReads[0].roles.auto).toBe('unknown');
    expect(sim.teamReads[0].roles.fuel).toBe('unknown');
  });

  it('estimated fuel caps at partial (never a confirmed strong ✓)', () => {
    const roles = classifyRoles(undefined, undefined, {
      auto: 11,
      fuel: 39,
      climb: null,
      defense: null,
      source: 'epa',
      provisional: true,
    });
    expect(roles.auto).toBe('partial');
    expect(roles.fuel).toBe('partial'); // 39 ≥ FUEL_STRONG, but estimates cap at partial
  });

  it('weak estimate (low auto/fuel points) → none, not a false partial', () => {
    const roles = classifyRoles(undefined, undefined, {
      auto: 1,
      fuel: 5,
      climb: null,
      defense: null,
      source: 'epa',
      provisional: true,
    });
    expect(roles.auto).toBe('none');
    expect(roles.fuel).toBe('none');
  });

  it('a non-EPA (source none) estimate is ignored → roles unknown', () => {
    const roles = classifyRoles(undefined, undefined, {
      auto: 0,
      fuel: 0,
      climb: null,
      defense: null,
      source: 'none',
      provisional: false,
    });
    expect(roles.auto).toBe('unknown');
    expect(roles.fuel).toBe('unknown');
  });
});

describe('summarizeGaps', () => {
  function read(team: number, roles: Partial<TeamRoleReadRoles>, over?: Partial<ReadShape>): ReadShape {
    return {
      teamNumber: team,
      matchesScouted: 5,
      hasPit: true,
      source: 'scouting',
      expected: 50,
      roles: { auto: 'none', fuel: 'none', defense: 'none', climbL1: 'none', climbL23: 'none', ...roles },
      ...over,
    };
  }
  type TeamRoleReadRoles = ReadShape['roles'];
  type ReadShape = ReturnType<typeof simulateAlliance>['teamReads'][number];

  it('two feeders + no scorer → gap text includes "feeders"', () => {
    const reads = [
      read(1, { climbL23: 'strong' }),
      read(2, { climbL23: 'strong' }),
      read(3, { defense: 'strong' }),
    ];
    const pits = new Map<number, TeamPit>([
      [1, pit({ matchStrategy: ['feed'] })],
      [2, pit({ matchStrategy: ['feed'] })],
      [3, pit({})],
    ]);
    const gaps = summarizeGaps(reads, pits);
    expect(gaps.some((g) => g.text.toLowerCase().includes('feeder'))).toBe(true);
  });

  it('no L2/L3 climber → "No L2/L3 climber"', () => {
    const reads = [
      read(1, { climbL1: 'strong', fuel: 'strong', defense: 'strong' }),
      read(2, { climbL1: 'strong', fuel: 'strong' }),
      read(3, { climbL1: 'strong', fuel: 'strong' }),
    ];
    const gaps = summarizeGaps(reads, new Map());
    expect(gaps.some((g) => g.text === 'No L2/L3 climber')).toBe(true);
  });

  it('all core roles covered → single Balanced alliance note', () => {
    const reads = [
      read(1, { fuel: 'strong', defense: 'strong', climbL23: 'strong' }),
      read(2, { fuel: 'strong', defense: 'strong', climbL23: 'strong' }),
      read(3, { fuel: 'strong', defense: 'strong', climbL23: 'strong' }),
    ];
    // hasPit true so no match-only note; double-climb note also fires though →
    // so check Balanced only fires when truly no gaps. Use single climbers to
    // avoid the double-high note.
    const reads2 = [
      read(1, { fuel: 'strong', defense: 'strong', climbL23: 'strong' }),
      read(2, { fuel: 'strong', defense: 'strong', climbL1: 'strong' }),
      read(3, { fuel: 'strong', defense: 'strong', climbL1: 'strong' }),
    ];
    const gaps = summarizeGaps(reads2, new Map());
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe('note');
    expect(gaps[0].text).toMatch(/Balanced alliance/);
    void reads;
  });

  it('team with no data → "no data" gap naming the team number', () => {
    const reads = [
      read(1, { fuel: 'strong', defense: 'strong', climbL23: 'strong' }),
      read(2, { fuel: 'strong', defense: 'strong', climbL1: 'strong' }),
      read(3, {}, { source: 'none', hasPit: false, matchesScouted: 0 }),
    ];
    const gaps = summarizeGaps(reads, new Map());
    expect(gaps.some((g) => g.text === 'Team 3: no data')).toBe(true);
  });
});

describe('simulateVersus', () => {
  const a = new Map<number, TeamAgg>([
    [1, agg({ teamNumber: 1, matchesScouted: 5, scoutingExpectedPoints: 120, meanFuelPoints: 40, meanClimbPoints: 20, avgDefenseRating: 1, reliability: 1 })],
    [2, agg({ teamNumber: 2, matchesScouted: 5, scoutingExpectedPoints: 110, meanFuelPoints: 35, meanClimbPoints: 18, avgDefenseRating: 0.5, reliability: 0.9 })],
    [3, agg({ teamNumber: 3, matchesScouted: 5, scoutingExpectedPoints: 100, meanFuelPoints: 30, meanClimbPoints: 16, avgDefenseRating: 0.2, reliability: 0.95 })],
    [4, agg({ teamNumber: 4, matchesScouted: 5, scoutingExpectedPoints: 30, meanFuelPoints: 10, meanClimbPoints: 6, avgDefenseRating: 4, reliability: 0.6 })],
    [5, agg({ teamNumber: 5, matchesScouted: 5, scoutingExpectedPoints: 25, meanFuelPoints: 8, meanClimbPoints: 4, avgDefenseRating: 3.5, reliability: 0.5 })],
    [6, agg({ teamNumber: 6, matchesScouted: 5, scoutingExpectedPoints: 20, meanFuelPoints: 6, meanClimbPoints: 2, avgDefenseRating: 3, reliability: 0.7 })],
  ]);
  const empty = new Map<number, number | null>();
  const pits = new Map<number, TeamPit>();

  it('per-side scores equal simulateAlliance projectedScore for each side', () => {
    const vs = simulateVersus([1, 2, 3], [4, 5, 6], a, empty, pits, false);
    const sa = simulateAlliance(makeInput({ pickedTeams: [1, 2, 3], baselineTeams: [4, 5, 6], agg: a }));
    const sb = simulateAlliance(makeInput({ pickedTeams: [4, 5, 6], baselineTeams: [1, 2, 3], agg: a }));
    expect(vs.a.projectedScore).toBe(sa.projectedScore);
    expect(vs.b.projectedScore).toBe(sb.projectedScore);
  });

  it('aWinProb > 0.5 when A is the stronger alliance, and is symmetric', () => {
    const ab = simulateVersus([1, 2, 3], [4, 5, 6], a, empty, pits, false);
    const ba = simulateVersus([4, 5, 6], [1, 2, 3], a, empty, pits, false);
    expect(ab.aWinProb).not.toBeNull();
    expect(ab.aWinProb as number).toBeGreaterThan(0.5);
    // symmetry: P(A beats B) + P(B beats A) ≈ 1
    expect((ab.aWinProb as number) + (ba.aWinProb as number)).toBeCloseTo(1, 6);
  });

  it('aWinProb is null until both sides have 3 teams', () => {
    expect(simulateVersus([1, 2, 3], [4, 5], a, empty, pits, false).aWinProb).toBeNull();
    expect(simulateVersus([1, 2], [4, 5, 6], a, empty, pits, false).aWinProb).toBeNull();
    expect(simulateVersus([], [], a, empty, pits, false).aWinProb).toBeNull();
  });

  it('per-axis winner: A leads fuel/climb, B leads defense', () => {
    const vs = simulateVersus([1, 2, 3], [4, 5, 6], a, empty, pits, false);
    const byAxis = Object.fromEntries(vs.axes.map((x) => [x.axis, x]));
    expect(byAxis.fuel.winner).toBe('a'); // 105 vs 24
    expect(byAxis.climb.winner).toBe('a'); // 54 vs 12
    expect(byAxis.defense.winner).toBe('b'); // best defender 1 vs 4
  });

  it('degrades gracefully with empty sides (no throw, scores 0, null winprob)', () => {
    const vs = simulateVersus([], [], new Map(), empty, pits, true);
    expect(vs.a.projectedScore).toBe(0);
    expect(vs.b.projectedScore).toBe(0);
    expect(vs.aWinProb).toBeNull();
    expect(vs.axes).toHaveLength(4);
    expect(vs.axes.every((x) => x.winner === 'tie')).toBe(true);
  });
});

describe('purity', () => {
  it('twice with the same input yields deep-equal output', () => {
    const a = new Map<number, TeamAgg>([
      [1, agg({ teamNumber: 1, matchesScouted: 3, scoutingExpectedPoints: 50 })],
      [2, agg({ teamNumber: 2, matchesScouted: 3, scoutingExpectedPoints: 40 })],
      [3, agg({ teamNumber: 3, matchesScouted: 3, scoutingExpectedPoints: 30 })],
    ]);
    const input = makeInput({ pickedTeams: [1, 2, 3], baselineTeams: [], agg: a });
    expect(simulateAlliance(input)).toEqual(simulateAlliance(input));
  });

  it('never throws when agg is empty or epaByTeam is a plain object', () => {
    expect(() =>
      simulateAlliance({
        pickedTeams: [1, 2, 3],
        baselineTeams: [],
        agg: new Map(),
        // tolerate a plain-object EPA map (rehydrated cache)
        epaByTeam: {} as unknown as Map<number, number | null>,
        pits: new Map(),
        statboticsAvailable: true,
      }),
    ).not.toThrow();
  });
});
