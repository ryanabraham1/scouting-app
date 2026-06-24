import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';

// Hoisted mock fns — vi.mock factories run before module-level consts, so the
// shared spies must come from vi.hoisted().
const { toDataURL, getSyncQueue } = vi.hoisted(() => ({
  toDataURL: vi.fn(async (_text: string) => 'data:image/png;base64,STUB'),
  getSyncQueue: vi.fn(),
}));

// Mock qrcode so we never touch a canvas in jsdom — toDataURL resolves a stub.
// It captures the payload string it was asked to render so we can decode it.
vi.mock('qrcode', () => ({
  default: { toDataURL },
  toDataURL,
}));

// getSyncQueue lives in @/db/localStore (added by the MAP cluster). The focused
// test mocks it so QrSendScreen has a deterministic backlog without IndexedDB.
// It returns camelCase LocalMatchReports — the screen maps them through
// toUpsertPayload (the SINGLE wire shape) before chunking into frames.
vi.mock('@/db/localStore', () => ({
  getSyncQueue: () => getSyncQueue(),
}));

// crypto.randomUUID must exist in the test environment.
if (!globalThis.crypto?.randomUUID) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto = { ...globalThis.crypto, randomUUID: () => 'test-sid' };
}

import QrSendScreen from '@/qr/QrSendScreen';
import { QR_FRAME_MS } from '@/sync/constants';
import { parseFrame, FrameAccumulator } from '@/qr/envelope';
import { sampleLocalReports, sampleUpsertPayloads } from './fixtures';

// The backlog as it lives in the store (camelCase LocalMatchReports).
const backlog = sampleLocalReports();
// The snake_case wire payloads the QR frames MUST carry (shared with the
// receiver/ingest tests so the two sides can never drift).
const expectedWire = sampleUpsertPayloads();

beforeEach(() => {
  toDataURL.mockClear();
  getSyncQueue.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('QrSendScreen', () => {
  it('renders the qr-send screen and a frame image from the backlog', async () => {
    getSyncQueue.mockResolvedValue(backlog);
    render(<QrSendScreen />);
    expect(screen.getByTestId('qr-send')).toBeTruthy();
    const img = await screen.findByTestId('qr-frame');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,STUB');
    expect(toDataURL).toHaveBeenCalled();
  });

  it('emits frames that decode to SNAKE_CASE wire payloads, not camelCase', async () => {
    vi.useFakeTimers();
    getSyncQueue.mockResolvedValue(backlog);
    render(<QrSendScreen />);

    // Flush the async backlog load + first frame render.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The screen only renders the CURRENT frame, so cycle the cadence enough
    // times that every frame in the hand-off has been rendered (and captured by
    // the toDataURL spy). Total frame count is shown in qr-send-progress.
    const total = Number(screen.getByTestId('qr-send-progress').textContent!.split('/')[1]);
    expect(total).toBeGreaterThan(1); // multi-frame hand-off
    for (let i = 0; i < total; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        vi.advanceTimersByTime(QR_FRAME_MS);
        await Promise.resolve();
      });
    }

    // Reassemble every rendered frame back into the original wire payloads.
    const acc = new FrameAccumulator();
    for (const c of toDataURL.mock.calls) {
      const f = parseFrame(c[0] as string);
      if (f) acc.add(f);
    }
    expect(acc.complete).toBe(true);
    const decoded = acc.reports();
    expect(decoded).toEqual(expectedWire);

    // Belt-and-braces: the keys are snake_case, NOT camelCase.
    const first = decoded[0] as Record<string, unknown>;
    expect(first).toHaveProperty('event_key', '2026casnv');
    expect(first).toHaveProperty('scout_id', 'scout1');
    expect(first).not.toHaveProperty('eventKey');
    expect(first).not.toHaveProperty('scoutId');
  });

  it('shows an empty state when the queue is empty', async () => {
    getSyncQueue.mockResolvedValue([]);
    render(<QrSendScreen />);
    await waitFor(() => {
      expect(screen.getByText(/nothing to send/i)).toBeTruthy();
    });
    expect(screen.queryByTestId('qr-frame')).toBeNull();
  });

  it('advances qr-send-progress over time', async () => {
    vi.useFakeTimers();
    getSyncQueue.mockResolvedValue(backlog);
    render(<QrSendScreen />);

    // Flush the async backlog load + first frame render.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const progress = screen.getByTestId('qr-send-progress');
    const total = Number(progress.textContent!.split('/')[1]);
    expect(total).toBeGreaterThan(1); // ~1800 chars of notes → multiple frames
    expect(progress.textContent).toBe(`1/${total}`);

    // Advance one cadence tick → frame index moves to 2/total.
    await act(async () => {
      vi.advanceTimersByTime(QR_FRAME_MS);
    });
    expect(screen.getByTestId('qr-send-progress').textContent).toBe(`2/${total}`);
  });
});
