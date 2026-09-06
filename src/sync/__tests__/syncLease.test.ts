import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetSyncLeaseForTests,
  withCrossTabSyncLease,
} from '@/sync/syncLease';

describe('cross-tab sync lease fallback', () => {
  beforeEach(async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: undefined });
    await resetSyncLeaseForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await resetSyncLeaseForTests();
  });

  it('atomically admits only one of two simultaneous contenders', async () => {
    let releaseOwner!: () => void;
    const ownerFinished = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const began: string[] = [];

    const first = withCrossTabSyncLease(async () => {
      began.push('first');
      await ownerFinished;
      return 'completed';
    });
    const second = withCrossTabSyncLease(async () => {
      began.push('second');
      await ownerFinished;
      return 'completed';
    });

    await vi.waitFor(() => expect(began).toHaveLength(1));
    releaseOwner();
    expect((await Promise.all([first, second])).sort()).toEqual([
      'completed',
      'not-acquired',
    ]);
    expect(began).toHaveLength(1);
  });

  it('allows recovery after an unrenewed owner expires without late-release clobbering', async () => {
    let now = 10_000;
    let releaseCrashedTab!: () => void;
    const crashedTabFinished = new Promise<void>((resolve) => {
      releaseCrashedTab = resolve;
    });
    const began: string[] = [];

    const crashedTab = withCrossTabSyncLease(
      async () => {
        began.push('expired-owner');
        await crashedTabFinished;
        return 'completed';
      },
      { leaseMs: 1_000, renew: false, now: () => now },
    );
    await vi.waitFor(() => expect(began).toEqual(['expired-owner']));

    now += 1_001;
    let releaseSuccessor!: () => void;
    const successorFinished = new Promise<void>((resolve) => {
      releaseSuccessor = resolve;
    });
    let successorStillOwner!: () => Promise<boolean>;
    const successor = withCrossTabSyncLease(
      async (stillOwner) => {
        began.push('successor');
        successorStillOwner = stillOwner;
        await successorFinished;
        return 'completed';
      },
      { leaseMs: 1_000, renew: false, now: () => now },
    );
    await vi.waitFor(() => expect(began).toEqual(['expired-owner', 'successor']));

    // The expired owner finishes late. Its conditional release must leave the
    // successor's token untouched.
    releaseCrashedTab();
    expect(await crashedTab).toBe('completed');
    expect(await successorStillOwner()).toBe(true);
    expect(await withCrossTabSyncLease(
      async () => {
        began.push('third');
        return 'completed';
      },
      { leaseMs: 1_000, renew: false, now: () => now },
    )).toBe('not-acquired');

    releaseSuccessor();
    expect(await successor).toBe('completed');
    expect(began).toEqual(['expired-owner', 'successor']);
  });

  it('reports incomplete when ownership expires between work phases', async () => {
    let now = 20_000;

    const result = await withCrossTabSyncLease(
      async (stillOwner) => {
        expect(await stillOwner()).toBe(true);
        now += 1_001;
        expect(await stillOwner()).toBe(false);
        return 'incomplete';
      },
      { leaseMs: 1_000, renew: false, now: () => now },
    );

    expect(result).toBe('incomplete');
  });
});
