import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { getSyncQueue } from '@/db/localStore';
import { toUpsertPayload } from '@/sync/mapReport';
import { buildFrames, frameToString, type QrFrame } from '@/qr/envelope';
import { QR_FRAME_MS } from '@/sync/constants';

// Animated QR sender (contracts §6/§7). Loads the unsynced backlog, chunks it
// into envelope frames, and cycles through them as scannable QR images at the
// QR_FRAME_MS cadence so a receiver's camera can re-assemble the whole batch.
export default function QrSendScreen() {
  const [frames, setFrames] = useState<QrFrame[] | null>(null);
  const [isEmpty, setIsEmpty] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  // Build frames once from the backlog. The wire payload is the SAME snake_case
  // object the online outbox sends (toUpsertPayload) — NOT the camelCase
  // LocalMatchReport — so the receiver's ingest path reads the right keys.
  // sid is a fresh per-hand-off random id; crypto.randomUUID() is the runtime
  // source (envelope.ts stays pure).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const queue = (await getSyncQueue()).map(toUpsertPayload);
      if (cancelled) return;
      // Branch on the mapped backlog BEFORE building frames — no decode-time
      // sentinel. An empty backlog has nothing to hand off.
      if (queue.length === 0) {
        setIsEmpty(true);
        setFrames(null);
        return;
      }
      const sid = crypto.randomUUID();
      setIsEmpty(false);
      setFrames(buildFrames(queue, sid));
      setFrameIndex(0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Cycle the current frame index while running.
  useEffect(() => {
    if (!frames || frames.length <= 1 || paused) return;
    const timer = setInterval(() => {
      setFrameIndex((i) => (i + 1) % frames.length);
    }, QR_FRAME_MS);
    return () => clearInterval(timer);
  }, [frames, paused]);

  // Render the active frame to a PNG data URL whenever it changes.
  const lastRendered = useRef<string | null>(null);
  useEffect(() => {
    if (!frames || frames.length === 0) return;
    const frame = frames[frameIndex];
    const payload = frameToString(frame);
    if (lastRendered.current === payload) return;
    lastRendered.current = payload;
    let cancelled = false;
    void QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 320 }).then(
      (url) => {
        if (!cancelled) setDataUrl(url);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [frames, frameIndex]);

  return (
    <div
      data-testid="qr-send"
      className="flex min-h-screen flex-col items-center gap-6 bg-background p-4 text-foreground"
    >
      <header className="w-full">
        <h1 className="text-2xl font-bold">Send over QR</h1>
        <p className="text-sm text-muted-foreground">
          Point the receiving device&apos;s camera at the code. Keep this screen open until the
          receiver shows it has all frames.
        </p>
      </header>

      {isEmpty ? (
        <p data-testid="qr-send-empty" className="mt-8 text-center text-lg text-muted-foreground">
          Nothing to send — your reports are all synced.
        </p>
      ) : frames === null ? (
        <p className="text-sm text-muted-foreground">Loading backlog…</p>
      ) : (
        <>
          <div className="flex flex-col items-center gap-3">
            {dataUrl && (
              <img
                data-testid="qr-frame"
                src={dataUrl}
                alt={`QR frame ${frameIndex + 1} of ${frames.length}`}
                className="h-80 w-80 rounded-lg bg-white p-2"
              />
            )}
            <span data-testid="qr-send-progress" className="text-lg font-semibold tabular-nums">
              {frameIndex + 1}/{frames.length}
            </span>
          </div>

          <Button
            data-testid="qr-send-pause"
            variant="secondary"
            className="h-14 min-h-[44px] w-full max-w-xs"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </>
      )}
    </div>
  );
}
