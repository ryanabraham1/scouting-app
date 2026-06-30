// src/dash/__tests__/MatchView.test.tsx
// MATCHVIEW cluster test. Mocks the react-query data hooks. List the event's
// matches; clicking one shows every report on that match (across stations /
// teams / scouters) so the lead can cross-check.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MsrRow } from '@/dash/types';
import type { MatchRow, ScoutRow } from '@/dash/useEventData';

const useEventMatchesMock = vi.fn();
const useEventReportsMock = vi.fn();
const useEventScoutsMock = vi.fn();

vi.mock('@/dash/useEventData', () => ({
  useEventMatches: (eventKey: string | null) => useEventMatchesMock(eventKey),
  useEventReports: (eventKey: string | null) => useEventReportsMock(eventKey),
  useEventScouts: (eventKey: string | null) => useEventScoutsMock(eventKey),
}));

// MatchVideo AND the new MatchResultsCard fetch the TBA match through
// tbaGetOptional (deduped on the same ['tba','match',key] query key). The mock is
// controllable per-test: by default it stays pending so the video embed sits in
// its loading state and the results card simply renders no RP line. A test can
// override `tbaGetOptionalMock` to resolve with a score_breakdown carrying RP.
// isUnavailable is also imported by MatchVideo + the results card, so stub it.
const tbaGetOptionalMock = vi.fn(() => new Promise(() => {}));
vi.mock('@/dash/proxies', () => ({
  tbaGet: vi.fn(() => new Promise(() => {})),
  tbaGetOptional: (...args: unknown[]) => tbaGetOptionalMock(...(args as [])),
  isUnavailable: (b: unknown) =>
    typeof b === 'object' && b !== null && (b as { available?: unknown }).available === false,
}));

import MatchView from '@/dash/MatchView';

function renderView(eventKey: string, initialMatchKey?: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MatchView eventKey={eventKey} initialMatchKey={initialMatchKey} />
    </QueryClientProvider>,
  );
}

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

function match(overrides: Partial<MatchRow>): MatchRow {
  return {
    match_key: '2026casnv_qm1',
    event_key: '2026casnv',
    comp_level: 'qm',
    match_number: 1,
    scheduled_time: null,
    red1: 254,
    red2: 1678,
    red3: null,
    blue1: null,
    blue2: null,
    blue3: null,
    actual_red_score: null,
    actual_blue_score: null,
    winner: null,
    result_synced_at: null,
    ...overrides,
  };
}

const matches: MatchRow[] = [
  match({ match_key: '2026casnv_qm1', match_number: 1 }),
  match({ match_key: '2026casnv_qm2', match_number: 2 }),
];

const scouts: ScoutRow[] = [{ id: 's1', display_name: 'Ada', event_key: '2026casnv' }];

// qm1 has two reports (different teams/stations/scouters); qm2 has none.
const reports: MsrRow[] = [
  row({ match_key: '2026casnv_qm1', target_team_number: 254, station: 1, scout_id: 's1', fuel_points: 20 }),
  row({ match_key: '2026casnv_qm1', target_team_number: 1678, station: 2, scout_id: null, fuel_points: 8 }),
];

function querySuccess<T>(data: T) {
  return { data, isLoading: false, isError: false, isSuccess: true };
}
function queryLoading() {
  return { data: undefined, isLoading: true, isError: false, isSuccess: false };
}

beforeEach(() => {
  cleanup();
  useEventMatchesMock.mockReset();
  useEventReportsMock.mockReset();
  useEventScoutsMock.mockReset();
  tbaGetOptionalMock.mockReset();
  // Default: leave the TBA fetch pending (video loading; results card shows no RP).
  tbaGetOptionalMock.mockImplementation(() => new Promise(() => {}));
  useEventMatchesMock.mockReturnValue(querySuccess(matches));
  useEventReportsMock.mockReturnValue(querySuccess(reports));
  useEventScoutsMock.mockReturnValue(querySuccess(scouts));
});

describe('MatchView', () => {
  it('renders the shell and a match list with friendly labels', () => {
    const { getByTestId } = renderView("2026casnv");
    expect(getByTestId('dash-match')).toBeTruthy();
    const list = getByTestId('match-list');
    // Friendly labels, not raw match keys.
    expect(within(list).getByText('Qual 1')).toBeTruthy();
    expect(within(list).getByText('Qual 2')).toBeTruthy();
    expect(within(list).queryByText(/2026casnv_qm1/)).toBeNull();
  });

  it('shows a loading state while data is loading', () => {
    useEventMatchesMock.mockReturnValue(queryLoading());
    const { getByTestId } = renderView("2026casnv");
    expect(getByTestId('match-loading')).toBeTruthy();
  });

  it('shows a per-match report count in the list', () => {
    const { getByTestId } = renderView("2026casnv");
    expect(getByTestId('match-item-2026casnv_qm1').textContent).toContain('2');
    expect(getByTestId('match-item-2026casnv_qm2').textContent).toContain('0');
  });

  it('opens a match on click and shows every report with team/station/scouter', () => {
    const { getByTestId } = renderView("2026casnv");
    fireEvent.click(getByTestId('match-item-2026casnv_qm1'));

    const detail = getByTestId('match-detail');
    const scope = within(detail);
    // both target teams appear
    expect(scope.getByText(/254/)).toBeTruthy();
    expect(scope.getByText(/1678/)).toBeTruthy();
    // scouter name resolved for s1; "unassigned" / "—" for the null scout_id
    expect(scope.getByText(/Ada/)).toBeTruthy();
  });

  it('shows an empty state for a match with no reports', () => {
    const { getByTestId } = renderView("2026casnv");
    fireEvent.click(getByTestId('match-item-2026casnv_qm2'));
    expect(getByTestId('match-empty')).toBeTruthy();
  });

  it('shows the match video embed and a per-team activity timeline for the selected match', () => {
    const { getByTestId } = renderView("2026casnv");
    fireEvent.click(getByTestId('match-item-2026casnv_qm1'));

    // Video embed mounts (pending fetch → loading state).
    expect(getByTestId('match-video-loading')).toBeTruthy();

    // One timeline row per report, labelled with team number.
    const timelines = getByTestId('match-timelines');
    expect(getByTestId('match-timeline-254-1')).toBeTruthy();
    expect(getByTestId('match-timeline-1678-2')).toBeTruthy();
    expect(within(timelines).getByText(/Team 254/)).toBeTruthy();
  });

  it('puts the video before the report list in the detail grid (no-scroll layout)', () => {
    const { getByTestId } = renderView('2026casnv');
    fireEvent.click(getByTestId('match-item-2026casnv_qm1'));

    const grid = getByTestId('match-detail-grid');
    const video = getByTestId('match-video-sync');
    const detail = getByTestId('match-detail');
    // Both live inside the shared grid…
    expect(grid.contains(video)).toBe(true);
    expect(grid.contains(detail)).toBe(true);
    // …and the video card comes first in DOM order (top on mobile).
    expect(video.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the activity timelines before the report list (readable alongside the video)', () => {
    const { getByTestId } = renderView('2026casnv');
    fireEvent.click(getByTestId('match-item-2026casnv_qm1'));

    const timelines = getByTestId('match-timelines');
    const detail = getByTestId('match-detail');
    // Timelines sit above the reports list so they can be read alongside the video.
    expect(
      timelines.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the sync control disabled until a video time is known', () => {
    const { getByTestId } = renderView('2026casnv');
    fireEvent.click(getByTestId('match-item-2026casnv_qm1'));
    const syncBtn = getByTestId('match-sync-now') as HTMLButtonElement;
    expect(syncBtn.disabled).toBe(true);
  });

  it('degrades gracefully with no playhead before any video time arrives', () => {
    const { getByTestId, queryByTestId } = renderView('2026casnv');
    fireEvent.click(getByTestId('match-item-2026casnv_qm1'));
    // No video time yet → timelines render but carry no playhead.
    expect(getByTestId('match-timelines')).toBeTruthy();
    expect(queryByTestId('timeline-playhead')).toBeNull();
  });

  it('opens the full per-report detail in a sheet when a report row is tapped', () => {
    const { getByTestId, queryByTestId } = renderView("2026casnv");
    fireEvent.click(getByTestId('match-item-2026casnv_qm1'));

    // No report sheet yet.
    expect(queryByTestId('report-detail')).toBeNull();

    fireEvent.click(getByTestId('match-report-254-1-0'));
    const detail = getByTestId('report-detail');
    const scope = within(detail);
    // Full report detail surfaces the friendly match label and fuel breakdown.
    expect(getByTestId('report-match-label').textContent).toBe('Qual 1');
    expect(scope.getByText(/Teleop active/i)).toBeTruthy();
    expect(scope.getByText(/Fuel points/i)).toBeTruthy();
  });

  it('renders a multi-scout conflict header + tints member tiles when 2 scouts cover one robot', () => {
    // Two divergent reports on the SAME robot (1678, blue 2), distinct scouts.
    const conflictReports: MsrRow[] = [
      row({ match_key: '2026casnv_qm1', target_team_number: 1678, alliance_color: 'blue', station: 2, scout_id: 's1', fuel_points: 14, climb_success: true, climb_level: 3, no_show: false }),
      row({ match_key: '2026casnv_qm1', target_team_number: 1678, alliance_color: 'blue', station: 2, scout_id: 's2', fuel_points: 4, climb_success: false, climb_level: 0, no_show: true }),
    ];
    useEventReportsMock.mockReturnValue(querySuccess(conflictReports));
    const { getByTestId } = renderView('2026casnv');
    fireEvent.click(getByTestId('match-item-2026casnv_qm1'));

    // Group header chip for the conflicted robot.
    const header = getByTestId('match-conflict-1678-2');
    expect(header).toBeTruthy();
    expect(within(header).getByTestId('conflict-marker').getAttribute('data-severity')).toBe(
      'severe',
    );
    // Both member tiles render under the disambiguated ids and carry a border.
    const tileA = getByTestId('match-report-1678-2-0');
    const tileB = getByTestId('match-report-1678-2-1');
    expect(tileA.className).toContain('border-l-destructive');
    expect(tileB.className).toContain('border-l-destructive');
  });

  it('folds the scouting-status summary + reported rows into the reports card', () => {
    // Roster: Ada (s1) + Bo (s2). qm1 has a report from s1 only and one
    // unattributed (null) -> s2 is missing.
    useEventScoutsMock.mockReturnValue(
      querySuccess([
        { id: 's1', display_name: 'Ada', event_key: '2026casnv' },
        { id: 's2', display_name: 'Bo', event_key: '2026casnv' },
      ]),
    );
    const { getByTestId, queryByTestId } = renderView('2026casnv');
    fireEvent.click(getByTestId('match-item-2026casnv_qm1'));

    // The status + the report tiles now live in ONE card (match-scout-status is
    // the merged "Reports on this match" card, which also holds match-detail).
    const card = getByTestId('match-scout-status');
    expect(card).toBeTruthy();
    expect(within(card).getByTestId('match-detail')).toBeTruthy();
    // Slim summary keeps the heartbeat intent (synced count + stations).
    expect(card.textContent).toMatch(/synced/);
    expect(card.textContent).toMatch(/stations/);
    // s1 reported (a reported row keyed by scout id, visible by default).
    expect(getByTestId('match-scout-reported-s1')).toBeTruthy();
    // The bulky "not reported" list is collapsed behind a toggle by default…
    expect(queryByTestId('match-scout-missing-s2')).toBeNull();
    expect(getByTestId('match-scout-missing-toggle').textContent).toMatch(/not reported/);
    // …and expands on click to reveal the missing scout row.
    fireEvent.click(getByTestId('match-scout-missing-toggle'));
    expect(getByTestId('match-scout-missing-s2')).toBeTruthy();
  });

  it('orders the detail pane: results → video → timelines → combined reports+status', () => {
    const { getByTestId } = renderView('2026casnv');
    fireEvent.click(getByTestId('match-item-2026casnv_qm1'));
    const results = getByTestId('match-results');
    const video = getByTestId('match-video-sync');
    const timelines = getByTestId('match-timelines');
    // The combined block: status summary + report tiles in the same card.
    const combined = getByTestId('match-scout-status');
    // Results lead, then video, then timelines, then the combined reports+status block.
    expect(
      results.compareDocumentPosition(video) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      video.compareDocumentPosition(timelines) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      timelines.compareDocumentPosition(combined) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  describe('match results card', () => {
    const playedMatches: MatchRow[] = [
      match({
        match_key: '2026casnv_qm1',
        match_number: 1,
        actual_red_score: 88,
        actual_blue_score: 72,
        winner: 'red',
        result_synced_at: '2026-06-23T01:00:00Z',
      }),
      match({ match_key: '2026casnv_qm2', match_number: 2 }), // unplayed
    ];

    it('shows the final score + highlights the winning alliance for a played match', () => {
      useEventMatchesMock.mockReturnValue(querySuccess(playedMatches));
      const { getByTestId } = renderView('2026casnv');
      fireEvent.click(getByTestId('match-item-2026casnv_qm1'));

      const score = getByTestId('match-results-score');
      expect(score.textContent).toContain('88');
      expect(score.textContent).toContain('72');
      expect(getByTestId('match-results-winner').textContent).toMatch(/Red wins/);
    });

    it('shows per-alliance RP when TBA provides score_breakdown.rp', async () => {
      tbaGetOptionalMock.mockResolvedValue({
        score_breakdown: { red: { rp: 4 }, blue: { rp: 1 } },
      });
      useEventMatchesMock.mockReturnValue(querySuccess(playedMatches));
      const { getByTestId, findByTestId } = renderView('2026casnv');
      fireEvent.click(getByTestId('match-item-2026casnv_qm1'));

      const redRp = await findByTestId('match-results-rp-red');
      expect(redRp.textContent).toMatch(/4 RP/);
      expect((await findByTestId('match-results-rp-blue')).textContent).toMatch(/1 RP/);
    });

    it('omits RP when TBA has no usable score_breakdown.rp (never fabricates)', () => {
      tbaGetOptionalMock.mockResolvedValue({ score_breakdown: { red: {}, blue: null } });
      useEventMatchesMock.mockReturnValue(querySuccess(playedMatches));
      const { getByTestId, queryByTestId } = renderView('2026casnv');
      fireEvent.click(getByTestId('match-item-2026casnv_qm1'));
      // Score still shows; RP lines are omitted.
      expect(getByTestId('match-results-score')).toBeTruthy();
      expect(queryByTestId('match-results-rp-red')).toBeNull();
      expect(queryByTestId('match-results-rp-blue')).toBeNull();
    });

    it('shows the "not played yet" state for an unplayed match', () => {
      useEventMatchesMock.mockReturnValue(querySuccess(playedMatches));
      const { getByTestId, queryByTestId } = renderView('2026casnv');
      fireEvent.click(getByTestId('match-item-2026casnv_qm2'));
      expect(getByTestId('match-results-unplayed')).toBeTruthy();
      // No score block for an unplayed match.
      expect(queryByTestId('match-results-score')).toBeNull();
    });
  });

  it('selects the deep-linked match on mount when initialMatchKey is given', () => {
    const { getByTestId } = renderView('2026casnv', '2026casnv_qm1');
    // No list click needed — the detail pane for qm1 renders straight away.
    expect(getByTestId('match-detail')).toBeTruthy();
    // qm1 has the two seeded reports, confirming the right match is selected.
    expect(getByTestId('match-report-254-1-0')).toBeTruthy();
  });

  it('renders a coverage marker on each left-list match item', () => {
    const { getByTestId } = renderView('2026casnv');
    expect(getByTestId('match-coverage-2026casnv_qm1')).toBeTruthy();
    expect(getByTestId('match-coverage-2026casnv_qm2')).toBeTruthy();
  });

  // --- playoff label disambiguation + ordering + search (MatchView changes) ---
  describe('playoff labels, ordering, and search', () => {
    const playoffMatches: MatchRow[] = [
      match({ match_key: '2026casnv_qm10', match_number: 10, red1: 254, red2: 9999 }),
      match({ match_key: '2026casnv_qm2', match_number: 2 }),
      // Distinct playoff SETS — these must read "Semi 1" and "Semi 3", NOT both "Semi 1".
      match({ match_key: '2026casnv_sf1m1', comp_level: 'sf', match_number: 1, red1: 1678 }),
      match({ match_key: '2026casnv_sf3m1', comp_level: 'sf', match_number: 1, red1: 5012 }),
    ];

    it('labels distinct playoff sets so they are not all "Semi 1"', () => {
      useEventMatchesMock.mockReturnValue(querySuccess(playoffMatches));
      const { getByTestId } = renderView('2026casnv');
      const list = getByTestId('match-list');
      expect(within(list).getByText('Semi 1')).toBeTruthy();
      expect(within(list).getByText('Semi 3')).toBeTruthy();
      // The two sf sets are disambiguated — never collapsed onto one label.
      expect(within(list).queryAllByText('Semi 1').length).toBe(1);
    });

    it('orders quals before playoffs and quals by number (qm2 before qm10)', () => {
      useEventMatchesMock.mockReturnValue(querySuccess(playoffMatches));
      const { getByTestId } = renderView('2026casnv');
      const items = within(getByTestId('match-list')).getAllByTestId(/^match-item-/);
      const keys = items.map((el) => el.getAttribute('data-testid'));
      expect(keys).toEqual([
        'match-item-2026casnv_qm2',
        'match-item-2026casnv_qm10',
        'match-item-2026casnv_sf1m1',
        'match-item-2026casnv_sf3m1',
      ]);
    });

    it('filters the list by team number across all six alliance slots', () => {
      useEventMatchesMock.mockReturnValue(querySuccess(playoffMatches));
      const { getByTestId, queryByTestId } = renderView('2026casnv');
      fireEvent.change(getByTestId('match-search'), { target: { value: '9999' } });
      // 9999 only plays qm10.
      expect(getByTestId('match-item-2026casnv_qm10')).toBeTruthy();
      expect(queryByTestId('match-item-2026casnv_qm2')).toBeNull();
      expect(queryByTestId('match-item-2026casnv_sf1m1')).toBeNull();
    });

    it('filters the list by match label (e.g. "Semi 3")', () => {
      useEventMatchesMock.mockReturnValue(querySuccess(playoffMatches));
      const { getByTestId, queryByTestId } = renderView('2026casnv');
      fireEvent.change(getByTestId('match-search'), { target: { value: 'Semi 3' } });
      expect(getByTestId('match-item-2026casnv_sf3m1')).toBeTruthy();
      expect(queryByTestId('match-item-2026casnv_sf1m1')).toBeNull();
      expect(queryByTestId('match-item-2026casnv_qm2')).toBeNull();
    });

    it('shows the empty-search state when nothing matches the filter', () => {
      useEventMatchesMock.mockReturnValue(querySuccess(playoffMatches));
      const { getByTestId, queryByTestId } = renderView('2026casnv');
      fireEvent.change(getByTestId('match-search'), { target: { value: 'zzz-no-match' } });
      expect(getByTestId('match-search-empty')).toBeTruthy();
      expect(queryByTestId('match-list')).toBeNull();
    });
  });
});
