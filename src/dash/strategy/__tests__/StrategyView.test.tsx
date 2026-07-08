// src/dash/strategy/__tests__/StrategyView.test.tsx
// The Strategy tab: two sub-views (Whiteboard boards per game phase + robot
// start squares / Analytics with the prediction breakdown moved from Next
// Match), OUR-matches-only selector with tracking, manual team entry, and
// per-team red flags.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, cleanup, within, fireEvent, type RenderResult } from '@testing-library/react';
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
vi.mock('@/dash/strategy/strategyCanvasClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/dash/strategy/strategyCanvasClient')>();
  return {
    MANUAL_MATCH_KEY: real.MANUAL_MATCH_KEY,
    canvasKeyFor: real.canvasKeyFor,
    useStrategyCanvas: () => ({ data: { strokes: [], deletedIds: [], robots: [] } }),
    saveStrategyCanvas: vi.fn(async () => {}),
  };
});

// Pit facts per team: empty map (covered by useTeamPit's own tests).
vi.mock('@/dash/useTeamPit', () => ({
  useEventPits: () => ({ data: new Map() }),
}));

// The recharts section is a lazy chunk — stub it (SVG charts don't lay out in
// jsdom; the surrounding dashboard math is asserted via the tape/team rows).
vi.mock('@/dash/strategy/MatchupCharts', () => ({
  default: () => <div data-testid="matchup-charts-stub" />,
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

// The jsdom-compat shim lacks a full localStorage — install an in-memory one
// (same pattern as RankingView.test.tsx) for the manual-teams persistence.
beforeAll(() => {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    get length() {
      return mem.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
});

beforeEach(() => {
  cleanup();
  localStorage.clear();
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

function mkMatch(
  key: string,
  num: number,
  red: number[],
  blue: number[],
  played = false,
): Record<string, unknown> {
  return {
    match_key: key,
    event_key: '2026evt',
    comp_level: 'qm',
    match_number: num,
    scheduled_time: null,
    red1: red[0] ?? null,
    red2: red[1] ?? null,
    red3: red[2] ?? null,
    blue1: blue[0] ?? null,
    blue2: blue[1] ?? null,
    blue3: blue[2] ?? null,
    actual_red_score: played ? 100 : null,
    actual_blue_score: played ? 90 : null,
    winner: played ? 'red' : null,
    result_synced_at: null,
  };
}

function setupHappyPath(available: boolean) {
  // OUR next unplayed match is qm2. qm3 does NOT include us (must be absent
  // from the selector); qm4 does (a second OUR match to pick manually).
  const matches = [
    mkMatch('2026evt_qm1', 1, RED, BLUE, true),
    mkMatch('2026evt_qm2', 2, RED, BLUE),
    mkMatch('2026evt_qm3', 3, [777, 888, 999], [666, 555, 444]),
    mkMatch('2026evt_qm4', 4, [777, 888, 999], [OUR_TEAM, 555, 444]),
  ];

  // Reports: give the scouted teams some data (3256 is never scouted).
  // 111 is the CLEAN team (no defense, no incidents) — the red-flag test
  // asserts its card carries no flag list.
  const reports: MsrRow[] = [
    row({ target_team_number: 111, match_key: '2026evt_qm1', fuel_points: 12, defense_rating: 0 }),
    row({ target_team_number: 111, match_key: '2026evt_qm0', fuel_points: 8, defense_rating: 0 }),
    // 222 is rate-derived (low confidence) → the ONLY row that should wear the
    // low-confidence chip.
    row({ target_team_number: 222, match_key: '2026evt_qm1', fuel_points: 20, fuel_estimate_confidence: 0.3 }),
    row({ target_team_number: 333, match_key: '2026evt_qm1', fuel_points: 15 }),
    // 444 died twice → a high-severity red flag on its card.
    row({ target_team_number: 444, match_key: '2026evt_qm1', fuel_points: 5, died: true }),
    row({ target_team_number: 444, match_key: '2026evt_qm0', fuel_points: 5, died: true }),
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
  for (const t of [...RED, ...BLUE, 777, 888, 999, 666]) {
    epaByTeam.set(t, available ? 25 : null);
  }

  useEventMatchesMock.mockReturnValue(dataResult(matches));
  useEventReportsMock.mockReturnValue(dataResult(reports));
  useEventTeamsMock.mockReturnValue(dataResult(teams));
  useEventEpaMock.mockReturnValue(dataResult({ epaByTeam, available }));
}

/** The analytics sub-view is behind the segmented selector — open it. */
function openAnalytics(utils: RenderResult): void {
  fireEvent.click(utils.getByRole('tab', { name: 'Analytics' }));
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

  it('with NO schedule it stays usable: manual matchup + whiteboard still mount', () => {
    useEventMatchesMock.mockReturnValue(dataResult([]));
    useEventReportsMock.mockReturnValue(dataResult([]));
    useEventTeamsMock.mockReturnValue(dataResult([]));
    useEventEpaMock.mockReturnValue(dataResult({ epaByTeam: new Map(), available: true }));

    const { getByTestId, queryByTestId } = render(<StrategyView eventKey="2026evt" />);
    expect(getByTestId('dash-strategy-no-schedule')).toBeTruthy();
    expect(getByTestId('dash-strategy-title').textContent).toMatch(/Manual matchup/i);
    expect(getByTestId('field-whiteboard')).toBeTruthy();
    expect(queryByTestId('dash-next-match-select')).toBeNull();
  });

  it('renders predicted scores and per-team source badges (Statbotics available)', () => {
    setupHappyPath(true);
    const utils = render(<StrategyView eventKey="2026evt" />);
    openAnalytics(utils);
    const { getByTestId, getAllByTestId } = utils;

    const redScore = getByTestId('dash-next-red-score');
    const blueScore = getByTestId('dash-next-blue-score');
    expect(redScore.textContent).toMatch(/\d/);
    expect(blueScore.textContent).toMatch(/\d/);
    expect(Number.isNaN(parseInt(redScore.textContent ?? '', 10))).toBe(false);

    expect(getByTestId('dash-next-red-winprob').textContent).toMatch(/%/);

    const badges = getAllByTestId('dash-next-source-badge');
    expect(badges.length).toBe(6);
    const badgeText = badges.map((b) => b.textContent).join(' ');
    expect(badgeText).toMatch(/blend|epa|scouting/);

    expect(document.querySelector('[data-testid="epa-unavailable"]')).toBeNull();
  });

  it('renders predictions with NO EPA banner when Statbotics is down (banner removed)', () => {
    setupHappyPath(false);
    const utils = render(<StrategyView eventKey="2026evt" />);
    openAnalytics(utils);
    const { getByTestId, getAllByTestId, queryByTestId } = utils;

    // The Statbotics-offline banner was removed from this tab (vertical space).
    expect(queryByTestId('epa-unavailable')).toBeNull();
    expect(queryByTestId('epa-local')).toBeNull();
    expect(getByTestId('dash-next-red-score').textContent).toMatch(/\d/);

    const badges = getAllByTestId('dash-next-source-badge');
    expect(badges.length).toBe(6);
    const badgeText = badges.map((b) => b.textContent).join(' ');
    expect(badgeText).not.toMatch(/blend/);
    expect(badgeText).not.toMatch(/\bepa\b/);
  });

  it('shows the matchup strip on the whiteboard view with OUR alliance badged', () => {
    setupHappyPath(true);
    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);

    // Default sub-view is the whiteboard — the matchup must still be glanceable.
    expect(getByTestId('field-whiteboard')).toBeTruthy();
    const strip = getByTestId('dash-strategy-matchup');
    for (const t of [...RED, ...BLUE]) {
      expect(strip.textContent).toContain(String(t));
    }
    // We're on red in qm2 — the red chip group carries the "us" badge.
    const red = getByTestId('dash-strategy-matchup-red');
    expect(red.textContent?.toLowerCase()).toContain('us');
    const blue = getByTestId('dash-strategy-matchup-blue');
    expect(blue.textContent?.toLowerCase()).not.toContain('us');
  });

  it('renders per-team component lines that reconcile with the expected points', () => {
    setupHappyPath(true);
    const utils = render(<StrategyView eventKey="2026evt" />);
    openAnalytics(utils);
    const { getByTestId } = utils;

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

  it('shows red flags on the team cards (444 died twice → high severity)', () => {
    setupHappyPath(true);
    const utils = render(<StrategyView eventKey="2026evt" />);
    openAnalytics(utils);
    const { getByTestId, queryByTestId } = utils;

    const flags = getByTestId('dash-next-flags-444');
    expect(flags.textContent).toMatch(/Died \/ lost comms in 2 of 2/);
    expect(flags.querySelector('[data-severity="high"]')).toBeTruthy();
    // A clean team shows no flag list at all.
    expect(queryByTestId('dash-next-flags-111')).toBeNull();
  });

  it('renders the rate-FUEL low-confidence chip ONLY for low-confidence teams, and ONE combined auto field', () => {
    setupHappyPath(true);
    const utils = render(<StrategyView eventKey="2026evt" />);
    openAnalytics(utils);
    const { getAllByTestId, getByTestId } = utils;

    expect(getAllByTestId('fuel-low-confidence').length).toBe(1);
    const lowConfRow = getByTestId('dash-next-team-222');
    expect(within(lowConfRow).getByTestId('fuel-low-confidence')).toBeTruthy();

    const combined = getAllByTestId('combined-auto-stub');
    expect(combined.length).toBe(1);

    const ourRow = getByTestId(`dash-next-team-${OUR_TEAM}`);
    expect(within(ourRow).getByTestId('dash-next-source-badge').textContent?.toLowerCase()).toContain('epa');
  });

  it('marks OUR alliance column and base-team row', () => {
    setupHappyPath(true);
    const utils = render(<StrategyView eventKey="2026evt" />);
    openAnalytics(utils);
    const ourRow = utils.getByTestId(`dash-next-team-${OUR_TEAM}`);
    expect(within(ourRow).getByTestId('dash-next-us-chip')).toBeTruthy();
  });

  it('mounts the alliance matchup panel in the analytics view', () => {
    setupHappyPath(true);
    const utils = render(<StrategyView eventKey="2026evt" />);
    openAnalytics(utils);
    expect(utils.getByTestId('dash-matchup-panel')).toBeTruthy();
  });

  it('renders the matchup dashboard (tale of the tape + per-team comparison) in analytics', async () => {
    setupHappyPath(true);
    const utils = render(<StrategyView eventKey="2026evt" />);
    openAnalytics(utils);
    const { getByTestId, findByTestId } = utils;

    expect(getByTestId('matchup-dashboard')).toBeTruthy();
    // Tale of the tape: projected score row carries both alliance numbers.
    const scoreRow = getByTestId('tape-row-projected-score');
    expect(scoreRow.textContent).toMatch(/\d/);
    // Teleop (not "fuel") is the phase label.
    expect(getByTestId('tape-row-teleop-pts')).toBeTruthy();
    // One comparison row per team, base team included.
    for (const t of [...RED, ...BLUE]) {
      expect(getByTestId(`matchup-dash-team-${t}`)).toBeTruthy();
    }
    // The lazy charts section resolves (stubbed here).
    expect(await findByTestId('matchup-charts-stub')).toBeTruthy();
  });

  it('defaults to the whiteboard view with five phase boards', () => {
    setupHappyPath(true);
    const { getByTestId, getByRole } = render(<StrategyView eventKey="2026evt" />);

    // Whiteboard is the default sub-view.
    const board = getByTestId('field-whiteboard');
    expect(board.getAttribute('data-phase')).toBe('auto');
    // All five phase tabs exist; switching remounts the board on that phase.
    for (const label of ['Auto', 'Transition', 'Active', 'Inactive', 'Endgame']) {
      expect(getByRole('tab', { name: label })).toBeTruthy();
    }
    fireEvent.click(getByRole('tab', { name: 'Endgame' }));
    expect(getByTestId('field-whiteboard').getAttribute('data-phase')).toBe('endgame');
  });

  it('shows draggable robot start squares + a color key for OUR alliance on the auto board only', () => {
    setupHappyPath(true);
    const { getByTestId, getByRole, queryByTestId } = render(
      <StrategyView eventKey="2026evt" />,
    );

    // qm2: we're on RED with 111 and 222 — three squares + the color key.
    for (const t of RED) expect(getByTestId(`wb-robot-${t}`)).toBeTruthy();
    const key = getByTestId('wb-robot-key');
    for (const t of RED) expect(key.textContent).toContain(String(t));

    // Not on the other phase boards.
    fireEvent.click(getByRole('tab', { name: 'Active' }));
    expect(queryByTestId(`wb-robot-${OUR_TEAM}`)).toBeNull();
    expect(queryByTestId('wb-robot-key')).toBeNull();
  });

  it('lists ONLY our matches in the selector', () => {
    setupHappyPath(true);
    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);

    const selector = getByTestId('dash-next-match-select') as HTMLSelectElement;
    const values = Array.from(selector.options).map((o) => o.value);
    expect(values).toContain('2026evt_qm1');
    expect(values).toContain('2026evt_qm2');
    expect(values).toContain('2026evt_qm4');
    expect(values).not.toContain('2026evt_qm3'); // not our match
  });

  it('defaults the selector to OUR next match and lets the user pin another OUR match', () => {
    setupHappyPath(true);
    const { getByTestId, queryByTestId } = render(<StrategyView eventKey="2026evt" />);

    const selector = getByTestId('dash-next-match-select') as HTMLSelectElement;
    expect(selector.value).toBe('2026evt_qm2');
    expect(getByTestId('dash-next-tracking')).toBeTruthy();
    expect(queryByTestId('dash-next-track-btn')).toBeNull();

    fireEvent.change(selector, { target: { value: '2026evt_qm4' } });
    expect((getByTestId('dash-next-match-select') as HTMLSelectElement).value).toBe('2026evt_qm4');
    expect(getByTestId('dash-strategy-title').textContent).toMatch(/Qual 4|Q4/);
    expect(queryByTestId('dash-next-tracking')).toBeNull();

    fireEvent.click(getByTestId('dash-next-track-btn'));
    expect((getByTestId('dash-next-match-select') as HTMLSelectElement).value).toBe('2026evt_qm2');
    expect(getByTestId('dash-next-tracking')).toBeTruthy();
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
        scheduled_time: null, red1: 777, red2: 888, red3: 999, blue1: 666, blue2: 555, blue3: OUR_TEAM,
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
              label: 'Qualification 4',
              status: 'Now queuing',
              redTeams: [777, 888, 999],
              blueTeams: [OUR_TEAM, 555, 444],
              times: { estimatedStartTime: null, estimatedQueueTime: null, estimatedOnDeckTime: null, estimatedOnFieldTime: null, actualQueueTime: null },
            },
          ],
        },
      }),
    );

    const { getByTestId } = render(<StrategyView eventKey="2026evt" />);
    expect((getByTestId('dash-next-match-select') as HTMLSelectElement).value).toBe('2026evt_qm4');
    expect(getByTestId('dash-next-tracking')).toBeTruthy();
  });

  it('manual team entry overrides the lineup and drives the prediction', () => {
    setupHappyPath(true);
    const utils = render(<StrategyView eventKey="2026evt" />);
    const { getByTestId } = utils;

    fireEvent.click(getByTestId('dash-strategy-edit-teams'));
    const set = (tid: string, v: string) =>
      fireEvent.change(getByTestId(tid), { target: { value: v } });
    set('manual-team-red1', '1', );
    set('manual-team-red1', '1690');
    set('manual-team-red2', '2056');
    set('manual-team-red3', '254');
    set('manual-team-blue1', String(OUR_TEAM));
    set('manual-team-blue2', '118');
    set('manual-team-blue3', '148');
    fireEvent.click(getByTestId('manual-teams-apply'));

    expect(getByTestId('dash-strategy-manual-chip')).toBeTruthy();

    openAnalytics(utils);
    expect(getByTestId('dash-next-team-1690')).toBeTruthy();
    expect(getByTestId(`dash-next-team-${OUR_TEAM}`)).toBeTruthy();
    // We're on BLUE in the manual lineup — the base-team chip rides along.
    const ourRow = getByTestId(`dash-next-team-${OUR_TEAM}`);
    expect(within(ourRow).getByTestId('dash-next-us-chip')).toBeTruthy();
  });

  it('renders the win-prob banner with BOTH percentages summing to 100', () => {
    setupHappyPath(true);
    const utils = render(<StrategyView eventKey="2026evt" />);
    openAnalytics(utils);
    const { getByTestId } = utils;

    const red = getByTestId('dash-next-red-winprob');
    const blue = getByTestId('dash-next-blue-winprob');
    const redPct = parseInt(red.textContent ?? '', 10);
    const bluePct = parseInt(blue.textContent ?? '', 10);
    expect(Number.isNaN(redPct)).toBe(false);
    expect(redPct + bluePct).toBe(100);
  });

  it('shows blue% > 50% for a blue-favored matchup', () => {
    const matches = [mkMatch('2026evt_qm2', 2, RED, BLUE)];
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

    const utils = render(<StrategyView eventKey="2026evt" />);
    openAnalytics(utils);
    const bluePct = parseInt(utils.getByTestId('dash-next-blue-winprob').textContent ?? '', 10);
    const redPct = parseInt(utils.getByTestId('dash-next-red-winprob').textContent ?? '', 10);
    expect(bluePct).toBeGreaterThan(50);
    expect(redPct).toBeLessThan(50);
  });

  it('labels a perfect 50/50 as "Even", never crowns a side', () => {
    const matches = [mkMatch('2026evt_qm2', 2, RED, BLUE)];
    const teams = [...RED, ...BLUE].map((t) => ({ team_number: t, nickname: null }));
    const epaByTeam = new Map<number, number | null>();
    for (const t of [...RED, ...BLUE]) epaByTeam.set(t, 30);

    useEventMatchesMock.mockReturnValue(dataResult(matches));
    useEventReportsMock.mockReturnValue(dataResult([])); // no scouting -> pure EPA
    useEventTeamsMock.mockReturnValue(dataResult(teams));
    useEventEpaMock.mockReturnValue(dataResult({ epaByTeam, available: true }));

    const utils = render(<StrategyView eventKey="2026evt" />);
    openAnalytics(utils);
    const redPct = parseInt(utils.getByTestId('dash-next-red-winprob').textContent ?? '', 10);
    const bluePct = parseInt(utils.getByTestId('dash-next-blue-winprob').textContent ?? '', 10);
    expect(redPct).toBe(50);
    expect(bluePct).toBe(50);
    const label = utils.getByTestId('dash-next-winprob-label').textContent ?? '';
    expect(label).toMatch(/Even/i);
    expect(label).not.toMatch(/favored/i);
  });
});
