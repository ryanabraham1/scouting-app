import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  teleopWindowAt,
  windowForBurst,
  useMatchClock,
  remainingMs,
  AUTO_MS,
  TELEOP_MS,
  PAUSE_FALLBACK_MS,
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

describe('remainingMs (count-down)', () => {
  it('counts down from total to zero as elapsed grows', () => {
    expect(remainingMs(AUTO_MS, 0)).toBe(20000);
    expect(remainingMs(AUTO_MS, 5000)).toBe(15000);
    expect(remainingMs(AUTO_MS, 20000)).toBe(0);
  });
  it('clamps to zero past the total (never negative)', () => {
    expect(remainingMs(AUTO_MS, 25000)).toBe(0);
    expect(remainingMs(TELEOP_MS, 200000)).toBe(0);
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

describe('useMatchClock pause -> teleop fallback timer', () => {
  it('a forgotten GO tap auto-enters teleop after PAUSE_FALLBACK_MS, flagged unconfirmed', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(1000);
      result.current.startAuto();
    });
    act(() => {
      now.advance(AUTO_MS);
      vi.advanceTimersByTime(250);
    });
    expect(result.current.state.phase).toBe('pause');

    // Sit in pause past the fallback window without ever tapping GO. Without
    // this fallback the phase stayed 'pause' for the whole match, silently
    // tagging every teleop burst/interval as 'auto'.
    act(() => {
      now.advance(PAUSE_FALLBACK_MS);
      vi.advanceTimersByTime(PAUSE_FALLBACK_MS + 250);
    });
    expect(result.current.state.phase).toBe('teleop');
    expect(result.current.state.teleopClockUnconfirmed).toBe(true);
  });

  it('a GO tap within the window cancels the fallback (stays confirmed)', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(1000);
      result.current.startAuto();
    });
    act(() => {
      now.advance(AUTO_MS);
      vi.advanceTimersByTime(250);
    });
    act(() => {
      now.advance(3000);
      vi.advanceTimersByTime(3000);
      result.current.markGo();
    });
    act(() => {
      now.advance(PAUSE_FALLBACK_MS);
      vi.advanceTimersByTime(PAUSE_FALLBACK_MS + 250);
    });
    expect(result.current.state.phase).toBe('teleop');
    expect(result.current.state.teleopClockUnconfirmed).toBe(false);
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

// Contract guard: every window the client can stamp onto a burst must be one the
// server's validate_match_report_payload accepts, or the whole report terminally
// dead-letters ("feeding burst is malformed"). windowForBurst() returns 'auto'
// during the auto phase AND the pre-GO 'pause'/'done' fallback, so the server's
// FEEDING whitelist (which historically omitted 'auto') has to include it too.
describe('burst window ↔ server validation contract', () => {
  const CLIENT_EMITTABLE_WINDOWS: MatchWindow[] = (() => {
    const phases = ['idle', 'auto', 'pause', 'teleop', 'done'] as const;
    const times = [-1000, 0, 15000, 40000, 90000, 140000, 200000];
    const out = new Set<MatchWindow>();
    for (const phase of phases) {
      for (const t of times) out.add(windowForBurst(phase, t));
    }
    return [...out];
  })();

  /** Parse the `b->>'window' not in ( … )` whitelist that follows a given anchor. */
  function windowWhitelistAfter(sql: string, anchor: string): Set<string> {
    const from = sql.indexOf(anchor);
    if (from === -1) throw new Error(`anchor not found: ${anchor}`);
    const clauseStart = sql.indexOf("b->>'window' not in (", from);
    if (clauseStart === -1) throw new Error(`window whitelist not found after ${anchor}`);
    const open = sql.indexOf('(', clauseStart);
    const close = sql.indexOf(')', open);
    const list = sql.slice(open + 1, close);
    return new Set([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  }

  /** Latest migration (by filename) that (re)defines the payload validator. */
  function latestValidatorSql(): string {
    const dir = resolve(process.cwd(), 'supabase/migrations');
    const file = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) =>
        readFileSync(resolve(dir, f), 'utf8').includes(
          'function public.validate_match_report_payload',
        ),
      )
      .sort()
      .pop();
    if (!file) throw new Error('no validate_match_report_payload migration found');
    return readFileSync(resolve(dir, file), 'utf8');
  }

  it('the client only emits windows the server accepts for fuel and feeding bursts', () => {
    // 'auto' is a real client output — assert we are actually testing that case.
    expect(CLIENT_EMITTABLE_WINDOWS).toContain('auto');

    const sql = latestValidatorSql();
    const fuelWhitelist = windowWhitelistAfter(sql, "p->'fuel_bursts'");
    const feedingWhitelist = windowWhitelistAfter(sql, "p->'feeding_bursts'");

    for (const w of CLIENT_EMITTABLE_WINDOWS) {
      expect(fuelWhitelist.has(w)).toBe(true);
      expect(feedingWhitelist.has(w)).toBe(true);
    }
  });
});
