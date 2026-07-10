import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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

beforeEach(() => saveStrategyCanvasMock.mockClear());
afterEach(cleanup);

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
