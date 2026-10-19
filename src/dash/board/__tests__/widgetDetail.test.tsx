import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardEditor } from '../editor';
import { useWidgetDetail } from '../widgets/useWidgetDetail';

const advance = (ms: number): void => { act(() => vi.advanceTimersByTime(ms)); };
afterEach(() => vi.useRealTimers());

describe('widget detail during navigation', () => {
  it('keeps card bodies stable during a continuous pinch and switches after settling', () => {
    vi.useFakeTimers();
    const editor = new BoardEditor({ clientId: 'detail-test' });
    const { result, unmount } = renderHook(() => useWidgetDetail(editor));
    expect(result.current).toBe(false);
    for (let i = 0; i < 12; i++) {
      act(() => editor.setCamera({ x: i, y: 0, z: 0.3 }));
      advance(40);
      expect(result.current).toBe(false);
    }
    advance(200);
    expect(result.current).toBe(true);
    act(() => editor.setCamera({ x: 0, y: 0, z: 0.44 }));
    advance(250);
    expect(result.current).toBe(true);
    act(() => editor.setCamera({ x: 0, y: 0, z: 0.6 }));
    advance(250);
    expect(result.current).toBe(false);
    unmount();
  });

  it('cancels a pending detail switch on unmount', () => {
    vi.useFakeTimers();
    const editor = new BoardEditor({ clientId: 'detail-test' });
    const { unmount } = renderHook(() => useWidgetDetail(editor));
    act(() => editor.setCamera({ x: 0, y: 0, z: 0.2 }));
    advance(30);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
