// src/dash/__tests__/TeamView.test.tsx
// TEAMVIEW cluster test. Mocks the react-query data hooks (@/dash/useEventData)
// so the view is exercised purely as a presentation/aggregation component:
// pick a team, assert its TeamAgg stats render, the EPA-unavailable note shows
// when available:false, and the no-data state appears for an unscouted team.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import type { MsrRow } from '@/dash/types';
import type { TeamRow, EventEpa, MatchRow } from '@/dash/useEventData';
import type { TeamPit } from '@/dash/useTeamPit';

// --- mock the data hooks -----------------------------------------------------
const useEventTeamsMock = vi.fn();
const useEventReportsMock = vi.fn();
const useEventEpaMock = vi.fn();

const useEventScoutsMock = vi.fn();
const useTeamPitMock = vi.fn();
const useEventMatchesMock = vi.fn();

vi.mock('@/dash/useEventData', () => ({
  useEventTeams: (eventKey: string | null) => useEventTeamsMock(eventKey),
  useEventReports: (eventKey: string | null) => useEventReportsMock(eventKey),
  useEventScouts: (eventKey: string | null) => useEventScoutsMock(eventKey),
  useEventEpa: (teams: number[], eventKey: string | null) =>
    useEventEpaMock(teams, eventKey),
  useEventMatches: () => useEventMatchesMock(),
  // TBA enrichment hooks degrade to null in this presentation test; the panels
  // render their "—" fallbacks rather than hitting the network.
  useTbaTeam: () => ({ data: null }),
  useTbaTeamEventStatus: () => ({ data: null }),
  useTeamSeasonStats: () => ({ data: null }),
}));

const useTeamPhotoMock = vi.fn();
vi.mock('@/dash/useTeamPit', () => ({
  useTeamPit: (eventKey: string | null, teamNumber: number | null) =>
    useTeamPitMock(eventKey, teamNumber),
  // The team photo thumbnail resolves a pit/TBA image; controllable per test.
  // Defaults to "no image" so most cases render without a thumbnail.
  useTeamPhoto: () => useTeamPhotoMock(),
}));

// MatchVideo fetches the TBA match via react-query; stub it so the last-match
// card renders without a QueryClient/network in this unit test.
vi.mock('@/dash/MatchVideo', () => ({
  default: ({ matchKey }: { matchKey: string }) => (
    <div data-testid="match-video-stub">{matchKey}</div>
  ),
}));

import TeamView from '@/dash/TeamView';

function pit(overrides: Partial<TeamPit>): TeamPit {
  return {
    eventKey: '2026casnv',
    teamNumber: 254,
    drivetrain: 'Swerve',
    mechanisms: ['Elevator', 'Pivot intake'],
    capabilities: ['L3 climb', 'High goal'],
    intakeSources: ['Ground', 'Corral'],
    visionSystem: 'Limelight 3',
    batteryCount: 6,
    chargerCount: 2,
    batteryBrand: 'MK',
    batteryConnector: 'Anderson SB50',
    preferredAutoStartPosition: null,
    preferredAutoPath: null,
    matchStrategy: ['Score', 'Cycle'],
    robotLengthIn: 30,
    robotWidthIn: 28,
    robotHeightIn: 24,
    trenchCapable: true,
    photoPath: null,
    notes: 'Fast and reliable robot',
    authorScoutId: 's1',
    ...overrides,
  };
}

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
    scout_id: null,
    notes: null,
    server_received_at: '2026-06-23T00:00:00Z',
    deleted: false,
    ...overrides,
  };
}

const teams: TeamRow[] = [
  { team_number: 254, nickname: 'Cheesy Poofs' },
  { team_number: 1678, nickname: 'Citrus Circuits' },
];

function match(overrides: Partial<MatchRow>): MatchRow {
  return {
    match_key: '2026casnv_qm1',
    event_key: '2026casnv',
    comp_level: 'qm',
    match_number: 1,
    scheduled_time: null,
    red1: 254,
    red2: 1111,
    red3: 2222,
    blue1: 3333,
    blue2: 4444,
    blue3: 5555,
    actual_red_score: 88,
    actual_blue_score: 72,
    winner: 'red',
    result_synced_at: '2026-06-23T01:00:00Z',
    ...overrides,
  };
}

// qm2 is the team's LATEST scouted match (chronological), so the last-match card
// anchors there; give it played alliances/score so the details panel populates.
const matches: MatchRow[] = [
  match({ match_key: '2026casnv_qm1', match_number: 1 }),
  match({
    match_key: '2026casnv_qm2',
    match_number: 2,
    red1: 254,
    red2: 6666,
    red3: 7777,
    blue1: 8888,
    blue2: 9999,
    blue3: 1010,
    actual_red_score: 55,
    actual_blue_score: 91,
    winner: 'blue',
  }),
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
    scout_id: 's1',
    notes: 'fast cycler',
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
  useEventScoutsMock.mockReset();
  useEventEpaMock.mockReset();
  useTeamPitMock.mockReset();
  useEventMatchesMock.mockReset();
  useTeamPhotoMock.mockReset();
  useTeamPhotoMock.mockReturnValue({ data: { url: null, source: null }, isLoading: false });
  // sensible defaults
  useEventTeamsMock.mockReturnValue(querySuccess(teams));
  useEventReportsMock.mockReturnValue(querySuccess(reports));
  useEventMatchesMock.mockReturnValue(querySuccess(matches));
  useEventScoutsMock.mockReturnValue(
    querySuccess([{ id: 's1', display_name: 'Ada', event_key: '2026casnv' }]),
  );
  useEventEpaMock.mockReturnValue(querySuccess(epaResult(48.5, true)));
  // default: a pit report exists for the selected team.
  useTeamPitMock.mockReturnValue(querySuccess(pit({})));
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
    const picker = getByTestId('team-picker');
    expect(picker.className).not.toContain('max-w-xs');
    expect(picker.firstElementChild?.className).toContain('lg:grid-cols-');
    expect(getByTestId('team-picker-context').textContent).toContain('No team selected');
  });

  // --- team-search live results above the <select> (TeamView change) ----------
  it('shows clickable search results by team number and selecting one picks it', () => {
    const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
    // The <select> keeps the FULL team list for browsing.
    const select = getByTestId('team-select') as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: /254/ })).toBeTruthy();
    expect(within(select).getByRole('option', { name: /1678/ })).toBeTruthy();

    // Typing surfaces a live, clickable results list (not a hidden dropdown filter).
    fireEvent.change(getByTestId('team-search'), { target: { value: '254' } });
    expect(getByTestId('team-search-results')).toBeTruthy();
    expect(getByTestId('team-search-result-254')).toBeTruthy();
    expect(queryByTestId('team-search-result-1678')).toBeNull();

    // Clicking a result selects that team and clears the search.
    fireEvent.click(getByTestId('team-search-result-254'));
    expect((getByTestId('team-select') as HTMLSelectElement).value).toBe('254');
    expect((getByTestId('team-search') as HTMLInputElement).value).toBe('');
    expect(queryByTestId('team-search-results')).toBeNull();
  });

  it('matches search results by nickname (case-insensitive) and shows an empty state', () => {
    const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
    fireEvent.change(getByTestId('team-search'), { target: { value: 'citrus' } });
    // 1678 "Citrus Circuits" matches; 254 "Cheesy Poofs" does not.
    expect(getByTestId('team-search-result-1678')).toBeTruthy();
    expect(queryByTestId('team-search-result-254')).toBeNull();

    // No matches → a clear empty state.
    fireEvent.change(getByTestId('team-search'), { target: { value: 'zzzzz' } });
    expect(getByTestId('team-search-empty')).toBeTruthy();
  });

  it('selects the top live result with Enter and updates the selected-team context', () => {
    const onSelectTeam = vi.fn();
    const { getByTestId, queryByTestId } = render(
      <TeamView eventKey="2026casnv" onSelectTeam={onSelectTeam} />,
    );
    const search = getByTestId('team-search');
    fireEvent.change(search, { target: { value: 'citrus' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelectTeam).toHaveBeenCalledWith(1678);
    expect((getByTestId('team-select') as HTMLSelectElement).value).toBe('1678');
    expect((search as HTMLInputElement).value).toBe('');
    expect(queryByTestId('team-search-results')).toBeNull();
    expect(getByTestId('team-picker-context').textContent).toContain('1678');
    expect(getByTestId('team-picker-context').textContent).toContain('Citrus Circuits');
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

    // meanFuelPoints = (20 + 10) / 2 = 15 (RAW — no confidence down-weight)
    expect(scope.getByTestId('team-mean-fuel-points').textContent).toContain('15');

    // The weighted (×confidence) stat has been removed entirely.
    expect(scope.queryByTestId('team-fuel-points-weighted')).toBeNull();

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

  it('uses the selected team scouting fallback when external EPA is unavailable', () => {
    useEventEpaMock.mockReturnValue(querySuccess(epaResult(null, false)));
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    const epa = getByTestId('team-epa');
    expect(epa.textContent?.toLowerCase()).toContain('in-house estimate');
  });

  it('lists the team scouted matches with friendly labels', () => {
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    const list = getByTestId('team-match-list');
    const scope = within(list);
    expect(scope.getByText(/Qual 1/)).toBeTruthy();
    expect(scope.getByText(/Qual 2/)).toBeTruthy();
    expect(scope.queryByText(/2026casnv_qm/)).toBeNull();
  });

  it('lays out multiple scout notes in a responsive compact grid', () => {
    useEventReportsMock.mockReturnValue(
      querySuccess(
        Array.from({ length: 9 }, (_, i) =>
          row({
            match_key: `2026casnv_qm${i + 1}`,
            scout_id: 's1',
            notes: `Observation from match ${i + 1}`,
          }),
        ),
      ),
    );
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');

    const notes = getByTestId('team-notes');
    const list = notes.querySelector('ul');
    expect(list?.className).toContain('grid');
    expect(list?.className).toContain('sm:grid-cols-2');
    expect(within(notes).getAllByTestId(/^team-note-\d+$/)).toHaveLength(9);
    expect(getByTestId('team-note-0').textContent).toContain('Qual 1');
    expect(getByTestId('team-note-0').textContent).toContain('Ada');
    expect(getByTestId('team-note-8').textContent).toContain('Observation from match 9');
  });

  it('reveals a match report detail (with scouter) when a scouted-match row is clicked', () => {
    const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');

    // No detail open initially.
    expect(queryByTestId('team-match-detail')).toBeNull();

    fireEvent.click(getByTestId('team-match-row-0'));
    const detail = getByTestId('team-match-detail');
    const scope = within(detail);
    // The scouter who made it is attributed by display name.
    expect(scope.getByText(/Ada/)).toBeTruthy();
    // The free-text note is shown.
    expect(scope.getByText(/fast cycler/)).toBeTruthy();
  });

  it('shows the no-data state for an unscouted team', () => {
    const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '1678'); // 1678 has zero reports
    expect(getByTestId('team-no-data')).toBeTruthy();
    expect(queryByTestId('team-detail')).toBeNull();
  });

  it('renders the pit report panel for the selected team', () => {
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    const panel = getByTestId('team-pit');
    const scope = within(panel);
    expect(scope.getByText('Swerve')).toBeTruthy();
    expect(scope.getByText('Elevator')).toBeTruthy();
    expect(scope.getByText('L3 climb')).toBeTruthy();
    expect(scope.getByText('Corral')).toBeTruthy();
    expect(scope.getByText(/Fast and reliable/)).toBeTruthy();
    expect(scope.getByTestId('team-pit-author').textContent).toContain('Scouted by Ada');
  });

  it('shows a friendly empty state when no pit report exists', () => {
    useTeamPitMock.mockReturnValue(querySuccess(null));
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    expect(getByTestId('team-pit-empty')).toBeTruthy();
  });

  it('shows the pit panel even for an unscouted team', () => {
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '1678');
    expect(getByTestId('team-pit')).toBeTruthy();
  });

  it('opens the full report drill-down sheet from a scouted-match row', () => {
    const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    fireEvent.click(getByTestId('team-match-row-0'));
    expect(queryByTestId('report-detail')).toBeNull();

    fireEvent.click(getByTestId('team-match-fullreport-0'));
    const detail = getByTestId('report-detail');
    expect(detail).toBeTruthy();
    expect(within(detail).getByText(/Fuel points/i)).toBeTruthy();
  });

  it('renders the Trends charts when the team has >= the trend window of reports', () => {
    // 3 reports clears the trend window (TREND_WINDOW = 3) so Trends shows.
    // At least one successful climb so the climb chart isn't hidden as "no climb".
    useEventReportsMock.mockReturnValue(
      querySuccess(
        [20, 10, 15].map((f, i) =>
          row({
            target_team_number: 254,
            match_key: `2026casnv_qm${i + 1}`,
            fuel_points: f,
            climb_success: i === 0,
            climb_level: i === 0 ? 2 : 0,
          }),
        ),
      ),
    );
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    const trends = getByTestId('team-trends');
    expect(trends).toBeTruthy();
    // Fuel-points-per-match bar chart (>=3 reports => not empty).
    const fuel = getByTestId('team-trend-fuel');
    expect(fuel.getAttribute('data-chart-empty')).not.toBe('true');
    // Fuel-by-shift stacked bar + a climb/defense line chart are present too.
    expect(getByTestId('team-trend-shift')).toBeTruthy();
    expect(getByTestId('team-trend-climb')).toBeTruthy();
  });

  it('hides climb stats + chart and shows a "no climb" note for a non-climbing team', () => {
    // 3 reports (clears the trend window) with NO successful climbs.
    useEventReportsMock.mockReturnValue(
      querySuccess(
        [20, 10, 15].map((f, i) =>
          row({
            target_team_number: 254,
            match_key: `2026casnv_qm${i + 1}`,
            fuel_points: f,
            climb_success: false,
            climb_level: 0,
          }),
        ),
      ),
    );
    const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    // Climb stats are replaced by a "no climb" note; the climb trend is hidden.
    expect(getByTestId('team-no-climb')).toBeTruthy();
    expect(queryByTestId('team-climb-success-rate')).toBeNull();
    expect(queryByTestId('team-avg-climb-level')).toBeNull();
    expect(queryByTestId('team-mean-climb-points')).toBeNull();
    expect(queryByTestId('team-trend-climb')).toBeNull();
    // Defense/reliability stats still render.
    expect(getByTestId('team-reliability')).toBeTruthy();
  });

  it('preselects the team passed via the selectedTeam prop', () => {
    const { getByTestId } = render(<TeamView eventKey="2026casnv" selectedTeam={254} />);
    // No manual selection needed — 254's detail renders straight away.
    expect(getByTestId('team-detail')).toBeTruthy();
    expect((getByTestId('team-select') as HTMLSelectElement).value).toBe('254');
  });

  it('syncs the shown team when selectedTeam changes (e.g. navigating from rankings)', () => {
    const { getByTestId, rerender } = render(
      <TeamView eventKey="2026casnv" selectedTeam={1678} />,
    );
    // 1678 has no reports → no-data state.
    expect(getByTestId('team-no-data')).toBeTruthy();
    rerender(<TeamView eventKey="2026casnv" selectedTeam={254} />);
    expect(getByTestId('team-detail')).toBeTruthy();
    expect((getByTestId('team-select') as HTMLSelectElement).value).toBe('254');
  });

  it('still lets the dropdown drive manual selection alongside the prop', () => {
    const { getByTestId } = render(<TeamView eventKey="2026casnv" selectedTeam={254} />);
    expect(getByTestId('team-detail')).toBeTruthy();
    selectTeam(getByTestId, '1678');
    expect(getByTestId('team-no-data')).toBeTruthy();
  });

  it('hides the Trends block entirely when there is not enough data (below the trend window)', () => {
    // 2 reports < TREND_WINDOW (3) → recentTrend is "insufficient" → no Trends
    // block at all (no empty placeholder chart).
    const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254'); // default fixture has exactly 2 reports
    expect(queryByTestId('team-trends')).toBeNull();
    expect(queryByTestId('team-trend-fuel')).toBeNull();
    // The rest of the detail still renders.
    expect(getByTestId('team-detail')).toBeTruthy();
  });

  it('folds mean ± σ inline into the fuel/climb/defense stats (no separate Distribution card)', () => {
    // 5 matches, fuel {10,10,30,30,30} → all-mean 22, last-3 mean 30 → improving.
    useEventReportsMock.mockReturnValue(
      querySuccess(
        [10, 10, 30, 30, 30].map((f, i) =>
          row({
            target_team_number: 254,
            match_key: `2026casnv_qm${i + 1}`,
            fuel_points: f,
            defense_rating: 3,
            climb_success: true,
            climb_level: 2,
          }),
        ),
      ),
    );
    const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');

    // The standalone Distribution card is gone — the data now lives inline.
    expect(queryByTestId('team-distribution')).toBeNull();
    expect(queryByTestId('team-dist-fuel')).toBeNull();
    expect(queryByTestId('team-dist-climb')).toBeNull();
    expect(queryByTestId('team-dist-defense')).toBeNull();

    const detail = getByTestId('team-detail');
    const scope = within(detail);

    // σ now appears inline on the existing fuel/climb/defense stat blocks.
    expect(scope.getByTestId('team-mean-fuel-points').textContent).toMatch(/\d+\.\d ± \d+\.\d/);
    expect(scope.getByTestId('team-mean-climb-points').textContent).toMatch(/\d+\.\d ± \d+\.\d/);
    expect(scope.getByTestId('team-avg-defense-rating').textContent).toMatch(/\d+\.\d ± \d+\.\d/);

    // Recent form: improving → success tone + signed delta label, shown inline.
    const form = scope.getByTestId('team-recent-form');
    expect(form.textContent).toMatch(/Improving \+\d+\.\d/);
    expect(form.className).toMatch(/text-success/);
  });

  it('shows a stable recent-form chip when there is no upward/downward trend', () => {
    // 3 flat matches → recentFuelDelta ~0 → "Stable".
    useEventReportsMock.mockReturnValue(
      querySuccess(
        [20, 20, 20].map((f, i) =>
          row({
            target_team_number: 254,
            match_key: `2026casnv_qm${i + 1}`,
            fuel_points: f,
          }),
        ),
      ),
    );
    const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
    selectTeam(getByTestId, '254');
    const form = within(getByTestId('team-detail')).getByTestId('team-recent-form');
    expect(form.textContent).toContain('Stable');
  });

  // --- Last-match details + deep-link to the Match tab ----------------------
  describe('last-match card', () => {
    it('shows both alliances (our team highlighted) and the final score + winner', () => {
      const { getByTestId } = render(<TeamView eventKey="2026casnv" />);
      selectTeam(getByTestId, '254');
      // The latest scouted match is qm2 (blue wins 55–91).
      const details = getByTestId('team-last-match-details');
      const scope = within(details);
      const red = scope.getByTestId('team-last-match-alliance-red');
      const blue = scope.getByTestId('team-last-match-alliance-blue');
      // Our team (254) appears on the red alliance line; opponents on both.
      expect(within(red).getByText('254')).toBeTruthy();
      expect(within(blue).getByText('8888')).toBeTruthy();
      // Final score shows on each alliance line.
      expect(red.textContent).toContain('55');
      expect(blue.textContent).toContain('91');
      // Winner label.
      expect(scope.getByTestId('team-last-match-winner').textContent).toMatch(/Blue wins/);
    });

    it('is clickable to deep-link into the Match tab with that match', () => {
      const onOpenMatch = vi.fn();
      const { getByTestId } = render(
        <TeamView eventKey="2026casnv" onOpenMatch={onOpenMatch} />,
      );
      selectTeam(getByTestId, '254');
      fireEvent.click(getByTestId('team-last-match-open'));
      expect(onOpenMatch).toHaveBeenCalledWith('2026casnv_qm2');
    });

    it('does not render the open button when no onOpenMatch is wired', () => {
      const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
      selectTeam(getByTestId, '254');
      expect(getByTestId('team-last-match')).toBeTruthy();
      expect(queryByTestId('team-last-match-open')).toBeNull();
    });
  });

  // --- Compact robot photo near the team header (no big standalone block) ----
  describe('robot photo', () => {
    it('renders a compact photo thumbnail near the header and opens a lightbox on click', () => {
      useTeamPhotoMock.mockReturnValue({
        data: { url: 'https://example.com/robot.jpg', source: 'pit' },
        isLoading: false,
      });
      const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
      selectTeam(getByTestId, '254');
      // The old big standalone photo block is gone.
      expect(queryByTestId('team-pit-photo')).toBeNull();
      // A compact thumbnail is present; clicking it opens the full-image lightbox.
      const thumb = getByTestId('team-photo-thumb');
      expect(thumb).toBeTruthy();
      expect(queryByTestId('team-photo-lightbox')).toBeNull();
      fireEvent.click(thumb);
      expect(getByTestId('team-photo-lightbox')).toBeTruthy();
    });

    it('renders nothing for the photo when no image is available', () => {
      // Default useTeamPhoto mock → url null.
      const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
      selectTeam(getByTestId, '254');
      expect(queryByTestId('team-photo-thumb')).toBeNull();
      expect(queryByTestId('team-pit-photo')).toBeNull();
    });

    it('navigates multiple pit photos in the lightbox', () => {
      useTeamPhotoMock.mockReturnValue({
        data: {
          url: 'https://example.com/one.jpg',
          urls: ['https://example.com/one.jpg', 'https://example.com/two.jpg'],
          source: 'pit',
        },
        isLoading: false,
      });
      const { getByTestId, getByRole, getByAltText } = render(
        <TeamView eventKey="2026casnv" />,
      );
      selectTeam(getByTestId, '254');
      fireEvent.click(getByTestId('team-photo-thumb'));
      fireEvent.click(getByRole('button', { name: 'Next pit photo' }));
      expect(getByAltText(/photo 2/i)).toHaveAttribute('src', 'https://example.com/two.jpg');
    });
  });

  // --- Multi-scout reconciliation (multi-scout-reconciliation) -------------
  describe('multi-scout conflicts', () => {
    // qm1: two scouts disagree on the SAME robot (254 red 1). qm2: single scout.
    const conflictReports: MsrRow[] = [
      row({ target_team_number: 254, match_key: '2026casnv_qm1', station: 1, scout_id: 's1', fuel_points: 14, climb_success: true, climb_level: 3, no_show: false }),
      row({ target_team_number: 254, match_key: '2026casnv_qm1', station: 1, scout_id: 's2', fuel_points: 4, climb_success: false, climb_level: 0, no_show: true }),
      row({ target_team_number: 254, match_key: '2026casnv_qm2', station: 1, scout_id: 's1', fuel_points: 10 }),
    ];

    it('shows the conflict summary pill and a per-row marker', () => {
      useEventReportsMock.mockReturnValue(querySuccess(conflictReports));
      const { getByTestId, getAllByTestId } = render(<TeamView eventKey="2026casnv" />);
      selectTeam(getByTestId, '254');
      expect(getByTestId('team-conflict-summary').textContent).toContain('1 multi-scout conflict');
      // Both qm1 report rows belong to the conflicted robot → a marker on each.
      expect(getAllByTestId('team-conflict-marker').length).toBe(2);
    });

    it('filters to the conflicted rows when "conflicts only" is on, and collapses any open row', () => {
      useEventReportsMock.mockReturnValue(querySuccess(conflictReports));
      const { getByTestId, getAllByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
      selectTeam(getByTestId, '254');

      // Open a row, then toggle conflicts-only → the open detail collapses.
      fireEvent.click(getByTestId('team-match-row-0'));
      expect(getByTestId('team-match-detail')).toBeTruthy();
      fireEvent.click(getByTestId('team-conflicts-only'));
      expect(queryByTestId('team-match-detail')).toBeNull();

      // Only the conflicted qm1 rows remain (qm2's single-scout row is filtered out).
      const list = getByTestId('team-match-list');
      expect(within(list).getAllByText(/Qual 1/).length).toBe(2);
      expect(within(list).queryByText(/Qual 2/)).toBeNull();
      expect(getAllByTestId('team-conflict-marker').length).toBe(2);
    });

    it('shows no summary pill when the team has no conflicts', () => {
      // Default reports = two single-scout matches → no multi-scout coverage.
      const { getByTestId, queryByTestId } = render(<TeamView eventKey="2026casnv" />);
      selectTeam(getByTestId, '254');
      expect(queryByTestId('team-conflict-summary')).toBeNull();
      expect(queryByTestId('team-conflicts-only')).toBeNull();
    });
  });
});
