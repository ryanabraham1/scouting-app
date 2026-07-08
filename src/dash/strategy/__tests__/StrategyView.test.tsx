// src/dash/strategy/__tests__/StrategyView.test.tsx
// The Strategy tab: prediction breakdown (moved here from Next Match — those
// tests migrated with it), match tracking/selector, whiteboard mount, matchup
// panel, component lines, and the enriched team cards.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, within, fireEvent } from '@testing-library/react';
import type { MsrRow } from '@/dash/types';
import { OUR_TEAM } from '@/dash/constants';

// --- mock the data hooks so the view is pure/testable ---
const useEventMatchesMock = vi.fn();
const useEventReportsMock = vi.fn();
const useEventTeamsMock = vi.fn();
const useEventEpaMock = vi.fn();
const useNexusEventStatusMock = vi.fn();

vi.mock('@/dash/useEventData', () => ({
  useEventMatches: (eventKey: string | null) => useEventMatchesMock(eventKey),
  useEventReports: (eventKey: string | null) => useEventReportsMock(eventKey),
  useEventTeams: (eventKey: string | null) => useEventTeamsMock(eventKey),
  useEventEpa: (teams: number[], eventKey: string | null, matches?: unknown) =>
    useEventEpaMock(teams, eventKey, matches),
  useNexusEventStatus: (eventKey: string | null) => useNexusEventStatusMock(eventKey),
  // Component-split inputs: the default fitted fraction, always available.
  useEventComponentEpas: () => ({
    data: {
      fraction: { fAuto: 0.15, fFuel: 0.55, fClimb: 0.3 },
      defenseByTeam: new Map<number, number | null>(),
      available: true,
    },
  }),
  // Matchup-intelligence: the MatchupPanel mounted by StrategyView reads notes.
  useMatchupNotes: () => ({ data: new Map<string, string>() }),
}));

// useSync: mounted for the outbox drain — mock to the real shape.
vi.mock('@/sync/useSync', () => ({
  useSync: () => ({
    online: true,
    queued: 0,
    deadLetters: 0,
    syncing: false,
    syncNow: vi.fn(),
    lastSyncedAt: null,
  }),
}));

// Whiteboard persistence: no IndexedDB/network in jsdom units.
vi.mock('@/dash/strategy/strategyCanvasClient', () => ({
  useStrategyCanvas: () => ({ data: { strokes: [], deletedIds: [] } }),
  saveStrategyCanvas: vi.fn(async () => {}),
  canvasKeyFor: (e: string, m: string) => `${e}:${m}`,
}));

// Pit facts per team: empty map (covered by useTeamPit's own tests).
vi.mock('@/dash/useTeamPit', () => ({
  useEventPits: () => ({ data: new Map() }),
}));

// --- stub the combined auto field to keep this focused on strategy rendering ---
vi.mock('@/dash/CombinedAutoField', () => ({
  default: (props: { redTeams: number[]; blueTeams: number[] }) => (
    <div
      data-testid="combined-auto-stub"
      data-red={props.redTeams.join(',')}
      data-blue={props.blueTeams.join(',')}
    />
  ),
  defaultMatchupOverlays: () => [],
}));

import StrategyView from '@/dash/strategy/StrategyView';

beforeEach(() => {
  cleanup();
  useEventMatchesMock.mockReset();
  useEventReportsMock.mockReset();
  useEventTeamsMock.mockReset();
  useEventEpaMock.mockReset();
  useNexusEventStatusMock.mockReset();
  // Default: Nexus unavailable so the view degrades to the schedule.
  useNexusEventStatusMock.mockReturnValue(dataResult({ status: null, available: false }));
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
    // 222 is rate-derived (low confidence) → the ONLY row that should wear the
    // low-confidence chip; the 0.8-confidence teams and unscouted teams don't.
    row({ target_team_number: 222, match_key: '2026evt_qm1', fuel_points: 20, fuel_estimate_confidence: 0.3 }),
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

describe('StrategyView', () => {
  it('renders a loading state while data is loading', () => {
    useEventMatchesMock.mockReturnValue(loadingResult());
    useEventReportsMock.mockReturnValue(loadingResult());
    useEventTeamsMock.mockReturnValue(loadingResult());
    useEventEpaMock.mockReturnValue(dataResult({ epaByTeam: new Map(), available: false }));

    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);
    expect(getByTestId('dash-strategy')).toBeTruthy();
    expect(getByTestId('dash-strategy-loading')).toBeTruthy();
  });

  it('renders a no-match state when there are no matches', () => {
    useEventMatchesMock.mockReturnValue(dataResult([]));
    useEventReportsMock.mockReturnValue(dataResult([]));
    useEventTeamsMock.mockReturnValue(dataResult([]));
    useEventEpaMock.mockReturnValue(dataResult({ epaByTeam: new Map(), available: true }));

    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);
    expect(getByTestId('dash-strategy-no-match')).toBeTruthy();
  });

  it('renders predicted scores and per-team source badges (Statbotics available)', () => {
    setupHappyPath(true);
    const { getByTestId, getAllByTestId } = render(<StrategyView eventKey="2026evt" />);

    expect(getByTestId('dash-strategy')).toBeTruthy();

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
    const badgeText = badges.map((b) => b.textContent).join(' ');
    expect(badgeText).toMatch(/blend|epa|scouting/);

    // EPA-unavailable banner is NOT shown when available.
    expect(document.querySelector('[data-testid="epa-unavailable"]')).toBeNull();
  });

  it('shows the epa-unavailable banner but still renders predictions when Statbotics is down', () => {
    setupHappyPath(false);
    const { getByTestId, getAllByTestId } = render(<StrategyView eventKey="2026evt" />);

    const banner = getByTestId('epa-unavailable');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toMatch(/EPA/i);

    expect(getByTestId('dash-next-red-score').textContent).toMatch(/\d/);

    const badges = getAllByTestId('dash-next-source-badge');
    expect(badges.length).toBe(6);
    const badgeText = badges.map((b) => b.textContent).join(' ');
    expect(badgeText).not.toMatch(/blend/);
    expect(badgeText).not.toMatch(/\bepa\b/);
  });

  it('renders per-team component lines that reconcile with the expected points', () => {
    setupHappyPath(true);
    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);

    // Every team row carries a component line; a scouted team's parts sum to its
    // expected points within rounding (±3 for three rounded parts).
    for (const t of [...RED, ...BLUE]) {
      expect(getByTestId(`dash-next-components-${t}`)).toBeTruthy();
    }
    const scoutedRow = getByTestId('dash-next-team-111');
    const expectedNum = parseInt(
      within(scoutedRow).getByTestId('dash-next-team-expected').textContent ?? '',
      10,
    );
    const compNums = (
      getByTestId('dash-next-components-111').textContent?.match(/\d+/g) ?? []
    ).map(Number);
    if (compNums.length >= 3 && Number.isFinite(expectedNum)) {
      const sum = compNums[0] + compNums[1] + compNums[2];
      expect(Math.abs(expectedNum - sum)).toBeLessThanOrEqual(3);
    }
  });

  it('renders the rate-FUEL low-confidence chip ONLY for low-confidence teams, and ONE combined auto field', () => {
    setupHappyPath(true);
    const { getAllByTestId, getByTestId } = render(<StrategyView eventKey="2026evt" />);

    expect(getAllByTestId('fuel-low-confidence').length).toBe(1);
    const lowConfRow = getByTestId('dash-next-team-222');
    expect(within(lowConfRow).getByTestId('fuel-low-confidence')).toBeTruthy();

    const combined = getAllByTestId('combined-auto-stub');
    expect(combined.length).toBe(1);
    expect(combined[0].getAttribute('data-red')).toBeTruthy();
    expect(combined[0].getAttribute('data-blue')).toBeTruthy();

    // 3256 row resolves to an EPA source badge (unscouted).
    const ourRow = getByTestId(`dash-next-team-${OUR_TEAM}`);
    expect(within(ourRow).getByTestId('dash-next-source-badge').textContent?.toLowerCase()).toContain('epa');
  });

  it('mounts the field whiteboard for the selected match', () => {
    setupHappyPath(true);
    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);
    expect(getByTestId('field-whiteboard')).toBeTruthy();
    expect(getByTestId('wb-surface')).toBeTruthy();
    // Basic tools present.
    expect(getByTestId('wb-tool-pen')).toBeTruthy();
    expect(getByTestId('wb-tool-erase')).toBeTruthy();
    expect(getByTestId('wb-undo')).toBeTruthy();
    expect(getByTestId('wb-redo')).toBeTruthy();
    expect(getByTestId('wb-clear')).toBeTruthy();
  });

  it('mounts the alliance matchup panel (exploit/watch + notes)', () => {
    setupHappyPath(true);
    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);
    expect(getByTestId('dash-matchup-panel')).toBeTruthy();
  });

  it('defaults the selector to OUR next match and lets the user view any match', () => {
    setupHappyPath(true);
    const { getByTestId, getAllByTestId } = render(<StrategyView eventKey="2026evt" />);

    const selector = getByTestId('dash-next-match-select') as HTMLSelectElement;
    expect(selector).toBeTruthy();
    expect(selector.value).toBe('2026evt_qm2');

    // The header reflects the selected (default) match.
    expect(getByTestId('dash-strategy-title').textContent).toMatch(/Qual 2|Q2/);
    expect(getByTestId(`dash-next-team-${OUR_TEAM}`)).toBeTruthy();

    // Override: pick qm3 (does NOT include 3256).
    fireEvent.change(selector, { target: { value: '2026evt_qm3' } });
    expect(getByTestId('dash-strategy-title').textContent).toMatch(/Qual 3|Q3/);
    const rows = getAllByTestId(/^dash-next-team-\d+$/);
    const numbers = rows.map((r) => r.getAttribute('data-testid'));
    expect(numbers).toContain('dash-next-team-777');
    expect(numbers).not.toContain(`dash-next-team-${OUR_TEAM}`);
  });

  it('labels playoff semifinals by their SET number, not match_number (no duplicate "Semi 1")', () => {
    const matches = [
      {
        match_key: '2026evt_sf1m1', event_key: '2026evt', comp_level: 'sf', match_number: 1,
        scheduled_time: null, red1: OUR_TEAM, red2: 111, red3: 222, blue1: 333, blue2: 444, blue3: 555,
        actual_red_score: null, actual_blue_score: null, winner: null, result_synced_at: null,
      },
      {
        match_key: '2026evt_sf2m1', event_key: '2026evt', comp_level: 'sf', match_number: 1,
        scheduled_time: null, red1: 777, red2: 888, red3: 999, blue1: 666, blue2: 555, blue3: 444,
        actual_red_score: null, actual_blue_score: null, winner: null, result_synced_at: null,
      },
    ];
    useEventMatchesMock.mockReturnValue(dataResult(matches));
    useEventReportsMock.mockReturnValue(dataResult([]));
    useEventTeamsMock.mockReturnValue(dataResult([]));
    useEventEpaMock.mockReturnValue(dataResult({ epaByTeam: new Map(), available: false }));

    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);
    const selector = getByTestId('dash-next-match-select') as HTMLSelectElement;
    const labels = Array.from(selector.options).map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.startsWith('Semi 1'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Semi 2'))).toBe(true);
    expect(labels.filter((l) => l.startsWith('Semi 1 ')).length).toBe(1);
  });

  it('tracks OUR next match by default and snaps back via the Track button after a manual pick', () => {
    setupHappyPath(true);
    const { getByTestId, queryByTestId } = render(<StrategyView eventKey="2026evt" />);

    const selector = getByTestId('dash-next-match-select') as HTMLSelectElement;
    expect(selector.value).toBe('2026evt_qm2');
    expect(getByTestId('dash-next-tracking')).toBeTruthy();
    expect(queryByTestId('dash-next-track-btn')).toBeNull();

    fireEvent.change(selector, { target: { value: '2026evt_qm3' } });
    expect((getByTestId('dash-next-match-select') as HTMLSelectElement).value).toBe('2026evt_qm3');
    expect(queryByTestId('dash-next-tracking')).toBeNull();
    const trackBtn = getByTestId('dash-next-track-btn');
    expect(trackBtn).toBeTruthy();

    fireEvent.click(trackBtn);
    expect((getByTestId('dash-next-match-select') as HTMLSelectElement).value).toBe('2026evt_qm2');
    expect(getByTestId('dash-next-tracking')).toBeTruthy();
    expect(queryByTestId('dash-next-track-btn')).toBeNull();
  });

  it('live-follows the Nexus next match for our team while tracking', () => {
    setupHappyPath(true);
    useNexusEventStatusMock.mockReturnValue(
      dataResult({
        available: true,
        status: {
          eventKey: '2026evt',
          dataAsOfTime: 1,
          nowQueuing: null,
          onField: null,
          queuing: null,
          matches: [],
          upcoming: [
            {
              label: 'Qualification 3',
              status: 'Now queuing',
              redTeams: [OUR_TEAM, 777, 888],
              blueTeams: [666, 555, 444],
              times: { estimatedStartTime: null, estimatedQueueTime: null, estimatedOnDeckTime: null, estimatedOnFieldTime: null, actualQueueTime: null },
            },
          ],
        },
      }),
    );

    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);
    expect((getByTestId('dash-next-match-select') as HTMLSelectElement).value).toBe('2026evt_qm3');
    expect(getByTestId('dash-next-tracking')).toBeTruthy();
  });

  it('renders the win-prob banner with BOTH red and blue percentages summing to 100', () => {
    setupHappyPath(true);
    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);

    const banner = getByTestId('dash-next-winprob-banner');
    expect(banner).toBeTruthy();

    const red = getByTestId('dash-next-red-winprob');
    const blue = getByTestId('dash-next-blue-winprob');
    expect(red.textContent).toMatch(/%/);
    expect(blue.textContent).toMatch(/%/);

    const redPct = parseInt(red.textContent ?? '', 10);
    const bluePct = parseInt(blue.textContent ?? '', 10);
    expect(Number.isNaN(redPct)).toBe(false);
    expect(Number.isNaN(bluePct)).toBe(false);
    expect(redPct + bluePct).toBe(100);
  });

  it('shows blue% > 50% for a blue-favored matchup', () => {
    const matches = [
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
        actual_red_score: null,
        actual_blue_score: null,
        winner: null,
        result_synced_at: null,
      },
    ];
    const reports: MsrRow[] = [
      row({ target_team_number: 111, match_key: '2026evt_qm1', fuel_points: 1 }),
      row({ target_team_number: 222, match_key: '2026evt_qm1', fuel_points: 1 }),
      row({ target_team_number: 333, match_key: '2026evt_qm1', fuel_points: 90 }),
      row({ target_team_number: 444, match_key: '2026evt_qm1', fuel_points: 90 }),
      row({ target_team_number: 555, match_key: '2026evt_qm1', fuel_points: 90 }),
    ];
    const teams = [...RED, ...BLUE].map((t) => ({ team_number: t, nickname: null }));
    const epaByTeam = new Map<number, number | null>();
    for (const t of [...RED, ...BLUE]) epaByTeam.set(t, null);

    useEventMatchesMock.mockReturnValue(dataResult(matches));
    useEventReportsMock.mockReturnValue(dataResult(reports));
    useEventTeamsMock.mockReturnValue(dataResult(teams));
    useEventEpaMock.mockReturnValue(dataResult({ epaByTeam, available: false }));

    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);
    const bluePct = parseInt(getByTestId('dash-next-blue-winprob').textContent ?? '', 10);
    const redPct = parseInt(getByTestId('dash-next-red-winprob').textContent ?? '', 10);
    expect(bluePct).toBeGreaterThan(50);
    expect(redPct).toBeLessThan(50);
  });

  it('labels a perfect 50/50 as "Even", never crowns a side', () => {
    const matches = [
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
        actual_red_score: null,
        actual_blue_score: null,
        winner: null,
        result_synced_at: null,
      },
    ];
    const teams = [...RED, ...BLUE].map((t) => ({ team_number: t, nickname: null }));
    const epaByTeam = new Map<number, number | null>();
    for (const t of [...RED, ...BLUE]) epaByTeam.set(t, 30);

    useEventMatchesMock.mockReturnValue(dataResult(matches));
    useEventReportsMock.mockReturnValue(dataResult([])); // no scouting -> pure EPA
    useEventTeamsMock.mockReturnValue(dataResult(teams));
    useEventEpaMock.mockReturnValue(dataResult({ epaByTeam, available: true }));

    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);
    const redPct = parseInt(getByTestId('dash-next-red-winprob').textContent ?? '', 10);
    const bluePct = parseInt(getByTestId('dash-next-blue-winprob').textContent ?? '', 10);
    expect(redPct).toBe(50);
    expect(bluePct).toBe(50);
    const label = getByTestId('dash-next-winprob-label').textContent ?? '';
    expect(label).toMatch(/Even/i);
    expect(label).not.toMatch(/favored/i);
  });

  it('marks OUR alliance column and base-team row', () => {
    setupHappyPath(true);
    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);
    // 3256 is on red in qm2 — its row carries the "us" chip.
    const ourRow = getByTestId(`dash-next-team-${OUR_TEAM}`);
    expect(within(ourRow).getByTestId('dash-next-us-chip')).toBeTruthy();
  });
});
