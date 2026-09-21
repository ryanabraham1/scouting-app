// src/dash/__tests__/tempo.test.ts
// Unit tests for cycle-time / tempo analytics derived from fuel_bursts: bursts
// per match, mean burst duration, inter-burst gap (cycle time), active fraction,
// and graceful handling of legacy rows with no bursts.

import { describe, it, expect } from 'vitest';
import { computeTeamTempo, EMPTY_TEAM_TEMPO } from '@/dash/tempo';
import { AUTO_MS, MATCH_MS } from '@/dash/matchTimeline';
import type { MsrRow, BurstRow } from '@/dash/types';

function row(bursts: BurstRow[] | null | undefined, overrides: Partial<MsrRow> = {}): MsrRow {
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
    fuel_bursts: bursts,
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

/** A teleop burst (window 'shift1') with the given relative start/end (ms). */
function teleopBurst(startMs: number, endMs: number, rate = 2): BurstRow {
  return { startMs, endMs, rate, window: 'shift1' };
}

describe('computeTeamTempo', () => {
  it('returns empty summary with no reports', () => {
    expect(computeTeamTempo([])).toEqual(EMPTY_TEAM_TEMPO);
  });

  it('skips reports with no bursts (sample reflects only burst-bearing rows)', () => {
    const reports = [row(null), row([]), row([teleopBurst(0, 1000)])];
    const t = computeTeamTempo(reports);
    expect(t.reportsWithBursts).toBe(1);
    expect(t.meanBurstsPerMatch).toBe(1);
  });

  it('computes bursts/match, mean duration, and the inter-burst gap', () => {
    // Two bursts: [0,1000] (1s) then [3000,4000] (1s); gap = 3000−1000 = 2000ms.
    const reports = [row([teleopBurst(0, 1000), teleopBurst(3000, 4000)])];
    const t = computeTeamTempo(reports);
    expect(t.reportsWithBursts).toBe(1);
    expect(t.meanBurstsPerMatch).toBe(2);
    expect(t.meanBurstDurationMs).toBe(1000); // (1000 + 1000) / 2 bursts
    expect(t.meanGapMs).toBe(2000);
    // Active = 2000ms of MATCH_MS.
    expect(t.activeFraction).toBeCloseTo(2000 / MATCH_MS, 6);
  });

  it('meanGapMs is null when no match had 2+ bursts', () => {
    const t = computeTeamTempo([row([teleopBurst(0, 1000)])]);
    expect(t.meanGapMs).toBeNull();
  });

  it('orders bursts by absolute start before measuring gaps', () => {
    // Out-of-order input; same two bursts as above → gap still 2000ms.
    const reports = [row([teleopBurst(3000, 4000), teleopBurst(0, 1000)])];
    expect(computeTeamTempo(reports).meanGapMs).toBe(2000);
  });

  it('never produces a negative gap from overlapping bursts', () => {
    const reports = [row([teleopBurst(0, 5000), teleopBurst(1000, 2000)])];
    // Second burst starts inside the first → no positive gap measured.
    expect(computeTeamTempo(reports).meanGapMs).toBeNull();
  });

  it('places auto-window bursts before teleop on the absolute clock', () => {
    // An auto burst [0,1000] then a teleop burst at rel 0 (abs AUTO_MS).
    const autoBurst: BurstRow = { startMs: 0, endMs: 1000, rate: 1, window: 'auto' };
    const reports = [row([autoBurst, teleopBurst(0, 1000)])];
    const t = computeTeamTempo(reports);
    // gap = AUTO_MS − 1000 (teleop abs start − auto burst end).
    expect(t.meanGapMs).toBe(AUTO_MS - 1000);
  });

  it('pools across multiple reports', () => {
    const reports = [
      row([teleopBurst(0, 1000)]),
      row([teleopBurst(0, 2000), teleopBurst(5000, 6000)]),
    ];
    const t = computeTeamTempo(reports);
    expect(t.reportsWithBursts).toBe(2);
    expect(t.meanBurstsPerMatch).toBe(1.5); // (1 + 2) / 2
    // durations: 1000, 2000, 1000 over 3 bursts → 4000/3.
    expect(t.meanBurstDurationMs).toBeCloseTo(4000 / 3, 6);
  });
});
