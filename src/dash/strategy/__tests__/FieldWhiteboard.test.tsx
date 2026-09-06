import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FieldWhiteboard from '@/dash/strategy/FieldWhiteboard';
import type { CanvasDoc, WhiteboardPhase } from '@/dash/strategy/strokes';

const saveStrategyCanvasMock = vi.fn(
  async (
    _eventKey: string,
    _matchKey: string,
    _phase: WhiteboardPhase,
    _doc: CanvasDoc,
  ) => {},
);

vi.mock('@/dash/strategy/strategyCanvasClient', () => ({
  saveStrategyCanvas: (
    eventKey: string,
    matchKey: string,
    phase: WhiteboardPhase,
    doc: CanvasDoc,
  ) => saveStrategyCanvasMock(eventKey, matchKey, phase, doc),
}));

vi.mock('@/sync/useOnline', () => ({
  useOnline: () => true,
}));

const REMOTE_DOC: CanvasDoc = {
  strokes: [
    {
      id: 'remote-stroke',
      seq: 1,
      color: '#fff',
      size: 0.02,
      points: [
        [0.1, 0.1, 0.5],
        [0.2, 0.2, 0.5],
      ],
    },
  ],
  deletedIds: [],
  robots: [],
};

beforeEach(() => {
  saveStrategyCanvasMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FieldWhiteboard save boundaries', () => {
  it('flushes a dirty snapshot on unmount before the debounce expires', async () => {
    const view = render(
      <FieldWhiteboard
        eventKey="event-a"
        matchKey="event-a_qm1"
        phase="auto"
        remoteDoc={REMOTE_DOC}
      />,
    );
    await waitFor(() => expect(view.getByTestId('wb-clear')).not.toBeDisabled());
    fireEvent.click(view.getByTestId('wb-clear'));
    view.unmount();

    await waitFor(() => expect(saveStrategyCanvasMock).toHaveBeenCalledTimes(1));
    expect(saveStrategyCanvasMock.mock.calls[0]?.slice(0, 3)).toEqual([
      'event-a',
      'event-a_qm1',
      'auto',
    ]);
    expect((saveStrategyCanvasMock.mock.calls[0]?.[3] as CanvasDoc).deletedIds).toContain(
      'remote-stroke',
    );
  });

  it('flushes against the old match and phase when its scope changes', async () => {
    const view = render(
      <FieldWhiteboard
        eventKey="event-a"
        matchKey="event-a_qm1"
        phase="auto"
        remoteDoc={REMOTE_DOC}
      />,
    );
    await waitFor(() => expect(view.getByTestId('wb-clear')).not.toBeDisabled());
    fireEvent.click(view.getByTestId('wb-clear'));
    view.rerender(
      <FieldWhiteboard
        eventKey="event-a"
        matchKey="event-a_qm2"
        phase="endgame"
        remoteDoc={undefined}
      />,
    );

    await waitFor(() =>
      expect(saveStrategyCanvasMock).toHaveBeenCalledWith(
        'event-a',
        'event-a_qm1',
        'auto',
        expect.any(Object),
      ),
    );
  });
});

describe('FieldWhiteboard live ink', () => {
  it('paints only newly received points on each animation frame', () => {
    const context = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      strokeStyle: '',
      fillStyle: '',
      lineCap: '',
      lineJoin: '',
      lineWidth: 0,
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );

    let queuedFrame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const view = render(
      <FieldWhiteboard
        eventKey="event-a"
        matchKey="event-a_qm1"
        phase="auto"
        remoteDoc={undefined}
      />,
    );
    const surface = view.getByTestId('wb-surface');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 390,
      bottom: 158,
      width: 390,
      height: 158,
      toJSON: () => ({}),
    });
    Object.defineProperty(surface, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });

    const flushFrame = (): void => {
      const frame = queuedFrame as FrameRequestCallback | null;
      queuedFrame = null;
      if (frame) act(() => frame(0));
    };

    fireEvent.pointerDown(surface, {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 39,
      clientY: 16,
    });
    flushFrame();
    expect(context.clearRect).toHaveBeenCalledTimes(1);
    expect(context.arc).toHaveBeenCalledTimes(1);

    fireEvent.pointerMove(surface, {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 78,
      clientY: 32,
    });
    flushFrame();
    expect(context.lineTo).toHaveBeenCalledTimes(1);
    expect(context.clearRect).toHaveBeenCalledTimes(1);

    fireEvent.pointerMove(surface, {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 117,
      clientY: 48,
    });
    flushFrame();
    expect(context.lineTo).toHaveBeenCalledTimes(2);
    // The already-painted prefix remains on the canvas; no full-stroke redraw.
    expect(context.clearRect).toHaveBeenCalledTimes(1);
  });
});
