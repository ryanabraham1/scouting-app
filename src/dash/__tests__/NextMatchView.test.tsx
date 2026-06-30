// src/dash/__tests__/NextMatchView.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, within, fireEvent } from '@testing-library/react';
import type { MsrRow } from '@/dash/types';
import { OUR_TEAM } from '@/dash/constants';

// --- mock the data hooks so the view is pure/testable ---
const useEventMatchesMock = vi.fn();
const useEventReportsMock = vi.fn();
const useEventTeamsMock = vi.fn();
const useEventEpaMock = vi.fn();
const useEventScoutsMock = vi.fn();
const useNexusEventStatusMock = vi.fn();

vi.mock('@/dash/useEventData', () => ({
  useEventMatches: (eventKey: string | null) => useEventMatchesMock(eventKey),
  useEventReports: (eventKey: string | null) => useEventReportsMock(eventKey),
  useEventTeams: (eventKey: string | null) => useEventTeamsMock(eventKey),
  useEventEpa: (teams: number[], eventKey: string | null, matches?: unknown) =>
    useEventEpaMock(teams, eventKey, matches),
  // Scout heartbeat: useEventScoutCoverage reads this; without it the new hook
  // would resolve to undefined and throw on render (reddening every test).
  useEventScouts: (eventKey: string | null) => useEventScoutsMock(eventKey),
  useNexusEventStatus: (eventKey: string | null) => useNexusEventStatusMock(eventKey),
  // Broadcast-panel hooks: static safe defaults (their own units cover them).
  useEventInfo: () => ({ data: { name: null, webcast: null } }),
  useTbaRankings: () => ({ data: undefined }),
  useTeamSeasonStats: () => ({
    data: { worldRank: null, totalEpa: null, epaSource: 'none', seasonRecord: null },
  }),
  // Matchup-intelligence: the MatchupPanel mounted by NextMatchView reads notes.
  useMatchupNotes: () => ({ data: new Map<string, string>() }),
}));

// useSync drives the heartbeat's online/pending hints — mock to the real shape.
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

// --- stub the combined auto field to keep this focused on prediction rendering ---
vi.mock('@/dash/CombinedAutoField', () => ({
  default: (props: { redTeams: number[]; blueTeams: number[] }) => (
    <div
      data-testid="combined-auto-stub"
      data-red={props.redTeams.join(',')}
      data-blue={props.blueTeams.join(',')}
    />
  ),
}));

import NextMatchView from '@/dash/NextMatchView';

beforeEach(() => {
  cleanup();
  useEventMatchesMock.mockReset();
  useEventReportsMock.mockReset();
  useEventTeamsMock.mockReset();
  useEventEpaMock.mockReset();
  useEventScoutsMock.mockReset();
  useNexusEventStatusMock.mockReset();
  // Default: Nexus unavailable so the view degrades to the schedule.
  useNexusEventStatusMock.mockReturnValue(dataResult({ status: null, available: false }));
  // Default scout roster (heartbeat denominator). Overridden per-test as needed.
  useEventScoutsMock.mockReturnValue(
    dataResult(
      Array.from({ length: 9 }, (_, i) => ({
        id: `s${i + 1}`,
        display_name: `Scout ${i + 1}`,
        event_key: '2026evt',
      })),
    ),
  );
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

  it('shows OUR last match (not an empty state) when the event is complete', () => {
    const played = (key: string, num: number, ours: boolean) => ({
      match_key: key,
      event_key: '2026evt',
      comp_level: 'qm',
      match_number: num,
      scheduled_time: null,
      red1: ours ? OUR_TEAM : 700,
      red2: 111,
      red3: 222,
      blue1: 333,
      blue2: 444,
      blue3: 555,
      actual_red_score: 80,
      actual_blue_score: 60,
      winner: 'red',
      result_synced_at: '2026-06-26T00:00:00Z',
    });
    const matches = [
      played('2026evt_qm1', 1, true),
      played('2026evt_qm5', 5, false),
      played('2026evt_qm7', 7, true),
    ];
    useEventMatchesMock.mockReturnValue(dataResult(matches));
    useEventReportsMock.mockReturnValue(dataResult([]));
    useEventTeamsMock.mockReturnValue(dataResult([]));
    useEventEpaMock.mockReturnValue(dataResult({ epaByTeam: new Map(), available: false }));

    const { getByTestId, queryByTestId } = render(<NextMatchView eventKey="2026evt" />);
    // Not the empty state; anchored on OUR last match (qm7).
    expect(queryByTestId('dash-next-no-match')).toBeNull();
    expect(getByTestId('dash-next-title').textContent).toMatch(/Q7/);
  });

  it('upcoming rail drops matches at/before the on-field match (removes already-played)', () => {
    const mk = (n: number) => ({
      match_key: `2026evt_qm${n}`,
      event_key: '2026evt',
      comp_level: 'qm',
      match_number: n,
      scheduled_time: null,
      red1: OUR_TEAM,
      red2: 111,
      red3: 222,
      blue1: 333,
      blue2: 444,
      blue3: 555,
      // NOTE: results NOT synced (all unplayed in the DB) — the frontier must
      // still remove qm1–qm3 because Nexus says qm3 is on the field.
      actual_red_score: null,
      actual_blue_score: null,
      winner: null,
      result_synced_at: null,
    });
    useEventMatchesMock.mockReturnValue(dataResult([1, 2, 3, 4, 5].map(mk)));
    useEventReportsMock.mockReturnValue(dataResult([]));
    useEventTeamsMock.mockReturnValue(dataResult([]));
    useEventEpaMock.mockReturnValue(dataResult({ epaByTeam: new Map(), available: true }));

    const nm = (n: number, st: string | null) => ({
      label: `Qualification ${n}`,
      status: st,
      redTeams: [OUR_TEAM, 111, 222],
      blueTeams: [333, 444, 555],
      times: {
        estimatedStartTime: null,
        estimatedQueueTime: null,
        estimatedOnDeckTime: null,
        estimatedOnFieldTime: null,
        actualQueueTime: null,
      },
    });
    useNexusEventStatusMock.mockReturnValue(
      dataResult({
        available: true,
        status: {
          eventKey: '2026evt',
          dataAsOfTime: 1,
          nowQueuing: 'Qualification 4',
          onField: nm(3, 'On field'),
          queuing: nm(4, 'Now queuing'),
          matches: [nm(3, 'On field'), nm(4, 'Now queuing'), nm(5, null)],
          upcoming: [nm(4, 'Now queuing'), nm(5, null)],
        },
      }),
    );

    const { getByTestId } = render(<NextMatchView eventKey="2026evt" />);
    const rail = getByTestId('dash-next-upcoming');
    expect(within(rail).getByText('Q4')).toBeTruthy();
    expect(within(rail).getByText('Q5')).toBeTruthy();
    // qm1, qm2, qm3 are at/before the on-field match -> gone from the rail.
    expect(within(rail).queryByText('Q1')).toBeNull();
    expect(within(rail).queryByText('Q2')).toBeNull();
    expect(within(rail).queryByText('Q3')).toBeNull();
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

  it('renders the rate-FUEL low-confidence chip and ONE combined auto field for the matchup', () => {
    setupHappyPath(true);
    const { getAllByTestId, getByTestId } = render(<NextMatchView eventKey="2026evt" />);

    // Rate-FUEL low-confidence indicator present where fuel is shown.
    expect(getAllByTestId('fuel-low-confidence').length).toBeGreaterThan(0);

    // Exactly ONE combined auto field for both alliances (no per-column fields,
    // no mode toggle).
    const combined = getAllByTestId('combined-auto-stub');
    expect(combined.length).toBe(1);
    // It receives both alliances' teams.
    expect(combined[0].getAttribute('data-red')).toBeTruthy();
    expect(combined[0].getAttribute('data-blue')).toBeTruthy();

    // 3256 row resolves to an EPA source badge (unscouted).
    const ourRow = getByTestId(`dash-next-team-${OUR_TEAM}`);
    expect(within(ourRow).getByTestId('dash-next-source-badge').textContent?.toLowerCase()).toContain('epa');
  });

  it('defaults the selector to OUR next match and lets the user view any match', () => {
    setupHappyPath(true);
    const { getByTestId, getAllByTestId } = render(<NextMatchView eventKey="2026evt" />);

    // A match selector is present and defaults to OUR auto-picked next match (qm2).
    const selector = getByTestId('dash-next-match-select') as HTMLSelectElement;
    expect(selector).toBeTruthy();
    expect(selector.value).toBe('2026evt_qm2');

    // The header reflects the selected (default) match in broadcast short form: Q2.
    expect(getByTestId('dash-next-title').textContent).toMatch(/Q2/);
    // OUR team's row is present for the default selection.
    expect(getByTestId(`dash-next-team-${OUR_TEAM}`)).toBeTruthy();

    // Override: pick qm3 (does NOT include 3256).
    fireEvent.change(selector, { target: { value: '2026evt_qm3' } });
    expect(getByTestId('dash-next-title').textContent).toMatch(/Q3/);
    // qm3 teams: 777,888,999 / 666,555,444 — six team rows, no 3256.
    const rows = getAllByTestId(/^dash-next-team-\d+$/);
    const numbers = rows.map((r) => r.getAttribute('data-testid'));
    expect(numbers).toContain('dash-next-team-777');
    expect(numbers).not.toContain(`dash-next-team-${OUR_TEAM}`);
  });

  it('tracks OUR next match by default and snaps back via the Track button after a manual pick', () => {
    setupHappyPath(true);
    const { getByTestId, queryByTestId } = render(<NextMatchView eventKey="2026evt" />);

    const selector = getByTestId('dash-next-match-select') as HTMLSelectElement;
    // Default: tracking OUR next match (qm2) -> tracking chip shown, no Track button.
    expect(selector.value).toBe('2026evt_qm2');
    expect(getByTestId('dash-next-tracking')).toBeTruthy();
    expect(queryByTestId('dash-next-track-btn')).toBeNull();

    // Manual pick drops out of tracking -> chip gone, Track button offered.
    fireEvent.change(selector, { target: { value: '2026evt_qm3' } });
    expect((getByTestId('dash-next-match-select') as HTMLSelectElement).value).toBe('2026evt_qm3');
    expect(queryByTestId('dash-next-tracking')).toBeNull();
    const trackBtn = getByTestId('dash-next-track-btn');
    expect(trackBtn).toBeTruthy();

    // Clicking Track snaps back to OUR next match (qm2) and re-enters tracking.
    fireEvent.click(trackBtn);
    expect((getByTestId('dash-next-match-select') as HTMLSelectElement).value).toBe('2026evt_qm2');
    expect(getByTestId('dash-next-tracking')).toBeTruthy();
    expect(queryByTestId('dash-next-track-btn')).toBeNull();
  });

  it('live-follows the Nexus next match for our team while tracking', () => {
    setupHappyPath(true);
    // Nexus reports qm3-equivalent ("Qualification 3") as our next upcoming match.
    // (qm3 in the fixture does NOT include 3256, so add 3256 to it via Nexus teams.)
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

    const { getByTestId } = render(<NextMatchView eventKey="2026evt" />);
    // While tracking, the view follows Nexus' next match (qm3) over the schedule (qm2).
    expect((getByTestId('dash-next-match-select') as HTMLSelectElement).value).toBe('2026evt_qm3');
    expect(getByTestId('dash-next-tracking')).toBeTruthy();
  });

  it('renders the win-prob banner with BOTH red and blue percentages', () => {
    setupHappyPath(true);
    const { getByTestId } = render(<NextMatchView eventKey="2026evt" />);

    const banner = getByTestId('dash-next-winprob-banner');
    expect(banner).toBeTruthy();

    const red = getByTestId('dash-next-red-winprob');
    const blue = getByTestId('dash-next-blue-winprob');
    // Both alliances' win probability shown as percentages.
    expect(red.textContent).toMatch(/%/);
    expect(blue.textContent).toMatch(/%/);

    // Red% and Blue% are complementary (sum to ~100%).
    const redPct = parseInt(red.textContent ?? '', 10);
    const bluePct = parseInt(blue.textContent ?? '', 10);
    expect(Number.isNaN(redPct)).toBe(false);
    expect(Number.isNaN(bluePct)).toBe(false);
    expect(redPct + bluePct).toBe(100);
  });

  it('shows blue% > 50% for a blue-favored matchup', () => {
    // Blue alliance scouted with far higher fuel output than red -> blue favored.
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
    // Red teams: weak. Blue teams: strong. (3256 is unscouted -> 0 from scouting.)
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

    const { getByTestId } = render(<NextMatchView eventKey="2026evt" />);
    const bluePct = parseInt(getByTestId('dash-next-blue-winprob').textContent ?? '', 10);
    const redPct = parseInt(getByTestId('dash-next-red-winprob').textContent ?? '', 10);
    expect(bluePct).toBeGreaterThan(50);
    expect(redPct).toBeLessThan(50);
  });

  it('renders the Nexus-fed upcoming list when Nexus is available', () => {
    setupHappyPath(true);
    useNexusEventStatusMock.mockReturnValue(
      dataResult({
        available: true,
        status: {
          eventKey: '2026evt',
          dataAsOfTime: 1,
          nowQueuing: 'Qualification 2',
          onField: {
            label: 'Qualification 1',
            status: 'On field',
            redTeams: [OUR_TEAM, 111, 222],
            blueTeams: [333, 444, 555],
            times: { estimatedStartTime: null, estimatedQueueTime: null, estimatedOnDeckTime: null, estimatedOnFieldTime: null, actualQueueTime: null },
          },
          queuing: {
            label: 'Qualification 2',
            status: 'Now queuing',
            redTeams: [OUR_TEAM, 111, 222],
            blueTeams: [333, 444, 555],
            times: { estimatedStartTime: null, estimatedQueueTime: null, estimatedOnDeckTime: null, estimatedOnFieldTime: null, actualQueueTime: null },
          },
          matches: [],
          upcoming: [
            {
              label: 'Qualification 2',
              status: 'Now queuing',
              redTeams: [OUR_TEAM, 111, 222],
              blueTeams: [333, 444, 555],
              times: { estimatedStartTime: null, estimatedQueueTime: null, estimatedOnDeckTime: null, estimatedOnFieldTime: null, actualQueueTime: null },
            },
          ],
        },
      }),
    );

    const { getByTestId } = render(<NextMatchView eventKey="2026evt" />);
    // Nexus-fed upcoming list rendered (no live badge — those were removed).
    expect(getByTestId('dash-next-upcoming')).toBeTruthy();
  });

  it('no longer renders the scout heartbeat (moved to the Scouters tab)', () => {
    setupHappyPath(true);
    // Even with fresh, attributed reports on the anchored match, the heartbeat
    // tile is gone from Next Match — it now lives in the Scouters tab.
    const fresh = new Date().toISOString();
    const reports: MsrRow[] = [
      row({ target_team_number: OUR_TEAM, match_key: '2026evt_qm2', station: 1, scout_id: 's1', server_received_at: fresh }),
      row({ target_team_number: 111, match_key: '2026evt_qm2', station: 2, scout_id: 's2', server_received_at: fresh }),
      row({ target_team_number: 222, match_key: '2026evt_qm2', station: 3, scout_id: 's3', server_received_at: fresh }),
    ];
    useEventReportsMock.mockReturnValue(dataResult(reports));

    const { queryByTestId } = render(<NextMatchView eventKey="2026evt" />);
    expect(queryByTestId('scout-heartbeat')).toBeNull();
    expect(queryByTestId('scout-heartbeat-count')).toBeNull();
    expect(queryByTestId('scout-heartbeat-last')).toBeNull();
  });

  it('no longer renders the per-team component estimate line (moved to Alliance sim)', () => {
    setupHappyPath(true);
    const { queryByTestId, getByTestId, getAllByTestId } = render(
      <NextMatchView eventKey="2026evt" />,
    );
    // The per-team auto/fuel/climb component line is gone from Next Match.
    for (const t of [...RED, ...BLUE]) {
      expect(queryByTestId(`dash-next-components-${t}`)).toBeNull();
    }
    // But the predicted alliance scores, win prob, and source badges stay intact.
    expect(getByTestId('dash-next-red-score').textContent).toMatch(/\d/);
    expect(getByTestId('dash-next-blue-score').textContent).toMatch(/\d/);
    expect(getByTestId('dash-next-red-winprob').textContent).toMatch(/%/);
    expect(getAllByTestId('dash-next-source-badge').length).toBe(6);
  });

  it('does not render the alliance matchup panel (removed)', () => {
    setupHappyPath(true);
    const { queryByTestId } = render(<NextMatchView eventKey="2026evt" />);
    expect(queryByTestId('dash-matchup-panel')).toBeNull();
  });
});
