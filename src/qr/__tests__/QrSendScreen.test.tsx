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

// getSyncQueue lives in @/db/localStore. The focused test mocks it so the screen
// has a deterministic backlog without IndexedDB. It returns camelCase
// LocalMatchReports — the screen maps them through toUpsertPayload (the SINGLE
// wire shape) before fountain-encoding.
vi.mock('@/db/localStore', () => ({
  getSyncQueue: () => getSyncQueue(),
}));

// Identity compression: keep the encode path synchronous and the decoded bytes
// equal to the raw JSON so this test asserts the wire shape, not gzip (which has
// its own round-trip test). The screen flags the payload uncompressed.
vi.mock('@/qr/compress', () => ({
  compressForQr: async (bytes: Uint8Array) => ({ bytes, compressed: false }),
  decompressForQr: async (bytes: Uint8Array) => bytes,
  compressionSupported: () => false,
}));

// crypto.randomUUID must exist in the test environment.
if (!globalThis.crypto?.randomUUID) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto = { ...globalThis.crypto, randomUUID: () => 'test-sid' };
}

import QrSendScreen from '@/qr/QrSendScreen';
import { QR_FRAME_MS } from '@/sync/constants';
import { parseFrame, FountainDecoder, bytesToReports } from '@/qr/envelope';
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

  it('emits fountain symbols that decode to SNAKE_CASE wire payloads, not camelCase', async () => {
    vi.useFakeTimers();
    getSyncQueue.mockResolvedValue(backlog);
    render(<QrSendScreen />);

    // Flush the async backlog load + compression + first frame render.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Cycle plenty of cadence ticks so the fountain emits well over K distinct
    // symbols. Each render hands a fresh frame string to the toDataURL spy.
    for (let i = 0; i < 80; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        vi.advanceTimersByTime(QR_FRAME_MS);
        await Promise.resolve();
      });
    }

    // Feed every rendered symbol into a fountain decoder — ANY ~K of them suffice.
    const decoder = new FountainDecoder();
    for (const c of toDataURL.mock.calls) {
      if (decoder.complete) break;
      const f = parseFrame(c[0] as string);
      if (f) decoder.add(f);
    }
    expect(decoder.complete).toBe(true);
    const decoded = bytesToReports(decoder.payloadBytes());
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

  it('advances the sent-symbol counter over time', async () => {
    vi.useFakeTimers();
    getSyncQueue.mockResolvedValue(backlog);
    render(<QrSendScreen />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('qr-send-progress').textContent).toMatch(/^1 sent/);

    // One cadence tick → the next fountain symbol.
    await act(async () => {
      vi.advanceTimersByTime(QR_FRAME_MS);
    });
    expect(screen.getByTestId('qr-send-progress').textContent).toMatch(/^2 sent/);
  });
});
