import { useEffect, useRef, useState } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';
import { FrameAccumulator, parseFrame } from '@/qr/envelope';
import { postIngest } from '@/qr/ingestClient';
import { saveReport } from '@/db/localStore';
import type { LocalMatchReport } from '@/db/types';

type Phase = 'scanning' | 'ingesting' | 'done' | 'error';

// Live camera receiver (contracts §6/§7). Scans animated QR frames via the
// device camera, reassembles the chunked backlog with FrameAccumulator, then
// persists each report locally (best-effort) and POSTs the batch to the
// `ingest-reports` Edge Function under the receiver's session JWT.
export default function QrReceiveScreen() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const accumulatorRef = useRef(new FrameAccumulator());
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const completedRef = useRef(false);

  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('scanning');
  const [ingested, setIngested] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const reader = new BrowserQRCodeReader();
    let cancelled = false;

    const handleComplete = async () => {
      // Guard against the callback firing again after we've already finished.
      if (completedRef.current) return;
      completedRef.current = true;
      controlsRef.current?.stop();
      setPhase('ingesting');

      const reports = accumulatorRef.current.reports();
      // Persist locally first so a wiped sender's data survives even if the
      // server POST fails. Individual failures are non-fatal.
      await Promise.all(
        reports.map(async (r) => {
          try {
            await saveReport(r as LocalMatchReport);
          } catch {
            // best-effort: ignore individual persistence failures
          }
        }),
      );

      try {
        const result = await postIngest(reports);
        if (cancelled) return;
        setIngested(result.ingested);
        setPhase('done');
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : 'Failed to upload reports.');
        setPhase('error');
      }
    };

    const start = async () => {
      try {
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          videoRef.current ?? undefined,
          (result) => {
            if (cancelled || completedRef.current) return;
            const text = result?.getText();
            if (!text) return;
            const frame = parseFrame(text);
            if (!frame) return; // malformed/foreign frame — ignore, no crash
            const acc = accumulatorRef.current;
            acc.add(frame);
            setReceived(acc.received);
            setTotal(acc.total);
            if (acc.complete) {
              void handleComplete();
            }
          },
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(
          err instanceof Error
            ? `Camera unavailable: ${err.message}`
            : 'Camera permission denied. Allow camera access to scan.',
        );
        setPhase('error');
      }
    };

    void start();

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
    };
  }, []);

  return (
    <div
      data-testid="qr-receive"
      className="flex min-h-screen flex-col items-center gap-6 bg-background p-4 text-foreground"
    >
      <header className="w-full">
        <h1 className="text-2xl font-bold">Receive over QR</h1>
        <p className="text-sm text-muted-foreground">
          Point this camera at the sending device&apos;s screen. Keep both still until every frame
          is captured.
        </p>
      </header>

      {phase === 'error' ? (
        <p
          data-testid="qr-receive-error"
          className="mt-8 max-w-sm rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-center text-base text-destructive"
        >
          {errorMessage ?? 'Something went wrong.'}
        </p>
      ) : phase === 'done' ? (
        <p
          data-testid="qr-receive-done"
          className="mt-8 max-w-sm rounded-lg border border-primary/50 bg-primary/10 p-4 text-center text-lg font-semibold"
        >
          Received and uploaded {ingested ?? 0} report{ingested === 1 ? '' : 's'}.
        </p>
      ) : (
        <>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            data-testid="qr-receive-video"
            className="aspect-square w-full max-w-sm rounded-lg bg-black"
            muted
            playsInline
          />
          <span data-testid="qr-receive-progress" className="text-lg font-semibold tabular-nums">
            {received}/{total ?? '?'}
          </span>
          {phase === 'ingesting' && (
            <p className="text-sm text-muted-foreground">Uploading received reports…</p>
          )}
        </>
      )}
    </div>
  );
}
