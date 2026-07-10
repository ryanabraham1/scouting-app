import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ACTIVE_EVENT_KEY } from '../useActiveEvent';

let eventRows: { event_key: string; is_active: boolean }[] = [];
let eventError: Error | null = null;
const from = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => {
      from(...args);
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: eventRows, error: eventError }),
        }),
      };
    },
  },
}));

// The jsdom-compat test environment has a non-functional localStorage, so we mock
// the store module directly to control the "stored" value deterministically.
let stored: string | null = null;
vi.mock('../activeEventStore', () => ({
  ACTIVE_EVENT_STORAGE_KEY: 'active_event_key',
  getStoredActiveEvent: () => stored,
  isValidStoredEventKey: (value: unknown) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
  setStoredActiveEvent: (v: string | null) => {
    stored = v;
  },
}));

import { useActiveEvent } from '../useActiveEvent';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  eventRows = [];
  eventError = null;
  stored = null;
  from.mockClear();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('useActiveEvent', () => {
  it('shows the stored fallback while immediately verifying it online', () => {
    stored = '2026casnv';
    const { result } = renderHook(() => useActiveEvent(), { wrapper });
    expect(result.current.eventKey).toBe('2026casnv');
    expect(result.current.loading).toBe(true);
    expect(result.current.authoritative).toBe(false);
  });

  it('overrides a stale local event with the server event online', async () => {
    stored = '2026casnv';
    eventRows = [{ event_key: '2026demo', is_active: true }];
    const { result } = renderHook(() => useActiveEvent(), { wrapper });
    await waitFor(() => expect(result.current.eventKey).toBe('2026demo'));
    expect(stored).toBe('2026demo');
    expect(result.current.authoritative).toBe(true);
  });

  it('ignores a stale persisted cache entry from the legacy query key', async () => {
    stored = '2026casnv';
    eventRows = [{ event_key: '2026demo', is_active: true }];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['active-event'], '2026casnv');
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useActiveEvent(), { wrapper: wrap });

    await waitFor(() => expect(result.current.eventKey).toBe('2026demo'));
    expect(qc.getQueryData(['active-event'])).toBe('2026casnv');
  });

  it('retains the stored event offline without starting a request', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    stored = '2026casnv';
    const { result } = renderHook(() => useActiveEvent(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.eventKey).toBe('2026casnv');
    expect(result.current.authoritative).toBe(true);
    expect(from).not.toHaveBeenCalled();
  });

  it('retains the stored event when the online request fails', async () => {
    stored = '2026casnv';
    eventError = new Error('Failed to fetch');
    const { result } = renderHook(() => useActiveEvent(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.eventKey).toBe('2026casnv');
    expect(result.current.authoritative).toBe(false);
  });

  it('resolves from the server when nothing is stored', async () => {
    eventRows = [{ event_key: '2026orwil', is_active: true }];
    const { result } = renderHook(() => useActiveEvent(), { wrapper });
    await waitFor(() => expect(result.current.eventKey).toBe('2026orwil'));
  });

  it('treats a successful empty server result as authoritative', async () => {
    stored = '2026casnv';
    eventRows = [];
    const { result } = renderHook(() => useActiveEvent(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.eventKey).toBeNull();
    expect(stored).toBeNull();
  });

  it('revalidates promptly when another tab changes the stored pointer', async () => {
    stored = '2026casnv';
    eventRows = [{ event_key: '2026casnv', is_active: true }];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useActiveEvent(), { wrapper: wrap });
    await waitFor(() => expect(result.current.authoritative).toBe(true));

    stored = '2026demo';
    eventRows = [{ event_key: '2026demo', is_active: true }];
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'active_event_key',
          oldValue: '2026casnv',
          newValue: '2026demo',
        }),
      );
    });
    await waitFor(() => expect(result.current.eventKey).toBe('2026demo'));
  });

  it('does not resurrect a cleared event after an explicit refetch', async () => {
    stored = '2026casnv';
    eventRows = [{ event_key: '2026casnv', is_active: true }];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useActiveEvent(), { wrapper: wrap });
    await waitFor(() => expect(result.current.eventKey).toBe('2026casnv'));
    stored = null;
    eventRows = [];
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ACTIVE_EVENT_KEY });
    });
    await waitFor(() => expect(result.current.eventKey).toBeNull());
  });
});
