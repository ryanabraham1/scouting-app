import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SliderShoot, rateFromPointer } from '@/capture/SliderShoot';

describe('rateFromPointer (horizontal: left=0, right=max)', () => {
  const rect = { left: 0, width: 200 };
  it('returns 0 at the left edge of the track', () => {
    expect(rateFromPointer(0, rect, 30)).toBe(0);
  });
  it('returns max at the right edge of the track', () => {
    expect(rateFromPointer(200, rect, 30)).toBe(30);
  });
  it('returns ~half at the middle', () => {
    expect(rateFromPointer(100, rect, 30)).toBe(15);
  });
  it('clamps left/right of the track', () => {
    expect(rateFromPointer(-50, rect, 30)).toBe(0);
    expect(rateFromPointer(999, rect, 30)).toBe(30);
  });
  it('honors a non-zero left offset', () => {
    expect(rateFromPointer(150, { left: 100, width: 200 }, 30)).toBe(8);
  });
  it('returns 0 for a zero-width track', () => {
    expect(rateFromPointer(0, { left: 0, width: 0 }, 30)).toBe(0);
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

  // Regression: pressing directly at a position (no drag) must report the press
  // rate AFTER the hold has started. The session's holdSample() drops samples
  // while no hold is active, so the old sample→start order integrated the whole
  // still-finger hold at 0 BPS — the counter never moved until the slider was
  // wiggled to a different value.
  it('starts the hold before reporting the initial press rate', () => {
    const order: string[] = [];
    const onShootStart = vi.fn(() => order.push('start'));
    const onShootRate = vi.fn(() => order.push('rate'));
    render(
      <SliderShoot
        data-testid="ss"
        onShootStart={onShootStart}
        onShootRate={onShootRate}
        onShootEnd={vi.fn()}
      />,
    );
    // jsdom's PointerEvent drops clientX; a MouseEvent-typed pointerdown
    // carries the coordinate so setFromPointer's Number.isFinite guard passes.
    const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 50 });
    Object.defineProperty(down, 'pointerId', { value: 1 });
    screen.getByTestId('ss').dispatchEvent(down);
    expect(onShootStart).toHaveBeenCalledTimes(1);
    expect(onShootRate).toHaveBeenCalled();
    expect(order[0]).toBe('start');
  });

  it('supports keyboard rate adjustment and commits on key release', () => {
    const onShootStart = vi.fn();
    const onShootRate = vi.fn();
    const onShootEnd = vi.fn();
    render(
      <SliderShoot
        data-testid="ss"
        onShootStart={onShootStart}
        onShootRate={onShootRate}
        onShootEnd={onShootEnd}
      />,
    );
    const el = screen.getByTestId('ss');

    fireEvent.keyDown(el, { key: 'ArrowRight' });
    fireEvent.keyDown(el, { key: 'PageUp' });
    expect(el.getAttribute('data-rate')).toBe('6');
    expect(onShootStart).toHaveBeenCalledTimes(1);

    fireEvent.keyUp(el, { key: 'PageUp' });
    expect(onShootEnd).toHaveBeenCalledWith(6);
    expect(el.getAttribute('data-rate')).toBe('0');
  });
});

describe('SliderShoot tone variant', () => {
  it('defaults to the energy (orange/scoring) tone', () => {
    render(<SliderShoot data-testid="ss" onShootStart={vi.fn()} onShootEnd={vi.fn()} />);
    expect(screen.getByTestId('ss').getAttribute('data-tone')).toBe('energy');
  });

  it('renders the brand (feeding) tone with brand accent classes on the fill', () => {
    render(
      <SliderShoot
        data-testid="feed"
        tone="brand"
        unitLabel="BPS"
        activeLabel="FEEDING"
        idleLabel="FEED · hold + slide →"
        onShootStart={vi.fn()}
        onShootEnd={vi.fn()}
      />,
    );
    const el = screen.getByTestId('feed');
    expect(el.getAttribute('data-tone')).toBe('brand');
    // Brand accent (cyan) is applied to the fill track, not the energy orange.
    const fill = screen.getByTestId('feed-fill');
    expect(fill.className).toContain('bg-brand/40');
    expect(fill.className).not.toContain('bg-energy');
    // Idle hint label is shown.
    expect(screen.getByText('FEED · hold + slide →')).toBeTruthy();
  });

  it('shows the icon + value readout (not clipped) at rate 0', () => {
    render(<SliderShoot data-testid="ss" onShootStart={vi.fn()} onShootEnd={vi.fn()} />);
    // The thumb (carrying the icon) is rendered and its left is inset, not at 0%,
    // so it isn't clipped by the container's overflow-hidden at rate 0.
    const thumb = screen.getByTestId('ss-thumb');
    expect(thumb).toBeTruthy();
    const left = thumb.style.left;
    expect(left).toContain('2.25rem'); // inset applied (calc(2.25rem + ...))
    // Value readout shows 0.
    expect(screen.getByTestId('ss').getAttribute('data-rate')).toBe('0');
  });
});
