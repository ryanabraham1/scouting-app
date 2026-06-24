import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCaptureEvents } from '@/capture/useCaptureEvents';

describe('useCaptureEvents', () => {
  it('records defense/defended intervals and exposes canUndo', () => {
    const { result } = renderHook(() => useCaptureEvents());
    expect(result.current.canUndo).toBe(false);

    act(() => {
      result.current.recordDefense({ startMs: 0, endMs: 3000, durationMs: 3000 });
      result.current.recordDefended({ startMs: 0, endMs: 1500, durationMs: 1500 });
    });

    expect(result.current.events).toHaveLength(2);
    expect(result.current.canUndo).toBe(true);
  });

  it('undoLast reverses the most recent action via the supplied handler', () => {
    const onUndoDefended = vi.fn();
    const onUndoDefense = vi.fn();
    const { result } = renderHook(() =>
      useCaptureEvents({ onUndoDefense, onUndoDefended }),
    );

    act(() => {
      result.current.recordDefense({ startMs: 0, endMs: 3000, durationMs: 3000 });
      result.current.recordDefended({ startMs: 0, endMs: 1500, durationMs: 1500 });
    });

    act(() => {
      result.current.undoLast(); // pops the defended interval
    });

    expect(onUndoDefended).toHaveBeenCalledWith({ startMs: 0, endMs: 1500, durationMs: 1500 });
    expect(onUndoDefense).not.toHaveBeenCalled();
    expect(result.current.events).toHaveLength(1);
  });

  it('skips trailing phase markers when undoing', () => {
    const onUndoFoul = vi.fn();
    const { result } = renderHook(() => useCaptureEvents({ onUndoFoul }));

    act(() => {
      result.current.recordFoul({ kind: 'minor' });
      result.current.recordPhase({ phase: 'teleop' });
    });

    act(() => {
      result.current.undoLast(); // should pop the foul, not the phase marker
    });

    expect(onUndoFoul).toHaveBeenCalledTimes(1);
    // the phase marker remains
    expect(result.current.events.some((e) => e.type === 'phase')).toBe(true);
    expect(result.current.events.some((e) => e.type === 'foul')).toBe(false);
  });
});
