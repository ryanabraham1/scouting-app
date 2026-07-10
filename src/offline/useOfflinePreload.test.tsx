import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreloadResult } from '@/db/preloadClient';

const preload = vi.fn();
vi.mock('@/db/preloadClient', () => ({
  preloadEventData: (...args: unknown[]) => preload(...args),
  getPreloadMeta: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/sync/useOnline', () => ({ useOnline: () => true }));

import { useOfflinePreload } from './useOfflinePreload';

function result(event: string, matches: number): PreloadResult {
  return {
    ok: true,
    at: `${event}-at`,
    counts: { matches, assignments: 0, pitAssignments: 0, roster: 0, teams: 0 },
    errors: [],
  };
}

describe('useOfflinePreload event races', () => {
  beforeEach(() => preload.mockReset());

  it('does not publish a previous event result after the scope changes', async () => {
    const resolvers = new Map<string, (value: PreloadResult) => void>();
    preload.mockImplementation((opts?: { eventKey: string }) => {
      if (!opts) return Promise.resolve(result('unexpected', 0));
      return new Promise<PreloadResult>((resolve) => resolvers.set(opts.eventKey, resolve));
    });
    const hook = renderHook(
      ({ eventKey }) => useOfflinePreload(eventKey),
      { initialProps: { eventKey: '2026old' } },
    );
    await waitFor(() => expect(preload).toHaveBeenCalledWith({ eventKey: '2026old', scoutId: undefined }));

    hook.rerender({ eventKey: '2026new' });
    await waitFor(() => expect(preload).toHaveBeenCalledWith({ eventKey: '2026new', scoutId: undefined }));

    await act(async () => {
      resolvers.get('2026old')?.(result('2026old', 99));
      await Promise.resolve();
    });
    expect(hook.result.current.counts?.matches).not.toBe(99);

    await act(async () => {
      resolvers.get('2026new')?.(result('2026new', 7));
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.counts?.matches).toBe(7));
  });
});
