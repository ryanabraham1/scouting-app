import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSyncCircuit,
  isSyncCircuitOpen,
  openSyncCircuit,
  retryDelayMs,
  syncCircuitUntil,
} from '../retrySchedule';

describe('retry scheduling', () => {
  beforeEach(() => clearSyncCircuit());

  it('applies exponential full jitter with a bounded floor', () => {
    expect(retryDelayMs({}, 0, 0, () => 0)).toBe(2_000);
    expect(retryDelayMs({}, 3, 0, () => 0)).toBe(8_000);
    expect(retryDelayMs({}, 3, 0, () => 1)).toBe(16_000);
  });

  it('honors Retry-After seconds and HTTP dates', () => {
    expect(retryDelayMs({ retryAfter: '12' }, 0, 1_000)).toBe(12_000);
    expect(
      retryDelayMs(
        { headers: { get: () => 'Thu, 01 Jan 1970 00:00:21 GMT' } },
        0,
        1_000,
      ),
    ).toBe(20_000);
  });

  it('persists and clears the cross-tab circuit deadline', () => {
    openSyncCircuit(20_000);
    expect(syncCircuitUntil()).toBe(20_000);
    expect(isSyncCircuitOpen(19_999)).toBe(true);
    expect(isSyncCircuitOpen(20_000)).toBe(false);
    clearSyncCircuit();
    expect(syncCircuitUntil()).toBe(0);
  });
});
