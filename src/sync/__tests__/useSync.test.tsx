import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { LocalMatchReport } from '@/db/types';
import type { FuelBurst } from '@/scoring';
import { db, saveReport } from '@/db/localStore';
import { SYNC_POLL_MS } from '@/sync/constants';

// --- mocks ---------------------------------------------------------------
const onlineRef = { value: true };
vi.mock('@/sync/useOnline', () => ({
  useOnline: () => onlineRef.value,
}));

const syncOnceMock = vi.fn(async () => ({ attempted: 0, synced: 0, retried: 0, deadLettered: 0 }));
vi.mock('@/sync/outbox', () => ({
  syncOnce: () => syncOnceMock(),
}));

import { useSync } from '../useSync';

function makeReport(overrides: Partial<LocalMatchReport> = {}): LocalMatchReport {
  const bursts: FuelBurst[] = [{ startMs: 0, endMs: 500, rate: 2, window: 'shift1' }];
  return {
    id: 'r1',
    schemaVersion: 1,
    appVersion: 'test',
    deviceId: 'dev1',
    createdAt: new Date('2026-06-23T00:00:00.000Z').toISOString(),
    eventKey: '2026event',
    matchKey: 'qm1',
    scoutId: 'scout1',
    targetTeamNumber: 254,
    allianceColor: 'red',
    station: 1,
    inactiveFirst: false,
    inactiveFirstSource: 'scout',
    teleopClockUnconfirmed: false,
    fuelBursts: bursts,
    autoFuel: 0,
    teleopFuelActive: 1,
    teleopFuelInactive: 0,
    endgameFuel: 0,
    fuelByShift: [0, 1, 0, 0],
    fuelPoints: 1,
    fuelEstimateConfidence: 1,
    climbLevel: 0,
    climbAttempted: false,
    climbSuccess: false,
    autoStartPosition: null,
    autoPath: null,
    autoLeftStartingLine: false,
    autoClimbLevel1: false,
    intakeSources: [],
    maxFuelCapacityObserved: 0,
    defenseRating: 0,
    pins: 0,
    foulsMinor: 0,
    foulsMajor: 0,
    noShow: false,
    died: false,
    tipped: false,
    droppedFuel: false,
    fedCorral: false,
    notes: '',
    syncState: 'dirty',
    rowRevision: 1,
    syncAttempts: 0,
    lastSyncError: null,
    ...overrides,
  };
}

describe('useSync', () => {
  beforeEach(async () => {
    await db.reports.clear();
    onlineRef.value = true;
    syncOnceMock.mockClear();
    syncOnceMock.mockResolvedValue({ attempted: 0, synced: 0, retried: 0, deadLettered: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes online status from useOnline', async () => {
    const { result } = renderHook(() => useSync());
    await waitFor(() => expect(syncOnceMock).toHaveBeenCalled());
    expect(result.current.online).toBe(true);
  });

  it('runs syncOnce on mount and refreshes queued/deadLetters from the store', async () => {
    await saveReport(makeReport({ id: 'q1', syncState: 'dirty' }));
    await saveReport(makeReport({ id: 'q2', syncState: 'pending' }));
    await saveReport(makeReport({ id: 'd1', syncState: 'error' }));

    const { result } = renderHook(() => useSync());

    await waitFor(() => expect(syncOnceMock).toHaveBeenCalledTimes(1));
    // queued = getSyncQueue() (dirty + pending, EXCLUDES dead-letters): q1, q2 → 2
    await waitFor(() => expect(result.current.queued).toBe(2));
    expect(result.current.deadLetters).toBe(1);
  });

  it('syncNow() invokes syncOnce and refreshes counts', async () => {
    const { result } = renderHook(() => useSync());
    await waitFor(() => expect(syncOnceMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.syncNow();
    });

    await waitFor(() => expect(syncOnceMock).toHaveBeenCalledTimes(2));
  });

  it('does NOT auto-run syncOnce on mount while offline', async () => {
    onlineRef.value = false;
    renderHook(() => useSync());
    // Give effects a chance to run.
    await act(async () => {
      await Promise.resolve();
    });
    expect(syncOnceMock).not.toHaveBeenCalled();
  });

  it('does NOT tick syncOnce on the poll interval while offline', async () => {
    vi.useFakeTimers();
    onlineRef.value = false;
    renderHook(() => useSync());

    await act(async () => {
      vi.advanceTimersByTime(SYNC_POLL_MS * 3);
    });
    expect(syncOnceMock).not.toHaveBeenCalled();
  });

  it('runs syncOnce once on the offline→online reconnect edge', async () => {
    onlineRef.value = false;
    const { rerender } = renderHook(() => useSync());

    await act(async () => {
      await Promise.resolve();
    });
    expect(syncOnceMock).not.toHaveBeenCalled();

    // Reconnect.
    onlineRef.value = true;
    rerender();

    await waitFor(() => expect(syncOnceMock).toHaveBeenCalledTimes(1));
  });

  it('ticks syncOnce every SYNC_POLL_MS while online', async () => {
    vi.useFakeTimers();
    renderHook(() => useSync());

    // mount run
    await act(async () => {
      await Promise.resolve();
    });
    const afterMount = syncOnceMock.mock.calls.length;
    expect(afterMount).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SYNC_POLL_MS);
    });
    expect(syncOnceMock.mock.calls.length).toBeGreaterThan(afterMount);
  });

  it('guards overlapping runs: a syncNow while a run is in flight does not double-run', async () => {
    let resolveRun: (() => void) | undefined;
    syncOnceMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = () => resolve({ attempted: 0, synced: 0, retried: 0, deadLettered: 0 });
        }),
    );

    const { result } = renderHook(() => useSync());
    // mount run is in flight (unresolved)
    await waitFor(() => expect(syncOnceMock).toHaveBeenCalledTimes(1));
    expect(result.current.syncing).toBe(true);

    // Try to trigger another while the first is still running.
    await act(async () => {
      result.current.syncNow();
    });
    expect(syncOnceMock).toHaveBeenCalledTimes(1);

    // Finish the in-flight run.
    await act(async () => {
      resolveRun?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.syncing).toBe(false));
  });
});
