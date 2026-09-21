// src/dash/__tests__/validateVsTba.test.ts
// Unit tests for the scout-vs-official-TBA cross-check: per-alliance offense
// summation (fuel), dedupe-by-station, tolerance bands, and severity
// tiers (match / minor / severe / incomplete / unscouted / unscored).

import { describe, it, expect } from 'vitest';
import {
  validateMatchVsTba,
  checkAlliance,
  validationLabel,
  TBA_VALIDATE_ABS_TOL,
  TBA_VALIDATE_SEVERE_REL,
} from '@/dash/validateVsTba';
import type { MsrRow } from '@/dash/types';

/** Minimal MsrRow factory (mirrors reconcile.test.ts). */
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
    auto_left_starting_line: false,
    defense_rating: 0,
    pins: 0,
    no_show: false,
    died: false,
    tipped: false,
    dropped_fuel: false,
    fed_corral: false,
    auto_start_position: null,
    auto_path: null,
    scout_id: null,
    notes: null,
    server_received_at: '2026-06-23T00:00:00Z',
    deleted: false,
    ...overrides,
  };
}

/** A full red alliance whose scouted offense sums to `perRobot * 3` fuel points. */
function fullAlliance(color: 'red' | 'blue', perRobot: number): MsrRow[] {
  return [1, 2, 3].map((station) =>
    row({ alliance_color: color, station, fuel_points: perRobot }),
  );
}

describe('checkAlliance — offense summation', () => {
  it('sums fuel_points across deduped robots', () => {
    const reports = [
      row({ station: 1, fuel_points: 40 }),
      row({ station: 2, fuel_points: 30 }),
      row({ station: 3, fuel_points: 20 }),
    ];
    const check = checkAlliance('red', reports, 200);
    expect(check.scoutedRobots).toBe(3);
    expect(check.scoutedOffensePoints).toBe(40 + 30 + 20);
  });

  it('keeps the latest report per station (no double-count on multi-scout)', () => {
    const reports = [
      row({ station: 1, fuel_points: 40, server_received_at: '2026-06-23T00:00:00Z' }),
      row({ station: 1, fuel_points: 50, server_received_at: '2026-06-23T01:00:00Z' }),
    ];
    const check = checkAlliance('red', reports, 50);
    expect(check.scoutedRobots).toBe(1); // one robot, deduped
    expect(check.scoutedOffensePoints).toBe(50); // the later report wins
  });

  it('ignores deleted rows', () => {
    const reports = [
      row({ station: 1, fuel_points: 40 }),
      row({ station: 2, fuel_points: 999, deleted: true }),
    ];
    const check = checkAlliance('red', reports, 40);
    expect(check.scoutedRobots).toBe(1);
    expect(check.scoutedOffensePoints).toBe(40);
  });
});

describe('checkAlliance — severity tiers', () => {
  it('match when within the absolute tolerance band', () => {
    // 3 robots × 60 = 180 scouted vs 185 official → |−5| ≤ 12 abs tol.
    const check = checkAlliance('red', fullAlliance('red', 60), 185);
    expect(check.severity).toBe('match');
    expect(check.delta).toBe(-5);
  });

  it('minor when outside tolerance but below severe', () => {
    // 180 scouted vs 210 official → −30; tol = max(12, 0.15·210=31.5)=31.5.
    // |−30| < 31.5 → actually within tol → match. Bump official to 220:
    // tol = max(12, 33) = 33; severe at 0.30·220 = 66. delta = 180−220 = −40.
    const check = checkAlliance('red', fullAlliance('red', 60), 220);
    expect(check.severity).toBe('minor');
  });

  it('severe when the gap reaches the severe fraction of official', () => {
    // 90 scouted vs 300 official → −210; 0.30·300 = 90 → |−210| ≥ 90 → severe.
    const check = checkAlliance('red', fullAlliance('red', 30), 300);
    expect(check.severity).toBe('severe');
    expect(Math.abs(check.delta as number)).toBeGreaterThanOrEqual(
      TBA_VALIDATE_SEVERE_REL * 300,
    );
  });

  it('incomplete when fewer than 3 robots scouted (not graded a conflict)', () => {
    const reports = [row({ station: 1, fuel_points: 40 })];
    const check = checkAlliance('red', reports, 200);
    expect(check.severity).toBe('incomplete');
    expect(check.delta).toBe(40 - 200); // still reported
  });

  it('unscouted when no reports for the alliance', () => {
    const check = checkAlliance('red', [], 200);
    expect(check.severity).toBe('unscouted');
    expect(check.delta).toBeNull();
  });

  it('unscored when the match is not played', () => {
    const check = checkAlliance('red', fullAlliance('red', 60), null);
    expect(check.severity).toBe('unscored');
    expect(check.officialScore).toBeNull();
  });

  it('uses the absolute floor for low official scores', () => {
    // official 20 → tol = max(12, 3) = 12. 3×10 = 30 scouted, delta +10 ≤ 12 → match.
    const check = checkAlliance('red', fullAlliance('red', 10), 20);
    expect(check.tolerance).toBe(TBA_VALIDATE_ABS_TOL);
    expect(check.severity).toBe('match');
  });
});

describe('validateMatchVsTba', () => {
  it('splits reports by alliance and reports the worst tier', () => {
    const reports = [
      ...fullAlliance('red', 60), // vs 185 → match
      ...fullAlliance('blue', 30), // vs 300 → severe
    ];
    const v = validateMatchVsTba('evt_qm1', reports, 185, 300);
    expect(v.red.severity).toBe('match');
    expect(v.blue.severity).toBe('severe');
    expect(v.worst).toBe('severe');
    expect(v.hasComparable).toBe(true);
  });

  it('hasComparable is false when neither alliance is gradable', () => {
    const v = validateMatchVsTba('evt_qm1', [], null, null);
    expect(v.worst).toBe('unscored');
    expect(v.hasComparable).toBe(false);
  });
});

describe('validationLabel', () => {
  it('returns a label for every tier', () => {
    for (const s of ['severe', 'minor', 'match', 'incomplete', 'unscouted', 'unscored'] as const) {
      expect(validationLabel(s)).toBeTruthy();
    }
  });
});
