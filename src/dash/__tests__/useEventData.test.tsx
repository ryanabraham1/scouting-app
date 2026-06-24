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
const epaFromTeamEventMock = vi.fn();
vi.mock('@/dash/proxies', () => ({
  tbaGet: (path: string) => tbaGetMock(path),
  statboticsGet: (path: string) => statboticsGetMock(path),
  epaFromTeamEvent: (json: unknown) => epaFromTeamEventMock(json),
}));

import {
  useEventReports,
  useEventMatches,
  useEventTeams,
  useTbaRankings,
  useEventEpa,
} from '../useEventData';
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
    epaFromTeamEventMock.mockReset();
    for (const k of Object.keys(tableResults)) delete tableResults[k];
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
    expect(result.current.data?.epaByTeam.get(254)).toBe(50);
    // 1678 came back unavailable → null in the map.
    expect(result.current.data?.epaByTeam.get(1678)).toBeNull();
  });

  it('useEventEpa returns { available: false } when Statbotics is down for every team', async () => {
    statboticsGetMock.mockResolvedValue({ available: false });

    const { result } = renderHook(() => useEventEpa([254, 1678], '2026casnv'), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.available).toBe(false);
    expect(result.current.data?.epaByTeam.get(254)).toBeNull();
    expect(result.current.data?.epaByTeam.get(1678)).toBeNull();
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
