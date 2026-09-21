import { describe, it, expect } from 'vitest';
import { buildTimeline, hasTimeline, fractionOfMatch, MATCH_MS, AUTO_MS } from '../matchTimeline';
import type { MsrRow } from '../types';

function row(partial: Partial<MsrRow>): MsrRow {
  return {
    target_team_number: 254,
    match_key: '2026casnv_qm1',
    alliance_color: 'red',
    station: 1,
    auto_fuel: 0,
    teleop_fuel_active: 0,
    teleop_fuel_inactive: 0,
    endgame_fuel: 0,
    fuel_points: 0,
    fuel_estimate_confidence: null,
    fuel_by_shift: [],
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
    server_received_at: '',
    deleted: false,
    ...partial,
  };
}

describe('buildTimeline', () => {
  it('returns [] for a report with no timestamped data', () => {
    expect(buildTimeline(row({}))).toEqual([]);
    expect(hasTimeline(row({}))).toBe(false);
  });

  it('places an auto burst in the auto window and a teleop burst after AUTO_MS', () => {
    const segs = buildTimeline(
      row({
        fuel_bursts: [
          { startMs: 2000, endMs: 5000, rate: 4, window: 'auto' },
          { startMs: 10000, endMs: 13000, rate: 6, window: 'shift1' },
        ],
      }),
    );
    expect(segs).toHaveLength(2);
    // auto burst stays at its raw ms
    expect(segs[0]).toMatchObject({ kind: 'shoot', startMs: 2000, endMs: 5000, rate: 4 });
    // teleop burst is offset by AUTO_MS
    expect(segs[1]).toMatchObject({ kind: 'shoot', startMs: AUTO_MS + 10000, rate: 6 });
  });

  it('maps feeding, defense, and defended onto the same absolute timeline, sorted', () => {
    const segs = buildTimeline(
      row({
        feeding_bursts: [{ startMs: 40000, endMs: 45000, rate: 3, window: 'shift2' }],
        defended_intervals: [{ startMs: 1000, endMs: 4000, phase: 'teleop' }],
        defense_intervals: [{ startMs: 500, endMs: 1500, phase: 'auto' }],
      }),
    );
    expect(segs.map((s) => s.kind)).toEqual(['defense', 'defended', 'feed']);
    // defense was in auto → not offset
    expect(segs[0]).toMatchObject({ kind: 'defense', startMs: 500, endMs: 1500 });
    // defended was in teleop → offset by AUTO_MS
    expect(segs[1]).toMatchObject({ kind: 'defended', startMs: AUTO_MS + 1000 });
  });

  it('drops zero/negative-length segments and clamps to the match length', () => {
    const segs = buildTimeline(
      row({
        fuel_bursts: [
          { startMs: 5000, endMs: 5000, rate: 0, window: 'shift1' }, // zero length
          { startMs: 139000, endMs: 200000, rate: 2, window: 'endgame' }, // overruns
        ],
      }),
    );
    expect(segs).toHaveLength(1);
    expect(segs[0].endMs).toBeLessThanOrEqual(MATCH_MS);
  });

  it('fractionOfMatch maps absolute ms to 0..1', () => {
    expect(fractionOfMatch(0)).toBe(0);
    expect(fractionOfMatch(MATCH_MS)).toBe(1);
    expect(fractionOfMatch(AUTO_MS)).toBeCloseTo(AUTO_MS / MATCH_MS, 5);
  });
});
