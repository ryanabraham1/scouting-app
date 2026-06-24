// src/dash/__tests__/RankingView.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import type { MsrRow } from '@/dash/types';
import type { EventEpa } from '@/dash/useEventData';

// --- mock the data hooks; each test sets the return values via the holders ---
let reportsReturn: { data: MsrRow[] | undefined; isLoading: boolean };
let epaReturn: { data: EventEpa | undefined };
let tbaReturn: { data: unknown };

vi.mock('@/dash/useEventData', () => ({
  useEventReports: () => reportsReturn,
  useEventEpa: () => epaReturn,
  useTbaRankings: () => tbaReturn,
}));

import RankingView from '@/dash/RankingView';

beforeEach(() => {
  cleanup();
  reportsReturn = { data: [], isLoading: false };
  epaReturn = { data: { epaByTeam: new Map(), available: false } };
  tbaReturn = { data: undefined };
});

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

/** Two scouted teams with clearly different fuel points so sort order is observable. */
const reports: MsrRow[] = [
  // Team 254: high fuel points
  row({ target_team_number: 254, fuel_points: 40, fuel_estimate_confidence: 1, climb_level: 3, climb_success: true, defense_rating: 4 }),
  row({ target_team_number: 254, fuel_points: 50, fuel_estimate_confidence: 1, climb_level: 3, climb_success: true, defense_rating: 4 }),
  // Team 1678: lower fuel points
  row({ target_team_number: 1678, fuel_points: 10, fuel_estimate_confidence: 1, climb_level: 1, climb_success: false, defense_rating: 2 }),
];

describe('RankingView', () => {
  it('renders the ranking container', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(getByTestId('dash-ranking')).toBeTruthy();
  });

  it('shows a loading state while reports load', () => {
    reportsReturn = { data: undefined, isLoading: true };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(getByTestId('dash-ranking-loading')).toBeTruthy();
  });

  it('shows an empty state when no team has scouting data', () => {
    reportsReturn = { data: [], isLoading: false };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(getByTestId('dash-ranking-empty')).toBeTruthy();
  });

  it('renders one row per scouted team', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(getByTestId('ranking-row-254')).toBeTruthy();
    expect(getByTestId('ranking-row-1678')).toBeTruthy();
  });

  it('defaults to sorting by scoutingExpectedPoints descending (254 before 1678)', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getAllByTestId } = render(<RankingView eventKey="2026casnv" />);
    const rows = getAllByTestId(/^ranking-row-/);
    expect(rows[0].getAttribute('data-testid')).toBe('ranking-row-254');
    expect(rows[1].getAttribute('data-testid')).toBe('ranking-row-1678');
  });

  it('reorders rows when a column header is clicked', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getByTestId, getAllByTestId } = render(<RankingView eventKey="2026casnv" />);

    // Click team-number header → sort ascending by team number puts 254 first
    // (254 < 1678). Click scoutingExpectedPoints once → ascending puts 1678 first.
    fireEvent.click(getByTestId('sort-scoutingExpectedPoints'));
    const rows = getAllByTestId(/^ranking-row-/);
    expect(rows[0].getAttribute('data-testid')).toBe('ranking-row-1678');
    expect(rows[1].getAttribute('data-testid')).toBe('ranking-row-254');
  });

  it('sorts by team number when its header is clicked', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getByTestId, getAllByTestId } = render(<RankingView eventKey="2026casnv" />);
    fireEvent.click(getByTestId('sort-teamNumber'));
    const rows = getAllByTestId(/^ranking-row-/);
    expect(rows[0].getAttribute('data-testid')).toBe('ranking-row-254');
    expect(rows[1].getAttribute('data-testid')).toBe('ranking-row-1678');
  });

  it('shows "—" for EPA when Statbotics is unavailable', () => {
    reportsReturn = { data: reports, isLoading: false };
    epaReturn = { data: { epaByTeam: new Map(), available: false } };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    const row254 = getByTestId('ranking-row-254');
    expect(within(row254).getByTestId('epa-254').textContent).toBe('—');
  });

  it('shows the EPA value when Statbotics is available', () => {
    reportsReturn = { data: reports, isLoading: false };
    epaReturn = {
      data: { epaByTeam: new Map([[254, 55], [1678, null]]), available: true },
    };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(within(getByTestId('ranking-row-254')).getByTestId('epa-254').textContent).toBe('55');
    // null EPA still renders "—"
    expect(within(getByTestId('ranking-row-1678')).getByTestId('epa-1678').textContent).toBe('—');
  });

  it('shows "—" for TBA rank when rankings are unavailable', () => {
    reportsReturn = { data: reports, isLoading: false };
    tbaReturn = { data: undefined };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(within(getByTestId('ranking-row-254')).getByTestId('tba-254').textContent).toBe('—');
  });

  it('matches TBA rank by team_key frc{n}', () => {
    reportsReturn = { data: reports, isLoading: false };
    tbaReturn = {
      data: { rankings: [{ rank: 1, team_key: 'frc254' }, { rank: 7, team_key: 'frc1678' }] },
    };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(within(getByTestId('ranking-row-254')).getByTestId('tba-254').textContent).toBe('1');
    expect(within(getByTestId('ranking-row-1678')).getByTestId('tba-1678').textContent).toBe('7');
  });

  it('selecting teams populates the compare panel', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getByTestId, queryByTestId } = render(<RankingView eventKey="2026casnv" />);
    // No compare panel before any selection.
    expect(queryByTestId('compare-panel')).toBeNull();

    fireEvent.click(getByTestId('cmp-254'));
    fireEvent.click(getByTestId('cmp-1678'));

    const panel = getByTestId('compare-panel');
    expect(panel).toBeTruthy();
    expect(within(panel).getByText('254')).toBeTruthy();
    expect(within(panel).getByText('1678')).toBeTruthy();
  });
});
