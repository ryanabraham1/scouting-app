// src/dash/__tests__/aggregate.test.ts
import { describe, it, expect } from 'vitest';
import {
  aggregateTeam,
  aggregateEvent,
  matchScoutCoverage,
  eventScoutCoverage,
} from '@/dash/aggregate';
import type { MsrRow, BurstRow, IntervalRow, ScoutLite } from '@/dash/types';
import { SCORING } from '@/scoring';

/** Minimal MsrRow factory: fills required fields, override per test. */
function row(overrides: Partial<MsrRow>): MsrRow {
  return {
    target_team_number: 100,
    match_key: 'evt_qm1',
    alliance_color: 'red',
    station: 1,
    auto_fuel: 0,
    teleop_fuel_active: 0,
    teleop_fuel_inactive: 0,
    endgame_fuel: 0,
    fuel_points: 0,
    fuel_estimate_confidence: 1,
    fuel_by_shift: [0, 0, 0, 0],
    climb_level: 0,
    climb_attempted: false,
    climb_success: false,
    auto_left_starting_line: false,
    auto_climb_level1: false,
    defense_rating: 0,
    pins: 0,
    no_show: false,
    died: false,
    tipped: false,
    dropped_fuel: false,
    fed_corral: false,
    auto_start_position: null,
    auto_path: null,
    server_received_at: '2026-06-23T00:00:00Z',
    deleted: false,
    ...overrides,
  };
}

describe('aggregateTeam', () => {
  // Team 100, 3 matches. Hand-computed expectations below.
  const reports: MsrRow[] = [
    row({
      match_key: 'evt_qm1',
      auto_fuel: 10,
      teleop_fuel_active: 20,
      teleop_fuel_inactive: 5,
      endgame_fuel: 3,
      fuel_points: 40,
      fuel_estimate_confidence: 0.9,
      climb_level: 2,
      climb_success: true,
      defense_rating: 3,
    }),
    row({
      match_key: 'evt_qm2',
      auto_fuel: 8,
      teleop_fuel_active: 14,
      teleop_fuel_inactive: 3,
      endgame_fuel: 1,
      fuel_points: 30,
      fuel_estimate_confidence: 0.6,
      climb_level: 3,
      climb_success: false, // attempted level 3 but failed -> 0 climb points
      defense_rating: 1,
      died: true,
    }),
    row({
      match_key: 'evt_qm3',
      auto_fuel: 12,
      teleop_fuel_active: 22,
      teleop_fuel_inactive: 4,
      endgame_fuel: 2,
      fuel_points: 50,
      fuel_estimate_confidence: 0.3,
      climb_level: 1,
      climb_success: true,
      defense_rating: 5,
    }),
  ];

  const agg = aggregateTeam(100, reports);

  it('reports team number and match count', () => {
    expect(agg.teamNumber).toBe(100);
    expect(agg.matchesScouted).toBe(3);
  });

  it('computes per-phase mean fuel', () => {
    expect(agg.meanAutoFuel).toBeCloseTo(10, 10); // (10+8+12)/3
    expect(agg.meanTeleopFuelActive).toBeCloseTo(56 / 3, 10); // (20+14+22)/3
    expect(agg.meanTeleopFuelInactive).toBeCloseTo(4, 10); // (5+3+4)/3
    expect(agg.meanEndgameFuel).toBeCloseTo(2, 10); // (3+1+2)/3
  });

  it('computes meanTotalFuel as mean of per-match total fuel', () => {
    // M1=38, M2=26, M3=40 -> 104/3
    expect(agg.meanTotalFuel).toBeCloseTo(104 / 3, 10);
  });

  it('computes raw mean fuel points and confidence', () => {
    expect(agg.meanFuelPoints).toBeCloseTo(40, 10); // (40+30+50)/3
    expect(agg.meanFuelConfidence).toBeCloseTo(0.6, 10); // (0.9+0.6+0.3)/3
  });

  it('computes climb stats and per-match climb points (success-gated)', () => {
    expect(agg.climbSuccessRate).toBeCloseTo(2 / 3, 10); // M1, M3 succeeded
    expect(agg.avgClimbLevel).toBeCloseTo(2, 10); // (2+3+1)/3
    // SCORING.CLIMB teleop: M1 L2=20 (success), M2 L3=0 (failed), M3 L1=10 (success)
    const expectedClimb =
      (SCORING.CLIMB[2].teleop + 0 + SCORING.CLIMB[1].teleop) / 3;
    expect(agg.meanClimbPoints).toBeCloseTo(expectedClimb, 10);
    expect(agg.meanClimbPoints).toBeCloseTo(10, 10);
  });

  it('computes defense, no-show/died rates and reliability', () => {
    expect(agg.avgDefenseRating).toBeCloseTo(3, 10); // (3+1+5)/3
    expect(agg.noShowRate).toBeCloseTo(0, 10);
    expect(agg.diedRate).toBeCloseTo(1 / 3, 10); // only M2 died
    // reliability = clamp01(1 - (0 + 1/3)) = 2/3
    expect(agg.reliability).toBeCloseTo(2 / 3, 10);
  });

  it('computes scoutingExpectedPoints = meanFuelPoints + meanClimbPoints (RAW)', () => {
    // 40 + 10 = 50 (no confidence down-weight)
    expect(agg.scoutingExpectedPoints).toBeCloseTo(50, 10);
  });
});

describe('aggregateTeam edge cases', () => {
  it('climb_level 0 yields 0 climb points even if climb_success is true', () => {
    const agg = aggregateTeam(7, [
      row({ target_team_number: 7, climb_level: 0, climb_success: true }),
    ]);
    expect(agg.meanClimbPoints).toBeCloseTo(0, 10);
  });

  it('clamps reliability at 0 when no-shows + deaths exceed 1', () => {
    // both no_show and died in the same single match -> 1 - (1 + 1) = -1 -> 0
    const agg = aggregateTeam(7, [
      row({ target_team_number: 7, no_show: true, died: true }),
    ]);
    expect(agg.reliability).toBe(0);
  });

  it('coalesces NULL fuel_estimate_confidence to 0.3 (data-quality flag only)', () => {
    // Legacy rows predate the 0.3 default/backfill; NULL must not zero FUEL.
    // Confidence is now informational only — it never down-weights the points.
    const agg = aggregateTeam(7, [
      row({ target_team_number: 7, fuel_points: 50, fuel_estimate_confidence: null }),
    ]);
    expect(agg.meanFuelConfidence).toBeCloseTo(0.3, 10);
    expect(agg.meanFuelPoints).toBeCloseTo(50, 10); // RAW, not down-weighted to 15
  });
});

describe('aggregateEvent', () => {
  const reports: MsrRow[] = [
    row({ target_team_number: 100, match_key: 'e_qm1', fuel_points: 20, fuel_estimate_confidence: 1 }),
    row({ target_team_number: 100, match_key: 'e_qm2', fuel_points: 40, fuel_estimate_confidence: 1 }),
    row({ target_team_number: 200, match_key: 'e_qm1', fuel_points: 10, fuel_estimate_confidence: 1 }),
    // deleted row for team 200 must be skipped
    row({ target_team_number: 200, match_key: 'e_qm2', fuel_points: 999, fuel_estimate_confidence: 1, deleted: true }),
    // deleted-only team 300 must produce NO entry
    row({ target_team_number: 300, match_key: 'e_qm1', fuel_points: 5, deleted: true }),
  ];

  const byTeam = aggregateEvent(reports);

  it('groups by target_team_number', () => {
    expect(byTeam.get(100)?.matchesScouted).toBe(2);
  });

  it('skips deleted rows when aggregating a team', () => {
    // team 200 has one live + one deleted -> only the live counts
    expect(byTeam.get(200)?.matchesScouted).toBe(1);
    expect(byTeam.get(200)?.meanFuelPoints).toBeCloseTo(10, 10);
  });

  it('creates no entry for teams whose only rows are deleted', () => {
    expect(byTeam.has(300)).toBe(false);
  });

  it('aggregates each team correctly', () => {
    // team 100: meanFuelPoints (20+40)/2 = 30
    expect(byTeam.get(100)?.meanFuelPoints).toBeCloseTo(30, 10);
  });

  it('returns an empty map for an empty input', () => {
    expect(aggregateEvent([]).size).toBe(0);
  });
});

describe('defense analytics', () => {
  // AUTO_MS = 20_000; teleop bursts/intervals are offset by it. To keep windows
  // simple we use auto-window bursts/intervals (no offset) so absolute ms == raw ms.
  const b = (startMs: number, endMs: number, rate: number): BurstRow => ({
    startMs,
    endMs,
    rate,
    window: 'auto',
  });
  const iv = (startMs: number, endMs: number): IntervalRow => ({
    startMs,
    endMs,
    phase: 'auto',
  });

  describe('Metric A — defended fuel suppression', () => {
    it('pools across a team\'s reports (undefended 10, defended 5 → ~0.5)', () => {
      // Each report: a rate-5 burst inside its defended interval + a rate-10 burst outside.
      const reports = [
        row({
          fuel_bursts: [b(0, 1000, 5), b(2000, 3000, 10)],
          defended_intervals: [iv(0, 1000)],
        }),
        row({
          fuel_bursts: [b(0, 1000, 5), b(2000, 3000, 10)],
          defended_intervals: [iv(0, 1000)],
        }),
      ];
      const agg = aggregateTeam(100, reports);
      expect(agg.fuelSuppressionWhileDefended).not.toBeNull();
      expect(agg.fuelSuppressionWhileDefended as number).toBeCloseTo(0.5, 6);
      expect(agg.defendedSampleMs).toBeGreaterThan(0);
    });

    it('null when reports have bursts but no defended intervals', () => {
      const agg = aggregateTeam(100, [row({ fuel_bursts: [b(0, 1000, 10)] })]);
      expect(agg.fuelSuppressionWhileDefended).toBeNull();
      expect(agg.defendedSampleMs).toBe(0);
    });

    it('null when defended the whole match (no baseline bursts)', () => {
      const agg = aggregateTeam(100, [
        row({ fuel_bursts: [b(0, 1000, 6)], defended_intervals: [iv(0, 1000)] }),
      ]);
      expect(agg.fuelSuppressionWhileDefended).toBeNull();
    });

    it('legacy rows (undefined bursts/intervals) → null, no throw', () => {
      const agg = aggregateTeam(100, [row({})]);
      expect(agg.fuelSuppressionWhileDefended).toBeNull();
      expect(agg.defendedSampleMs).toBe(0);
    });
  });

  describe('Metric B — defender effectiveness', () => {
    it('joins opponents in the same match; suppression > 0, sampleCount 1', () => {
      // Red team A plays defense over [0,1000); blue team B shoots rate 4 inside that
      // window and rate 10 outside it → A suppressed B.
      const reports = [
        row({
          target_team_number: 1,
          alliance_color: 'red',
          match_key: '2026x_qm1',
          defense_intervals: [iv(0, 1000)],
        }),
        row({
          target_team_number: 2,
          alliance_color: 'blue',
          match_key: '2026x_qm1',
          fuel_bursts: [b(0, 1000, 4), b(2000, 3000, 10)],
        }),
      ];
      const map = aggregateEvent(reports);
      const a = map.get(1)!;
      expect(a.defenderEffectiveness).not.toBeNull();
      expect(a.defenderEffectiveness as number).toBeGreaterThan(0);
      expect(a.defenseSampleCount).toBe(1);
    });

    it('excludes no_show / died opponents', () => {
      const reports = [
        row({
          target_team_number: 1,
          alliance_color: 'red',
          match_key: '2026x_qm1',
          defense_intervals: [iv(0, 1000)],
        }),
        row({
          target_team_number: 2,
          alliance_color: 'blue',
          match_key: '2026x_qm1',
          died: true,
          fuel_bursts: [b(0, 1000, 4), b(2000, 3000, 10)],
        }),
      ];
      const a = aggregateEvent(reports).get(1)!;
      expect(a.defenderEffectiveness).toBeNull();
      expect(a.defenseSampleCount).toBe(0);
    });

    it('dedupes multi-scout opponent reports (uses the richest)', () => {
      const reports = [
        row({
          target_team_number: 1,
          alliance_color: 'red',
          match_key: '2026x_qm1',
          defense_intervals: [iv(0, 1000)],
        }),
        // Sparse duplicate of opponent 2 (one burst).
        row({
          target_team_number: 2,
          alliance_color: 'blue',
          match_key: '2026x_qm1',
          fuel_bursts: [b(0, 1000, 4)],
        }),
        // Rich duplicate of opponent 2 (more bursts) — should win.
        row({
          target_team_number: 2,
          alliance_color: 'blue',
          match_key: '2026x_qm1',
          fuel_bursts: [b(0, 1000, 4), b(2000, 3000, 10)],
        }),
      ];
      const a = aggregateEvent(reports).get(1)!;
      expect(a.defenseSampleCount).toBe(1); // opponent 2 counted once
      expect(a.defenderEffectiveness as number).toBeGreaterThan(0);
    });

    it('null when the team never played defense', () => {
      const reports = [
        row({ target_team_number: 1, alliance_color: 'red', match_key: '2026x_qm1' }),
        row({
          target_team_number: 2,
          alliance_color: 'blue',
          match_key: '2026x_qm1',
          fuel_bursts: [b(0, 1000, 4)],
        }),
      ];
      const a = aggregateEvent(reports).get(1)!;
      expect(a.defenderEffectiveness).toBeNull();
      expect(a.defenseSampleCount).toBe(0);
    });

    it('stores the raw value at sampleCount 1 (display gating is a UI concern)', () => {
      const reports = [
        row({
          target_team_number: 1,
          alliance_color: 'red',
          match_key: '2026x_qm1',
          defense_intervals: [iv(0, 1000)],
        }),
        row({
          target_team_number: 2,
          alliance_color: 'blue',
          match_key: '2026x_qm1',
          fuel_bursts: [b(0, 1000, 4), b(2000, 3000, 10)],
        }),
      ];
      const a = aggregateEvent(reports).get(1)!;
      expect(a.defenseSampleCount).toBe(1);
      expect(a.defenderEffectiveness).not.toBeNull();
    });
  });

  it('aggregateEvent populates both defense fields on every team', () => {
    const map = aggregateEvent([
      row({ target_team_number: 1, alliance_color: 'red', match_key: '2026x_qm1' }),
      row({ target_team_number: 2, alliance_color: 'blue', match_key: '2026x_qm1' }),
    ]);
    for (const agg of map.values()) {
      expect(agg).toHaveProperty('fuelSuppressionWhileDefended');
      expect(agg).toHaveProperty('defenderEffectiveness');
      expect(agg.defenseSampleCount).toBe(0);
    }
  });
});

describe('distribution + trend', () => {
  it('computes population std-dev + min/max for fuel points', () => {
    // {40,30,20} → mean 30, popVar = (100+0+100)/3 = 66.6…, σ = √66.6… ≈ 8.165.
    const agg = aggregateTeam(100, [
      row({ match_key: 'evt_qm1', fuel_points: 40 }),
      row({ match_key: 'evt_qm2', fuel_points: 30 }),
      row({ match_key: 'evt_qm3', fuel_points: 20 }),
    ]);
    expect(agg.meanFuelPoints).toBeCloseTo(30, 10);
    expect(agg.stdDevFuelPoints).toBeCloseTo(8.165, 2);
    expect(agg.minFuelPoints).toBe(20);
    expect(agg.maxFuelPoints).toBe(40);
  });

  it('single match → zero spread, insufficient trend (NaN recent mean)', () => {
    const agg = aggregateTeam(100, [row({ match_key: 'evt_qm1', fuel_points: 25 })]);
    expect(agg.stdDevFuelPoints).toBe(0);
    expect(agg.minFuelPoints).toBe(25);
    expect(agg.maxFuelPoints).toBe(25);
    expect(agg.recentTrend).toBe('insufficient');
    expect(Number.isNaN(agg.recentFuelMean)).toBe(true);
    expect(agg.recentFuelDelta).toBe(0);
  });

  it('climb-points σ uses climbPointsForMatch (auto bonus independent of teleop)', () => {
    // Re-derive expected per-match climb points the SAME way climbPointsForMatch does,
    // pulling magnitudes from the frozen SCORING.CLIMB so a magnitude change re-derives.
    const climbPts = (r: {
      climb_success: boolean;
      climb_level: 1 | 2 | 3 | 0;
      auto_climb_level1: boolean;
    }): number => {
      let pts = 0;
      if (r.climb_success && r.climb_level !== 0) {
        pts += SCORING.CLIMB[r.climb_level].teleop;
      }
      if (r.auto_climb_level1) pts += SCORING.CLIMB[1].auto;
      return pts;
    };
    const inputs = [
      { climb_success: true, climb_level: 2 as const, auto_climb_level1: false },
      // auto bonus added even though teleop climb FAILED (locks in independence).
      { climb_success: false, climb_level: 3 as const, auto_climb_level1: true },
      { climb_success: true, climb_level: 1 as const, auto_climb_level1: true },
    ];
    const agg = aggregateTeam(
      100,
      inputs.map((c, i) =>
        row({
          match_key: `evt_qm${i + 1}`,
          climb_success: c.climb_success,
          climb_level: c.climb_level,
          auto_climb_level1: c.auto_climb_level1,
        }),
      ),
    );
    const perMatch = inputs.map(climbPts);
    const mean = perMatch.reduce((a, b) => a + b, 0) / perMatch.length;
    const expectedSd = Math.sqrt(
      perMatch.reduce((a, v) => a + (v - mean) ** 2, 0) / perMatch.length,
    );
    expect(agg.meanClimbPoints).toBeCloseTo(mean, 10);
    expect(agg.stdDevClimbPoints).toBeCloseTo(expectedSd, 4);
    expect(agg.minClimbPoints).toBeCloseTo(Math.min(...perMatch), 10);
    expect(agg.maxClimbPoints).toBeCloseTo(Math.max(...perMatch), 10);
  });

  it('trend improving when last-3 mean exceeds all-match mean past threshold', () => {
    // {10,10,30,30,30} → all-mean 22, last-3 mean 30, delta +8.
    const fuel = [10, 10, 30, 30, 30];
    const agg = aggregateTeam(
      100,
      fuel.map((f, i) => row({ match_key: `evt_qm${i + 1}`, fuel_points: f })),
    );
    expect(agg.recentTrend).toBe('improving');
    expect(agg.recentFuelDelta).toBeCloseTo(8, 10);
    expect(agg.recentFuelMean).toBeCloseTo(30, 10);
  });

  it('trend fading when last-3 mean drops below all-match mean past threshold', () => {
    const fuel = [40, 40, 10, 10, 10]; // all-mean 22, last-3 10, delta -12
    const agg = aggregateTeam(
      100,
      fuel.map((f, i) => row({ match_key: `evt_qm${i + 1}`, fuel_points: f })),
    );
    expect(agg.recentTrend).toBe('fading');
    expect(agg.recentFuelDelta).toBeLessThan(-0.5);
  });

  it('trend stable inside threshold', () => {
    const fuel = [20, 20, 20.3, 20, 20]; // |delta| < 0.5
    const agg = aggregateTeam(
      100,
      fuel.map((f, i) => row({ match_key: `evt_qm${i + 1}`, fuel_points: f })),
    );
    expect(agg.recentTrend).toBe('stable');
    expect(Math.abs(agg.recentFuelDelta)).toBeLessThan(0.5);
  });

  it('sorts out-of-order input by play order before slicing the trend window', () => {
    const sorted = [10, 10, 30, 30, 30]; // qm1..qm5 in play order → improving
    const sortedAgg = aggregateTeam(
      100,
      sorted.map((f, i) => row({ match_key: `evt_qm${i + 1}`, fuel_points: f })),
    );
    // Same data, scrambled key order: qm3, qm1, qm5, qm2, qm4.
    const order = [3, 1, 5, 2, 4];
    const scrambledAgg = aggregateTeam(
      100,
      order.map((k) => row({ match_key: `evt_qm${k}`, fuel_points: sorted[k - 1] })),
    );
    expect(scrambledAgg.recentTrend).toBe(sortedAgg.recentTrend);
    expect(scrambledAgg.recentFuelMean).toBeCloseTo(sortedAgg.recentFuelMean, 10);
    expect(scrambledAgg.recentFuelDelta).toBeCloseTo(sortedAgg.recentFuelDelta, 10);
  });
});

// ===========================================================================
// synthesizeMatchupGuidance (matchup-intelligence)
// ===========================================================================
import { synthesizeMatchupGuidance, type TeamAgg } from '@/dash/aggregate';

/** Minimal TeamAgg factory: a scouted team with benign defaults; override per test. */
function ta(over: Partial<TeamAgg> = {}): TeamAgg {
  return {
    teamNumber: 100,
    matchesScouted: 5,
    meanAutoFuel: 0,
    meanTeleopFuelActive: 0,
    meanTeleopFuelInactive: 0,
    meanEndgameFuel: 0,
    meanTotalFuel: 0,
    meanFuelPoints: 40,
    meanFuelConfidence: 1,
    climbSuccessRate: 0.5,
    avgClimbLevel: 1,
    meanClimbPoints: 10,
    avgDefenseRating: 0,
    noShowRate: 0,
    diedRate: 0,
    reliability: 1,
    scoutingExpectedPoints: 50,
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
    recentFuelMean: 40,
    recentFuelDelta: 0,
    recentTrend: 'stable',
    ...over,
  };
}

describe('synthesizeMatchupGuidance', () => {
  it('flags a reliable high climber as a high-severity climb threat', () => {
    const g = synthesizeMatchupGuidance(
      [ta({ teamNumber: 254, climbSuccessRate: 0.8, avgClimbLevel: 2.7 })],
      [],
    );
    const climb = g.red.threats.find((t) => t.kind === 'climb');
    expect(climb).toBeDefined();
    expect(climb!.severity).toBe('high');
    expect(climb!.text).toContain('Contest');
    expect(climb!.text).toContain('254');
    expect(climb!.text).toContain('L3');
  });

  it('flags a fragile robot as a high-severity exploit', () => {
    // noShow 0.3 + died 0.2 => reliability clamp01(1 - 0.5) = 0.5
    const g = synthesizeMatchupGuidance(
      [ta({ teamNumber: 148, noShowRate: 0.3, diedRate: 0.2, reliability: 0.5 })],
      [],
    );
    const fragile = g.red.exploits.find((t) => t.kind === 'fragile');
    expect(fragile).toBeDefined();
    expect(fragile!.severity).toBe('high');
    expect(fragile!.text).toContain('fragile');
    expect(fragile!.text).toContain('50%');
  });

  it('flags a heavy feeder as a feed-lane threat', () => {
    const g = synthesizeMatchupGuidance(
      [ta({ teamNumber: 1678, meanTeleopFuelInactive: 40 })],
      [],
    );
    const feed = g.red.threats.find((t) => t.kind === 'feed');
    expect(feed).toBeDefined();
    expect(feed!.text).toContain('feed lane');
  });

  it('an all-undefined / unscouted alliance is scouted:false with empty lists', () => {
    const g = synthesizeMatchupGuidance(
      [undefined, undefined, ta({ matchesScouted: 0 })],
      [],
    );
    expect(g.red.scouted).toBe(false);
    expect(g.red.threats).toHaveLength(0);
    expect(g.red.exploits).toHaveLength(0);
  });

  it('low-fuel team yields a fuel exploit + a once-per-alliance weak-defense rollup', () => {
    const g = synthesizeMatchupGuidance(
      [
        ta({ teamNumber: 10, meanFuelPoints: 12, avgDefenseRating: 0 }),
        ta({ teamNumber: 20, meanFuelPoints: 12, avgDefenseRating: 0.2 }),
      ],
      [],
    );
    const lowFuel = g.red.exploits.find((t) => t.kind === 'fuel' && t.teamNumber === 10);
    expect(lowFuel).toBeDefined();
    const rollup = g.red.exploits.filter(
      (t) => t.teamNumber === 0 && t.text.includes('Weak defense across'),
    );
    expect(rollup).toHaveLength(1);
  });

  it('caps each list at 4 and sorts high before med', () => {
    // 5 distinct high-severity threats (heavy scorers) across teams -> capped at 4.
    const aggs = [201, 202, 203, 204, 205].map((n) =>
      ta({ teamNumber: n, meanFuelPoints: 100, meanTeleopFuelInactive: 40 }),
    );
    const g = synthesizeMatchupGuidance(aggs, []);
    expect(g.red.threats.length).toBeLessThanOrEqual(4);
    // first item is a high severity
    expect(g.red.threats[0].severity).toBe('high');
    // sorted: all highs precede any med
    const firstMed = g.red.threats.findIndex((t) => t.severity === 'med');
    if (firstMed >= 0) {
      const lastHigh = g.red.threats.reduce(
        (acc, t, i) => (t.severity === 'high' ? i : acc),
        -1,
      );
      expect(lastHigh).toBeLessThan(firstMed);
    }
  });
});

describe('matchScoutCoverage', () => {
  const roster: ScoutLite[] = [
    { id: 'A', display_name: 'Ada' },
    { id: 'B', display_name: 'Bo' },
    { id: 'C', display_name: 'Cy' },
  ];

  it('counts distinct attributed scouts, tracks unattributed, picks newest stamp', () => {
    const reports: MsrRow[] = [
      row({ match_key: 'qm1', scout_id: 'A', station: 1, server_received_at: '2026-06-29T10:00:00Z' }),
      row({ match_key: 'qm1', scout_id: 'B', station: 2, server_received_at: '2026-06-29T11:00:00Z' }),
      row({ match_key: 'qm1', scout_id: null, station: 3, server_received_at: '2026-06-29T09:00:00Z' }),
      // a report on a DIFFERENT match must not bleed in
      row({ match_key: 'qm2', scout_id: 'C', station: 1, server_received_at: '2026-06-29T12:00:00Z' }),
    ];
    const cov = matchScoutCoverage(reports, roster, 'qm1');
    expect(cov.scoutsCovered).toBe(2);
    expect(cov.unattributed).toBe(1);
    expect(cov.reportedScoutIds.sort()).toEqual(['A', 'B']);
    expect(cov.lastReportAt).toBe('2026-06-29T11:00:00Z');
    expect(cov.missingScouts.map((s) => s.id)).toEqual(['C']);
    expect(cov.stationsCovered).toBe(3);
    expect(cov.scoutsTotal).toBe(3);
  });

  it('excludes deleted rows (defensive guard) from count and lastReportAt', () => {
    const reports: MsrRow[] = [
      row({ match_key: 'qm1', scout_id: 'A', station: 1, server_received_at: '2026-06-29T10:00:00Z' }),
      row({
        match_key: 'qm1',
        scout_id: 'B',
        station: 2,
        deleted: true,
        server_received_at: '2026-06-29T13:00:00Z',
      }),
    ];
    const cov = matchScoutCoverage(reports, roster, 'qm1');
    expect(cov.scoutsCovered).toBe(1);
    expect(cov.reportedScoutIds).toEqual(['A']);
    expect(cov.lastReportAt).toBe('2026-06-29T10:00:00Z');
  });

  it('still counts a report with a missing/garbage stamp but never lets it win lastReportAt', () => {
    const reports: MsrRow[] = [
      row({ match_key: 'qm1', scout_id: 'A', station: 1, server_received_at: undefined as unknown as string }),
      row({ match_key: 'qm1', scout_id: 'B', station: 2, server_received_at: 'not-a-date' }),
      row({ match_key: 'qm1', scout_id: 'C', station: 3, server_received_at: '2026-06-29T08:00:00Z' }),
    ];
    const cov = matchScoutCoverage(reports, roster, 'qm1');
    expect(cov.scoutsCovered).toBe(3);
    expect(cov.lastReportAt).toBe('2026-06-29T08:00:00Z');
  });

  it('returns a zeroed coverage for a match with no reports (all scouts missing)', () => {
    const cov = matchScoutCoverage([], roster, 'qm9');
    expect(cov.scoutsCovered).toBe(0);
    expect(cov.lastReportAt).toBeNull();
    expect(cov.missingScouts.map((s) => s.id)).toEqual(['A', 'B', 'C']);
    expect(cov.stationsCovered).toBe(0);
  });

  it('caps stationsCovered at the stationCap', () => {
    const reports: MsrRow[] = [1, 2, 3, 4, 5, 6, 7].map((st, i) =>
      row({ match_key: 'qm1', scout_id: `s${i}`, station: st }),
    );
    expect(matchScoutCoverage(reports, roster, 'qm1').stationsCovered).toBe(6);
  });
});

describe('eventScoutCoverage', () => {
  const roster: ScoutLite[] = [
    { id: 'A', display_name: 'Ada' },
    { id: 'B', display_name: 'Bo' },
  ];

  it('builds a per-match map, the global newest stamp, and the roster size', () => {
    const reports: MsrRow[] = [
      row({ match_key: 'qm1', scout_id: 'A', station: 1, server_received_at: '2026-06-29T10:00:00Z' }),
      row({ match_key: 'qm2', scout_id: 'B', station: 2, server_received_at: '2026-06-29T14:00:00Z' }),
      row({ match_key: 'qm2', scout_id: 'A', station: 1, server_received_at: '2026-06-29T12:00:00Z' }),
    ];
    const ev = eventScoutCoverage(reports, roster);
    expect(ev.scoutsTotal).toBe(2);
    expect(ev.lastReportAt).toBe('2026-06-29T14:00:00Z');
    expect([...ev.coverageByMatch.keys()].sort()).toEqual(['qm1', 'qm2']);
    expect(ev.coverageByMatch.get('qm1')!.scoutsCovered).toBe(1);
    expect(ev.coverageByMatch.get('qm2')!.scoutsCovered).toBe(2);
  });

  it('degrades with an empty roster (scoutsTotal 0, no divide-by-zero, no missing scouts)', () => {
    const reports: MsrRow[] = [row({ match_key: 'qm1', scout_id: 'A', station: 1 })];
    const ev = eventScoutCoverage(reports, []);
    expect(ev.scoutsTotal).toBe(0);
    expect(ev.coverageByMatch.get('qm1')!.missingScouts).toEqual([]);
  });
});
