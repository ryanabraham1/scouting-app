// src/dash/__tests__/scouterAccuracy.test.ts
// Unit tests for the scouter-load-accuracy aggregation (scouter load +
// agreement-vs-consensus accuracy). Pure functions; no network, no DOM.
import { describe, it, expect } from 'vitest';
import {
  aggregateScouterLoad,
  aggregateScouterAccuracy,
  mergeAccuracy,
  mode,
} from '@/dash/aggregate';
import type { MsrRow } from '@/dash/types';

let seq = 0;

/** Minimal MsrRow factory — only the fields the load/accuracy fns read. */
function makeRow(over: Partial<MsrRow> = {}): MsrRow {
  seq += 1;
  return {
    target_team_number: 100,
    match_key: 'qm1',
    alliance_color: 'red',
    station: 1,
    auto_fuel: 0,
    teleop_fuel_active: 0,
    teleop_fuel_inactive: 0,
    endgame_fuel: 0,
    fuel_points: 0,
    fuel_estimate_confidence: 1,
    fuel_by_shift: [],
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
    scout_id: 's1',
    notes: null,
    server_received_at: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    deleted: false,
    ...over,
  };
}

describe('aggregateScouterLoad', () => {
  it('counts reports, distinct matches, distinct teams per scout_id', () => {
    const reports = [
      makeRow({ scout_id: 'a', match_key: 'qm1', target_team_number: 1 }),
      makeRow({ scout_id: 'a', match_key: 'qm1', target_team_number: 2 }),
      makeRow({ scout_id: 'a', match_key: 'qm2', target_team_number: 1 }),
      makeRow({ scout_id: 'b', match_key: 'qm1', target_team_number: 3 }),
    ];
    const stats = aggregateScouterLoad(reports);
    const a = stats.byScout.get('a')!;
    expect(a.reportCount).toBe(3);
    expect(a.matches).toBe(2); // qm1, qm2
    expect(a.teams).toBe(2); // 1, 2
    const b = stats.byScout.get('b')!;
    expect(b.reportCount).toBe(1);
    expect(b.matches).toBe(1);
    expect(b.teams).toBe(1);
  });

  it('excludes deleted rows and null scout_id rows', () => {
    const reports = [
      makeRow({ scout_id: 'a' }),
      makeRow({ scout_id: 'a', deleted: true }),
      makeRow({ scout_id: null }),
    ];
    const stats = aggregateScouterLoad(reports);
    expect(stats.byScout.get('a')!.reportCount).toBe(1);
    expect(stats.byScout.has('null' as never)).toBe(false);
    expect(stats.totalReports).toBe(1);
    expect(stats.activeScouts).toBe(1);
  });

  it('computes meanLoad/maxLoad/activeScouts', () => {
    const reports = [
      makeRow({ scout_id: 'a', target_team_number: 1 }),
      makeRow({ scout_id: 'a', target_team_number: 2 }),
      makeRow({ scout_id: 'a', target_team_number: 3 }),
      makeRow({ scout_id: 'b', target_team_number: 4 }),
    ];
    const stats = aggregateScouterLoad(reports);
    expect(stats.totalReports).toBe(4);
    expect(stats.activeScouts).toBe(2);
    expect(stats.meanLoad).toBe(2); // 4 / 2
    expect(stats.maxLoad).toBe(3);
  });

  it('empty input → all zeros, no NaN', () => {
    const stats = aggregateScouterLoad([]);
    expect(stats.totalReports).toBe(0);
    expect(stats.activeScouts).toBe(0);
    expect(stats.meanLoad).toBe(0);
    expect(stats.maxLoad).toBe(0);
    expect(Number.isNaN(stats.meanLoad)).toBe(false);
    expect(stats.byScout.size).toBe(0);
  });
});

describe('aggregateScouterAccuracy', () => {
  it('overlap detection: two scouts on same (match,team) overlap; solo does not', () => {
    const reports = [
      makeRow({ scout_id: 'a', match_key: 'qm1', target_team_number: 1 }),
      makeRow({ scout_id: 'b', match_key: 'qm1', target_team_number: 1 }),
      makeRow({ scout_id: 'c', match_key: 'qm2', target_team_number: 9 }), // solo
    ];
    const acc = aggregateScouterAccuracy(reports);
    expect(acc.get('a')!.overlaps).toBe(1);
    expect(acc.get('b')!.overlaps).toBe(1);
    expect(acc.has('c')).toBe(false); // solo contributes 0 overlaps → not present
  });

  it('fuel agreement: within max(5, 10%) agrees, outside disagrees', () => {
    // consensus mean of [100, 104, 130] = 111.33; tol = max(5, 11.13) = 11.13
    const reports = [
      makeRow({ scout_id: 'a', match_key: 'qm1', target_team_number: 1, fuel_points: 100 }),
      makeRow({ scout_id: 'b', match_key: 'qm1', target_team_number: 1, fuel_points: 104 }),
      makeRow({ scout_id: 'c', match_key: 'qm1', target_team_number: 1, fuel_points: 130 }),
    ];
    const acc = aggregateScouterAccuracy(reports);
    // 100: |100-111.33|=11.33 > 11.13 → disagree
    expect(acc.get('a')!.fuelAgreeRate).toBe(0);
    // 104: |104-111.33|=7.33 <= 11.13 → agree
    expect(acc.get('b')!.fuelAgreeRate).toBe(1);
    // 130: |130-111.33|=18.67 > 11.13 → disagree
    expect(acc.get('c')!.fuelAgreeRate).toBe(0);
  });

  it('fuel agreement: absolute floor of 5 applies for small means', () => {
    // consensus mean of [2, 4, 12] = 6; tol = max(5, 0.6) = 5
    const reports = [
      makeRow({ scout_id: 'a', match_key: 'qm1', target_team_number: 1, fuel_points: 2 }),
      makeRow({ scout_id: 'b', match_key: 'qm1', target_team_number: 1, fuel_points: 4 }),
      makeRow({ scout_id: 'c', match_key: 'qm1', target_team_number: 1, fuel_points: 12 }),
    ];
    const acc = aggregateScouterAccuracy(reports);
    expect(acc.get('a')!.fuelAgreeRate).toBe(1); // |2-6|=4 <= 5
    expect(acc.get('b')!.fuelAgreeRate).toBe(1); // |4-6|=2 <= 5
    expect(acc.get('c')!.fuelAgreeRate).toBe(0); // |12-6|=6 > 5
  });

  it('climb mode: two say (success,L2), one (fail,L0) → consensus 1:2', () => {
    const reports = [
      makeRow({ scout_id: 'a', match_key: 'qm1', target_team_number: 1, climb_success: true, climb_level: 2 }),
      makeRow({ scout_id: 'b', match_key: 'qm1', target_team_number: 1, climb_success: true, climb_level: 2 }),
      makeRow({ scout_id: 'c', match_key: 'qm1', target_team_number: 1, climb_success: false, climb_level: 0 }),
    ];
    const acc = aggregateScouterAccuracy(reports);
    expect(acc.get('a')!.climbAgreeRate).toBe(1);
    expect(acc.get('b')!.climbAgreeRate).toBe(1);
    expect(acc.get('c')!.climbAgreeRate).toBe(0);
  });

  it('defense ±1: unrated 0 is excluded; 1/1/2 agree with mode 1 and 3 disagrees', () => {
    const reports = [
      makeRow({ scout_id: 'a', match_key: 'qm1', target_team_number: 1, defense_rating: 0 }),
      makeRow({ scout_id: 'b', match_key: 'qm1', target_team_number: 1, defense_rating: 1 }),
      makeRow({ scout_id: 'c', match_key: 'qm1', target_team_number: 1, defense_rating: 1 }),
      makeRow({ scout_id: 'd', match_key: 'qm1', target_team_number: 1, defense_rating: 2 }),
      makeRow({ scout_id: 'e', match_key: 'qm1', target_team_number: 1, defense_rating: 3 }),
    ];
    const acc = aggregateScouterAccuracy(reports);
    expect(acc.get('a')!.defenseAgreeRate).toBeNull();
    expect(acc.get('b')!.defenseAgreeRate).toBe(1);
    expect(acc.get('c')!.defenseAgreeRate).toBe(1);
    expect(acc.get('d')!.defenseAgreeRate).toBe(1); // |2-1|=1
    expect(acc.get('e')!.defenseAgreeRate).toBe(0); // |3-1|=2 > 1
  });

  it('provisional flag: overlaps < 3 provisional; >= 3 not', () => {
    // scout 'a' overlaps once (1 group) → provisional
    const oneOverlap = [
      makeRow({ scout_id: 'a', match_key: 'qm1', target_team_number: 1 }),
      makeRow({ scout_id: 'b', match_key: 'qm1', target_team_number: 1 }),
    ];
    expect(aggregateScouterAccuracy(oneOverlap).get('a')!.provisional).toBe(true);

    // scout 'a' overlaps in 3 distinct groups → not provisional
    const threeOverlaps: MsrRow[] = [];
    for (let i = 1; i <= 3; i++) {
      threeOverlaps.push(
        makeRow({ scout_id: 'a', match_key: `qm${i}`, target_team_number: 1 }),
        makeRow({ scout_id: 'b', match_key: `qm${i}`, target_team_number: 1 }),
      );
    }
    const acc = aggregateScouterAccuracy(threeOverlaps);
    expect(acc.get('a')!.overlaps).toBe(3);
    expect(acc.get('a')!.provisional).toBe(false);
  });

  it('no_show/died excluded from fuel/climb eligibility but not defense', () => {
    // Two scouts: 'a' reports normally, 'b' is a no-show on the same robot.
    const reports = [
      makeRow({
        scout_id: 'a',
        match_key: 'qm1',
        target_team_number: 1,
        fuel_points: 50,
        climb_success: true,
        climb_level: 1,
        defense_rating: 2,
      }),
      makeRow({
        scout_id: 'b',
        match_key: 'qm1',
        target_team_number: 1,
        no_show: true,
        fuel_points: 0,
        climb_success: false,
        climb_level: 0,
        defense_rating: 2,
      }),
    ];
    const acc = aggregateScouterAccuracy(reports);
    const b = acc.get('b')!;
    expect(b.overlaps).toBe(1);
    expect(b.fuelElig).toBe(0); // excluded from fuel
    expect(b.fuelAgreeRate).toBeNull();
    expect(b.climbElig).toBe(0); // excluded from climb
    expect(b.climbAgreeRate).toBeNull();
    expect(b.defenseElig).toBe(1); // still defense-eligible
    expect(b.defenseAgreeRate).toBe(1); // both rated 2 → consensus 2, agrees
    // 'a' fuel consensus is over only the one scored report → mean 50, agrees
    const a = acc.get('a')!;
    expect(a.fuelAgreeRate).toBe(1);
    expect(a.climbAgreeRate).toBe(1);
  });

  it('all-eligible-but-undefined fuel/climb (both no_show) → those rates null, no throw', () => {
    const reports = [
      makeRow({ scout_id: 'a', match_key: 'qm1', target_team_number: 1, no_show: true, defense_rating: 1 }),
      makeRow({ scout_id: 'b', match_key: 'qm1', target_team_number: 1, no_show: true, defense_rating: 1 }),
    ];
    const acc = aggregateScouterAccuracy(reports);
    const a = acc.get('a')!;
    expect(a.fuelAgreeRate).toBeNull();
    expect(a.climbAgreeRate).toBeNull();
    expect(a.defenseAgreeRate).toBe(1);
    // overall = mean of only the defense signal
    expect(a.overallAgreeRate).toBe(1);
  });

  it('all signals null → overallAgreeRate null', () => {
    // Construct a single ScouterAccuracyAgg-equivalent via merge of an all-null agg.
    const agg = {
      scoutId: 'x',
      overlaps: 1,
      fuelAgree: 0,
      fuelElig: 0,
      climbAgree: 0,
      climbElig: 0,
      defenseAgree: 0,
      defenseElig: 0,
      fuelAgreeRate: null,
      climbAgreeRate: null,
      defenseAgreeRate: null,
      overallAgreeRate: null,
      provisional: true,
    };
    const merged = mergeAccuracy([agg])!;
    expect(merged.overallAgreeRate).toBeNull();
  });
});

describe('mode', () => {
  it('returns most frequent value', () => {
    expect(mode([1, 2, 2, 3])).toBe(2);
  });
  it('ties resolve to the smallest value', () => {
    expect(mode([3, 3, 1, 1])).toBe(1);
    expect(mode([2, 2, 0, 0])).toBe(0);
  });
  it('empty input → null', () => {
    expect(mode([])).toBeNull();
  });
});

describe('mergeAccuracy', () => {
  it('sums counters and re-derives rate (NOT average of two rates)', () => {
    const a = {
      scoutId: 's1',
      overlaps: 2,
      fuelAgree: 1,
      fuelElig: 2,
      climbAgree: 0,
      climbElig: 0,
      defenseAgree: 0,
      defenseElig: 0,
      fuelAgreeRate: 0.5,
      climbAgreeRate: null,
      defenseAgreeRate: null,
      overallAgreeRate: 0.5,
      provisional: true,
    };
    const b = {
      scoutId: 's2',
      overlaps: 3,
      fuelAgree: 2,
      fuelElig: 3,
      climbAgree: 0,
      climbElig: 0,
      defenseAgree: 0,
      defenseElig: 0,
      fuelAgreeRate: 2 / 3,
      climbAgreeRate: null,
      defenseAgreeRate: null,
      overallAgreeRate: 2 / 3,
      provisional: false,
    };
    const merged = mergeAccuracy([a, b])!;
    // summed: 3/5 = 0.6, NOT (0.5 + 0.667)/2
    expect(merged.fuelAgreeRate).toBe(3 / 5);
    expect(merged.overlaps).toBe(5);
    expect(merged.provisional).toBe(false); // 5 >= 3
  });

  it('empty array → null', () => {
    expect(mergeAccuracy([])).toBeNull();
  });
});
