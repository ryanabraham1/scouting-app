import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrowserQRCodeReader } from '@zxing/browser';
import { Camera, CameraOff, CheckCircle2, RotateCcw, UserRound } from 'lucide-react';
import { FountainDecoder, parseFrame, bytesToReports } from '@/qr/envelope';
import { decompressForQr, DecompressionUnsupportedError } from '@/qr/compress';
import { postIngest } from '@/qr/ingestClient';
import { QR_SCAN_DELAY_MS } from '@/sync/constants';
import { BackLink } from '@/components/ui/BackLink';
import { useSession } from '@/auth/useSession';
import { isScouterLoggedOut } from '@/roster/selectScouter';

type Phase = 'scanning' | 'ingesting' | 'done' | 'error';

// Consecutive frames from a new session id required before the receiver abandons
// its in-progress decode and adopts the new session (single-sender-restart
// recovery without letting a brief foreign frame wipe a half-decoded transfer).
const ADOPT_AFTER_FOREIGN_FRAMES = 3;

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
// Guard: the receiver POSTs the decoded batch to the `ingest-reports` Edge
// Function under THIS device's session JWT. That function (BUG-7) now tolerates a
// scouter-less receiver server-side, but a device with no scouter selected almost
// always means the user opened the wrong screen / on the wrong device — and the
// QR sender tags each report with its author NAME, which the receiver's own
// identity is irrelevant to. We still prompt to pick a name first so the receiving
// device is a known, attributable participant (mirrors ScoutHome's name gate), and
// so the scouter has their assignments/identity ready when they return to scout.
export default function QrReceiveScreen() {
  const { scout, loading } = useSession();
  // A device that durably logged out has a stale scout row server-side; treat it
  // as no-scouter here, exactly like ScoutHome's gate.
  const hasScouter = Boolean(scout) && !isScouterLoggedOut();

  // Wait for the first session resolve before deciding (avoids a flash of the
  // "pick a name" prompt for an already-signed-in scout on a cold load).
  if (loading) {
    return (
      <div
        data-testid="qr-receive"
        className="flex min-h-screen flex-col items-center justify-center bg-background px-safe py-safe text-foreground"
      >
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!hasScouter) {
    return (
      <div
        data-testid="qr-receive"
        className="flex min-h-screen flex-col bg-background px-safe py-safe text-foreground"
      >
        <header className="mb-4 flex items-center gap-3">
          <BackLink to="/scout" label="Back" icon="back" />
          <Camera className="size-7 shrink-0 text-brand" aria-hidden />
          <h1 className="break-words text-xl font-bold leading-tight sm:text-2xl">Receive over QR</h1>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div
            data-testid="qr-receive-needs-scouter"
            className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-brand/40 bg-brand/10 p-6"
          >
            <UserRound className="size-10 shrink-0 text-brand" aria-hidden />
            <p className="text-base font-medium">Pick your name before receiving reports.</p>
            <p className="text-sm text-muted-foreground">
              This device needs a scouter selected so the reports you receive are uploaded under a
              known identity.
            </p>
            <Link
              data-testid="qr-receive-pick-name"
              to="/scout"
              className="mt-1 inline-flex min-h-[44px] items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-brand-foreground hover:bg-brand/90"
            >
              <UserRound className="size-4" /> Choose your name
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <QrReceiveScanner />;
}

function QrReceiveScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const decoderRef = useRef(new FountainDecoder());
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const completedRef = useRef(false);
  // Foreign-session debounce: don't wipe a half-decoded transfer on the FIRST
  // frame from a different session id (a reflection, a screenshot, or a second
  // scout's send screen briefly in frame). Only adopt a new session after several
  // CONSECUTIVE frames confirm the sender genuinely restarted — otherwise two
  // concurrent senders thrash and the transfer never completes.
  const foreignSidRef = useRef<string | null>(null);
  const foreignCountRef = useRef(0);

  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('scanning');
  const [ingested, setIngested] = useState<number | null>(null);
  const [failedCount, setFailedCount] = useState(0);
  const [failedError, setFailedError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // True when an ingest failed but the fully-decoded batch is still held in
  // decoderRef, so the upload can be retried WITHOUT re-scanning every frame.
  const [canRetry, setCanRetry] = useState(false);

  // Upload the already-decoded batch held in decoderRef. Extracted so both the
  // auto-complete path and a manual "Retry upload" can run it; the decoded bytes
  // survive a transient network failure, so a blip mid-upload never forces a
  // full re-scan of the sender's screen.
  const runIngest = useCallback(async (): Promise<void> => {
    setPhase('ingesting');
    setErrorMessage(null);
    setCanRetry(false);
    try {
      const decoder = decoderRef.current;
      const raw = await decompressForQr(decoder.payloadBytes(), decoder.compressed ?? false);
      const reports = bytesToReports(raw);
      const result = await postIngest(reports);
      setIngested(result.ingested);
      setFailedCount(result.failed.length);
      setFailedError(result.failed[0]?.error ?? null);
      if (result.ingested === 0 && result.failed.length > 0) {
        // Everything decoded but the server rejected every row → surface it AND
        // allow a retry (the rejection may be a transient RLS/auth blip).
        setErrorMessage(
          `Server rejected all ${result.failed.length} report${
            result.failed.length === 1 ? '' : 's'
          }: ${result.failed[0]?.error ?? 'unknown error'}`,
        );
        setPhase('error');
        setCanRetry(true);
      } else {
        // PARTIAL success (some ingested, some failed) still keeps a retry
        // affordance: the WHOLE batch is still in decoderRef and re-POSTing is
        // revision-guarded (already-ingested rows are server no-ops), so a retry
        // only re-attempts the failures. Without this the green "done" view hid the
        // failed subset, which is lost the moment the sender is wiped — the very
        // thing QR transfer exists to prevent.
        setCanRetry(result.failed.length > 0);
        setPhase('done');
      }
    } catch (err) {
      // A receiver that can't inflate a gzipped payload (no DecompressionStream)
      // would re-throw the identical error on every retry — mark it non-retryable
      // so the UI stops offering a useless "Retry upload". Any other failure
      // (transient network/ingest) keeps the batch in decoderRef and offers a retry.
      const unrecoverable = err instanceof DecompressionUnsupportedError;
      setErrorMessage(err instanceof Error ? err.message : 'Failed to upload reports.');
      setPhase('error');
      setCanRetry(!unrecoverable);
    }
  }, []);

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

    // zxing sleeps `delayBetweenScanAttempts`/`delayBetweenScanSuccess` (BOTH
    // 500ms by default) between decodes, which throttled the receiver to ~2
    // frames/sec — the dominant QR-transfer bottleneck. Drop both so we decode
    // at roughly camera frame rate; with fountain coding every extra symbol we
    // capture shortens the hand-off.
    const reader = new BrowserQRCodeReader(undefined, {
      delayBetweenScanAttempts: QR_SCAN_DELAY_MS,
      delayBetweenScanSuccess: QR_SCAN_DELAY_MS,
    });

    const handleComplete = () => {
      // Guard against the callback firing again after we've already finished.
      if (completedRef.current) return;
      completedRef.current = true;
      controlsRef.current?.stop();
      void runIngest();
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
            let decoder = decoderRef.current;
            // A restarted sender (navigation, lock/unlock, re-open to push a fresh
            // backlog) emits a NEW session id. FountainDecoder pins to the first
            // session and silently drops every frame from any other one, so without
            // adoption the receiver freezes mid-decode forever. BUT adopting on the
            // FIRST foreign frame lets a reflection / a second scout's screen / a
            // screenshot momentarily in frame wipe a half-decoded transfer — and two
            // concurrent senders then reset each other forever. So debounce: only
            // adopt a new session after N CONSECUTIVE frames from the SAME new sid.
            if (
              decoder.sessionId !== null &&
              frame.s !== decoder.sessionId &&
              !decoder.complete
            ) {
              if (foreignSidRef.current === frame.s) foreignCountRef.current += 1;
              else {
                foreignSidRef.current = frame.s;
                foreignCountRef.current = 1;
              }
              // Not yet convinced the sender truly changed — ignore this frame and
              // keep the current decode intact.
              if (foreignCountRef.current < ADOPT_AFTER_FOREIGN_FRAMES) return;
              decoder = new FountainDecoder();
              decoderRef.current = decoder;
              foreignSidRef.current = null;
              foreignCountRef.current = 0;
              setReceived(0);
              setTotal(null);
            } else {
              // A current-session (or first-ever) frame breaks any foreign streak.
              foreignSidRef.current = null;
              foreignCountRef.current = 0;
            }
            decoder.add(frame);
            setReceived(decoder.solvedCount);
            setTotal(decoder.total);
            if (decoder.complete) {
              handleComplete();
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
  }, [runIngest]);

  return (
    <div
      data-testid="qr-receive"
      className="flex min-h-screen flex-col bg-background px-safe py-safe text-foreground"
    >
      <header className="mb-4 flex items-start gap-3">
        <BackLink to="/scout" label="Back" icon="back" />
        <Camera
          className={`mt-2 size-7 shrink-0 ${phase === 'error' ? 'text-destructive' : 'text-brand'}`}
          aria-hidden
        />
        <div className="min-w-0">
          <h1 className="break-words text-xl font-bold leading-tight sm:text-2xl">Receive over QR</h1>
          <p className="text-sm text-muted-foreground">
            Aim at the sending device&apos;s screen. The codes cycle on their own — a missed one
            is fine, just hold it roughly in frame until the bar fills.
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
            {canRetry ? (
              <button
                type="button"
                data-testid="qr-receive-retry"
                onClick={() => void runIngest()}
                className="mt-1 inline-flex min-h-[44px] items-center gap-2 rounded-md border border-destructive/50 px-4 text-sm font-medium text-destructive hover:bg-destructive/15"
              >
                <RotateCcw className="size-4" /> Retry upload
              </button>
            ) : null}
          </div>
        ) : phase === 'done' ? (
          <div
            data-testid="qr-receive-done"
            className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-success/50 bg-success/10 p-6 text-center"
          >
            <CheckCircle2 className="size-10 shrink-0 text-success" aria-hidden />
            <p className="text-lg font-semibold">
              Received and uploaded {ingested ?? 0} report{ingested === 1 ? '' : 's'}.
            </p>
            {failedCount > 0 && (
              <p data-testid="qr-receive-partial" className="text-sm font-medium text-energy">
                {failedCount} report{failedCount === 1 ? '' : 's'} could not be uploaded
                {failedError ? ` (${failedError})` : ''}.
              </p>
            )}
            {/* Partial success keeps a retry: re-POSTing the held batch is
                revision-guarded, so it only re-attempts the failed subset. Without
                this the failed reports are lost when the sender is wiped. */}
            {failedCount > 0 && canRetry && (
              <button
                type="button"
                data-testid="qr-receive-retry"
                onClick={() => void runIngest()}
                className="mt-1 inline-flex min-h-[44px] items-center gap-2 rounded-md border border-energy/50 px-4 text-sm font-medium text-energy hover:bg-energy/15"
              >
                <RotateCcw className="size-4" /> Retry failed uploads
              </button>
            )}
          </div>
        ) : (
          <>
            {/* The video is always present while scanning/ingesting so the ref
                exists before decodeFromVideoDevice attaches a stream. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={videoRef}
              data-testid="qr-receive-video"
              className="aspect-square w-full max-w-sm rounded-xl bg-black object-cover landscape:h-[min(60vh,20rem)] landscape:w-auto"
              autoPlay
              muted
              playsInline
            />
            <div className="flex w-full max-w-sm flex-col items-center gap-2 landscape:items-start">
              <span
                data-testid="qr-receive-progress"
                className={`text-2xl font-bold tabular-nums ${
                  total !== null && received >= total ? 'text-success' : 'text-brand'
                }`}
              >
                {received}/{total ?? '?'}
              </span>
              {/* Fill bar: maps decoded blocks → percent so the user has a clear
                  "how much longer" signal instead of bare counts. */}
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-[width] duration-150 ${
                    total !== null && received >= total ? 'bg-success' : 'bg-brand'
                  }`}
                  style={{
                    width: total ? `${Math.min(100, Math.round((received / total) * 100))}%` : '0%',
                  }}
                />
              </div>
              <span className="text-sm text-muted-foreground">blocks decoded</span>
              {phase === 'ingesting' && (
                <p className="text-sm font-medium text-energy">Uploading received reports…</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
