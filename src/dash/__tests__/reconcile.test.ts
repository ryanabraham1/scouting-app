// src/dash/__tests__/reconcile.test.ts
// Unit tests for the multi-scout reconciliation detector: grouping + dedupe,
// severity classification (incl. agree vs unknown), divergence math, null
// guards, and the fuel_points comparand pin.

import { describe, it, expect } from 'vitest';
import {
  detectMultiScoutReports,
  classifySeverity,
  computeDivergences,
  formatDivergences,
  FUEL_MINOR_PTS,
  FUEL_SEVERE_PTS,
  DEFENSE_SEVERE,
} from '@/dash/reconcile';
import type { MsrRow } from '@/dash/types';

/** Minimal MsrRow factory (mirrors aggregate.test.ts). */
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
    scout_id: null,
    notes: null,
    server_received_at: '2026-06-23T00:00:00Z',
    deleted: false,
    ...overrides,
  };
}

const ROBOT = { match_key: 'evt_qm1', target_team_number: 1678, alliance_color: 'blue' as const, station: 2 };

describe('detectMultiScoutReports — grouping', () => {
  it('returns [] when no robot is covered by 2+ distinct scouts', () => {
    const reports = [
      row({ ...ROBOT, station: 1, scout_id: 'a' }),
      row({ ...ROBOT, station: 2, scout_id: 'b' }), // different robot
    ];
    expect(detectMultiScoutReports(reports)).toEqual([]);
  });

  it('dedupes two active rows from the SAME scout (outbox artifact, not a conflict)', () => {
    const reports = [
      row({ ...ROBOT, scout_id: 'a', fuel_points: 4, server_received_at: '2026-06-23T00:00:00Z' }),
      row({ ...ROBOT, scout_id: 'a', fuel_points: 14, server_received_at: '2026-06-23T01:00:00Z' }),
    ];
    expect(detectMultiScoutReports(reports)).toEqual([]);
  });

  it('keeps the latest row per scout when deduping', () => {
    const reports = [
      row({ ...ROBOT, scout_id: 'a', fuel_points: 4, server_received_at: '2026-06-23T00:00:00Z' }),
      row({ ...ROBOT, scout_id: 'a', fuel_points: 99, server_received_at: '2026-06-23T05:00:00Z' }),
      row({ ...ROBOT, scout_id: 'b', fuel_points: 4 }),
    ];
    const groups = detectMultiScoutReports(reports);
    expect(groups).toHaveLength(1);
    // The latest 'a' row (99) is the one compared, so fuel diverges from b (4).
    const fuels = groups[0].reports.map((r) => r.fuel_points).sort((x, y) => x - y);
    expect(fuels).toEqual([4, 99]);
  });
});

describe('detectMultiScoutReports — severity', () => {
  it('two scouts agree → one group, severity agree, not conflicted', () => {
    const reports = [
      row({ ...ROBOT, scout_id: 'a', fuel_points: 12, climb_success: true, climb_level: 2, defense_rating: 1 }),
      row({ ...ROBOT, scout_id: 'b', fuel_points: 12, climb_success: true, climb_level: 2, defense_rating: 1 }),
    ];
    const groups = detectMultiScoutReports(reports);
    expect(groups).toHaveLength(1);
    expect(groups[0].severity).toBe('agree');
    expect(groups[0].isConflicted).toBe(false);
    expect(groups[0].teamNumber).toBe(1678);
    expect(groups[0].station).toBe(2);
    expect(groups[0].allianceColor).toBe('blue');
  });

  it('minor fuel divergence straddling the thresholds → minor', () => {
    // spread = 5: >= FUEL_MINOR_PTS (3) but < FUEL_SEVERE_PTS (8).
    expect(FUEL_MINOR_PTS).toBeLessThan(5);
    expect(5).toBeLessThan(FUEL_SEVERE_PTS);
    const reports = [
      row({ ...ROBOT, scout_id: 'a', fuel_points: 10 }),
      row({ ...ROBOT, scout_id: 'b', fuel_points: 15 }),
    ];
    const groups = detectMultiScoutReports(reports);
    expect(groups[0].severity).toBe('minor');
    expect(groups[0].isConflicted).toBe(true);
  });

  it('severe fuel divergence (spread >= FUEL_SEVERE_PTS) → severe', () => {
    const reports = [
      row({ ...ROBOT, scout_id: 'a', fuel_points: 4 }),
      row({ ...ROBOT, scout_id: 'b', fuel_points: 14 }),
    ];
    expect(detectMultiScoutReports(reports)[0].severity).toBe('severe');
  });

  it('climb success disagreement → severe', () => {
    const reports = [
      row({ ...ROBOT, scout_id: 'a', climb_success: true, climb_level: 3, fuel_points: 10 }),
      row({ ...ROBOT, scout_id: 'b', climb_success: false, climb_level: 0, fuel_points: 10 }),
    ];
    const g = detectMultiScoutReports(reports)[0];
    expect(g.divergences.climb_success_divergent).toBe(true);
    expect(g.severity).toBe('severe');
  });

  it('no-show disagreement → severe', () => {
    const reports = [
      row({ ...ROBOT, scout_id: 'a', no_show: true, fuel_points: 0 }),
      row({ ...ROBOT, scout_id: 'b', no_show: false, fuel_points: 0 }),
    ];
    expect(detectMultiScoutReports(reports)[0].severity).toBe('severe');
  });

  it('three scouts → group of 3, spread uses max−min across all', () => {
    const reports = [
      row({ ...ROBOT, scout_id: 'a', fuel_points: 4 }),
      row({ ...ROBOT, scout_id: 'b', fuel_points: 9 }),
      row({ ...ROBOT, scout_id: 'c', fuel_points: 16 }),
    ];
    const g = detectMultiScoutReports(reports)[0];
    expect(g.reports).toHaveLength(3);
    expect(g.divergences.fuel_spread).toBe(12);
    expect(g.severity).toBe('severe');
  });
});

describe('detectMultiScoutReports — null guards & comparand', () => {
  it('null/missing optional columns never manufacture a spurious conflict', () => {
    const reports = [
      row({ ...ROBOT, scout_id: 'a', fuel_points: 10, fuel_estimate_confidence: 0.9 }),
      row({
        ...ROBOT,
        scout_id: 'b',
        fuel_points: 10,
        fuel_estimate_confidence: null,
        fuel_bursts: null,
        defended_intervals: null,
      }),
    ];
    expect(() => detectMultiScoutReports(reports)).not.toThrow();
    expect(detectMultiScoutReports(reports)[0].severity).toBe('agree');
  });

  it('all-null numeric overlap with no boolean divergence → unknown (false-negative guard)', () => {
    // fuel_points null on both, climb both unsuccessful (no level overlap),
    // defense_rating null on at least one side, no flag disagreement.
    const reports = [
      row({ ...ROBOT, scout_id: 'a', fuel_points: null as unknown as number, defense_rating: null as unknown as number }),
      row({ ...ROBOT, scout_id: 'b', fuel_points: null as unknown as number, defense_rating: null as unknown as number }),
    ];
    const g = detectMultiScoutReports(reports)[0];
    expect(g.severity).toBe('unknown');
    expect(g.isConflicted).toBe(false);
    expect(g.divergences.comparable_metric_count).toBeLessThanOrEqual(3);
  });

  it('pins fuel_points (NOT raw inputs) as the fuel comparand', () => {
    // Identical raw inputs but divergent server fuel_points → fires on fuel_points.
    const reports = [
      row({
        ...ROBOT,
        scout_id: 'a',
        auto_fuel: 5,
        teleop_fuel_active: 5,
        teleop_fuel_inactive: 0,
        endgame_fuel: 0,
        fuel_points: 8,
      }),
      row({
        ...ROBOT,
        scout_id: 'b',
        auto_fuel: 5,
        teleop_fuel_active: 5,
        teleop_fuel_inactive: 0,
        endgame_fuel: 0,
        fuel_points: 16,
      }),
    ];
    const g = detectMultiScoutReports(reports)[0];
    expect(g.divergences.fuel_spread).toBe(8);
    expect(g.severity).toBe('severe');
  });

  it('excludes deleted rows from forming/joining a group', () => {
    const reports = [
      row({ ...ROBOT, scout_id: 'a', fuel_points: 4 }),
      row({ ...ROBOT, scout_id: 'b', fuel_points: 14, deleted: true }),
    ];
    expect(detectMultiScoutReports(reports)).toEqual([]);
  });
});

describe('classifySeverity — threshold branches', () => {
  it('exports the threshold constants', () => {
    expect(FUEL_MINOR_PTS).toBe(3);
    expect(FUEL_SEVERE_PTS).toBe(8);
    expect(DEFENSE_SEVERE).toBe(3);
  });

  it('defense spread >= DEFENSE_SEVERE → severe', () => {
    const d = computeDivergences([
      row({ ...ROBOT, scout_id: 'a', defense_rating: 0 }),
      row({ ...ROBOT, scout_id: 'b', defense_rating: 3 }),
    ]);
    expect(d.defense_spread).toBe(3);
    expect(classifySeverity(d)).toBe('severe');
  });

  it('defense spread of 1 (below severe) → minor', () => {
    const d = computeDivergences([
      row({ ...ROBOT, scout_id: 'a', defense_rating: 1 }),
      row({ ...ROBOT, scout_id: 'b', defense_rating: 2 }),
    ]);
    expect(classifySeverity(d)).toBe('minor');
  });

  it('tipped disagreement alone → minor', () => {
    const d = computeDivergences([
      row({ ...ROBOT, scout_id: 'a', tipped: true, fuel_points: 10 }),
      row({ ...ROBOT, scout_id: 'b', tipped: false, fuel_points: 10 }),
    ]);
    expect(d.tipped_divergent).toBe(true);
    expect(classifySeverity(d)).toBe('minor');
  });
});

describe('formatDivergences', () => {
  it('emits real-value lines for the divergent metrics', () => {
    const g = detectMultiScoutReports([
      row({ ...ROBOT, scout_id: 'a', fuel_points: 14, climb_success: true, climb_level: 3, defense_rating: 4, no_show: false }),
      row({ ...ROBOT, scout_id: 'b', fuel_points: 8, climb_success: false, climb_level: 0, defense_rating: 1, no_show: true }),
    ])[0];
    const lines = formatDivergences(g);
    expect(lines).toContain('Fuel: 14 vs 8 pts');
    expect(lines.some((l) => l.startsWith('Climb:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Defense:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('No-show:'))).toBe(true);
  });

  it('emits a neutral line for an agree group', () => {
    const g = detectMultiScoutReports([
      row({ ...ROBOT, scout_id: 'a', fuel_points: 10 }),
      row({ ...ROBOT, scout_id: 'b', fuel_points: 10 }),
    ])[0];
    expect(formatDivergences(g)[0]).toMatch(/agree/i);
  });
});
