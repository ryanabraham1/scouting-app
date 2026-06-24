import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SliderShoot, rateFromPointer } from '@/capture/SliderShoot';

describe('rateFromPointer', () => {
  const rect = { top: 0, height: 200 };
  it('returns 0 at the bottom of the track', () => {
    expect(rateFromPointer(200, rect, 30)).toBe(0);
  });
  it('returns max at the top of the track', () => {
    expect(rateFromPointer(0, rect, 30)).toBe(30);
  });
  it('returns ~half at the middle', () => {
    expect(rateFromPointer(100, rect, 30)).toBe(15);
  });
  it('clamps above/below the track', () => {
    expect(rateFromPointer(-50, rect, 30)).toBe(30);
    expect(rateFromPointer(999, rect, 30)).toBe(0);
  });
  it('returns 0 for a zero-height track', () => {
    expect(rateFromPointer(0, { top: 0, height: 0 }, 30)).toBe(0);
  });
});

describe('SliderShoot gesture', () => {
  beforeEach(() => {
    // jsdom returns a zero rect; force a deterministic geometry.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 200,
      height: 200,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });

  // NOTE: jsdom's synthetic PointerEvents do not carry clientX/Y, so the rate
  // *math* is verified by the rateFromPointer unit tests above. Here we verify the
  // gesture lifecycle: start on press, commit on release, spring back to 0.
  it('fires onShootStart on press, onShootEnd on release, and springs back to 0', () => {
    const onShootStart = vi.fn();
    const onShootEnd = vi.fn();
    render(<SliderShoot data-testid="ss" onShootStart={onShootStart} onShootEnd={onShootEnd} />);
    const el = screen.getByTestId('ss');

    fireEvent.pointerDown(el, { pointerId: 1 });
    expect(onShootStart).toHaveBeenCalledTimes(1);
    expect(el.getAttribute('data-active')).toBe('true');

    fireEvent.pointerUp(el, { pointerId: 1 });
    expect(onShootEnd).toHaveBeenCalledTimes(1);
    expect(typeof onShootEnd.mock.calls[0][0]).toBe('number');
    // springs back to 0 and deactivates
    expect(el.getAttribute('data-rate')).toBe('0');
    expect(el.getAttribute('data-active')).toBe('false');
  });
});
