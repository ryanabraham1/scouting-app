// src/dash/__tests__/defenseAnalytics.test.ts
import { describe, it, expect } from 'vitest';
import {
  AUTO_MS,
  burstAbsRange,
  intervalAbsRange,
  overlapMs,
  weightedRate,
  clampSuppression,
  suppressionFromBursts,
  pctSigned,
} from '@/dash/defenseAnalytics';
import type { BurstRow, IntervalRow } from '@/dash/types';

const burst = (o: Partial<BurstRow>): BurstRow => ({
  startMs: 0,
  endMs: 1000,
  rate: 1,
  window: 'teleop',
  ...o,
});
const interval = (o: Partial<IntervalRow>): IntervalRow => ({
  startMs: 0,
  endMs: 1000,
  phase: 'teleop',
  ...o,
});

describe('overlapMs', () => {
  it('disjoint ranges → 0', () => {
    expect(overlapMs({ start: 0, end: 10 }, { start: 20, end: 30 })).toBe(0);
  });
  it('partial overlap → overlap length', () => {
    expect(overlapMs({ start: 0, end: 20 }, { start: 10, end: 40 })).toBe(10);
  });
  it('nested → inner length', () => {
    expect(overlapMs({ start: 0, end: 100 }, { start: 30, end: 50 })).toBe(20);
  });
});

describe('burstAbsRange / intervalAbsRange', () => {
  it('auto window is not offset', () => {
    expect(burstAbsRange(burst({ startMs: 1000, endMs: 3000, window: 'auto' }))).toEqual({
      start: 1000,
      end: 3000,
    });
    expect(intervalAbsRange(interval({ startMs: 500, endMs: 1500, phase: 'auto' }))).toEqual({
      start: 500,
      end: 1500,
    });
  });
  it('teleop window is offset by AUTO_MS', () => {
    expect(burstAbsRange(burst({ startMs: 1000, endMs: 3000, window: 'teleop' }))).toEqual({
      start: AUTO_MS + 1000,
      end: AUTO_MS + 3000,
    });
    expect(intervalAbsRange(interval({ startMs: 500, endMs: 1500, phase: 'teleop' }))).toEqual({
      start: AUTO_MS + 500,
      end: AUTO_MS + 1500,
    });
  });
});

describe('weightedRate', () => {
  it('single burst fully inside one window → insideRate==rate, outsideRate==null', () => {
    // teleop burst [AUTO_MS+0, AUTO_MS+1000), rate 4, inside a covering window.
    const b = burst({ startMs: 0, endMs: 1000, rate: 4, window: 'teleop' });
    const wr = weightedRate([b], [{ start: AUTO_MS, end: AUTO_MS + 1000 }]);
    expect(wr.insideRate).toBe(4);
    expect(wr.outsideRate).toBeNull();
    expect(wr.insideDur).toBe(1000);
    expect(wr.outsideDur).toBe(0);
  });

  it('burst split 50/50 across a window edge → equal durations, rates equal rate', () => {
    // teleop burst [AUTO_MS, AUTO_MS+2000), rate 6; window covers first half only.
    const b = burst({ startMs: 0, endMs: 2000, rate: 6, window: 'teleop' });
    const wr = weightedRate([b], [{ start: AUTO_MS, end: AUTO_MS + 1000 }]);
    expect(wr.insideDur).toBe(1000);
    expect(wr.outsideDur).toBe(1000);
    expect(wr.insideRate).toBe(6);
    expect(wr.outsideRate).toBe(6);
  });

  it('no windows → all outside', () => {
    const b = burst({ startMs: 0, endMs: 1000, rate: 3, window: 'teleop' });
    const wr = weightedRate([b], []);
    expect(wr.insideRate).toBeNull();
    expect(wr.outsideRate).toBe(3);
  });

  it('empty / undefined bursts → both null', () => {
    expect(weightedRate([], []).insideRate).toBeNull();
    expect(weightedRate(undefined, []).outsideRate).toBeNull();
  });
});

describe('suppressionFromBursts', () => {
  it('undefended rate 10, defended rate 6 → 0.4', () => {
    const defended = burst({ startMs: 0, endMs: 1000, rate: 6, window: 'teleop' });
    const undef = burst({ startMs: 2000, endMs: 3000, rate: 10, window: 'teleop' });
    const supp = suppressionFromBursts([defended, undef], [
      { start: AUTO_MS, end: AUTO_MS + 1000 },
    ]);
    expect(supp).toBeCloseTo(0.4, 6);
  });

  it('defended rate > undefended → negative suppression', () => {
    const defended = burst({ startMs: 0, endMs: 1000, rate: 12, window: 'teleop' });
    const undef = burst({ startMs: 2000, endMs: 3000, rate: 10, window: 'teleop' });
    const supp = suppressionFromBursts([defended, undef], [
      { start: AUTO_MS, end: AUTO_MS + 1000 },
    ]);
    expect(supp).toBeLessThan(0);
    expect(supp).toBeCloseTo(-0.2, 6);
  });

  it('no defended windows → null', () => {
    const b = burst({ startMs: 0, endMs: 1000, rate: 10, window: 'teleop' });
    expect(suppressionFromBursts([b], [])).toBeNull();
  });

  it('defended entire match (no outside bursts) → null', () => {
    const b = burst({ startMs: 0, endMs: 1000, rate: 6, window: 'teleop' });
    expect(
      suppressionFromBursts([b], [{ start: AUTO_MS, end: AUTO_MS + 1000 }]),
    ).toBeNull();
  });

  it('empty bursts → null', () => {
    expect(suppressionFromBursts([], [{ start: 0, end: 1000 }])).toBeNull();
    expect(suppressionFromBursts(undefined, [{ start: 0, end: 1000 }])).toBeNull();
  });
});

describe('clampSuppression', () => {
  it('caps at ±1', () => {
    expect(clampSuppression(2.5)).toBe(1);
    expect(clampSuppression(-3)).toBe(-1);
    expect(clampSuppression(0.3)).toBeCloseTo(0.3, 6);
  });
});

describe('pctSigned', () => {
  it('positive uses no sign', () => {
    expect(pctSigned(0.3)).toBe('30%');
  });
  it('negative uses the Unicode minus (U+2212)', () => {
    expect(pctSigned(-0.12)).toBe('−12%');
  });
  it('zero → 0%', () => {
    expect(pctSigned(0)).toBe('0%');
  });
});
