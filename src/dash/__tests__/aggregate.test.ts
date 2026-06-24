// src/dash/__tests__/aggregate.test.ts
import { aggregateTeam, aggregateEvent } from '@/dash/aggregate';
import type { MsrRow } from '@/dash/types';
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

  it('down-weights fuel points by mean confidence', () => {
    // fuelPointsWeighted = meanFuelPoints * meanFuelConfidence = 40 * 0.6
    expect(agg.fuelPointsWeighted).toBeCloseTo(24, 10);
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

  it('computes scoutingExpectedPoints = fuelPointsWeighted + meanClimbPoints', () => {
    // 24 + 10 = 34
    expect(agg.scoutingExpectedPoints).toBeCloseTo(34, 10);
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

  it('single perfect-confidence match has fuelPointsWeighted == meanFuelPoints', () => {
    const agg = aggregateTeam(7, [
      row({ target_team_number: 7, fuel_points: 42, fuel_estimate_confidence: 1 }),
    ]);
    expect(agg.fuelPointsWeighted).toBeCloseTo(42, 10);
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
    // team 100: meanFuelPoints (20+40)/2 = 30, confidence 1 -> weighted 30
    expect(byTeam.get(100)?.fuelPointsWeighted).toBeCloseTo(30, 10);
  });

  it('returns an empty map for an empty input', () => {
    expect(aggregateEvent([]).size).toBe(0);
  });
});
