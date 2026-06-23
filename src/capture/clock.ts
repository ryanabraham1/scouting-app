// src/capture/clock.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchWindow } from '@/scoring';
import { SHIFT_BOUNDS } from '@/scoring';

export type ClockPhase = 'idle' | 'auto' | 'pause' | 'teleop' | 'done';

export const AUTO_MS = 20000;
export const TELEOP_MS = 140000;

// Order of teleop windows from teleop start onward (keys of SHIFT_BOUNDS, so it
// excludes 'auto' — letting us index SHIFT_BOUNDS without a type error).
const TELEOP_WINDOW_ORDER: (keyof typeof SHIFT_BOUNDS)[] = [
  'transition',
  'shift1',
  'shift2',
  'shift3',
  'shift4',
  'endgame',
];

// Pure: maps teleop elapsed ms (0..140000) to a MatchWindow via SHIFT_BOUNDS.
// >= TELEOP_MS clamps to 'endgame'. Takes its time as an argument (no Date.now).
export function teleopWindowAt(elapsedMs: number): MatchWindow {
  if (elapsedMs >= TELEOP_MS) return 'endgame';
  for (const window of TELEOP_WINDOW_ORDER) {
    const { start, end } = SHIFT_BOUNDS[window];
    if (elapsedMs >= start && elapsedMs < end) return window;
  }
  // Below the first boundary (negative) clamps to the first window.
  return 'transition';
}

// Pure: tags a fuel burst with its window given the current phase + teleop ms.
export function windowForBurst(
  phase: ClockPhase,
  teleopElapsedMs: number,
): MatchWindow {
  if (phase === 'auto') return 'auto';
  if (phase === 'teleop') return teleopWindowAt(teleopElapsedMs);
  return 'auto';
}

export interface MatchClockState {
  phase: ClockPhase;
  autoStartedAt: number | null;
  teleopAnchoredAt: number | null;
  teleopClockUnconfirmed: boolean;
}

const INITIAL_STATE: MatchClockState = {
  phase: 'idle',
  autoStartedAt: null,
  teleopAnchoredAt: null,
  teleopClockUnconfirmed: false,
};

export function useMatchClock(now: () => number = () => Date.now()) {
  const nowRef = useRef(now);
  nowRef.current = now;

  const [state, setState] = useState<MatchClockState>(INITIAL_STATE);
  const [, setTick] = useState(0);

  // Tick to refresh elapsed/window readouts; `now` is injectable for tests.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, []);

  const autoElapsedMs =
    state.autoStartedAt === null ? 0 : nowRef.current() - state.autoStartedAt;
  const teleopElapsedMs =
    state.teleopAnchoredAt === null
      ? 0
      : nowRef.current() - state.teleopAnchoredAt;

  // Auto auto-advances to 'pause' once AUTO_MS has elapsed.
  useEffect(() => {
    if (state.phase === 'auto' && autoElapsedMs >= AUTO_MS) {
      setState((s) => (s.phase === 'auto' ? { ...s, phase: 'pause' } : s));
    }
  }, [state.phase, autoElapsedMs]);

  const window: MatchWindow = windowForBurst(state.phase, teleopElapsedMs);

  const startAuto = useCallback(() => {
    setState({
      phase: 'auto',
      autoStartedAt: nowRef.current(),
      teleopAnchoredAt: null,
      teleopClockUnconfirmed: false,
    });
  }, []);

  // Confirmed two-tap teleop entry: scout taps GO at the real teleop start.
  const markGo = useCallback(() => {
    setState((s) => ({
      ...s,
      phase: 'teleop',
      teleopAnchoredAt: nowRef.current(),
      teleopClockUnconfirmed: false,
    }));
  }, []);

  // Fallback teleop entry (no GO tap): anchor now but flag the clock unconfirmed.
  const enterTeleopFallback = useCallback(() => {
    setState((s) => ({
      ...s,
      phase: 'teleop',
      teleopAnchoredAt: nowRef.current(),
      teleopClockUnconfirmed: true,
    }));
  }, []);

  // 0:30 cue: remap the anchor so the current `now` maps to endgame start.
  const reAnchor = useCallback(() => {
    setState((s) => ({
      ...s,
      teleopAnchoredAt: nowRef.current() - SHIFT_BOUNDS.endgame.start,
    }));
  }, []);

  const finish = useCallback(() => {
    setState((s) => ({ ...s, phase: 'done' }));
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return {
    state,
    autoElapsedMs,
    teleopElapsedMs,
    window,
    startAuto,
    markGo,
    enterTeleopFallback,
    reAnchor,
    finish,
    reset,
  };
}
