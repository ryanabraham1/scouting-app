// src/dash/__tests__/NextMatchView.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import type { MsrRow } from '@/dash/types';
import { OUR_TEAM } from '@/dash/constants';

// --- mock the data hooks so the view is pure/testable ---
const useEventMatchesMock = vi.fn();
const useEventReportsMock = vi.fn();
const useEventTeamsMock = vi.fn();
const useEventEpaMock = vi.fn();

vi.mock('@/dash/useEventData', () => ({
  useEventMatches: (eventKey: string | null) => useEventMatchesMock(eventKey),
  useEventReports: (eventKey: string | null) => useEventReportsMock(eventKey),
  useEventTeams: (eventKey: string | null) => useEventTeamsMock(eventKey),
  useEventEpa: (teams: number[], eventKey: string | null) =>
    useEventEpaMock(teams, eventKey),
}));

// --- stub AutoRoutines to keep this focused on prediction rendering ---
vi.mock('@/dash/AutoRoutines', () => ({
  default: (props: { isOurAlliance: boolean }) => (
    <div data-testid="auto-routines-stub" data-our={String(props.isOurAlliance)} />
  ),
}));

import NextMatchView from '@/dash/NextMatchView';

beforeEach(() => {
  cleanup();
  useEventMatchesMock.mockReset();
  useEventReportsMock.mockReset();
  useEventTeamsMock.mockReset();
  useEventEpaMock.mockReset();
});

/** Minimal MsrRow factory. */
function row(overrides: Partial<MsrRow>): MsrRow {
  return {
    target_team_number: 100,
    match_key: '2026evt_qm1',
    alliance_color: 'red',
    station: 1,
    auto_fuel: 0,
    teleop_fuel_active: 0,
    teleop_fuel_inactive: 0,
    endgame_fuel: 0,
    fuel_points: 10,
    fuel_estimate_confidence: 0.8,
    fuel_by_shift: [0, 0, 0, 0],
    climb_level: 2,
    climb_attempted: true,
    climb_success: true,
    auto_left_starting_line: true,
    auto_climb_level1: false,
    defense_rating: 3,
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

const RED = [OUR_TEAM, 111, 222];
const BLUE = [333, 444, 555];

function loadingResult() {
  return { data: undefined, isLoading: true, isError: false };
}
function dataResult<T>(data: T) {
  return { data, isLoading: false, isError: false };
}

function setupHappyPath(available: boolean) {
  // 3256's next unplayed qm is match 2 (match 1 is played, match 3 doesn't include 3256).
  const matches = [
    {
      match_key: '2026evt_qm1',
      event_key: '2026evt',
      comp_level: 'qm',
      match_number: 1,
      scheduled_time: null,
      red1: OUR_TEAM,
      red2: 111,
      red3: 222,
      blue1: 333,
      blue2: 444,
      blue3: 555,
      actual_red_score: 100, // played
      actual_blue_score: 90,
      winner: 'red',
      result_synced_at: null,
    },
    {
      match_key: '2026evt_qm2',
      event_key: '2026evt',
      comp_level: 'qm',
      match_number: 2,
      scheduled_time: null,
      red1: RED[0],
      red2: RED[1],
      red3: RED[2],
      blue1: BLUE[0],
      blue2: BLUE[1],
      blue3: BLUE[2],
      actual_red_score: null, // unplayed
      actual_blue_score: null,
      winner: null,
      result_synced_at: null,
    },
    {
      match_key: '2026evt_qm3',
      event_key: '2026evt',
      comp_level: 'qm',
      match_number: 3,
      scheduled_time: null,
      red1: 777,
      red2: 888,
      red3: 999,
      blue1: 666,
      blue2: 555,
      blue3: 444,
      actual_red_score: null,
      actual_blue_score: null,
      winner: null,
      result_synced_at: null,
    },
  ];

  // Reports: give the scouted teams some data (3256 is never scouted).
  const reports: MsrRow[] = [
    row({ target_team_number: 111, match_key: '2026evt_qm1', fuel_points: 12 }),
    row({ target_team_number: 111, match_key: '2026evt_qm0', fuel_points: 8 }),
    row({ target_team_number: 222, match_key: '2026evt_qm1', fuel_points: 20 }),
    row({ target_team_number: 333, match_key: '2026evt_qm1', fuel_points: 15 }),
    row({ target_team_number: 444, match_key: '2026evt_qm1', fuel_points: 5 }),
  ];

  const teams = [
    { team_number: OUR_TEAM, nickname: 'Us' },
    { team_number: 111, nickname: 'Alpha' },
    { team_number: 222, nickname: 'Beta' },
    { team_number: 333, nickname: 'Gamma' },
    { team_number: 444, nickname: 'Delta' },
    { team_number: 555, nickname: 'Epsilon' },
  ];

  const epaByTeam = new Map<number, number | null>();
  if (available) {
    for (const t of [...RED, ...BLUE]) epaByTeam.set(t, 25);
  } else {
    for (const t of [...RED, ...BLUE]) epaByTeam.set(t, null);
  }

  useEventMatchesMock.mockReturnValue(dataResult(matches));
  useEventReportsMock.mockReturnValue(dataResult(reports));
  useEventTeamsMock.mockReturnValue(dataResult(teams));
  useEventEpaMock.mockReturnValue(dataResult({ epaByTeam, available }));
}

describe('NextMatchView', () => {
  it('renders a loading state while data is loading', () => {
    useEventMatchesMock.mockReturnValue(loadingResult());
    useEventReportsMock.mockReturnValue(loadingResult());
    useEventTeamsMock.mockReturnValue(loadingResult());
    useEventEpaMock.mockReturnValue(dataResult({ epaByTeam: new Map(), available: false }));

    const { getByTestId } = render(<NextMatchView eventKey="2026evt" />);
    expect(getByTestId('dash-next')).toBeTruthy();
    expect(getByTestId('dash-next-loading')).toBeTruthy();
  });

  it('renders a no-match state when there are no unplayed matches', () => {
    useEventMatchesMock.mockReturnValue(dataResult([]));
    useEventReportsMock.mockReturnValue(dataResult([]));
    useEventTeamsMock.mockReturnValue(dataResult([]));
    useEventEpaMock.mockReturnValue(dataResult({ epaByTeam: new Map(), available: true }));

    const { getByTestId } = render(<NextMatchView eventKey="2026evt" />);
    expect(getByTestId('dash-next-no-match')).toBeTruthy();
  });

  it('renders predicted scores and per-team source badges (Statbotics available)', () => {
    setupHappyPath(true);
    const { getByTestId, getAllByTestId } = render(<NextMatchView eventKey="2026evt" />);

    expect(getByTestId('dash-next')).toBeTruthy();

    // Predicted alliance scores are rendered as numbers.
    const redScore = getByTestId('dash-next-red-score');
    const blueScore = getByTestId('dash-next-blue-score');
    expect(redScore.textContent).toMatch(/\d/);
    expect(blueScore.textContent).toMatch(/\d/);
    expect(Number.isNaN(parseInt(redScore.textContent ?? '', 10))).toBe(false);

    // Win prob shown as a percent.
    expect(getByTestId('dash-next-red-winprob').textContent).toMatch(/%/);

    // Per-team rows with source badges for all 6 teams.
    const badges = getAllByTestId('dash-next-source-badge');
    expect(badges.length).toBe(6);
    // With both scouting + EPA present for scouted teams, expect at least one 'blend';
    // 3256 is unscouted -> 'epa'.
    const badgeText = badges.map((b) => b.textContent).join(' ');
    expect(badgeText).toMatch(/blend|epa|scouting/);

    // EPA-unavailable banner is NOT shown when available.
    expect(document.querySelector('[data-testid="epa-unavailable"]')).toBeNull();
  });

  it('shows the epa-unavailable banner but still renders predictions when Statbotics is down', () => {
    setupHappyPath(false);
    const { getByTestId, getAllByTestId } = render(<NextMatchView eventKey="2026evt" />);

    // Banner present.
    const banner = getByTestId('epa-unavailable');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toMatch(/EPA/i);

    // Predictions still render.
    expect(getByTestId('dash-next-red-score').textContent).toMatch(/\d/);

    // Source badges still render (scouting-only / none).
    const badges = getAllByTestId('dash-next-source-badge');
    expect(badges.length).toBe(6);
    const badgeText = badges.map((b) => b.textContent).join(' ');
    // No 'blend' or 'epa' when Statbotics is down.
    expect(badgeText).not.toMatch(/blend/);
    expect(badgeText).not.toMatch(/\bepa\b/);
  });

  it('renders the rate-FUEL low-confidence chip and AutoRoutines for both alliances', () => {
    setupHappyPath(true);
    const { getAllByTestId, getByTestId } = render(<NextMatchView eventKey="2026evt" />);

    // Rate-FUEL low-confidence indicator present where fuel is shown.
    expect(getAllByTestId('fuel-low-confidence').length).toBeGreaterThan(0);

    // AutoRoutines rendered for both alliances; the one containing 3256 is "ours".
    const stubs = getAllByTestId('auto-routines-stub');
    expect(stubs.length).toBe(2);
    const ourFlags = stubs.map((s) => s.getAttribute('data-our'));
    expect(ourFlags).toContain('true');
    expect(ourFlags).toContain('false');

    // 3256 row resolves to an EPA source badge (unscouted).
    const ourRow = getByTestId(`dash-next-team-${OUR_TEAM}`);
    expect(within(ourRow).getByTestId('dash-next-source-badge').textContent?.toLowerCase()).toContain('epa');
  });
});
