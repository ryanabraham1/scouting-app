// src/auth/__tests__/useSession.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const getSession = vi.fn();
const onAuthStateChange = vi.fn();
const unsubscribe = vi.fn();
const from = vi.fn();

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => getSession(...a),
      onAuthStateChange: (...a: unknown[]) => onAuthStateChange(...a),
    },
    from: (...a: unknown[]) => from(...a),
  },
}));

import { useSession } from '../useSession';

const session = { user: { id: 'auth-uid-1' } };
const scoutRow = {
  id: 's1', event_key: '2026casnv', display_name: 'Ada',
  auth_uid: 'auth-uid-1', created_at: '2026-06-23T00:00:00.000Z',
};

function mockScoutTable() {
  return {
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: scoutRow, error: null }) }) }),
  };
}

beforeEach(() => {
  getSession.mockReset();
  onAuthStateChange.mockReset();
  unsubscribe.mockReset();
  from.mockReset();
  onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe } } });
  from.mockImplementation(() => mockScoutTable());
});

describe('useSession', () => {
  it('starts loading, then resolves session/scout (no role)', async () => {
    getSession.mockResolvedValue({ data: { session }, error: null });

    const { result } = renderHook(() => useSession());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toEqual(session);
    expect(result.current.scout).toEqual(scoutRow);
    expect('role' in result.current).toBe(false);
  });

  it('resolves to nulls when there is no session', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toBeNull();
    expect(result.current.scout).toBeNull();
  });

  // Regression: the "selected event disappears" bug. A later auth event (e.g.
  // TOKEN_REFRESHED on a timer, or tab focus) must NOT flip loading back to true,
  // which previously unmounted guarded screens and wiped their local state.
  it('does NOT re-enter loading on a subsequent auth event', async () => {
    getSession.mockResolvedValue({ data: { session }, error: null });

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Grab the registered onAuthStateChange callback and fire it again.
    const cb = onAuthStateChange.mock.calls[0][0] as (e: string, s: unknown) => void;
    await act(async () => {
      cb('TOKEN_REFRESHED', session);
    });

    expect(result.current.loading).toBe(false);
  });

  it('unsubscribes the auth listener on unmount', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    const { unmount } = renderHook(() => useSession());
    await waitFor(() => expect(onAuthStateChange).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
