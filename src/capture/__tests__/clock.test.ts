import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  teleopWindowAt,
  windowForBurst,
  useMatchClock,
  AUTO_MS,
  TELEOP_MS,
} from '@/capture/clock';
import type { MatchWindow } from '@/scoring';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function fakeNow() {
  let t = 0;
  const fn = () => t;
  fn.set = (v: number) => {
    t = v;
  };
  fn.advance = (d: number) => {
    t += d;
  };
  return fn as (() => number) & {
    set: (v: number) => void;
    advance: (d: number) => void;
  };
}

describe('teleopWindowAt boundary table', () => {
  const cases: Array<[number, MatchWindow]> = [
    [0, 'transition'],
    [9999, 'transition'],
    [10000, 'shift1'],
    [34999, 'shift1'],
    [35000, 'shift2'],
    [59999, 'shift2'],
    [60000, 'shift3'],
    [84999, 'shift3'],
    [85000, 'shift4'],
    [109999, 'shift4'],
    [110000, 'endgame'],
    [139999, 'endgame'],
    [140000, 'endgame'],
    [999999, 'endgame'],
  ];
  it.each(cases)('elapsed %d -> %s', (elapsed, expected) => {
    expect(teleopWindowAt(elapsed)).toBe(expected);
  });

  it('clamps negative elapsed to transition', () => {
    expect(teleopWindowAt(-1)).toBe('transition');
  });

  it('exposes phase-duration constants', () => {
    expect(AUTO_MS).toBe(20000);
    expect(TELEOP_MS).toBe(140000);
  });
});

describe('windowForBurst', () => {
  it("returns 'auto' when phase is auto", () => {
    expect(windowForBurst('auto', 50000)).toBe('auto');
  });
  it('maps via teleopWindowAt when phase is teleop', () => {
    expect(windowForBurst('teleop', 0)).toBe('transition');
    expect(windowForBurst('teleop', 36000)).toBe('shift2');
    expect(windowForBurst('teleop', 120000)).toBe('endgame');
  });
  it("falls back to 'auto' for idle/pause/done", () => {
    expect(windowForBurst('idle', 36000)).toBe('auto');
    expect(windowForBurst('pause', 36000)).toBe('auto');
    expect(windowForBurst('done', 36000)).toBe('auto');
  });
});

describe('useMatchClock auto -> pause', () => {
  it('startAuto sets phase auto, then advances to pause after AUTO_MS', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(1000);
      result.current.startAuto();
    });
    expect(result.current.state.phase).toBe('auto');
    expect(result.current.state.autoStartedAt).toBe(1000);
    expect(result.current.window).toBe('auto');

    act(() => {
      now.advance(AUTO_MS);
      vi.advanceTimersByTime(250);
    });
    expect(result.current.state.phase).toBe('pause');
  });
});

describe('useMatchClock markGo -> teleop', () => {
  it('markGo sets phase teleop, anchors now, unconfirmed=false', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(5000);
      result.current.startAuto();
    });
    act(() => {
      now.set(28000);
      result.current.markGo();
    });

    expect(result.current.state.phase).toBe('teleop');
    expect(result.current.state.teleopAnchoredAt).toBe(28000);
    expect(result.current.state.teleopClockUnconfirmed).toBe(false);
    expect(result.current.teleopElapsedMs).toBe(0);
    expect(result.current.window).toBe('transition');
  });
});

describe('useMatchClock fallback teleop entry', () => {
  it('entering teleop without markGo sets unconfirmed=true', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(5000);
      result.current.startAuto();
    });
    act(() => {
      now.set(30000);
      result.current.enterTeleopFallback();
    });

    expect(result.current.state.phase).toBe('teleop');
    expect(result.current.state.teleopAnchoredAt).toBe(30000);
    expect(result.current.state.teleopClockUnconfirmed).toBe(true);
  });
});

describe('useMatchClock reAnchor', () => {
  it('reAnchor remaps now to the endgame window (110000ms)', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(1000);
      result.current.startAuto();
    });
    act(() => {
      now.set(40000);
      result.current.markGo();
    });
    // markGo anchors at now=40000, so teleop elapsed is 0 here. Advance the
    // injected clock so the readout reflects mid-teleop (shift1) before the cue.
    act(() => {
      now.set(60000);
      vi.advanceTimersByTime(250);
    });
    expect(result.current.window).toBe('shift1');

    act(() => {
      now.set(200000);
      result.current.reAnchor();
    });

    expect(result.current.state.teleopAnchoredAt).toBe(200000 - 110000);
    expect(result.current.teleopElapsedMs).toBe(110000);
    expect(result.current.window).toBe('endgame');
  });
});

describe('useMatchClock finish + reset', () => {
  it('finish -> done; reset -> idle with cleared anchors', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(1000);
      result.current.startAuto();
    });
    act(() => {
      now.set(30000);
      result.current.markGo();
    });
    act(() => {
      result.current.finish();
    });
    expect(result.current.state.phase).toBe('done');

    act(() => {
      result.current.reset();
    });
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.autoStartedAt).toBeNull();
    expect(result.current.state.teleopAnchoredAt).toBeNull();
    expect(result.current.state.teleopClockUnconfirmed).toBe(false);
    expect(result.current.window).toBe('auto');
  });
});

describe('purity guard', () => {
  it('teleopWindowAt and windowForBurst do not reference Date.now', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/capture/clock.ts'),
      'utf8',
    );
    const teleopFn = src.slice(
      src.indexOf('export function teleopWindowAt'),
      src.indexOf('export function windowForBurst'),
    );
    const burstFn = src.slice(
      src.indexOf('export function windowForBurst'),
      src.indexOf('export interface MatchClockState'),
    );
    expect(teleopFn).not.toContain('Date.now');
    expect(burstFn).not.toContain('Date.now');
  });
});
