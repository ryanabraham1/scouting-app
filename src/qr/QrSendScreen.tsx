import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { getSyncQueue, listDeadLetters } from '@/db/localStore';
import { toUpsertPayload } from '@/sync/mapReport';
import { getCachedDisplayNameForScoutId } from '@/roster/scoutIdentityCache';
import { FountainEncoder, frameToString, reportsToBytes } from '@/qr/envelope';
import { compressForQr } from '@/qr/compress';
import { QR_FRAME_MS } from '@/sync/constants';
import { BackLink } from '@/components/ui/BackLink';
import { CheckCircle2 } from 'lucide-react';

// Animated QR sender (contracts §6/§7). Loads the unsynced backlog, gzip-
// compresses it, and emits an ENDLESS stream of fountain symbols — each a random
// XOR of source blocks — so the receiver reconstructs the batch from ~K
// successful scans in any order. A missed frame costs nothing; we just keep
// cycling fresh symbols until the receiver says it has everything.
export default function QrSendScreen() {
  const [encoder, setEncoder] = useState<FountainEncoder | null>(null);
  const [isEmpty, setIsEmpty] = useState(false);
  const [seq, setSeq] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [paused, setPaused] = useState(reducedMotion);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => {
      setReducedMotion(event.matches);
      if (event.matches) setPaused(true);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Build the fountain encoder once from the backlog. The wire payload is the
  // SAME snake_case object the online outbox sends (toUpsertPayload) — NOT the
  // camelCase LocalMatchReport — so the receiver's ingest path reads the right
  // keys. We additionally tag each report with `scout_name` (best-effort, from
  // this device's identity cache): the receiver can't resolve a FOREIGN device's
  // `scout_id` (those rows are per-device and get consolidated by
  // select_scouter), so the name is what lets ingest re-attach the report to the
  // right scouter instead of dead-lettering it. The online outbox never carries
  // this field, so the shared wire shape is unchanged. sid is a fresh short
  // per-hand-off id (crypto.randomUUID() is the runtime source; envelope.ts
  // stays pure).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // The QR batch is the device-to-device RESCUE path, so it must carry the
      // DEAD-LETTERED ('error') reports too — those are the ones that most need to
      // be hand-carried to another device to sync (BUG-2). getSyncQueue() only
      // returns dirty/pending (the auto-retry worklist deliberately excludes error),
      // so union it with listDeadLetters(). De-dupe by id in case a row appears in
      // both. The wire/merge shape is unchanged.
      const [pending, dead] = await Promise.all([getSyncQueue(), listDeadLetters()]);
      const byId = new Map<string, (typeof pending)[number]>();
      for (const r of [...pending, ...dead]) byId.set(r.id, r);
      const queue = [...byId.values()].map((r) => {
        const payload = toUpsertPayload(r);
        const name = getCachedDisplayNameForScoutId(r.scoutId);
        return name ? { ...payload, scout_name: name } : payload;
      });
      if (cancelled) return;
      if (queue.length === 0) {
        setIsEmpty(true);
        setEncoder(null);
        return;
      }
      const { bytes, compressed } = await compressForQr(reportsToBytes(queue));
      if (cancelled) return;
      const sid = crypto.randomUUID().slice(0, 8);
      setIsEmpty(false);
      setEncoder(new FountainEncoder(bytes, sid, compressed));
      setSeq(0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Advance to the next fountain symbol while running.
  useEffect(() => {
    if (!encoder || paused) return;
    const timer = setInterval(() => setSeq((s) => s + 1), QR_FRAME_MS);
    return () => clearInterval(timer);
  }, [encoder, paused]);

  // Draw the current symbol STRAIGHT to a canvas (not a PNG data URL fed to an
  // <img>): the img path re-decodes a base64 PNG every frame and flashes white
  // between swaps, which both looks clunky and starves the receiver of a clean
  // frame at the fast cadence. Canvas draws in place, so frames swap instantly.
  // 'L' error correction keeps the code as sparse as possible — the screen→camera
  // channel is clean and fountain coding already tolerates dropped frames, so
  // heavy ECC would only add modules and slow the camera's lock.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!encoder || !canvas) return;
    const payload = frameToString(encoder.frame(seq));
    void QRCode.toCanvas(canvas, payload, { errorCorrectionLevel: 'L', margin: 2, width: 400 });
  }, [encoder, seq]);

  return (
    <div
      data-testid="qr-send"
      className="flex min-h-screen flex-col items-center gap-6 bg-background px-safe py-safe text-foreground"
    >
      <header className="w-full">
        <div className="flex items-center gap-3">
          <BackLink to="/scout" label="Back" icon="back" />
          <h1 className="text-2xl font-bold">Send over QR</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Point the receiving device&apos;s camera at the code. It flips through symbols on its
          own — leave this screen up until the receiver&apos;s bar is full.
        </p>
      </header>

      {isEmpty ? (
        <div
          data-testid="qr-send-empty"
          className="mt-8 flex flex-col items-center gap-3 text-center"
        >
          <CheckCircle2 className="size-10 shrink-0 text-success" aria-hidden />
          <p className="text-lg text-success">Nothing to send — your reports are all synced.</p>
        </div>
      ) : encoder === null ? (
        <p className="text-sm text-muted-foreground">Loading backlog…</p>
      ) : (
        <>
          <div className="flex flex-col items-center gap-3">
            <canvas
              ref={canvasRef}
              data-testid="qr-frame"
              aria-label={`QR fountain symbol ${seq + 1}`}
              className="aspect-square w-full max-w-[20rem] rounded-lg bg-white p-2"
            />
            <span data-testid="qr-send-progress" className="text-lg font-semibold tabular-nums">
              <span className="text-brand">{seq + 1} sent</span>{' '}
              <span className="text-muted-foreground">
                · {encoder.k} block{encoder.k === 1 ? '' : 's'} to receive
              </span>
            </span>
            {reducedMotion && paused ? (
              <span className="max-w-xs text-center text-sm text-muted-foreground">
                Animation is paused for your reduced-motion preference. Resume when the receiver
                is ready.
              </span>
            ) : null}
          </div>

          <Button
            data-testid="qr-send-pause"
            variant={paused ? 'brand' : 'secondary'}
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
