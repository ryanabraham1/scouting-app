// src/dash/__tests__/useMatchScoutCoverage.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { MsrRow } from '@/dash/types';
import type { ScoutRow } from '@/dash/useEventData';

const useEventReportsMock = vi.fn();
const useEventScoutsMock = vi.fn();

vi.mock('@/dash/useEventData', () => ({
  useEventReports: (k: string | null) => useEventReportsMock(k),
  useEventScouts: (k: string | null) => useEventScoutsMock(k),
}));

import { useEventScoutCoverage, useMatchScoutCoverage } from '@/dash/useMatchScoutCoverage';
import { eventScoutCoverage } from '@/dash/aggregate';

function row(o: Partial<MsrRow>): MsrRow {
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
    server_received_at: '2026-06-29T10:00:00Z',
    deleted: false,
    ...o,
  };
}

const reports: MsrRow[] = [
  row({ match_key: 'qm1', scout_id: 'A', station: 1, server_received_at: '2026-06-29T10:00:00Z' }),
  row({ match_key: 'qm1', scout_id: 'B', station: 2, server_received_at: '2026-06-29T11:00:00Z' }),
  row({ match_key: 'qm2', scout_id: 'A', station: 1, server_received_at: '2026-06-29T12:00:00Z' }),
];
const scouts: ScoutRow[] = [
  { id: 'A', display_name: 'Ada', event_key: 'evt' },
  { id: 'B', display_name: 'Bo', event_key: 'evt' },
  { id: 'C', display_name: 'Cy', event_key: 'evt' },
];

beforeEach(() => {
  useEventReportsMock.mockReset();
  useEventScoutsMock.mockReset();
  useEventReportsMock.mockReturnValue({ data: reports, isLoading: false });
  useEventScoutsMock.mockReturnValue({ data: scouts, isLoading: false });
});

describe('useEventScoutCoverage', () => {
  it('matches the pure helper output', () => {
    const { result } = renderHook(() => useEventScoutCoverage('evt'));
    const expected = eventScoutCoverage(
      reports,
      scouts.map((s) => ({ id: s.id, display_name: s.display_name })),
    );
    expect(result.current.scoutsTotal).toBe(expected.scoutsTotal);
    expect(result.current.lastReportAt).toBe(expected.lastReportAt);
    expect(result.current.coverageByMatch.get('qm1')!.scoutsCovered).toBe(2);
    expect(result.current.coverageByMatch.get('qm2')!.scoutsCovered).toBe(1);
    expect(result.current.scoutsLoading).toBe(false);
  });

  it('yields a safe zeroed default when reports are undefined (offline cold start)', () => {
    useEventReportsMock.mockReturnValue({ data: undefined, isLoading: false });
    useEventScoutsMock.mockReturnValue({ data: undefined, isLoading: true });
    const { result } = renderHook(() => useEventScoutCoverage('evt'));
    expect(result.current.scoutsTotal).toBe(0);
    expect(result.current.lastReportAt).toBeNull();
    expect(result.current.coverageByMatch.size).toBe(0);
    expect(result.current.scoutsLoading).toBe(true);
  });
});

describe('useMatchScoutCoverage', () => {
  it('selects one match and lists missing scouts', () => {
    const { result } = renderHook(() => useMatchScoutCoverage('evt', 'qm1'));
    expect(result.current.scoutsCovered).toBe(2);
    expect(result.current.missingScouts.map((s) => s.id)).toEqual(['C']);
    expect(result.current.lastReportAt).toBe('2026-06-29T11:00:00Z');
  });

  it('returns a zeroed default for a match with no reports', () => {
    const { result } = renderHook(() => useMatchScoutCoverage('evt', 'qm99'));
    expect(result.current.scoutsCovered).toBe(0);
    expect(result.current.missingScouts.map((s) => s.id)).toEqual(['A', 'B', 'C']);
    expect(result.current.lastReportAt).toBeNull();
  });
});
