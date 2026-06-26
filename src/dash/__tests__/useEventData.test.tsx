import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// --- supabase mock: a chainable query builder that resolves to {data,error} ---
interface BuilderResult {
  data: unknown;
  error: unknown;
}
const tableResults: Record<string, BuilderResult> = {};

function makeBuilder(result: BuilderResult) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of ['select', 'eq', 'order', 'in', 'is']) {
    builder[method] = vi.fn(chain);
  }
  // Awaiting the builder resolves to the result.
  (builder as { then: unknown }).then = (
    resolve: (r: BuilderResult) => unknown,
  ) => resolve(result);
  return builder;
}

const fromMock = vi.fn((table: string) =>
  makeBuilder(tableResults[table] ?? { data: [], error: null }),
);

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => fromMock(table),
  },
}));

// --- proxies mock ---
const tbaGetMock = vi.fn();
const statboticsGetMock = vi.fn();
const nexusGetMock = vi.fn();
const epaFromTeamEventMock = vi.fn();
vi.mock('@/dash/proxies', () => ({
  tbaGet: (path: string) => tbaGetMock(path),
  statboticsGet: (path: string) => statboticsGetMock(path),
  nexusGet: (path: string) => nexusGetMock(path),
  epaFromTeamEvent: (json: unknown) => epaFromTeamEventMock(json),
}));

import {
  useEventReports,
  useEventMatches,
  useEventTeams,
  useEventScouts,
  useTbaRankings,
  useEventEpa,
  useNexusEventStatus,
  useTeamSeasonStats,
} from '../useEventData';
// The season-wide EPA fallback fetches per-event matches + per-team events
// through this SHARED query client (queryClient.fetchQuery), so they cache /
// dedupe across hooks. Clear it between tests to keep them isolated.
import { queryClient as sharedQueryClient } from '@/lib/queryPersist';

import { useActiveEvent } from '../useActiveEvent';

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useEventData', () => {
  beforeEach(() => {
    fromMock.mockClear();
    tbaGetMock.mockReset();
    statboticsGetMock.mockReset();
    nexusGetMock.mockReset();
    epaFromTeamEventMock.mockReset();
    for (const k of Object.keys(tableResults)) delete tableResults[k];
    // The cross-event EPA caches live on the shared client — drop them so each
    // test starts cold and tbaGet call-count assertions are meaningful.
    sharedQueryClient.clear();
  });

  it('useEventReports resolves rows from match_scouting_report', async () => {
    tableResults['match_scouting_report'] = {
      data: [{ target_team_number: 254, match_key: 'qm1' }],
      error: null,
    };
    const { result } = renderHook(() => useEventReports('2026casnv'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ target_team_number: 254, match_key: 'qm1' }]);
    expect(fromMock).toHaveBeenCalledWith('match_scouting_report');
  });

  it('useEventMatches resolves rows from match', async () => {
    tableResults['match'] = {
      data: [{ match_key: 'qm1', event_key: '2026casnv' }],
      error: null,
    };
    const { result } = renderHook(() => useEventMatches('2026casnv'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ match_key: 'qm1', event_key: '2026casnv' }]);
    expect(fromMock).toHaveBeenCalledWith('match');
  });

  it('useEventTeams resolves teams for the event', async () => {
    tableResults['event_team'] = {
      data: [{ team: { team_number: 254, nickname: 'Cheesy' } }],
      error: null,
    };
    const { result } = renderHook(() => useEventTeams('2026casnv'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ team_number: 254, nickname: 'Cheesy' }]);
  });

  it('useEventScouts resolves scouts for the event', async () => {
    tableResults['scout'] = {
      data: [{ id: 's1', display_name: 'Ada', event_key: '2026casnv' }],
      error: null,
    };
    const { result } = renderHook(() => useEventScouts('2026casnv'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { id: 's1', display_name: 'Ada', event_key: '2026casnv' },
    ]);
    expect(fromMock).toHaveBeenCalledWith('scout');
  });

  it('useTbaRankings calls tbaGet with the rankings path', async () => {
    tbaGetMock.mockResolvedValue({ rankings: [] });
    const { result } = renderHook(() => useTbaRankings('2026casnv'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026casnv/rankings');
  });

  it('does not run any query when eventKey is null (enabled guard)', async () => {
    renderHook(() => useEventReports(null), { wrapper: wrapper() });
    renderHook(() => useTbaRankings(null), { wrapper: wrapper() });
    await Promise.resolve();
    expect(fromMock).not.toHaveBeenCalled();
    expect(tbaGetMock).not.toHaveBeenCalled();
  });

  it('useEventEpa builds an epaByTeam map and is available when EPA is present', async () => {
    statboticsGetMock.mockImplementation(async (path: string) =>
      path.includes('/254/') ? { epa: { total_points: { mean: 50 } } } : { available: false },
    );
    epaFromTeamEventMock.mockImplementation((json: unknown) =>
      json && (json as { epa?: unknown }).epa ? 50 : null,
    );

    const { result } = renderHook(() => useEventEpa([254, 1678], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.available).toBe(true);
    expect(result.current.data?.source).toBe('statbotics');
    expect(result.current.data?.epaByTeam.get(254)).toBe(50);
    // 1678 came back unavailable → null in the map.
    expect(result.current.data?.epaByTeam.get(1678)).toBeNull();
  });

  it('useEventEpa source is none with no matches when Statbotics is down for every team', async () => {
    statboticsGetMock.mockResolvedValue({ available: false });

    const { result } = renderHook(() => useEventEpa([254, 1678], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.available).toBe(false);
    expect(result.current.data?.source).toBe('none');
    expect(result.current.data?.epaByTeam.get(254)).toBeNull();
    expect(result.current.data?.epaByTeam.get(1678)).toBeNull();
  });

  it('useEventEpa and useTeamSeasonStats report the SAME EPA for a team (one source)', async () => {
    // The discrepancy fix: the prediction (useEventEpa) and the Total-EPA tile
    // (useTeamSeasonStats) both read seasonEpaForTeam, so a team's EPA is byte-for-
    // byte identical in both — no more 303-in-the-tile / 290-in-the-prediction.
    statboticsGetMock.mockResolvedValue({ available: false }); // -> in-house path
    tbaGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/team/') && path.includes('/events/')) {
        return Promise.resolve(['2026casnv']);
      }
      if (path === '/event/2026casnv/matches') {
        return Promise.resolve([
          {
            key: '2026casnv_qm1',
            event_key: '2026casnv',
            comp_level: 'qm',
            match_number: 1,
            actual_time: 100,
            alliances: {
              red: { team_keys: ['frc254', 'frc1', 'frc2'], score: 120 },
              blue: { team_keys: ['frc1678', 'frc3', 'frc4'], score: 40 },
            },
            winning_alliance: 'red',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const w = wrapper();
    const ev = renderHook(() => useEventEpa([254, 1678], '2026casnv'), { wrapper: w });
    const ts = renderHook(() => useTeamSeasonStats(254, '2026casnv'), { wrapper: w });
    await waitFor(() => expect(ev.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(ts.result.current.isSuccess).toBe(true));

    const fromPrediction = ev.result.current.data?.epaByTeam.get(254);
    const fromTile = ts.result.current.data?.totalEpa;
    expect(typeof fromPrediction).toBe('number');
    expect(fromTile).toBe(fromPrediction); // identical, not just close
    expect(ev.result.current.data?.source).toBe('local');
  });

  it('useEventEpa computes EPA from TBA results when Statbotics is down and the local table is empty', async () => {
    // Statbotics down for every team, and NO local matches passed (the importer
    // stores schedule only) -> fetch results from TBA and run the EPA model.
    statboticsGetMock.mockResolvedValue({ available: false });
    tbaGetMock.mockImplementation((path: string) => {
      // Teams attended only the current event this season.
      if (path.startsWith('/team/')) return Promise.resolve(['2026casnv']);
      if (path === '/event/2026casnv/matches') {
        return Promise.resolve([
          {
            key: '2026casnv_qm1',
            event_key: '2026casnv',
            comp_level: 'qm',
            match_number: 1,
            actual_time: 100,
            alliances: {
              red: { team_keys: ['frc254', 'frc1', 'frc2'], score: 120 },
              blue: { team_keys: ['frc1678', 'frc3', 'frc4'], score: 40 },
            },
            winning_alliance: 'red',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useEventEpa([254, 1678], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026casnv/matches');
    expect(result.current.data?.available).toBe(true);
    expect(result.current.data?.source).toBe('local');
    // Winning red 254 should sit above losing blue 1678.
    const a = result.current.data?.epaByTeam.get(254) as number;
    const b = result.current.data?.epaByTeam.get(1678) as number;
    expect(a).toBeGreaterThan(b);
  });

  it('useEventEpa carries EPA forward from a prior event (season-wide)', async () => {
    // Statbotics down. Team 254 played a PRIOR event (2026caph) where it won big,
    // then the current event (2026casnv) where it tied. The season-wide model
    // must seed 254 from its prior-event performance, so at the current event it
    // sits clearly above the init baseline / above a team that only played the
    // current event and lost.
    statboticsGetMock.mockResolvedValue({ available: false });
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc254/events/2026') {
        return Promise.resolve(['2026caph', '2026casnv']);
      }
      if (path === '/team/frc1678/events/2026') {
        return Promise.resolve(['2026casnv']);
      }
      if (path === '/event/2026caph/matches') {
        // Prior event: 254 dominates across several matches.
        const ms = [];
        for (let i = 1; i <= 6; i += 1) {
          ms.push({
            key: `2026caph_qm${i}`,
            event_key: '2026caph',
            comp_level: 'qm',
            match_number: i,
            actual_time: 100 + i,
            alliances: {
              red: { team_keys: ['frc254', `frc${100 + i}`, `frc${200 + i}`], score: 150 },
              blue: { team_keys: [`frc${300 + i}`, `frc${400 + i}`, `frc${500 + i}`], score: 30 },
            },
            winning_alliance: 'red',
          });
        }
        return Promise.resolve(ms);
      }
      if (path === '/event/2026casnv/matches') {
        return Promise.resolve([
          {
            key: '2026casnv_qm1',
            event_key: '2026casnv',
            comp_level: 'qm',
            match_number: 1,
            actual_time: 1000,
            alliances: {
              red: { team_keys: ['frc254', 'frc1', 'frc2'], score: 80 },
              blue: { team_keys: ['frc1678', 'frc3', 'frc4'], score: 80 },
            },
            winning_alliance: '',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useEventEpa([254, 1678], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc254/events/2026');
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026caph/matches');
    expect(result.current.data?.source).toBe('local');
    const a = result.current.data?.epaByTeam.get(254) as number;
    const b = result.current.data?.epaByTeam.get(1678) as number;
    // 254 carried a strong EPA in from 2026caph; 1678 only played the (tied)
    // current match -> 254 sits clearly above 1678.
    expect(a).toBeGreaterThan(b);
  });

  it('useEventEpa caches the per-event TBA matches fetch across hook renders (deduped)', async () => {
    statboticsGetMock.mockResolvedValue({ available: false });
    tbaGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/team/')) return Promise.resolve(['2026casnv']);
      if (path === '/event/2026casnv/matches') {
        return Promise.resolve([
          {
            key: '2026casnv_qm1',
            event_key: '2026casnv',
            comp_level: 'qm',
            match_number: 1,
            actual_time: 100,
            alliances: {
              red: { team_keys: ['frc254', 'frc1', 'frc2'], score: 120 },
              blue: { team_keys: ['frc1678', 'frc3', 'frc4'], score: 40 },
            },
            winning_alliance: 'red',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const w = wrapper();
    const first = renderHook(() => useEventEpa([254, 1678], '2026casnv'), { wrapper: w });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

    const matchesCallsAfterFirst = tbaGetMock.mock.calls.filter(
      (c) => c[0] === '/event/2026casnv/matches',
    ).length;
    expect(matchesCallsAfterFirst).toBe(1);

    // A second hook for the SAME event reuses the cached per-event matches
    // payload rather than refetching it.
    const second = renderHook(() => useEventEpa([254, 1678], '2026casnv'), { wrapper: w });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    const matchesCallsAfterSecond = tbaGetMock.mock.calls.filter(
      (c) => c[0] === '/event/2026casnv/matches',
    ).length;
    expect(matchesCallsAfterSecond).toBe(1);
  });

  it('useTeamSeasonStats derives Total EPA from TBA matches when Statbotics has no EPA', async () => {
    // Statbotics returns world rank only (no EPA, no record).
    statboticsGetMock.mockResolvedValue({ epa: { ranks: { total: { rank: 7 } } } });
    const eventMatches = [
      {
        key: '2026casnv_qm1',
        event_key: '2026casnv',
        comp_level: 'qm',
        match_number: 1,
        actual_time: 100,
        alliances: {
          red: { team_keys: ['frc3256', 'frc1', 'frc2'], score: 120 },
          blue: { team_keys: ['frc4', 'frc5', 'frc6'], score: 40 },
        },
        winning_alliance: 'red',
      },
    ];
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc3256/events/2026') return Promise.resolve(['2026casnv']);
      if (path === '/event/2026casnv/matches') return Promise.resolve(eventMatches);
      // /team/frc3256/matches/2026 -> season record source.
      return Promise.resolve(eventMatches);
    });

    const { result } = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc3256/matches/2026');
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026casnv/matches');
    expect(result.current.data?.epaSource).toBe('inhouse');
    expect(result.current.data?.totalEpa).not.toBeNull();
    expect(Number.isFinite(result.current.data?.totalEpa as number)).toBe(true);
  });

  it('useTeamSeasonStats EPA fallback runs over COMPLETE alliance match sets (not the inflated single-team slice)', async () => {
    // Statbotics has no EPA, so the hook derives an in-house estimate season-wide.
    // It must run the model over FULL (all-6-team) match sets — running it over
    // the team's own season SLICE inflates its EPA, so that path must NOT be used.
    statboticsGetMock.mockResolvedValue({ epa: { ranks: { total: { rank: 7 } } } });
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc3256/events/2026') return Promise.resolve(['2026casnv']);
      if (path === '/event/2026casnv/matches') {
        return Promise.resolve([
          {
            key: '2026casnv_qm1', comp_level: 'qm', match_number: 1, actual_time: 1,
            alliances: {
              red: { team_keys: ['frc3256', 'frc1', 'frc2'], score: 120 },
              blue: { team_keys: ['frc4', 'frc5', 'frc6'], score: 40 },
            },
            winning_alliance: 'red',
          },
          {
            key: '2026casnv_qm2', comp_level: 'qm', match_number: 2, actual_time: 2,
            alliances: {
              red: { team_keys: ['frc4', 'frc1', 'frc5'], score: 60 },
              blue: { team_keys: ['frc3256', 'frc2', 'frc6'], score: 80 },
            },
            winning_alliance: 'blue',
          },
        ]);
      }
      return Promise.resolve([]); // team-season payload (used only for the record)
    });

    const { result } = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The EPA estimate is computed from the (season-wide) full match set.
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026casnv/matches');
    expect(result.current.data?.epaSource).toBe('inhouse');
    expect(Number.isFinite(result.current.data?.totalEpa as number)).toBe(true);
  });

  it('useNexusEventStatus parses live status when Nexus is available', async () => {
    nexusGetMock.mockResolvedValue({
      eventKey: '2026casnv',
      nowQueuing: 'Qualification 5',
      matches: [
        { label: 'Qualification 5', status: 'Now queuing', redTeams: ['1'], blueTeams: ['2'], times: {} },
      ],
    });

    const { result } = renderHook(() => useNexusEventStatus('2026casnv'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.available).toBe(true);
    expect(result.current.data?.status?.nowQueuing).toBe('Qualification 5');
    expect(nexusGetMock).toHaveBeenCalledWith('/event/2026casnv');
  });

  it('useNexusEventStatus prefers the webhook snapshot in the DB over the proxy', async () => {
    // A fresh webhook-pushed row exists -> the hook reads it (source 'webhook')
    // and must NOT fall back to the nexus-proxy pull.
    tableResults['nexus_event_status'] = {
      data: [
        {
          payload: {
            eventKey: '2026casnv',
            nowQueuing: 'Qualification 9',
            matches: [
              { label: 'Qualification 9', status: 'Now queuing', redTeams: ['1'], blueTeams: ['2'], times: {} },
            ],
          },
          data_as_of_time: Date.now(),
          received_at: null,
        },
      ],
      error: null,
    };
    nexusGetMock.mockResolvedValue({ available: false });

    const { result } = renderHook(() => useNexusEventStatus('2026casnv'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.available).toBe(true);
    expect(result.current.data?.source).toBe('webhook');
    expect(result.current.data?.stale).toBe(false);
    expect(result.current.data?.status?.nowQueuing).toBe('Qualification 9');
    expect(nexusGetMock).not.toHaveBeenCalled();
  });

  it('useNexusEventStatus keeps a stale snapshot only when the proxy is ALSO down', async () => {
    tableResults['nexus_event_status'] = {
      data: [
        {
          payload: { eventKey: '2026casnv', matches: [] },
          data_as_of_time: Date.now() - 10 * 60_000, // 10 min old -> stale
          received_at: null,
        },
      ],
      error: null,
    };
    nexusGetMock.mockResolvedValue({ available: false }); // proxy down too

    const { result } = renderHook(() => useNexusEventStatus('2026casnv'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.stale).toBe(true);
    expect(result.current.data?.source).toBe('webhook');
    expect(nexusGetMock).toHaveBeenCalled(); // it DID try the proxy first
  });

  it('useNexusEventStatus falls through a STALE snapshot to a fresh proxy pull', async () => {
    tableResults['nexus_event_status'] = {
      data: [
        {
          payload: { eventKey: '2026casnv', nowQueuing: 'OLD', matches: [] },
          data_as_of_time: Date.now() - 10 * 60_000, // stale
          received_at: null,
        },
      ],
      error: null,
    };
    nexusGetMock.mockResolvedValue({
      eventKey: '2026casnv',
      nowQueuing: 'Qualification 14',
      matches: [],
    });

    const { result } = renderHook(() => useNexusEventStatus('2026casnv'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.source).toBe('proxy');
    expect(result.current.data?.status?.nowQueuing).toBe('Qualification 14');
  });

  it('useNexusEventStatus honors a bigint data_as_of_time returned as a STRING', async () => {
    // PostgREST serializes bigint columns as JSON strings — the staleness guard
    // must still fire (coerce, don't typeof-reject).
    tableResults['nexus_event_status'] = {
      data: [
        {
          payload: { eventKey: '2026casnv', matches: [] },
          data_as_of_time: String(Date.now() - 10 * 60_000), // STRING, 10 min old
          received_at: null,
        },
      ],
      error: null,
    };
    nexusGetMock.mockResolvedValue({ available: false });

    const { result } = renderHook(() => useNexusEventStatus('2026casnv'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.stale).toBe(true);
  });

  it('useNexusEventStatus degrades to unavailable when Nexus is down', async () => {
    nexusGetMock.mockResolvedValue({ available: false });

    const { result } = renderHook(() => useNexusEventStatus('2026casnv'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.available).toBe(false);
    expect(result.current.data?.status).toBeNull();
  });

  it('useTeamSeasonStats uses the Statbotics record and does NOT call TBA', async () => {
    statboticsGetMock.mockResolvedValue({
      epa: { total_points: { mean: 42 }, ranks: { total: { rank: 7 } } },
      record: { wins: 12, losses: 3, ties: 1 },
    });

    const { result } = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.seasonRecord).toBe('12-3-1');
    expect(tbaGetMock).not.toHaveBeenCalled();
  });

  it('useTeamSeasonStats falls back to a TBA-derived record when Statbotics has none', async () => {
    // Statbotics has EPA but no W-L-T record.
    statboticsGetMock.mockResolvedValue({
      epa: { total_points: { mean: 42 }, ranks: { total: { rank: 7 } } },
    });
    // TBA matches: 3256 wins one (on red) and loses one (on blue).
    tbaGetMock.mockResolvedValue([
      {
        alliances: {
          red: { team_keys: ['frc3256', 'frc1', 'frc2'], score: 100 },
          blue: { team_keys: ['frc4', 'frc5', 'frc6'], score: 80 },
        },
        winning_alliance: 'red',
      },
      {
        alliances: {
          red: { team_keys: ['frc7', 'frc8', 'frc9'], score: 90 },
          blue: { team_keys: ['frc3256', 'frc10', 'frc11'], score: 70 },
        },
        winning_alliance: 'red',
      },
    ]);

    const { result } = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc3256/matches/2026');
    expect(result.current.data?.seasonRecord).toBe('1-1-0');
  });

  it('useTeamSeasonStats leaves the record null when both Statbotics and TBA fail', async () => {
    statboticsGetMock.mockResolvedValue({ available: false });
    tbaGetMock.mockRejectedValue(new Error('tba down'));

    const { result } = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.seasonRecord).toBeNull();
  });
});

describe('useActiveEvent', () => {
  beforeEach(() => {
    fromMock.mockClear();
    for (const k of Object.keys(tableResults)) delete tableResults[k];
  });

  it('resolves the active event_key from the event table', async () => {
    tableResults['event'] = {
      data: [{ event_key: '2026casnv', is_active: true }],
      error: null,
    };
    const { result } = renderHook(() => useActiveEvent(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.eventKey).toBe('2026casnv');
    expect(fromMock).toHaveBeenCalledWith('event');
  });

  it('returns a null eventKey when no event is active', async () => {
    tableResults['event'] = { data: [], error: null };
    const { result } = renderHook(() => useActiveEvent(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.eventKey).toBeNull();
  });
});
