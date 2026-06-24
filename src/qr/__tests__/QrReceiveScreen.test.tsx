import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';

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

// The receiver is INGEST-ONLY: it must NOT persist foreign reports locally.
// We still mock the store so an accidental import would surface as a spy call.
const saveReport = vi.fn();
vi.mock('@/db/localStore', () => ({ saveReport: (...a: unknown[]) => saveReport(...a) }));

import QrReceiveScreen from '@/qr/QrReceiveScreen';
import { buildFrames, frameToString } from '@/qr/envelope';
import { sampleUpsertPayloads } from './fixtures';

// Build a multi-frame hand-off of the SAME snake_case wire payloads the sender
// emits (shared fixture) so reassembly exercises >1 frame and the two sides of
// the hand-off can never drift back to camelCase.
const sourceReports = sampleUpsertPayloads();
const frames = buildFrames(sourceReports, 'sid-test');
const frameStrings = frames.map(frameToString);

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
  it('advances progress as frames arrive, then ingests on completion', async () => {
    render(<QrReceiveScreen />);
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

    // First frame → progress 1/total.
    await act(async () => emit(frameStrings[0]));
    const progress = screen.getByTestId('qr-receive-progress');
    expect(progress.textContent).toBe(`1/${frames.length}`);

    // A malformed frame must be ignored (no crash, no progress bump).
    await act(async () => emit('{not-json'));
    expect(screen.getByTestId('qr-receive-progress').textContent).toBe(`1/${frames.length}`);

    // Remaining frames → completion.
    for (let i = 1; i < frameStrings.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => emit(frameStrings[i]));
    }

    await waitFor(() => expect(screen.getByTestId('qr-receive-done')).toBeTruthy());

    // postIngest called with the reconstructed SNAKE_CASE reports.
    expect(postIngest).toHaveBeenCalledTimes(1);
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

  it('surfaces a camera-permission denial as a visible error', async () => {
    reject();
    render(<QrReceiveScreen />);
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

    render(<QrReceiveScreen />);

    const error = await screen.findByTestId('qr-receive-error');
    expect(error).toBeTruthy();
    // The message must point the user at the real fix (HTTPS / localhost).
    expect(error.textContent).toMatch(/HTTPS|localhost/i);

    // We never even attempt to decode (no camera to talk to) and never ingest.
    expect(decodeFromVideoDevice).not.toHaveBeenCalled();
    expect(postIngest).not.toHaveBeenCalled();
  });
});
