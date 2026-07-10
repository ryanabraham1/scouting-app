import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the browser supabase client; deleteEvent only calls `rpc`.
const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
}));

// In-memory active-event store so we can assert the pointer is cleared without a
// real localStorage (jsdom-compat env has a non-functional one).
const store = vi.hoisted(() => ({ active: null as string | null }));
vi.mock('@/dash/activeEventStore', () => ({
  getStoredActiveEvent: () => store.active,
  setStoredActiveEvent: (k: string | null) => {
    store.active = k;
  },
}));

import { deleteEvent } from '../deleteEvent';

beforeEach(() => {
  rpc.mockReset();
  store.active = null;
});

describe('deleteEvent', () => {
  it('calls the delete_event RPC with the event key', async () => {
    rpc.mockResolvedValue({ error: null });
    await deleteEvent('2026casnv');
    expect(rpc).toHaveBeenCalledWith('delete_event', { p_event_key: '2026casnv' });
  });

  it('throws the RPC error message', async () => {
    rpc.mockResolvedValue({ error: { message: 'denied' } });
    await expect(deleteEvent('2026casnv')).rejects.toThrow('denied');
  });

  it('clears the active pointer + query cache when deleting the active event', async () => {
    rpc.mockResolvedValue({ error: null });
    store.active = '2026casnv';
    const setQueryData = vi.fn();
    await deleteEvent('2026casnv', { setQueryData } as never);
    expect(store.active).toBeNull();
    expect(setQueryData).toHaveBeenCalledWith(
      ['active-event', 'server-authority-v2'],
      null,
    );
  });

  it('leaves the active pointer alone when deleting a different event', async () => {
    rpc.mockResolvedValue({ error: null });
    store.active = '2026caetb';
    const setQueryData = vi.fn();
    await deleteEvent('2026casnv', { setQueryData } as never);
    expect(store.active).toBe('2026caetb');
    expect(setQueryData).not.toHaveBeenCalled();
  });
});
