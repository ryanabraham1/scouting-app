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
    decodeFromVideoDevice(deviceId: unknown, video: unknown, callback: DecodeCb) {
      captured = callback;
      return decodeFromVideoDevice(deviceId, video, callback);
    }
  },
}));

const postIngest = vi.fn();
vi.mock('@/qr/ingestClient', () => ({ postIngest: (...a: unknown[]) => postIngest(...a) }));

const saveReport = vi.fn();
vi.mock('@/db/localStore', () => ({ saveReport: (...a: unknown[]) => saveReport(...a) }));

import QrReceiveScreen from '@/qr/QrReceiveScreen';
import { buildFrames, frameToString } from '@/qr/envelope';

// Build a multi-frame hand-off of real reports so reassembly exercises >1 frame.
const sourceReports = [
  { id: 'a1', event_key: '2026casnv', match_key: 'qm1', notes: 'x'.repeat(900) },
  { id: 'a2', event_key: '2026casnv', match_key: 'qm2', notes: 'y'.repeat(900) },
];
const frames = buildFrames(sourceReports, 'sid-test');
const frameStrings = frames.map(frameToString);

function emit(text: string) {
  if (!captured) throw new Error('decode callback not yet registered');
  captured({ getText: () => text }, undefined, { stop } as { stop: () => void });
}

beforeEach(() => {
  decodeFromVideoDevice.mockClear();
  stop.mockClear();
  postIngest.mockReset();
  saveReport.mockReset();
  captured = null;
  state.rejectMode = false;
  postIngest.mockResolvedValue({ ingested: sourceReports.length });
  saveReport.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('QrReceiveScreen', () => {
  it('advances progress as frames arrive, then ingests on completion', async () => {
    render(<QrReceiveScreen />);
    expect(screen.getByTestId('qr-receive')).toBeTruthy();

    // Wait for the reader to register its callback.
    await waitFor(() => expect(captured).not.toBeNull());

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

    // postIngest called with the reconstructed reports.
    expect(postIngest).toHaveBeenCalledTimes(1);
    expect(postIngest).toHaveBeenCalledWith(sourceReports);

    // Each report persisted locally (best-effort).
    expect(saveReport).toHaveBeenCalledTimes(sourceReports.length);

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
});
