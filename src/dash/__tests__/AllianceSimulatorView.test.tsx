// src/dash/__tests__/AllianceSimulatorView.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { MsrRow } from '@/dash/types';
import type { EventComponentEpa, EventEpa, MatchRow, TeamRow } from '@/dash/useEventData';
import { F_DEFAULT } from '@/dash/aggregate';
import type { TeamPit } from '@/dash/useTeamPit';

// --- mock the data hooks; capture useEventEpa args to assert the §2 union ---
const useEventReportsMock = vi.fn();
const useEventMatchesMock = vi.fn();
const useEventTeamsMock = vi.fn();
const useEventEpaMock = vi.fn();
const useEventComponentEpasMock = vi.fn();
const useEventPitsMock = vi.fn();

vi.mock('@/dash/useEventData', () => ({
  useEventReports: (eventKey: string | null) => useEventReportsMock(eventKey),
  useEventMatches: (eventKey: string | null) => useEventMatchesMock(eventKey),
  useEventTeams: (eventKey: string | null) => useEventTeamsMock(eventKey),
  useEventEpa: (teams: number[], eventKey: string | null, matches?: unknown) =>
    useEventEpaMock(teams, eventKey, matches),
  useEventComponentEpas: (teams: number[], eventKey: string | null) =>
    useEventComponentEpasMock(teams, eventKey),
}));

vi.mock('@/dash/useTeamPit', () => ({
  useEventPits: (eventKey: string | null) => useEventPitsMock(eventKey),
}));

import AllianceSimulatorView from '@/dash/AllianceSimulatorView';

function dataResult<T>(data: T): { data: T; isLoading: boolean } {
  return { data, isLoading: false };
}

/** Build a schedule of N matches over the given team pool (3 reds, 3 blues). */
function schedule(teams: number[]): MatchRow[] {
  const m: MatchRow = {
    match_key: '2026casnv_qm1',
    event_key: '2026casnv',
    comp_level: 'qm',
    match_number: 1,
    scheduled_time: null,
    red1: teams[0] ?? null,
    red2: teams[1] ?? null,
    red3: teams[2] ?? null,
    blue1: teams[3] ?? null,
    blue2: teams[4] ?? null,
    blue3: teams[5] ?? null,
    actual_red_score: null,
    actual_blue_score: null,
    winner: null,
    result_synced_at: null,
  };
  return [m];
}

const SCHEDULE_TEAMS = [11, 22, 33, 44, 55, 66];

beforeEach(() => {
  cleanup();
  useEventReportsMock.mockReset();
  useEventMatchesMock.mockReset();
  useEventTeamsMock.mockReset();
  useEventEpaMock.mockReset();
  useEventComponentEpasMock.mockReset();
  useEventPitsMock.mockReset();

  useEventReportsMock.mockReturnValue(dataResult<MsrRow[]>([]));
  useEventMatchesMock.mockReturnValue(dataResult<MatchRow[]>(schedule(SCHEDULE_TEAMS)));
  useEventTeamsMock.mockReturnValue(dataResult<TeamRow[]>([]));
  useEventEpaMock.mockReturnValue(
    dataResult<EventEpa>({ epaByTeam: new Map(), available: false, source: 'none' }),
  );
  useEventComponentEpasMock.mockReturnValue(
    dataResult<EventComponentEpa>({
      fraction: F_DEFAULT,
      defenseByTeam: new Map(),
      available: false,
    }),
  );
  useEventPitsMock.mockReturnValue(dataResult<Map<number, TeamPit>>(new Map()));
});

describe('AllianceSimulatorView', () => {
  it('renders pick buttons from the schedule union even with 0 reports', () => {
    const { getByTestId } = render(<AllianceSimulatorView eventKey="2026casnv" />);
    expect(getByTestId('dash-alliance')).toBeTruthy();
    expect(getByTestId('alliance-prompt')).toBeTruthy();
    // At least 3 pick buttons from the schedule.
    for (const t of [11, 22, 33]) {
      expect(getByTestId(`alliance-pick-${t}`)).toBeTruthy();
    }
  });

  it('selecting 3 teams shows the score; 4th unselected is disabled; clear resets', () => {
    const { getByTestId, queryByTestId } = render(<AllianceSimulatorView eventKey="2026casnv" />);
    fireEvent.click(getByTestId('alliance-pick-11'));
    fireEvent.click(getByTestId('alliance-pick-22'));
    fireEvent.click(getByTestId('alliance-pick-33'));

    expect(getByTestId('alliance-score')).toBeTruthy();
    expect(getByTestId('alliance-score-source')).toBeTruthy();
    expect(getByTestId('alliance-roles')).toBeTruthy();
    expect(queryByTestId('alliance-prompt')).toBeNull();

    // A 4th unselected pick button is disabled at cap.
    expect((getByTestId('alliance-pick-44') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(getByTestId('alliance-clear'));
    expect(getByTestId('alliance-prompt')).toBeTruthy();
  });

  it('feeds the selected (unscouted) team into useEventEpa teamNumbers (§2 union)', () => {
    const { getByTestId } = render(<AllianceSimulatorView eventKey="2026casnv" />);
    fireEvent.click(getByTestId('alliance-pick-22'));
    // The latest useEventEpa call must include the selected team 22.
    const lastCall = useEventEpaMock.mock.calls.at(-1);
    expect(lastCall).toBeTruthy();
    const teamNumbers = lastCall![0] as number[];
    expect(teamNumbers).toContain(22);
  });

  it('statboticsAvailable wiring: a local EPA source still blends (available === true)', () => {
    // One scouted team + EPA available via LOCAL source.
    useEventReportsMock.mockReturnValue(
      dataResult<MsrRow[]>([
        msr({ target_team_number: 11, fuel_points: 40, fuel_estimate_confidence: 1 }),
        msr({ target_team_number: 11, fuel_points: 40, fuel_estimate_confidence: 1 }),
        msr({ target_team_number: 11, fuel_points: 40, fuel_estimate_confidence: 1 }),
        msr({ target_team_number: 11, fuel_points: 40, fuel_estimate_confidence: 1 }),
      ]),
    );
    useEventEpaMock.mockReturnValue(
      dataResult<EventEpa>({
        epaByTeam: new Map<number, number | null>([[11, 80]]),
        available: true,
        source: 'local',
      }),
    );
    const { getByTestId } = render(<AllianceSimulatorView eventKey="2026casnv" />);
    fireEvent.click(getByTestId('alliance-pick-11'));
    fireEvent.click(getByTestId('alliance-pick-22'));
    fireEvent.click(getByTestId('alliance-pick-33'));
    // Team 11 (scouted + EPA, 4 matches) blends → chip source reads "blend".
    const chip = getByTestId('alliance-team-chip-11');
    expect(chip.textContent).toMatch(/blend/);
    expect(chip.textContent).not.toMatch(/scouting/);
  });

  it('EPA degradation banner: source local renders the in-house/local warning', () => {
    useEventEpaMock.mockReturnValue(
      dataResult<EventEpa>({ epaByTeam: new Map(), available: true, source: 'local' }),
    );
    const { getByTestId } = render(<AllianceSimulatorView eventKey="2026casnv" />);
    expect(getByTestId('alliance-epa-banner').textContent).toMatch(/local/i);
  });

  it('EPA banner absent when source is statbotics', () => {
    useEventEpaMock.mockReturnValue(
      dataResult<EventEpa>({ epaByTeam: new Map(), available: true, source: 'statbotics' }),
    );
    const { queryByTestId } = render(<AllianceSimulatorView eventKey="2026casnv" />);
    expect(queryByTestId('alliance-epa-banner')).toBeNull();
  });

  it('Top baseline excludes the picked teams (no self-vs-self ~50%)', () => {
    // Scout all 6 teams so they are all ranking candidates with real expected.
    const reports: MsrRow[] = [];
    SCHEDULE_TEAMS.forEach((t, i) => {
      for (let k = 0; k < 4; k++) {
        reports.push(
          msr({ target_team_number: t, fuel_points: 50 - i * 5, fuel_estimate_confidence: 1 }),
        );
      }
    });
    useEventReportsMock.mockReturnValue(dataResult<MsrRow[]>(reports));
    const { getByTestId } = render(<AllianceSimulatorView eventKey="2026casnv" />);
    // Pick the strongest three (11, 22, 33).
    fireEvent.click(getByTestId('alliance-pick-11'));
    fireEvent.click(getByTestId('alliance-pick-22'));
    fireEvent.click(getByTestId('alliance-pick-33'));
    fireEvent.click(getByTestId('alliance-baseline-top'));
    // Baseline excludes picks → red (top alliance) beats the remaining-3 baseline
    // → win prob strictly above 50%, NOT a self-vs-self coin flip.
    const txt = getByTestId('alliance-winprob').textContent ?? '';
    const pct = Number(txt.replace(/[^\d.]/g, ''));
    expect(pct).toBeGreaterThan(50);
  });

  it('versus mode toggle renders the two pickers', () => {
    const { getByTestId } = render(<AllianceSimulatorView eventKey="2026casnv" />);
    fireEvent.click(getByTestId('alliance-mode-versus'));
    expect(getByTestId('alliance-vs-picker-a')).toBeTruthy();
    expect(getByTestId('alliance-vs-picker-b')).toBeTruthy();
    expect(getByTestId('alliance-vs-prompt')).toBeTruthy();
    // pick buttons available per side
    expect(getByTestId('alliance-vs-pick-a-11')).toBeTruthy();
    expect(getByTestId('alliance-vs-pick-b-11')).toBeTruthy();
  });

  it('a team picked on A is excluded from B (no double-pick)', () => {
    const { getByTestId, queryByTestId } = render(<AllianceSimulatorView eventKey="2026casnv" />);
    fireEvent.click(getByTestId('alliance-mode-versus'));
    fireEvent.click(getByTestId('alliance-vs-pick-a-11'));
    // team 11 now removed from B's picker
    expect(queryByTestId('alliance-vs-pick-b-11')).toBeNull();
  });

  it('head-to-head panel appears once both alliances are filled', () => {
    const { getByTestId, queryByTestId } = render(<AllianceSimulatorView eventKey="2026casnv" />);
    fireEvent.click(getByTestId('alliance-mode-versus'));
    fireEvent.click(getByTestId('alliance-vs-pick-a-11'));
    fireEvent.click(getByTestId('alliance-vs-pick-a-22'));
    fireEvent.click(getByTestId('alliance-vs-pick-a-33'));
    fireEvent.click(getByTestId('alliance-vs-pick-b-44'));
    fireEvent.click(getByTestId('alliance-vs-pick-b-55'));
    fireEvent.click(getByTestId('alliance-vs-pick-b-66'));

    expect(queryByTestId('alliance-vs-prompt')).toBeNull();
    expect(getByTestId('alliance-vs-panel')).toBeTruthy();
    expect(getByTestId('alliance-vs-a-score')).toBeTruthy();
    expect(getByTestId('alliance-vs-b-score')).toBeTruthy();
    expect(getByTestId('alliance-vs-winprob')).toBeTruthy();
    expect(getByTestId('alliance-vs-compare')).toBeTruthy();
  });

  it('single mode is the default and unchanged (parity)', () => {
    const { getByTestId } = render(<AllianceSimulatorView eventKey="2026casnv" />);
    expect((getByTestId('alliance-mode-single') as HTMLButtonElement).getAttribute('aria-selected')).toBe('true');
    expect(getByTestId('alliance-picker')).toBeTruthy();
    expect(getByTestId('alliance-prompt')).toBeTruthy();
  });
});

/** Minimal MsrRow factory. */
function msr(overrides: Partial<MsrRow>): MsrRow {
  return {
    target_team_number: 11,
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
