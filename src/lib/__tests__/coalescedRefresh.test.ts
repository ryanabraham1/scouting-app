import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescedRefresh } from '../coalescedRefresh';

describe('createCoalescedRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once for a burst of per-row realtime events', async () => {
    const run = vi.fn();
    const refresh = createCoalescedRefresh(run, { delayMs: 1000 });
    for (let i = 0; i < 756; i++) refresh.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('spreads devices across the jitter window', async () => {
    const run = vi.fn();
    const refresh = createCoalescedRefresh(run, {
      delayMs: 1000,
      jitterMs: 4000,
      random: () => 0.5,
    });
    refresh.request();
    await vi.advanceTimersByTimeAsync(2999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs once more when a trigger lands during a run, never concurrently', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const refresh = createCoalescedRefresh(run, { delayMs: 100 });
    refresh.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    refresh.request();
    refresh.flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('flush skips the wait and replaces the pending run', async () => {
    const run = vi.fn();
    const refresh = createCoalescedRefresh(run, { delayMs: 1000 });
    refresh.request();
    refresh.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps working after a failed run', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('522')).mockResolvedValue(undefined);
    const refresh = createCoalescedRefresh(run, { delayMs: 100 });
    refresh.request();
    await vi.advanceTimersByTimeAsync(100);
    refresh.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancel drops the pending run and ignores later triggers', async () => {
    const run = vi.fn();
    const refresh = createCoalescedRefresh(run, { delayMs: 100 });
    refresh.request();
    refresh.cancel();
    refresh.request();
    refresh.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
  });
});
