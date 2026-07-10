// src/capture/clock.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchWindow } from '@/scoring';
import { SHIFT_BOUNDS } from '@/scoring';

export type ClockPhase = 'idle' | 'auto' | 'pause' | 'teleop' | 'done';

export const AUTO_MS = 20000;
export const TELEOP_MS = 140000;
// How long the clock may sit in 'pause' before it assumes the scout missed the
// GO tap and enters teleop on its own (flagged unconfirmed). The real
// auto→teleop gap is a few seconds; without this fallback a forgotten GO tap
// left the phase at 'pause' for the entire match, silently tagging every
// teleop burst/interval as 'auto' with no downstream trace.
export const PAUSE_FALLBACK_MS = 15000;

// Pure: remaining ms in a phase, clamped to [0, totalMs]. Used to drive the
// count-DOWN readout (remaining = total - elapsed).
export function remainingMs(totalMs: number, elapsedMs: number): number {
  return Math.max(0, totalMs - elapsedMs);
}

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

export interface MatchClockSnapshot {
  phase: ClockPhase;
  autoElapsedMs: number;
  teleopElapsedMs: number;
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
  const [suspendedElapsed, setSuspendedElapsed] = useState<{
    autoElapsedMs: number;
    teleopElapsedMs: number;
  } | null>(null);
  const [, setTick] = useState(0);

  // Tick to refresh elapsed/window readouts; `now` is injectable for tests.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, []);

  const autoElapsedMs =
    suspendedElapsed !== null
      ? suspendedElapsed.autoElapsedMs
      : state.autoStartedAt === null
        ? 0
        : nowRef.current() - state.autoStartedAt;
  const teleopElapsedMs =
    suspendedElapsed !== null
      ? suspendedElapsed.teleopElapsedMs
      : state.teleopAnchoredAt === null
        ? 0
        : nowRef.current() - state.teleopAnchoredAt;

  // Auto auto-advances to 'pause' once AUTO_MS has elapsed.
  useEffect(() => {
    if (suspendedElapsed === null && state.phase === 'auto' && autoElapsedMs >= AUTO_MS) {
      setState((s) => (s.phase === 'auto' ? { ...s, phase: 'pause' } : s));
    }
  }, [state.phase, autoElapsedMs, suspendedElapsed]);

  // Pause auto-advances to teleop (flagged UNCONFIRMED) if the scout never taps
  // GO. A tap of GO afterwards still re-anchors and clears the flag (markGo).
  useEffect(() => {
    if (
      suspendedElapsed !== null ||
      state.phase !== 'pause' ||
      state.autoStartedAt === null
    ) {
      return;
    }
    const pauseElapsedMs = nowRef.current() - (state.autoStartedAt + AUTO_MS);
    const id = setTimeout(() => {
      setState((s) =>
        s.phase === 'pause'
          ? {
              ...s,
              phase: 'teleop',
              teleopAnchoredAt: nowRef.current(),
              teleopClockUnconfirmed: true,
            }
          : s,
      );
    }, Math.max(0, PAUSE_FALLBACK_MS - pauseElapsedMs));
    return () => clearTimeout(id);
  }, [state.phase, state.autoStartedAt, suspendedElapsed]);

  const window: MatchWindow = windowForBurst(state.phase, teleopElapsedMs);

  const startAuto = useCallback(() => {
    setSuspendedElapsed(null);
    setState({
      phase: 'auto',
      autoStartedAt: nowRef.current(),
      teleopAnchoredAt: null,
      teleopClockUnconfirmed: false,
    });
  }, []);

  // Confirmed two-tap teleop entry: scout taps GO at the real teleop start.
  const markGo = useCallback(() => {
    setSuspendedElapsed(null);
    setState((s) => ({
      ...s,
      phase: 'teleop',
      teleopAnchoredAt: nowRef.current(),
      teleopClockUnconfirmed: false,
    }));
  }, []);

  // Fallback teleop entry (no GO tap): anchor now but flag the clock unconfirmed.
  const enterTeleopFallback = useCallback(() => {
    setSuspendedElapsed(null);
    setState((s) => ({
      ...s,
      phase: 'teleop',
      teleopAnchoredAt: nowRef.current(),
      teleopClockUnconfirmed: true,
    }));
  }, []);

  // 0:30 cue: remap the anchor so the current `now` maps to endgame start.
  const reAnchor = useCallback(() => {
    setSuspendedElapsed(null);
    setState((s) => ({
      ...s,
      teleopAnchoredAt: nowRef.current() - SHIFT_BOUNDS.endgame.start,
    }));
  }, []);

  const finish = useCallback(() => {
    setSuspendedElapsed(null);
    setState((s) => ({ ...s, phase: 'done' }));
  }, []);

  const reset = useCallback(() => {
    setSuspendedElapsed(null);
    setState(INITIAL_STATE);
  }, []);

  const restore = useCallback((snapshot: MatchClockSnapshot) => {
    const autoElapsed = Math.max(0, Math.min(AUTO_MS, snapshot.autoElapsedMs));
    const teleopElapsed = Math.max(0, Math.min(TELEOP_MS, snapshot.teleopElapsedMs));
    const requiresResume =
      snapshot.phase === 'auto' ||
      snapshot.phase === 'pause' ||
      snapshot.phase === 'teleop';
    setState({
      phase: snapshot.phase,
      autoStartedAt: null,
      teleopAnchoredAt: null,
      teleopClockUnconfirmed: snapshot.teleopClockUnconfirmed,
    });
    setSuspendedElapsed(
      requiresResume
        ? { autoElapsedMs: autoElapsed, teleopElapsedMs: teleopElapsed }
        : null,
    );
  }, []);

  const resumeFromSaved = useCallback(() => {
    setSuspendedElapsed((saved) => {
      if (!saved) return null;
      const current = nowRef.current();
      setState((s) => ({
        ...s,
        autoStartedAt:
          s.phase === 'auto' || s.phase === 'pause'
            ? current - saved.autoElapsedMs
            : s.autoStartedAt,
        teleopAnchoredAt:
          s.phase === 'teleop'
            ? current - saved.teleopElapsedMs
            : s.teleopAnchoredAt,
      }));
      return null;
    });
  }, []);

  const snapshot: MatchClockSnapshot = {
    phase: state.phase,
    autoElapsedMs: Math.max(0, Math.min(AUTO_MS, autoElapsedMs)),
    teleopElapsedMs: Math.max(0, Math.min(TELEOP_MS, teleopElapsedMs)),
    teleopClockUnconfirmed: state.teleopClockUnconfirmed,
  };

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
    restore,
    resumeFromSaved,
    resumeRequired: suspendedElapsed !== null,
    snapshot,
  };
}
