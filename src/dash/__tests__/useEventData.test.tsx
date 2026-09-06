import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
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
  useEventAssignments,
  useEventPitAssignments,
  useTbaRankings,
  useEventEpa,
  useNexusEventStatus,
  useTeamSeasonStats,
  mergeMatchupNotes,
} from '../useEventData';
// The season-wide EPA fallback fetches per-team season matches through this
// SHARED query client (queryClient.fetchQuery), so they cache /
// dedupe across hooks. Clear it between tests to keep them isolated.
import { queryClient as sharedQueryClient } from '@/lib/queryPersist';
import { computeLocalEpa, tbaMatchesToRows } from '@/dash/localEpa';
import { EPA_RECENCY_BOOST } from '@/dash/constants';
import {
  fetchSeasonMatchRows,
} from '@/dash/seasonEpa';

import { useActiveEvent } from '../useActiveEvent';

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function expireSharedSeasonQueries(): void {
  for (const query of sharedQueryClient.getQueryCache().findAll()) {
    if (query.state.data === undefined) continue;
    sharedQueryClient.setQueryData(query.queryKey, query.state.data, { updatedAt: 1 });
  }
}

function localEpaMatch() {
  return {
    key: '2026casnv_qm1',
    event_key: '2026casnv',
    comp_level: 'qm',
    match_number: 1,
    actual_time: 100,
    alliances: {
      red: { team_keys: ['frc254', 'frc1', 'frc2'], score: 150 },
      blue: { team_keys: ['frc3', 'frc4', 'frc5'], score: 30 },
    },
    winning_alliance: 'red',
  };
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

  it('keeps assignment query failures as errors while online instead of caching []', async () => {
    tableResults.assignment = {
      data: null,
      error: { message: 'temporary PostgREST failure' },
    };
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    const { result } = renderHook(() => useEventAssignments('2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('keeps an unsynced team-note edit authoritative over the server row', () => {
    const key = '2026casnv:-1:254';
    const merged = mergeMatchupNotes(
      [{
        event_key: '2026casnv',
        our_team: -1,
        opp_team: 254,
        note: 'server',
        row_revision: 200,
        updated_at: '2026-01-01T00:00:00Z',
        author_scout_id: null,
        deleted: false,
      }],
      [{
        key,
        eventKey: '2026casnv',
        ourTeam: -1,
        oppTeam: 254,
        note: 'offline edit',
        updatedAt: '1970-01-01T00:00:00.100Z',
        authorScoutId: null,
        syncState: 'dirty',
        syncAttempts: 0,
        lastSyncError: null,
      }],
    );
    expect(merged.get(key)).toBe('offline edit');
  });

  it('does not let an old synced Dexie row hide a newer cross-device server edit', () => {
    const key = '2026casnv:-1:254';
    const merged = mergeMatchupNotes(
      [{
        event_key: '2026casnv',
        our_team: -1,
        opp_team: 254,
        note: 'new from partner device',
        row_revision: 300,
        updated_at: '2026-01-01T00:00:00Z',
        author_scout_id: null,
        deleted: false,
      }],
      [{
        key,
        eventKey: '2026casnv',
        ourTeam: -1,
        oppTeam: 254,
        note: 'old local',
        updatedAt: '1970-01-01T00:00:00.200Z',
        authorScoutId: null,
        syncState: 'synced',
        syncAttempts: 0,
        lastSyncError: null,
      }],
    );
    expect(merged.get(key)).toBe('new from partner device');
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

  it('keeps match and pit assignment queries isolated across A→B→A', async () => {
    tableResults['assignment'] = {
      data: [{
        event_key: '2026a',
        match_key: '2026a_qm1',
        scout_id: 'a-scout',
        alliance_color: 'red',
        station: 1,
        target_team_number: 101,
      }],
      error: null,
    };
    tableResults['pit_assignment'] = {
      data: [{
        event_key: '2026a',
        team_number: 101,
        scout_id: 'a-scout',
        source: 'manual',
      }],
      error: null,
    };
    const hook = renderHook(
      ({ eventKey }: { eventKey: string }) => ({
        match: useEventAssignments(eventKey),
        pit: useEventPitAssignments(eventKey),
      }),
      { initialProps: { eventKey: '2026a' }, wrapper: wrapper() },
    );
    await waitFor(() => expect(hook.result.current.match.isSuccess).toBe(true));
    await waitFor(() => expect(hook.result.current.pit.isSuccess).toBe(true));
    expect(hook.result.current.match.data?.[0]?.event_key).toBe('2026a');
    expect(hook.result.current.pit.data?.[0]?.event_key).toBe('2026a');

    tableResults['assignment'] = {
      data: [{
        event_key: '2026b',
        match_key: '2026b_qm1',
        scout_id: 'b-scout',
        alliance_color: 'blue',
        station: 2,
        target_team_number: 202,
      }],
      error: null,
    };
    tableResults['pit_assignment'] = {
      data: [{
        event_key: '2026b',
        team_number: 202,
        scout_id: 'b-scout',
        source: 'auto',
      }],
      error: null,
    };
    hook.rerender({ eventKey: '2026b' });
    await waitFor(() =>
      expect(hook.result.current.match.data?.[0]?.event_key).toBe('2026b'),
    );
    await waitFor(() =>
      expect(hook.result.current.pit.data?.[0]?.event_key).toBe('2026b'),
    );

    hook.rerender({ eventKey: '2026a' });
    await waitFor(() =>
      expect(hook.result.current.match.data?.[0]?.event_key).toBe('2026a'),
    );
    expect(hook.result.current.pit.data?.[0]?.event_key).toBe('2026a');
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

  it('isolates one team EPA failure without discarding successful teammates', async () => {
    statboticsGetMock.mockImplementation(async (path: string) => {
      if (path.includes('/254/')) return { epa: { total_points: { mean: 50 } } };
      throw new Error('team-specific proxy failure');
    });

    const { result } = renderHook(() => useEventEpa([254, 1678], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.epaByTeam.get(254)).toBe(50);
    expect(result.current.data?.epaByTeam.get(1678)).toBeNull();
    expect(result.current.data?.available).toBe(true);
  });

  it('preserves stale last-good Statbotics EPA when an offline refresh fails', async () => {
    const statboticsKey = ['epa', 'season-statbotics', 254, '2026'] as const;
    const lastGood = { worldRank: 7, totalEpa: 48.5, record: '10-2-0' };
    sharedQueryClient.setQueryData(statboticsKey, lastGood, { updatedAt: 1 });
    statboticsGetMock.mockRejectedValue(new Error('venue offline'));
    tbaGetMock.mockRejectedValue(new Error('venue offline'));

    const { result } = renderHook(() => useEventEpa([254], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(statboticsGetMock).toHaveBeenCalledWith('/team_year/254/2026');
    expect(result.current.data?.epaByTeam.get(254)).toBe(48.5);
    expect(result.current.data?.sourceByTeam?.get(254)).toBe('statbotics');
    expect(sharedQueryClient.getQueryData(statboticsKey)).toEqual(lastGood);
  });

  it('preserves stale last-good local EPA when the team-season refresh fails', async () => {
    statboticsGetMock.mockResolvedValue({ available: false });
    tbaGetMock.mockResolvedValue([localEpaMatch()]);
    const first = renderHook(() => useEventEpa([254], '2026casnv'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(first.result.current.data?.source).toBe('local'));
    const lastGood = first.result.current.data?.epaByTeam.get(254);
    expect(lastGood).toBeTypeOf('number');
    first.unmount();

    expireSharedSeasonQueries();
    statboticsGetMock.mockRejectedValue(new Error('Statbotics offline'));
    tbaGetMock.mockRejectedValue(new Error('TBA team matches offline'));
    const offline = renderHook(() => useEventEpa([254], '2026casnv'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(offline.result.current.isSuccess).toBe(true));
    expect(offline.result.current.data?.epaByTeam.get(254)).toBe(lastGood);
    expect(offline.result.current.data?.source).toBe('local');
  });

  it('treats a genuine successful empty TBA refresh as empty, not last-good', async () => {
    statboticsGetMock.mockResolvedValue({ available: false });
    tbaGetMock.mockResolvedValue([localEpaMatch()]);
    const first = renderHook(() => useEventEpa([254], '2026casnv'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(first.result.current.data?.source).toBe('local'));
    first.unmount();

    expireSharedSeasonQueries();
    tbaGetMock.mockResolvedValue([]);
    const empty = renderHook(() => useEventEpa([254], '2026casnv'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(empty.result.current.isSuccess).toBe(true));
    expect(empty.result.current.data?.available).toBe(false);
    expect(empty.result.current.data?.source).toBe('none');
    expect(empty.result.current.data?.epaByTeam.get(254)).toBeNull();
  });

  it('reuses one team-season payload between events in the same year', async () => {
    statboticsGetMock.mockResolvedValue({ available: false });
    const eventMatch = (eventKey: string, redScore: number, blueScore: number) => ({
      key: `${eventKey}_qm1`,
      event_key: eventKey,
      comp_level: 'qm',
      match_number: 1,
      actual_time: eventKey === '2026a' ? 100 : 200,
      alliances: {
        red: { team_keys: ['frc1', 'frc2', 'frc3'], score: redScore },
        blue: { team_keys: ['frc4', 'frc5', 'frc6'], score: blueScore },
      },
      winning_alliance: redScore > blueScore ? 'red' : '',
    });
    tbaGetMock.mockResolvedValue([
      eventMatch('2026a', 180, 0),
      eventMatch('2026b', 30, 30),
    ]);

    const w = wrapper();
    const eventA = renderHook(() => useTeamSeasonStats(1, '2026a'), { wrapper: w });
    await waitFor(() => expect(eventA.result.current.isSuccess).toBe(true));
    const a = eventA.result.current.data?.totalEpa;
    eventA.unmount();

    const eventB = renderHook(() => useTeamSeasonStats(1, '2026b'), { wrapper: w });
    await waitFor(() => expect(eventB.result.current.isSuccess).toBe(true));
    const b = eventB.result.current.data?.totalEpa;

    expect(a).toBeTypeOf('number');
    expect(b).toBeTypeOf('number');
    expect(b).toBe(a);
    expect(tbaGetMock.mock.calls.filter(
      (call) => call[0] === '/team/frc1/matches/2026',
    )).toHaveLength(1);
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

  it('keeps the season fallback successful-but-empty during a complete TBA outage', async () => {
    statboticsGetMock.mockResolvedValue({ available: false });
    tbaGetMock.mockRejectedValue(new Error('venue offline'));

    const { result } = renderHook(() => useEventEpa([254, 1678], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.available).toBe(false);
    expect(result.current.data?.source).toBe('none');
  });

  it('fetches complete event schedules for the requested teams', async () => {
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc1/events/2026') return Promise.resolve(['2026a', '2026shared']);
      if (path === '/team/frc2/events/2026') return Promise.resolve(['2026b', '2026shared']);
      if (path.startsWith('/event/')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await fetchSeasonMatchRows([1, 2], '2026shared', '2026');

    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc1/events/2026');
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc2/events/2026');
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026a/matches');
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026b/matches');
    expect(tbaGetMock.mock.calls.filter(
      (call) => call[0] === '/event/2026shared/matches',
    )).toHaveLength(1);
  });

  it('useEventEpa and useTeamSeasonStats report the SAME EPA for a team (one source)', async () => {
    // The discrepancy fix: the prediction (useEventEpa) and the Total-EPA tile
    // (useTeamSeasonStats) both read seasonEpaForTeam, so a team's EPA is byte-for-
    // byte identical in both — no more 303-in-the-tile / 290-in-the-prediction.
    statboticsGetMock.mockResolvedValue({ available: false }); // -> in-house path
    const eventMatches = [{
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
    }];
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc254/events/2026') return Promise.resolve(['2026casnv']);
      if (path === '/team/frc1678/events/2026') return Promise.resolve(['2026casnv']);
      if (path === '/event/2026casnv/matches') return Promise.resolve(eventMatches);
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

  it('keeps a team EPA independent of the other displayed teams', async () => {
    statboticsGetMock.mockResolvedValue({ available: false });
    const current = {
      key: '2026current_qm1',
      event_key: '2026current',
      comp_level: 'qm',
      match_number: 1,
      actual_time: 200,
      alliances: {
        red: { team_keys: ['frc1', 'frc3', 'frc4'], score: 90 },
        blue: { team_keys: ['frc2', 'frc5', 'frc6'], score: 80 },
      },
      winning_alliance: 'red',
    };
    const prior = {
      key: '2026prior_qm1',
      event_key: '2026prior',
      comp_level: 'qm',
      match_number: 1,
      actual_time: 100,
      alliances: {
        red: { team_keys: ['frc2', 'frc7', 'frc8'], score: 180 },
        blue: { team_keys: ['frc9', 'frc10', 'frc11'], score: 0 },
      },
      winning_alliance: 'red',
    };
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc1/events/2026') return Promise.resolve(['2026current']);
      if (path === '/team/frc2/events/2026') return Promise.resolve(['2026prior', '2026current']);
      if (path === '/team/frc1/matches/2026') return Promise.resolve([current]);
      if (path === '/event/2026current/matches') return Promise.resolve([current]);
      if (path === '/event/2026prior/matches') return Promise.resolve([prior]);
      return Promise.resolve([]);
    });

    const w = wrapper();
    const tile = renderHook(() => useTeamSeasonStats(1, '2026current'), { wrapper: w });
    await waitFor(() => expect(tile.result.current.isSuccess).toBe(true));
    const tileOnly = tile.result.current.data?.totalEpa;

    const bulk = renderHook(() => useEventEpa([1, 2], '2026current'), { wrapper: w });
    await waitFor(() => expect(bulk.result.current.isSuccess).toBe(true));
    const bulkValue = bulk.result.current.data?.epaByTeam.get(1);

    expect(tileOnly).toBeTypeOf('number');
    expect(bulkValue).toBe(tileOnly);
    expect(tile.result.current.data?.totalEpa).toBe(tileOnly);
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc2/events/2026');
  });

  it('useEventEpa computes EPA from TBA results when Statbotics is down and the local table is empty', async () => {
    // Statbotics down for every team, and NO local matches passed (the importer
    // stores schedule only) -> fetch results from TBA and run the EPA model.
    statboticsGetMock.mockResolvedValue({ available: false });
    tbaGetMock.mockResolvedValue([{
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
    }]);

    const { result } = renderHook(() => useEventEpa([254, 1678], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc254/events/2026');
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc1678/events/2026');
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026casnv/matches');
    expect(result.current.data?.available).toBe(true);
    expect(result.current.data?.source).toBe('local');
    // Winning red 254 should sit above losing blue 1678.
    const a = result.current.data?.epaByTeam.get(254) as number;
    const b = result.current.data?.epaByTeam.get(1678) as number;
    expect(a).toBeGreaterThan(b);
  });

  it('shows TBA EPA first, then promotes the display when Statbotics finishes', async () => {
    let resolveStatbotics: ((value: unknown) => void) | undefined;
    statboticsGetMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveStatbotics = resolve;
      }),
    );
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc254/events/2026') return Promise.resolve(['2026casnv']);
      if (path === '/event/2026casnv/matches') return Promise.resolve([localEpaMatch()]);
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useEventEpa([254], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.data?.source).toBe('local'));
    const tbaEpa = result.current.data?.epaByTeam.get(254);
    expect(tbaEpa).toBeTypeOf('number');

    await act(async () => {
      resolveStatbotics?.({
        epa: { total_points: { mean: 55 }, ranks: { total: { rank: 7 } } },
        record: { wins: 8, losses: 2, ties: 0 },
      });
    });

    await waitFor(() => expect(result.current.data?.source).toBe('statbotics'));
    expect(result.current.data?.epaByTeam.get(254)).toBe(55);
    expect(result.current.data?.epaByTeam.get(254)).not.toBe(tbaEpa);
  });

  it('shows Statbotics immediately when it wins the race without waiting for TBA', async () => {
    let resolveTba: ((value: unknown[]) => void) | undefined;
    const pendingTba = new Promise<unknown[]>((resolve) => {
      resolveTba = resolve;
    });
    tbaGetMock.mockReturnValue(pendingTba);
    statboticsGetMock.mockResolvedValue({
      epa: { total_points: { mean: 61 }, ranks: { total: { rank: 3 } } },
      record: { wins: 10, losses: 1, ties: 0 },
    });

    const { result } = renderHook(() => useEventEpa([254], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.data?.source).toBe('statbotics'));
    expect(result.current.data?.epaByTeam.get(254)).toBe(61);

    await act(async () => {
      resolveTba?.([]);
    });
  });

  it('useEventEpa carries EPA forward from a prior event (season-wide)', async () => {
    // Statbotics down. Team 254 played a PRIOR event (2026caph) where it won big,
    // then the current event (2026casnv) where it tied. The season-wide model
    // must seed 254 from its prior-event performance, so at the current event it
    // sits clearly above the init baseline / above a team that only played the
    // current event and lost.
    statboticsGetMock.mockResolvedValue({ available: false });
    const priorMatches: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 6; i += 1) {
      priorMatches.push({
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
    const currentMatch = {
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
    };
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc254/events/2026') return Promise.resolve(['2026caph', '2026casnv']);
      if (path === '/team/frc1678/events/2026') return Promise.resolve(['2026casnv']);
      if (path === '/event/2026caph/matches') return Promise.resolve(priorMatches);
      if (path === '/event/2026casnv/matches') return Promise.resolve([currentMatch]);
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useEventEpa([254, 1678], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026caph/matches');
    expect(result.current.data?.source).toBe('local');
    const a = result.current.data?.epaByTeam.get(254) as number;
    const b = result.current.data?.epaByTeam.get(1678) as number;
    // 254 carried a strong EPA in from 2026caph; 1678 only played the (tied)
    // current match -> 254 sits clearly above 1678.
    expect(a).toBeGreaterThan(b);
  });

  it('replays partner-only event matches instead of the inflated team slice', async () => {
    statboticsGetMock.mockResolvedValue({ available: false });

    const priorEvent = Array.from({ length: 4 }, (_, index) => ({
      key: `2026prior_qm${index + 1}`,
      event_key: '2026prior',
      comp_level: 'qm',
      match_number: index + 1,
      actual_time: 100 + index,
      alliances: {
        red: { team_keys: ['frc2', 'frc3', 'frc4'], score: 150 },
        blue: { team_keys: ['frc5', 'frc6', 'frc7'], score: 30 },
      },
      winning_alliance: 'red',
    }));
    const currentEvent = [{
      key: '2026current_qm1',
      event_key: '2026current',
      comp_level: 'qm',
      match_number: 1,
      actual_time: 1000,
      alliances: {
        red: { team_keys: ['frc1', 'frc2', 'frc8'], score: 90 },
        blue: { team_keys: ['frc9', 'frc10', 'frc11'], score: 70 },
      },
      winning_alliance: 'red',
    }];

    const fullEvent = [...priorEvent, ...currentEvent];
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc1/matches/2026') return Promise.resolve(currentEvent);
      if (path === '/team/frc1/events/2026') return Promise.resolve(['2026current']);
      if (path === '/event/2026current/matches') return Promise.resolve(fullEvent);
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useTeamSeasonStats(1, '2026current'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const inflatedSlice = computeLocalEpa(tbaMatchesToRows(currentEvent), {
      recencyBoost: EPA_RECENCY_BOOST,
    }).get(1);
    const completeEvent = computeLocalEpa(tbaMatchesToRows(fullEvent), {
      recencyBoost: EPA_RECENCY_BOOST,
    }).get(1);

    expect(priorEvent).toHaveLength(4);
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc1/events/2026');
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026current/matches');
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc1/matches/2026');
    expect(result.current.data?.totalEpa).toBe(completeEvent);
    expect(result.current.data?.totalEpa).not.toBe(inflatedSlice);
  });

  it('caches team-event and event-match payloads across hook renders', async () => {
    statboticsGetMock.mockResolvedValue({ available: false });
    const eventMatches = [{
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
    }];
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc254/events/2026') return Promise.resolve(['2026casnv']);
      if (path === '/team/frc1678/events/2026') return Promise.resolve(['2026casnv']);
      if (path === '/event/2026casnv/matches') return Promise.resolve(eventMatches);
      return Promise.resolve([]);
    });

    const w = wrapper();
    const first = renderHook(() => useEventEpa([254, 1678], '2026casnv'), { wrapper: w });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

    expect(tbaGetMock).toHaveBeenCalledTimes(3);

    // A second hook reuses both team-event lists and the shared event schedule.
    const second = renderHook(() => useEventEpa([254, 1678], '2026casnv'), { wrapper: w });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(tbaGetMock).toHaveBeenCalledTimes(3);
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
      if (path === '/team/frc3256/matches/2026') return Promise.resolve(eventMatches);
      if (path === '/team/frc3256/events/2026') return Promise.resolve(['2026casnv']);
      if (path === '/event/2026casnv/matches') return Promise.resolve(eventMatches);
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc3256/matches/2026');
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc3256/events/2026');
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026casnv/matches');
    expect(result.current.data?.epaSource).toBe('inhouse');
    expect(result.current.data?.totalEpa).not.toBeNull();
    expect(Number.isFinite(result.current.data?.totalEpa as number)).toBe(true);
  });

  it('useTeamSeasonStats EPA fallback runs over COMPLETE alliance match sets (not the inflated single-team slice)', async () => {
    // Statbotics has no EPA, so the hook derives an in-house estimate season-wide.
    // The team-season endpoint is only the team's slice; EPA must instead use
    // the complete event endpoint so partners and opponents are fully trained.
    statboticsGetMock.mockResolvedValue({ epa: { ranks: { total: { rank: 7 } } } });
    const teamSlice = [{
      key: '2026casnv_qm1', comp_level: 'qm', match_number: 1, actual_time: 10,
      alliances: {
        red: { team_keys: ['frc3256', 'frc1', 'frc2'], score: 150 },
        blue: { team_keys: ['frc4', 'frc5', 'frc6'], score: 30 },
      },
      winning_alliance: 'red',
    }];
    const partnerOnly = Array.from({ length: 4 }, (_, index) => ({
      key: `2026casnv_qm${index + 2}`,
      comp_level: 'qm',
      match_number: index + 2,
      actual_time: index + 1,
      alliances: {
        red: { team_keys: ['frc1', 'frc7', 'frc8'], score: 150 },
        blue: { team_keys: ['frc9', 'frc10', 'frc11'], score: 30 },
      },
      winning_alliance: 'red',
    }));
    const completeEvent = [...partnerOnly, ...teamSlice];
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc3256/matches/2026') return Promise.resolve(teamSlice);
      if (path === '/team/frc3256/events/2026') return Promise.resolve(['2026casnv']);
      if (path === '/event/2026casnv/matches') return Promise.resolve(completeEvent);
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc3256/matches/2026');
    expect(tbaGetMock).toHaveBeenCalledWith('/event/2026casnv/matches');
    expect(result.current.data?.epaSource).toBe('inhouse');
    const fullValue = computeLocalEpa(tbaMatchesToRows(completeEvent), {
      recencyBoost: EPA_RECENCY_BOOST,
    }).get(3256);
    const sliceValue = computeLocalEpa(tbaMatchesToRows(teamSlice), {
      recencyBoost: EPA_RECENCY_BOOST,
    }).get(3256);
    expect(result.current.data?.totalEpa).toBe(fullValue);
    expect(result.current.data?.totalEpa).not.toBe(sliceValue);
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

  it('uses the Statbotics record while eagerly warming the TBA fallback', async () => {
    statboticsGetMock.mockResolvedValue({
      epa: { total_points: { mean: 42 }, ranks: { total: { rank: 7 } } },
      record: { wins: 12, losses: 3, ties: 1 },
    });

    const { result } = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.seasonRecord).toBe('12-3-1');
    expect(tbaGetMock).toHaveBeenCalledWith('/team/frc3256/matches/2026');
  });

  it('starts the season record request before season EPA finishes', async () => {
    let resolveStatbotics: ((value: unknown) => void) | undefined;
    statboticsGetMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveStatbotics = resolve;
      }),
    );
    tbaGetMock.mockImplementation((path: string) => {
      if (path === '/team/frc3256/matches/2026') {
        return Promise.resolve([{
          alliances: {
            red: { team_keys: ['frc3256', 'frc1', 'frc2'], score: 100 },
            blue: { team_keys: ['frc4', 'frc5', 'frc6'], score: 80 },
          },
          winning_alliance: 'red',
        }]);
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => {
      expect(tbaGetMock).toHaveBeenCalledWith('/team/frc3256/matches/2026');
    });
    expect(result.current.isPending).toBe(true);

    resolveStatbotics?.({
      epa: { total_points: { mean: 42 }, ranks: { total: { rank: 7 } } },
    });
    await waitFor(() => expect(result.current.data?.seasonRecord).toBe('1-0-0'));
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

  it('preserves a stale last-good strict TBA season record when refresh rejects', async () => {
    statboticsGetMock.mockResolvedValue({
      epa: { total_points: { mean: 42 }, ranks: { total: { rank: 7 } } },
    });
    const played = [{
      alliances: {
        red: { team_keys: ['frc3256', 'frc1', 'frc2'], score: 100 },
        blue: { team_keys: ['frc4', 'frc5', 'frc6'], score: 80 },
      },
      winning_alliance: 'red',
    }];
    tbaGetMock.mockResolvedValue(played);
    const first = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(first.result.current.data?.seasonRecord).toBe('1-0-0'));
    first.unmount();

    expireSharedSeasonQueries();
    tbaGetMock.mockRejectedValue(new Error('venue offline'));
    const offline = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(offline.result.current.isSuccess).toBe(true));
    expect(offline.result.current.data?.seasonRecord).toBe('1-0-0');
    expect(sharedQueryClient.getQueryData([
      'tba', 'team-season-matches', 3256, '2026',
    ])).toEqual(played);
  });

  it('treats a successful empty strict TBA season refresh as authoritative', async () => {
    statboticsGetMock.mockResolvedValue({
      epa: { total_points: { mean: 42 }, ranks: { total: { rank: 7 } } },
    });
    tbaGetMock.mockResolvedValue([{
      alliances: {
        red: { team_keys: ['frc3256', 'frc1', 'frc2'], score: 100 },
        blue: { team_keys: ['frc4', 'frc5', 'frc6'], score: 80 },
      },
      winning_alliance: 'red',
    }]);
    const first = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(first.result.current.data?.seasonRecord).toBe('1-0-0'));
    first.unmount();

    expireSharedSeasonQueries();
    tbaGetMock.mockResolvedValue([]);
    const empty = renderHook(() => useTeamSeasonStats(3256, '2026casnv'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(empty.result.current.isSuccess).toBe(true));
    expect(empty.result.current.data?.seasonRecord).toBeNull();
    expect(sharedQueryClient.getQueryData([
      'tba', 'team-season-matches', 3256, '2026',
    ])).toEqual([]);
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
