import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  CoachTargetIndicator,
  useCoachTarget,
} from '../CoachTargetIndicator';

let targetRect = {
  top: 100,
  left: 20,
  right: 180,
  bottom: 160,
  width: 160,
  height: 60,
  x: 20,
  y: 100,
  toJSON: () => ({}),
};
let disconnectResizeObserver: ReturnType<typeof vi.fn>;

function Harness(props: {
  selector: string;
  showTarget?: boolean;
}): JSX.Element {
  const state = useCoachTarget(props.selector, props.selector);
  return (
    <div>
      {props.showTarget !== false ? (
        <button id="coach-target" type="button">
          Real control
        </button>
      ) : null}
      <output data-testid="mobile-placement">{state.mobilePlacement}</output>
      <CoachTargetIndicator box={state.box} />
    </div>
  );
}

describe('CoachTargetIndicator', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    targetRect = {
      top: 100,
      left: 20,
      right: 180,
      bottom: 160,
      width: 160,
      height: 60,
      x: 20,
      y: 100,
      toJSON: () => ({}),
    };
    disconnectResizeObserver = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {
          disconnectResizeObserver();
        }
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => targetRect,
    );
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves a real target and renders a non-interactive reduced-motion-safe outline', async () => {
    render(<Harness selector="#coach-target" />);
    const pointer = await screen.findByTestId('tutorial-target-indicator');
    expect(pointer).toHaveClass('pointer-events-none');
    expect(pointer).toHaveClass('motion-reduce:transition-none');
    expect(pointer).toHaveAttribute('aria-hidden', 'true');
  });

  it('hides cleanly when the target is unavailable', () => {
    render(<Harness selector="#missing-target" showTarget={false} />);
    expect(screen.queryByTestId('tutorial-target-indicator')).toBeNull();
  });

  it('hides when a resolved target is removed', async () => {
    const view = render(<Harness selector="#coach-target" />);
    await screen.findByTestId('tutorial-target-indicator');
    view.rerender(<Harness selector="#coach-target" showTarget={false} />);
    await waitFor(() =>
      expect(screen.queryByTestId('tutorial-target-indicator')).toBeNull(),
    );
  });

  it('places phone coaching opposite the target and scrolls offscreen targets into view', async () => {
    targetRect = {
      ...targetRect,
      top: 700,
      bottom: 760,
      y: 700,
    };
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    render(<Harness selector="#coach-target" />);

    await waitFor(() =>
      expect(screen.getByTestId('mobile-placement')).toHaveTextContent('top'),
    );
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'center', inline: 'nearest' }),
    );
  });

  it('keeps its arrow visible below targets near the top edge', async () => {
    targetRect = {
      ...targetRect,
      top: 4,
      bottom: 64,
      y: 4,
    };
    render(<Harness selector="#coach-target" />);
    const pointer = await screen.findByTestId('tutorial-target-indicator');
    expect(pointer).toHaveTextContent('USE THIS ↑');
  });

  it('clamps the outline and label inside a 320px viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    targetRect = {
      ...targetRect,
      left: 290,
      right: 390,
      width: 100,
      x: 290,
    };
    render(<Harness selector="#coach-target" />);
    const pointer = await screen.findByTestId('tutorial-target-indicator');
    expect(Number.parseFloat(pointer.style.left) + Number.parseFloat(pointer.style.width)).toBeLessThanOrEqual(318);
    const label = pointer.querySelector('span');
    expect(
      Number.parseFloat(pointer.style.left) +
      Number.parseFloat(label?.style.maxWidth ?? '999'),
    ).toBeLessThanOrEqual(318);
  });

  it('follows resize changes and removes observers and listeners on cleanup', async () => {
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const view = render(<Harness selector="#coach-target" />);
    await screen.findByTestId('tutorial-target-indicator');

    targetRect = {
      ...targetRect,
      top: 240,
      left: 100,
      right: 260,
      bottom: 300,
      x: 100,
      y: 240,
    };
    fireEvent(window, new Event('resize'));
    await waitFor(() =>
      expect(screen.getByTestId('tutorial-target-indicator')).toHaveStyle({
        left: '94px',
        top: '234px',
      }),
    );

    view.unmount();
    expect(disconnectResizeObserver).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith(
      'resize',
      expect.any(Function),
    );
    expect(removeListener).toHaveBeenCalledWith(
      'orientationchange',
      expect.any(Function),
    );
    expect(removeListener).toHaveBeenCalledWith(
      'scroll',
      expect.any(Function),
      true,
    );
  });
});
