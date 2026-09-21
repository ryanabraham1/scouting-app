// Realtime glue for the live dashboard / Pit Display. Regression coverage for the
// "next match only updates on reload" bug: a shared fixed channel topic left the
// incoming screen with a dead subscription, and nothing else ever refetched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Handler = (payload: unknown) => void;
interface FakeChannel {
  topic: string;
  handlers: Array<{ table: string; cb: Handler }>;
  statusCb: ((status: string, err?: Error) => void) | null;
  on: (type: string, filter: { table: string }, cb: Handler) => FakeChannel;
  subscribe: (cb?: (status: string, err?: Error) => void) => FakeChannel;
}
const channels: FakeChannel[] = [];
const removeChannelMock = vi.fn();

function makeChannel(topic: string): FakeChannel {
  const ch: FakeChannel = {
    topic,
    handlers: [],
    statusCb: null,
    on(_type, filter, cb) {
      ch.handlers.push({ table: filter.table, cb });
      return ch;
    },
    subscribe(cb) {
      ch.statusCb = cb ?? null;
      return ch;
    },
  };
  channels.push(ch);
  return ch;
}

// Fingerprint poll: `from(table).select(...).eq().order().limit()` resolves to
// whatever the per-table mock returns. `null` disables the poll (no `from`).
const fingerprintMock = vi.fn<(table: string) => Promise<unknown>>();
let fromEnabled = true;
vi.mock('@/lib/supabase', () => ({
  supabase: {
    channel: (topic: string) => makeChannel(topic),
    removeChannel: (ch: unknown) => removeChannelMock(ch),
    get from() {
      if (!fromEnabled) return undefined;
      return (table: string) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => fingerprintMock(table),
        };
        return chain;
      };
    },
  },
}));

const syncEventResultsMock = vi.fn();
vi.mock('@/dash/proxies', () => ({
  tbaGet: vi.fn(),
  statboticsGet: vi.fn(),
  nexusGet: vi.fn(),
  epaFromTeamEvent: vi.fn(),
  syncEventResults: (key: string) => syncEventResultsMock(key),
}));

import { useEventLiveSync, LIVE_REPORTS_POLL_MS } from '../useEventData';

function fire(ch: FakeChannel, table: string, payload: unknown): void {
  for (const h of ch.handlers) if (h.table === table) h.cb(payload);
}

describe('useEventLiveSync', () => {
  let qc: QueryClient;
  let invalidated: string[];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    channels.length = 0;
    fromEnabled = true;
    fingerprintMock.mockReset().mockResolvedValue({ data: [], count: 0, error: null });
    removeChannelMock.mockReset();
    syncEventResultsMock.mockReset().mockResolvedValue({ written: 0 });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    invalidated = [];
    vi.spyOn(qc, 'invalidateQueries').mockImplementation(async (filters) => {
      invalidated.push(JSON.stringify((filters as { queryKey: unknown }).queryKey));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a per-instance channel topic so two live screens never collide', () => {
    const a = renderHook(() => useEventLiveSync('2026casf'), { wrapper });
    const b = renderHook(() => useEventLiveSync('2026casf'), { wrapper });
    expect(channels).toHaveLength(2);
    expect(channels[0].topic).toMatch(/^live-2026casf-/);
    expect(channels[1].topic).toMatch(/^live-2026casf-/);
    expect(channels[0].topic).not.toBe(channels[1].topic);
    a.unmount();
    b.unmount();
    expect(removeChannelMock).toHaveBeenCalledTimes(2);
  });

  it('a match change refreshes the schedule + rankings; a posted score also refreshes EPA feeds', () => {
    renderHook(() => useEventLiveSync('2026casf'), { wrapper });
    const ch = channels[0];
    invalidated = [];
    // Predicted-time nudge only: no result yet.
    fire(ch, 'match', { new: { match_key: '2026casf_qm5', actual_red_score: null } });
    expect(invalidated).toContain(JSON.stringify(['matches', '2026casf']));
    expect(invalidated).toContain(JSON.stringify(['tba', 'rankings', '2026casf']));
    expect(invalidated).not.toContain(JSON.stringify(['epa']));
    invalidated = [];
    fire(ch, 'match', { new: { match_key: '2026casf_qm5', actual_red_score: 120, actual_blue_score: 98 } });
    expect(invalidated).toContain(JSON.stringify(['tba', 'event-matches', '2026casf']));
    expect(invalidated).toContain(JSON.stringify(['epa']));
  });

  it('catches up the live queries on a RE-subscribe (socket drop), not on the first one', () => {
    renderHook(() => useEventLiveSync('2026casf'), { wrapper });
    const ch = channels[0];
    invalidated = [];
    act(() => ch.statusCb?.('SUBSCRIBED'));
    expect(invalidated).not.toContain(JSON.stringify(['matches', '2026casf']));
    act(() => ch.statusCb?.('SUBSCRIBED'));
    expect(invalidated).toContain(JSON.stringify(['matches', '2026casf']));
    expect(invalidated).toContain(JSON.stringify(['tba', 'rankings', '2026casf']));
    expect(invalidated).toContain(JSON.stringify(['reports', '2026casf']));
  });

  it('refetches the schedule after every reconcile tick, and rankings when rows were written', async () => {
    syncEventResultsMock.mockResolvedValueOnce({ written: 2 });
    renderHook(() => useEventLiveSync('2026casf'), { wrapper });
    await waitFor(() => expect(syncEventResultsMock).toHaveBeenCalledWith('2026casf'));
    await waitFor(() =>
      expect(invalidated).toContain(JSON.stringify(['matches', '2026casf'])),
    );
    expect(invalidated).toContain(JSON.stringify(['tba', 'rankings', '2026casf']));
  });

  it('still refetches the schedule when the reconcile itself failed (another device may have written)', async () => {
    syncEventResultsMock.mockResolvedValueOnce(undefined);
    renderHook(() => useEventLiveSync('2026casf'), { wrapper });
    await waitFor(() =>
      expect(invalidated).toContain(JSON.stringify(['matches', '2026casf'])),
    );
    expect(invalidated).not.toContain(JSON.stringify(['tba', 'rankings', '2026casf']));
  });

  it('is a no-op without an event', () => {
    renderHook(() => useEventLiveSync(null), { wrapper });
    expect(channels).toHaveLength(0);
    expect(syncEventResultsMock).not.toHaveBeenCalled();
  });

  it('coalesces a burst of report events into one refetch', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useEventLiveSync('2026casf'), { wrapper });
      const ch = channels[0];
      invalidated = [];
      for (let i = 0; i < 6; i += 1) fire(ch, 'match_scouting_report', { new: {} });
      expect(invalidated).not.toContain(JSON.stringify(['reports', '2026casf']));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(
        invalidated.filter((k) => k === JSON.stringify(['reports', '2026casf'])),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fingerprint poll refetches reports when the server changed and realtime said nothing', async () => {
    vi.useFakeTimers();
    try {
      fingerprintMock.mockImplementation(async (table) =>
        table === 'match_scouting_report'
          ? { data: [{ server_received_at: '2026-09-20T10:00:00Z' }], count: 10, error: null }
          : { data: [], count: 0, error: null },
      );
      renderHook(() => useEventLiveSync('2026casf'), { wrapper });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      invalidated = [];

      // Unchanged fingerprint → no refetch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_REPORTS_POLL_MS);
      });
      expect(invalidated).not.toContain(JSON.stringify(['reports', '2026casf']));

      // A new report landed (count + newest stamp moved) → refetch reports only.
      fingerprintMock.mockImplementation(async (table) =>
        table === 'match_scouting_report'
          ? { data: [{ server_received_at: '2026-09-20T10:05:00Z' }], count: 11, error: null }
          : { data: [], count: 0, error: null },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_REPORTS_POLL_MS);
      });
      expect(invalidated).toContain(JSON.stringify(['reports', '2026casf']));
      expect(invalidated).not.toContain(JSON.stringify(['event-pits', '2026casf']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('catches up every live query when the tab becomes visible again', () => {
    renderHook(() => useEventLiveSync('2026casf'), { wrapper });
    invalidated = [];
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(invalidated).toContain(JSON.stringify(['reports', '2026casf']));
      expect(invalidated).toContain(JSON.stringify(['matches', '2026casf']));
    } finally {
      visibility.mockRestore();
    }
  });
});
