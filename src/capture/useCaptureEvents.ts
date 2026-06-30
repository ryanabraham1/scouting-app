import { useCallback, useRef, useState } from 'react';

/**
 * In-memory interaction timeline for the field-map capture screen.
 *
 * Every meaningful scout interaction is appended as a {@link CaptureEvent}.
 * The timeline drives the always-visible Undo button: popping the last entry
 * reverses its *derived* effect on the underlying `useCaptureSession`.
 *
 * The persisted data model is unchanged — this layer only records HOW the
 * existing report fields were produced (and feeds a future match-timeline view).
 */
export type CaptureEventType =
  | 'defense' // a completed "playing defense" interval
  | 'defended' // a completed "being defended" interval
  | 'burst' // a committed fuel burst (best-effort undo)
  | 'foul' // a foul increment
  | 'toggle' // a boolean toggle action (e.g. left-line, auto-climb)
  | 'phase'; // a phase change marker (not undoable on its own)

export interface CaptureEvent<P = unknown> {
  type: CaptureEventType;
  /** Wall-clock timestamp (Date.now) the event was recorded. */
  ts: number;
  payload: P;
}

export interface DefenseIntervalPayload {
  /** performance.now() at press. */
  startMs: number;
  /** performance.now() at release. */
  endMs: number;
  /** Exact elapsed ms (endMs - startMs), the amount added to the running total. */
  durationMs: number;
}

export interface BurstPayload {
  rate: number;
  /** Which slider committed the burst, so Undo pops from the right array. */
  kind?: 'fuel' | 'feeding';
}

export interface FoulPayload {
  /** 'minor' | 'major' — which counter was bumped. */
  kind: 'minor' | 'major';
}

export interface TogglePayload {
  /** A stable key identifying which boolean was toggled (e.g. 'autoLeftStartingLine'). */
  key: string;
  /** The value that was applied by this action (so undo can restore the prior one). */
  value: boolean;
  /** The value before this action — what undo restores. */
  prev: boolean;
}

export interface PhasePayload {
  phase: string;
}

/**
 * Reverse-effect callbacks the host (CaptureScreen) supplies so undo() can
 * unwind a popped event against the real session setters. Each is best-effort
 * and may be omitted; an undone event with no handler simply drops from the
 * timeline.
 */
export interface UndoHandlers {
  onUndoDefense?: (p: DefenseIntervalPayload) => void;
  onUndoDefended?: (p: DefenseIntervalPayload) => void;
  onUndoBurst?: (p: BurstPayload) => void;
  onUndoFoul?: (p: FoulPayload) => void;
  onUndoToggle?: (p: TogglePayload) => void;
}

export function useCaptureEvents(handlers: UndoHandlers = {}) {
  const [events, setEventsState] = useState<CaptureEvent[]>([]);
  // Ref mirror so undo() can resolve the popped event SYNCHRONOUSLY (reading it
  // from inside a setState updater returns null until the updater later runs).
  const eventsRef = useRef<CaptureEvent[]>([]);

  const setEvents = useCallback((next: CaptureEvent[]) => {
    eventsRef.current = next;
    setEventsState(next);
  }, []);

  const push = useCallback(
    (type: CaptureEventType, payload: unknown) => {
      setEvents([...eventsRef.current, { type, ts: Date.now(), payload }]);
    },
    [setEvents],
  );

  const recordDefense = useCallback(
    (p: DefenseIntervalPayload) => push('defense', p),
    [push],
  );
  const recordDefended = useCallback(
    (p: DefenseIntervalPayload) => push('defended', p),
    [push],
  );
  const recordBurst = useCallback((p: BurstPayload) => push('burst', p), [push]);
  const recordFoul = useCallback((p: FoulPayload) => push('foul', p), [push]);
  const recordToggle = useCallback((p: TogglePayload) => push('toggle', p), [push]);
  const recordPhase = useCallback((p: PhasePayload) => push('phase', p), [push]);

  /**
   * Pop the most recent UNDOABLE event and reverse its derived effect. Phase
   * markers are skipped (not undoable on their own) but removed if they sit on
   * top with nothing after them — actually we keep them and only pop the last
   * non-phase action. Returns the popped event, or null if nothing to undo.
   */
  const undo = useCallback((): CaptureEvent | null => {
    const prev = eventsRef.current;
    if (prev.length === 0) {
      return null;
    }
    // Find the last event that is undoable (skip trailing phase markers).
    let idx = prev.length - 1;
    while (idx >= 0 && prev[idx].type === 'phase') {
      idx -= 1;
    }
    if (idx < 0) {
      return null;
    }
    const popped = prev[idx];
    setEvents(prev.slice(0, idx).concat(prev.slice(idx + 1)));
    return popped;
  }, [setEvents]);

  // Apply the reverse effect for a popped event. Kept separate from the state
  // update so the host can call it after undo() returns the popped event; but
  // for ergonomics we expose a single undoAndApply that does both.
  const applyUndo = useCallback(
    (ev: CaptureEvent | null) => {
      if (!ev) {
        return;
      }
      switch (ev.type) {
        case 'defense':
          handlers.onUndoDefense?.(ev.payload as DefenseIntervalPayload);
          break;
        case 'defended':
          handlers.onUndoDefended?.(ev.payload as DefenseIntervalPayload);
          break;
        case 'burst':
          handlers.onUndoBurst?.(ev.payload as BurstPayload);
          break;
        case 'foul':
          handlers.onUndoFoul?.(ev.payload as FoulPayload);
          break;
        case 'toggle':
          handlers.onUndoToggle?.(ev.payload as TogglePayload);
          break;
        default:
          break;
      }
    },
    [handlers],
  );

  const undoLast = useCallback((): CaptureEvent | null => {
    const ev = undo();
    applyUndo(ev);
    return ev;
  }, [undo, applyUndo]);

  // Whether there is at least one undoable (non-phase) event.
  const canUndo = events.some((e) => e.type !== 'phase');

  return {
    events,
    canUndo,
    recordDefense,
    recordDefended,
    recordBurst,
    recordFoul,
    recordToggle,
    recordPhase,
    undo,
    applyUndo,
    undoLast,
  };
}
