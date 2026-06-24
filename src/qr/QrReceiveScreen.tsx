import { useEffect, useRef, useState } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';
import { Camera, CameraOff, CheckCircle2 } from 'lucide-react';
import { FrameAccumulator, parseFrame } from '@/qr/envelope';
import { postIngest } from '@/qr/ingestClient';

type Phase = 'scanning' | 'ingesting' | 'done' | 'error';

// Live camera receiver (contracts §6/§7). Scans animated QR frames via the
// device camera, reassembles the chunked backlog with FrameAccumulator, then
// POSTs the batch to the `ingest-reports` Edge Function under the receiver's
// session JWT. INGEST-ONLY: the reassembled payloads are snake_case raw reports
// authored by OTHER scouts. They must NOT be written into THIS device's local
// store — doing so would later make this device's own outbox call
// upsert_match_report with a foreign scout_id → ownership-gate 42501 →
// dead-letter. The service-role upsert on the server is ownership-exempt, so
// landing the data there is exactly what makes a wiped sender recoverable.
//
// Camera capture fix (design §F):
//  - The <video> is mounted unconditionally and carries autoPlay/muted/
//    playsInline so the attached MediaStream actually renders (zxing only sets
//    those attributes on elements IT creates, not on a ref we hand it). Without
//    autoPlay the stream attaches but the frame pump never produces images on
//    some browsers, so decode silently never fires.
//  - getUserMedia is only exposed in a secure context (HTTPS / localhost). On a
//    plain-http origin `navigator.mediaDevices` is undefined and zxing throws an
//    opaque TypeError; we detect that up front and show a clear, actionable
//    error instead of a dead black box.
//  - Rear camera: with deviceId === undefined, @zxing/browser@0.2.0 requests
//    `{ facingMode: 'environment' }`, which already prefers the rear camera. We
//    additionally try to resolve a /back|rear|environment/ device by label and
//    pass its id when one is found (more reliable on multi-camera Android).
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
    let cancelled = false;

    const fail = (message: string) => {
      if (cancelled) return;
      setErrorMessage(message);
      setPhase('error');
    };

    // Secure-context guard. mediaDevices is undefined on non-HTTPS, non-
    // localhost origins; calling into zxing would otherwise throw an opaque
    // "Cannot read properties of undefined (reading 'getUserMedia')".
    if (!navigator.mediaDevices?.getUserMedia) {
      fail(
        'Camera requires HTTPS or localhost. Open this page over a secure (https://) origin to scan.',
      );
      return;
    }

    const reader = new BrowserQRCodeReader();

    const handleComplete = async () => {
      // Guard against the callback firing again after we've already finished.
      if (completedRef.current) return;
      completedRef.current = true;
      controlsRef.current?.stop();
      setPhase('ingesting');

      const reports = accumulatorRef.current.reports();

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

    // Resolve the rear-facing camera id when the platform labels its devices.
    // Labels are empty until permission is granted, so this is best-effort:
    // if nothing matches we pass undefined and zxing falls back to
    // { facingMode: 'environment' }.
    const pickRearDeviceId = async (): Promise<string | undefined> => {
      try {
        const devices = await BrowserQRCodeReader.listVideoInputDevices();
        const rear = devices.find((d) => /back|rear|environment/i.test(d.label));
        return rear?.deviceId;
      } catch {
        return undefined;
      }
    };

    const start = async () => {
      try {
        const deviceId = await pickRearDeviceId();
        if (cancelled) return;
        const controls = await reader.decodeFromVideoDevice(
          deviceId,
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
        fail(
          err instanceof Error
            ? `Camera unavailable: ${err.message}`
            : 'Camera permission denied. Allow camera access to scan.',
        );
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
      className="flex min-h-screen flex-col bg-background p-4 text-foreground sm:p-6"
    >
      <header className="mb-4 flex items-center gap-3">
        <Camera className="size-7 shrink-0 text-primary" aria-hidden />
        <div>
          <h1 className="text-xl font-bold leading-tight sm:text-2xl">Receive over QR</h1>
          <p className="text-sm text-muted-foreground">
            Point at the sending device&apos;s screen. Keep both still until every frame is
            captured.
          </p>
        </div>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-5 landscape:flex-row landscape:items-center landscape:gap-8">
        {phase === 'error' ? (
          <div
            data-testid="qr-receive-error"
            className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-destructive/50 bg-destructive/10 p-6 text-center text-destructive"
          >
            <CameraOff className="size-10 shrink-0" aria-hidden />
            <p className="text-base font-medium">{errorMessage ?? 'Something went wrong.'}</p>
          </div>
        ) : phase === 'done' ? (
          <div
            data-testid="qr-receive-done"
            className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-primary/50 bg-primary/10 p-6 text-center"
          >
            <CheckCircle2 className="size-10 shrink-0 text-primary" aria-hidden />
            <p className="text-lg font-semibold">
              Received and uploaded {ingested ?? 0} report{ingested === 1 ? '' : 's'}.
            </p>
          </div>
        ) : (
          <>
            {/* The video is always present while scanning/ingesting so the ref
                exists before decodeFromVideoDevice attaches a stream. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={videoRef}
              data-testid="qr-receive-video"
              className="aspect-square w-full max-w-sm rounded-xl bg-black object-cover landscape:h-[min(70vh,22rem)] landscape:w-auto"
              autoPlay
              muted
              playsInline
            />
            <div className="flex flex-col items-center gap-2 landscape:items-start">
              <span
                data-testid="qr-receive-progress"
                className="text-2xl font-bold tabular-nums"
              >
                {received}/{total ?? '?'}
              </span>
              <span className="text-sm text-muted-foreground">frames captured</span>
              {phase === 'ingesting' && (
                <p className="text-sm font-medium text-primary">Uploading received reports…</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
