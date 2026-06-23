// src/sync/__tests__/useOnline.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOnline } from '../useOnline';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

afterEach(() => {
  // Restore the default so tests don't leak state.
  setOnLine(true);
});

describe('useOnline', () => {
  it('initializes from navigator.onLine (true)', () => {
    setOnLine(true);
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
  });

  it('initializes from navigator.onLine (false)', () => {
    setOnLine(false);
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(false);
  });

  it('flips to false when an offline event fires', () => {
    setOnLine(true);
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);

    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);
  });

  it('flips to true when an online event fires', () => {
    setOnLine(false);
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(false);

    act(() => {
      setOnLine(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
  });

  it('removes its listeners on unmount', () => {
    setOnLine(true);
    const { result, unmount } = renderHook(() => useOnline());
    unmount();

    // After unmount, dispatched events must not change anything observable.
    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event('offline'));
    });
    // The last rendered value stays true (hook is no longer subscribed).
    expect(result.current).toBe(true);
  });
});
