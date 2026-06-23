import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';

// Hoisted mock fns — vi.mock factories run before module-level consts, so the
// shared spies must come from vi.hoisted().
const { toDataURL, getSyncQueue } = vi.hoisted(() => ({
  toDataURL: vi.fn(async () => 'data:image/png;base64,STUB'),
  getSyncQueue: vi.fn(),
}));

// Mock qrcode so we never touch a canvas in jsdom — toDataURL resolves a stub.
vi.mock('qrcode', () => ({
  default: { toDataURL },
  toDataURL,
}));

// getSyncQueue lives in @/db/localStore (added by the MAP cluster). The focused
// test mocks it so QrSendScreen has a deterministic backlog without IndexedDB.
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

const twoReports = [
  { id: 'r1', matchKey: 'qm1', notes: 'x'.repeat(900) },
  { id: 'r2', matchKey: 'qm2', notes: 'y'.repeat(900) },
];

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
    getSyncQueue.mockResolvedValue(twoReports);
    render(<QrSendScreen />);
    expect(screen.getByTestId('qr-send')).toBeTruthy();
    const img = await screen.findByTestId('qr-frame');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,STUB');
    expect(toDataURL).toHaveBeenCalled();
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
    getSyncQueue.mockResolvedValue(twoReports);
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
