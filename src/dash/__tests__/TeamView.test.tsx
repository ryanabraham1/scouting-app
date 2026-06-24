// src/dash/__tests__/TeamView.test.tsx
// TEAMVIEW cluster test. Mocks the react-query data hooks (@/dash/useEventData)
// so the view is exercised purely as a presentation/aggregation component:
// pick a team, assert its TeamAgg stats render, the EPA-unavailable note shows
// when available:false, and the no-data state appears for an unscouted team.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import type { MsrRow } from '@/dash/types';
import type { TeamRow, EventEpa } from '@/dash/useEventData';

// --- mock the data hooks -----------------------------------------------------
const useEventTeamsMock = vi.fn();
const useEventReportsMock = vi.fn();
const useEventEpaMock = vi.fn();

vi.mock('@/dash/useEventData', () => ({
  useEventTeams: (eventKey: string | null) => useEventTeamsMock(eventKey),
  useEventReports: (eventKey: string | null) => useEventReportsMock(eventKey),
  useEventEpa: (teams: number[], eventKey: string | null) =>
    useEventEpaMock(teams, eventKey),
}));

import TeamView from '@/dash/TeamView';

/** Minimal MsrRow factory. */
function row(overrides: Partial<MsrRow>): MsrRow {
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

const teams: TeamRow[] = [
  { team_number: 254, nickname: 'Cheesy Poofs' },
  { team_number: 1678, nickname: 'Citrus Circuits' },
];

// Two scouted matches for team 254. fuel_estimate_confidence < 1 to surface the
// rate-FUEL down-weight, climb_success at level 3 for a non-zero climb points.
const reports: MsrRow[] = [
  row({
    target_team_number: 254,
    match_key: '2026casnv_qm1',
    fuel_points: 20,
    fuel_estimate_confidence: 0.3,
    climb_level: 3,
    climb_success: true,
  }),
  row({
    target_team_number: 254,
    match_key: '2026casnv_qm2',
    fuel_points: 10,
    fuel_estimate_confidence: 0.3,
    climb_level: 0,
    climb_success: false,
    defense_rating: 4,
  }),
];

function querySuccess<T>(data: T) {
  return { data, isLoading: false, isError: false, isSuccess: true };
}
function queryLoading() {
  return { data: undefined, isLoading: true, isError: false, isSuccess: false };
}

function epaResult(epa: number | null, available: boolean): EventEpa {
  const epaByTeam = new Map<number, number | null>();
  if (epa !== null || !available) epaByTeam.set(254, epa);
  return { epaByTeam, available };
}

beforeEach(() => {
  cleanup();
  useEventTeamsMock.mockReset();
  useEventReportsMock.mockReset();
  useEventEpaMock.mockReset();
  // sensible defaults
  useEventTeamsMock.mockReturnValue(querySuccess(teams));
  useEventReportsMock.mockReturnValue(querySuccess(reports));
  useEventEpaMock.mockReturnValue(querySuccess(epaResult(48.5, true)));
});

function selectTeam(getByTestId: (id: string) => HTMLElement, value: string) {
  const select = getByTestId('team-select') as HTMLSelectElement;
  fireEvent.change(select, { target: { value } });
}

describe('TeamView', () => {
  it('renders the shell and team picker', () => {
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    expect(getByTestId('dash-team')).toBeTruthy();
    expect(getByTestId('team-select')).toBeTruthy();
  });

  it('shows a loading state while teams are loading', () => {
    useEventTeamsMock.mockReturnValue(queryLoading());
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    expect(getByTestId('team-loading')).toBeTruthy();
  });

  it('renders the chosen team aggregate stats', () => {
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');

    // matchesScouted lives in the team header (outside team-detail).
    expect(getByTestId('team-matches-scouted').textContent).toContain('2');

    const detail = getByTestId('team-detail');
    const scope = within(detail);

    // meanFuelPoints = (20 + 10) / 2 = 15
    expect(scope.getByTestId('team-mean-fuel-points').textContent).toContain('15');

    // fuelPointsWeighted = 15 * 0.3 = 4.5  (rate-FUEL down-weight)
    expect(scope.getByTestId('team-fuel-points-weighted').textContent).toContain('4.5');

    // climbSuccessRate = 1/2 = 50%
    expect(scope.getByTestId('team-climb-success-rate').textContent).toContain('50');

    // reliability = 1 (no no-shows/deaths) → 100%
    expect(scope.getByTestId('team-reliability').textContent).toContain('100');
  });

  it('surfaces the rate-FUEL low-confidence chip when confidence is low', () => {
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    expect(getByTestId('team-fuel-lowconf-chip')).toBeTruthy();
  });

  it('shows the EPA number when Statbotics is available', () => {
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    const epa = getByTestId('team-epa');
    expect(epa.textContent).toContain('48.5');
  });

  it('shows an EPA-unavailable note when available is false', () => {
    useEventEpaMock.mockReturnValue(querySuccess(epaResult(null, false)));
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    const epa = getByTestId('team-epa');
    expect(epa.textContent?.toLowerCase()).toContain('unavailable');
  });

  it('lists the team scouted matches with fuel points and climb', () => {
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    const list = getByTestId('team-match-list');
    const scope = within(list);
    expect(scope.getByText(/2026casnv_qm1/)).toBeTruthy();
    expect(scope.getByText(/2026casnv_qm2/)).toBeTruthy();
  });

  it('shows the no-data state for an unscouted team', () => {
    const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '1678'); // 1678 has zero reports
    expect(getByTestId('team-no-data')).toBeTruthy();
    expect(queryByTestId('team-detail')).toBeNull();
  });
});
