import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// --- @zxing/browser fake reader --------------------------------------------
// decodeFromVideoDevice stores the continuous-decode callback so the test can
// drive it with a sequence of decoded "Result" objects (getText()). It also
// exposes a stop() spy via the controls it passes to the callback.
type DecodeCb = (
  result: { getText: () => string } | undefined,
  error: unknown,
  controls: { stop: () => void },
) => void;

const { decodeFromVideoDevice, stop, reject, state } = vi.hoisted(() => {
  const stopSpy = vi.fn();
  const flag = { rejectMode: false };
  // `reject()` makes the next decodeFromVideoDevice reject (permission denial).
  const fn = vi.fn(async (_deviceId: unknown, _video: unknown, _callback: DecodeCb) => {
    if (flag.rejectMode) throw new Error('Permission denied');
    return { stop: stopSpy };
  });
  return {
    decodeFromVideoDevice: fn,
    stop: stopSpy,
    state: flag,
    reject: () => {
      flag.rejectMode = true;
    },
  };
});

// Capture the live continuous-decode callback so the test can drive it.
let captured: DecodeCb | null = null;
vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: class {
    // Mirror the real static helper used to prefer the rear camera. The screen
    // resolves a /back|rear|environment/ device by label and passes its id to
    // decodeFromVideoDevice (falling back to undefined → facingMode env).
    static listVideoInputDevices() {
      return Promise.resolve([
        { deviceId: 'front-1', label: 'Front Camera', kind: 'videoinput', groupId: 'g' },
        { deviceId: 'back-1', label: 'Back Camera (environment)', kind: 'videoinput', groupId: 'g' },
      ] as MediaDeviceInfo[]);
    }

    decodeFromVideoDevice(deviceId: unknown, video: unknown, callback: DecodeCb) {
      captured = callback;
      return decodeFromVideoDevice(deviceId, video, callback);
    }
  },
}));

const postIngest = vi.fn();
vi.mock('@/qr/ingestClient', () => ({ postIngest: (...a: unknown[]) => postIngest(...a) }));

const stageCompletedQrTransfer = vi.fn(async (value: {
  sessionId: string;
  compressed: boolean;
  payload: Uint8Array;
}) => ({
  ...value,
  version: 1 as const,
  completedAt: Date.now(),
}));
const loadStagedQrTransfer = vi.fn(async (): Promise<unknown> => null);
const clearStagedQrTransfer = vi.fn(async () => undefined);
vi.mock('@/qr/receiveStaging', () => ({
  stageCompletedQrTransfer: (...args: unknown[]) => stageCompletedQrTransfer(...args as [{
    sessionId: string;
    compressed: boolean;
    payload: Uint8Array;
  }]),
  loadStagedQrTransfer: () => loadStagedQrTransfer(),
  clearStagedQrTransfer: () => clearStagedQrTransfer(),
}));

// Identity compression: the decoded bytes equal the raw JSON, so this test
// asserts the wire shape, not gzip (which has its own round-trip test).
vi.mock('@/qr/compress', () => ({
  decompressForQr: async (bytes: Uint8Array) => bytes,
  compressForQr: async (bytes: Uint8Array) => ({ bytes, compressed: false }),
  compressionSupported: () => false,
}));

// The receiver is INGEST-ONLY: it must NOT persist foreign reports locally.
// We still mock the store so an accidental import would surface as a spy call.
const saveReport = vi.fn();
vi.mock('@/db/localStore', () => ({ saveReport: (...a: unknown[]) => saveReport(...a) }));

// BUG-7 gate: QrReceiveScreen now requires a selected scouter before showing the
// scanner (mirrors ScoutHome's name gate). These tests exercise the scanner, so
// stand in a resolved, signed-in scouter and a not-logged-out state.
vi.mock('@/auth/useSession', () => ({
  useSession: () => ({ scout: { id: 'scout-1', display_name: 'Receiver', event_key: '2026test' }, loading: false }),
}));
vi.mock('@/roster/selectScouter', async (orig) => ({
  ...(await orig<typeof import('@/roster/selectScouter')>()),
  isScouterLoggedOut: () => false,
}));

import QrReceiveScreen from '@/qr/QrReceiveScreen';
import { FountainEncoder, frameToString, reportsToBytes } from '@/qr/envelope';
import { sampleUpsertPayloads } from './fixtures';

// A fountain stream of the SAME snake_case wire payloads the sender emits
// (shared fixture) so reassembly exercises many blocks and the two sides of the
// hand-off can never drift back to camelCase. Pre-render plenty of distinct
// symbols; the decoder only needs ~K of them, in any order.
const sourceReports = sampleUpsertPayloads();
const encoder = new FountainEncoder(reportsToBytes(sourceReports), 'sid-test', false);
const frameStrings = Array.from({ length: 160 }, (_, t) => frameToString(encoder.frame(t)));

function emit(text: string) {
  if (!captured) throw new Error('decode callback not yet registered');
  captured({ getText: () => text }, undefined, { stop } as { stop: () => void });
}

// Snapshot of the real mediaDevices so the secure-context test can restore it.
const realMediaDevices = navigator.mediaDevices;

beforeEach(() => {
  decodeFromVideoDevice.mockClear();
  stop.mockClear();
  postIngest.mockReset();
  stageCompletedQrTransfer.mockClear();
  loadStagedQrTransfer.mockReset().mockResolvedValue(null);
  clearStagedQrTransfer.mockReset().mockResolvedValue(undefined);
  saveReport.mockReset();
  captured = null;
  state.rejectMode = false;
  postIngest.mockResolvedValue({ ingested: sourceReports.length, failed: [] });
  saveReport.mockResolvedValue(undefined);
  // Default: a working secure context with a camera available.
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: realMediaDevices,
  });
});

describe('QrReceiveScreen', () => {
  it('resumes a completed staged transfer before starting the camera', async () => {
    loadStagedQrTransfer.mockResolvedValue({
      version: 1,
      sessionId: 'staged-sid',
      compressed: false,
      payload: reportsToBytes(sourceReports),
      completedAt: Date.now(),
    });
    render(
      <MemoryRouter>
        <QrReceiveScreen />
      </MemoryRouter>,
    );

    await screen.findByTestId('qr-receive-done');
    expect(postIngest).toHaveBeenCalledWith(sourceReports);
    expect(decodeFromVideoDevice).not.toHaveBeenCalled();
    expect(clearStagedQrTransfer).toHaveBeenCalled();
  });

  it('advances progress as frames arrive, then ingests on completion', async () => {
    render(
      <MemoryRouter>
        <QrReceiveScreen />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('qr-receive')).toBeTruthy();

    // Wait for the reader to register its callback.
    await waitFor(() => expect(captured).not.toBeNull());

    // Rear camera preferred: the resolved /back|rear|environment/ deviceId is
    // passed to decodeFromVideoDevice.
    expect(decodeFromVideoDevice).toHaveBeenCalledWith(
      'back-1',
      expect.anything(),
      expect.any(Function),
    );

    // First frame → progress shows "<solved>/<K blocks>" (K is the source-block
    // total pinned from the frame header).
    await act(async () => emit(frameStrings[0]));
    expect(screen.getByTestId('qr-receive-progress').textContent).toMatch(
      new RegExp(`/${encoder.k}$`),
    );

    // A malformed frame must be ignored (no crash).
    await act(async () => emit('{not-json'));
    expect(screen.getByTestId('qr-receive-progress').textContent).toMatch(
      new RegExp(`/${encoder.k}$`),
    );

    // Feed the fountain stream until the decoder solves every block. ANY ~K
    // symbols suffice, so completion arrives well before the stream is exhausted.
    for (let i = 1; i < frameStrings.length; i += 1) {
      if (screen.queryByTestId('qr-receive-done')) break;
      // eslint-disable-next-line no-await-in-loop
      await act(async () => emit(frameStrings[i]));
    }

    await waitFor(() => expect(screen.getByTestId('qr-receive-done')).toBeTruthy());

    // postIngest called with the reconstructed SNAKE_CASE reports.
    expect(postIngest).toHaveBeenCalledTimes(1);
    expect(stageCompletedQrTransfer).toHaveBeenCalledTimes(1);
    expect(stageCompletedQrTransfer.mock.invocationCallOrder[0]).toBeLessThan(
      postIngest.mock.invocationCallOrder[0],
    );
    expect(clearStagedQrTransfer).toHaveBeenCalledTimes(1);
    expect(postIngest).toHaveBeenCalledWith(sourceReports);
    const posted = postIngest.mock.calls[0][0] as Record<string, unknown>[];
    expect(posted[0]).toHaveProperty('event_key', '2026casnv');
    expect(posted[0]).toHaveProperty('scout_id', 'scout1');
    expect(posted[0]).not.toHaveProperty('eventKey');

    // INGEST-ONLY: foreign reports must NOT be written to this device's store.
    expect(saveReport).not.toHaveBeenCalled();

    // Stream stopped on completion.
    expect(stop).toHaveBeenCalled();

    // Ingested count surfaced.
    expect(screen.getByTestId('qr-receive-done').textContent).toMatch(
      new RegExp(String(sourceReports.length)),
    );
  });

  it('surfaces an error (not a silent "0 uploaded") when the server rejects every report', async () => {
    // The decode succeeds but ingest rejects all rows — the old UI showed a green
    // "uploaded 0 reports", hiding the failure. It must now read as an error.
    postIngest.mockResolvedValue({
      ingested: 0,
      failed: sourceReports.map((_, index) => ({ index, error: 'invalid scout_id: no such scout' })),
    });

    render(
      <MemoryRouter>
        <QrReceiveScreen />
      </MemoryRouter>,
    );
    await waitFor(() => expect(captured).not.toBeNull());

    for (let i = 0; i < frameStrings.length; i += 1) {
      if (screen.queryByTestId('qr-receive-error')) break;
      // eslint-disable-next-line no-await-in-loop
      await act(async () => emit(frameStrings[i]));
    }

    const error = await screen.findByTestId('qr-receive-error');
    expect(error).toBeTruthy();
    expect(error.textContent).toMatch(/rejected all/i);
    expect(error.textContent).toMatch(/invalid scout_id/i);
    // It must NOT render the success view.
    expect(screen.queryByTestId('qr-receive-done')).toBeNull();
    expect(postIngest).toHaveBeenCalledTimes(1);
  });

  it('surfaces a camera-permission denial as a visible error', async () => {
    reject();
    render(
      <MemoryRouter>
        <QrReceiveScreen />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('qr-receive-error')).toBeTruthy());
    expect(postIngest).not.toHaveBeenCalled();
  });

  it('shows a clear secure-context error when navigator.mediaDevices is unavailable', async () => {
    // Simulate a non-HTTPS / non-localhost origin: the platform never exposes
    // mediaDevices, so getUserMedia is unreachable.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    });

    render(
      <MemoryRouter>
        <QrReceiveScreen />
      </MemoryRouter>,
    );

    const error = await screen.findByTestId('qr-receive-error');
    expect(error).toBeTruthy();
    // The message must point the user at the real fix (HTTPS / localhost).
    expect(error.textContent).toMatch(/HTTPS|localhost/i);

    // We never even attempt to decode (no camera to talk to) and never ingest.
    expect(decodeFromVideoDevice).not.toHaveBeenCalled();
    expect(postIngest).not.toHaveBeenCalled();
  });
});
