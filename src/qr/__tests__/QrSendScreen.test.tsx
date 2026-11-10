vi.mock('@/dash/useActiveEvent', () => ({ useActiveEvent: () => ({ eventKey: '2026test', loading: false }) }));
vi.mock('@/auth/useSession', () => ({ useSession: () => ({ scout: null, loading: false }), clearCachedScout: vi.fn() }));
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Hoisted mock fns — vi.mock factories run before module-level consts, so the
// shared spies must come from vi.hoisted().
const { toCanvas, getSyncQueue, listDeadLetters } = vi.hoisted(() => ({
  // toCanvas(canvasEl, text, opts) — capture the payload string (2nd arg) so we
  // can decode the fountain stream. Resolves so the screen's `void` await is happy.
  toCanvas: vi.fn(async (_canvas: unknown, _text: string) => undefined),
  getSyncQueue: vi.fn(),
  listDeadLetters: vi.fn(),
}));

// Mock qrcode so we never touch a real canvas in jsdom — the screen now draws
// straight to a canvas via toCanvas (no PNG data URL / <img> reload).
vi.mock('qrcode', () => ({
  default: { toCanvas },
  toCanvas,
}));

// The payload string each render handed to toCanvas (2nd positional arg).
const renderedPayloads = (): string[] => toCanvas.mock.calls.map((c) => c[1] as string);

// getSyncQueue lives in @/db/localStore. The focused test mocks it so the screen
// has a deterministic backlog without IndexedDB. It returns camelCase
// LocalMatchReports — the screen maps them through toUpsertPayload (the SINGLE
// wire shape) before fountain-encoding.
vi.mock('@/db/localStore', () => ({
  getSyncQueue: () => getSyncQueue(),
  // QR-send unions the dirty/pending queue with DEAD-LETTERED reports so a stuck
  // report can still be hand-carried off-device (BUG-2). Default: none stuck.
  listDeadLetters: () => listDeadLetters(),
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
import { rememberScoutIdentity } from '@/roster/scoutIdentityCache';
import { sampleLocalReports, sampleUpsertPayloads } from './fixtures';

// A working in-memory localStorage — jsdom-compat's is non-functional, so the
// identity cache (and thus scout_name tagging) is inert unless we install one.
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  });
}

// The backlog as it lives in the store (camelCase LocalMatchReports).
const backlog = sampleLocalReports();
// The snake_case wire payloads the QR frames MUST carry (shared with the
// receiver/ingest tests so the two sides can never drift).
const expectedWire = sampleUpsertPayloads();

beforeEach(() => {
  toCanvas.mockClear();
  getSyncQueue.mockReset();
  listDeadLetters.mockReset();
  // Most tests don't exercise dead-letters; default to an empty stuck-list.
  listDeadLetters.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('QrSendScreen', () => {
  it('renders the qr-send screen and draws a frame canvas from the backlog', async () => {
    getSyncQueue.mockResolvedValue(backlog);
    render(
      <MemoryRouter>
        <QrSendScreen />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('qr-send')).toBeTruthy();
    const canvas = await screen.findByTestId('qr-frame');
    expect(canvas.tagName).toBe('CANVAS');
    await waitFor(() => expect(toCanvas).toHaveBeenCalled());
  });

  it('emits fountain symbols that decode to SNAKE_CASE wire payloads, not camelCase', async () => {
    vi.useFakeTimers();
    getSyncQueue.mockResolvedValue(backlog);
    render(
      <MemoryRouter>
        <QrSendScreen />
      </MemoryRouter>,
    );

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
    for (const payload of renderedPayloads()) {
      if (decoder.complete) break;
      const f = parseFrame(payload);
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

  it('tags each frame with scout_name when this device knows the scouter', async () => {
    vi.useFakeTimers();
    installMemoryLocalStorage();
    // Backlog reports are authored by scout id 'scout1'; remember its identity so
    // the QR sender can re-attach the name on the receiver.
    rememberScoutIdentity({
      id: 'scout1',
      event_key: '2026casnv',
      display_name: 'Ada Lovelace',
      auth_uid: 'uid-1',
      created_at: '2026-06-23T00:00:00.000Z',
    });
    getSyncQueue.mockResolvedValue(backlog);
    render(
      <MemoryRouter>
        <QrSendScreen />
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    for (let i = 0; i < 80; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        vi.advanceTimersByTime(QR_FRAME_MS);
        await Promise.resolve();
      });
    }

    const decoder = new FountainDecoder();
    for (const payload of renderedPayloads()) {
      if (decoder.complete) break;
      const f = parseFrame(payload);
      if (f) decoder.add(f);
    }
    expect(decoder.complete).toBe(true);
    const decoded = bytesToReports(decoder.payloadBytes()) as Record<string, unknown>[];
    // Every report carries the resolved name AND keeps the full wire shape.
    for (const r of decoded) {
      expect(r).toHaveProperty('scout_name', 'Ada Lovelace');
      expect(r).toHaveProperty('scout_id', 'scout1');
    }
  });

  it('shows an empty state when the queue is empty', async () => {
    getSyncQueue.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <QrSendScreen />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/nothing to send/i)).toBeTruthy();
    });
    expect(screen.queryByTestId('qr-frame')).toBeNull();
  });

  it('INCLUDES dead-lettered reports in the QR batch (BUG-2 rescue path)', async () => {
    vi.useFakeTimers();
    // No dirty/pending reports — only a stuck (error) report remains. It MUST still
    // be carried so it can be rescued onto another device.
    getSyncQueue.mockResolvedValue([]);
    listDeadLetters.mockResolvedValue(backlog);
    render(
      <MemoryRouter>
        <QrSendScreen />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    for (let i = 0; i < 80; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        vi.advanceTimersByTime(QR_FRAME_MS);
        await Promise.resolve();
      });
    }
    const decoder = new FountainDecoder();
    for (const payload of renderedPayloads()) {
      if (decoder.complete) break;
      const f = parseFrame(payload);
      if (f) decoder.add(f);
    }
    expect(decoder.complete).toBe(true);
    const decoded = bytesToReports(decoder.payloadBytes());
    expect(decoded).toEqual(expectedWire);
  });

  it('advances the sent-symbol counter over time', async () => {
    vi.useFakeTimers();
    getSyncQueue.mockResolvedValue(backlog);
    render(
      <MemoryRouter>
        <QrSendScreen />
      </MemoryRouter>,
    );

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
