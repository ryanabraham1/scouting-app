// src/dash/__tests__/NextMatchView.test.tsx
// Pit Display (formerly "Next Match"). The prediction breakdown / selector /
// auto-routine tests moved to StrategyView.test.tsx along with the UI.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { OUR_TEAM } from '@/dash/constants';

// --- mock the data hooks so the view is pure/testable ---
const useEventMatchesMock = vi.fn();
const useNexusEventStatusMock = vi.fn();

vi.mock('@/dash/useEventData', () => ({
  useEventMatches: (eventKey: string | null) => useEventMatchesMock(eventKey),
  useNexusEventStatus: (eventKey: string | null) => useNexusEventStatusMock(eventKey),
  // Broadcast-panel hooks: static safe defaults (their own units cover them).
  useEventInfo: () => ({ data: { name: null, webcast: null } }),
  useTbaRankings: () => ({ data: undefined }),
  useTeamSeasonStats: () => ({
    data: { worldRank: null, totalEpa: null, epaSource: 'none', seasonRecord: null },
  }),
}));

import NextMatchView from '@/dash/NextMatchView';

beforeEach(() => {
  cleanup();
  useEventMatchesMock.mockReset();
  useNexusEventStatusMock.mockReset();
  // Default: Nexus unavailable so the view degrades to the schedule.
  useNexusEventStatusMock.mockReturnValue(dataResult({ status: null, available: false }));
});

const RED = [OUR_TEAM, 111, 222];
const BLUE = [333, 444, 555];

function loadingResult() {
  return { data: undefined, isLoading: true, isError: false };
}
function dataResult<T>(data: T) {
  return { data, isLoading: false, isError: false };
}

function happyMatches() {
  // 3256's next unplayed qm is match 2 (match 1 is played, match 3 doesn't include 3256).
  return [
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
}

describe('NextMatchView (Pit Display)', () => {
  it('renders a loading state while the schedule is loading', () => {
    useEventMatchesMock.mockReturnValue(loadingResult());

    const { getByTestId } = render(<NextMatchView eventKey="2026evt" />);
    expect(getByTestId('dash-next')).toBeTruthy();
    expect(getByTestId('dash-next-loading')).toBeTruthy();
  });

  it('renders a no-match state when the event has no matches', () => {
    useEventMatchesMock.mockReturnValue(dataResult([]));

    const { getByTestId } = render(<NextMatchView eventKey="2026evt" />);
    expect(getByTestId('dash-next-no-match')).toBeTruthy();
  });

  it('auto-anchors the hero on OUR next unplayed match', () => {
    useEventMatchesMock.mockReturnValue(dataResult(happyMatches()));

    const { getByTestId } = render(<NextMatchView eventKey="2026evt" />);
    expect(getByTestId('dash-next-title').textContent).toMatch(/Q2/);
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

  it('live-follows the Nexus next match for our team in the hero card', () => {
    useEventMatchesMock.mockReturnValue(dataResult(happyMatches()));
    // Nexus reports "Qualification 3" as our next upcoming match.
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
    expect(getByTestId('dash-next-title').textContent).toMatch(/Q3/);
  });

  it('no longer renders the prediction breakdown (moved to the Strategy tab)', () => {
    useEventMatchesMock.mockReturnValue(dataResult(happyMatches()));

    const { queryByTestId } = render(<NextMatchView eventKey="2026evt" />);
    expect(queryByTestId('dash-next-winprob-banner')).toBeNull();
    expect(queryByTestId('dash-next-red-score')).toBeNull();
    expect(queryByTestId('dash-next-match-select')).toBeNull();
    expect(queryByTestId('dash-next-source-badge')).toBeNull();
    expect(queryByTestId('combined-auto')).toBeNull();
    expect(queryByTestId('dash-matchup-panel')).toBeNull();
    for (const t of [...RED, ...BLUE]) {
      expect(queryByTestId(`dash-next-components-${t}`)).toBeNull();
    }
  });

  it('no longer renders the scout heartbeat (moved to the Scouters tab)', () => {
    useEventMatchesMock.mockReturnValue(dataResult(happyMatches()));

    const { queryByTestId } = render(<NextMatchView eventKey="2026evt" />);
    expect(queryByTestId('scout-heartbeat')).toBeNull();
    expect(queryByTestId('scout-heartbeat-count')).toBeNull();
    expect(queryByTestId('scout-heartbeat-last')).toBeNull();
  });
});
