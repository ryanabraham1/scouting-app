import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { getSyncQueue } from '@/db/localStore';
import { toUpsertPayload } from '@/sync/mapReport';
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
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  // Build the fountain encoder once from the backlog. The wire payload is the
  // SAME snake_case object the online outbox sends (toUpsertPayload) — NOT the
  // camelCase LocalMatchReport — so the receiver's ingest path reads the right
  // keys. sid is a fresh short per-hand-off id (crypto.randomUUID() is the
  // runtime source; envelope.ts stays pure).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const queue = (await getSyncQueue()).map(toUpsertPayload);
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

  // Render the current symbol to a PNG data URL whenever it changes. Rendered at
  // a higher internal resolution than the 320px display box so each module stays
  // crisp when the camera samples it.
  useEffect(() => {
    if (!encoder) return;
    const payload = frameToString(encoder.frame(seq));
    let cancelled = false;
    void QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 512 }).then(
      (url) => {
        if (!cancelled) setDataUrl(url);
      },
    );
    return () => {
      cancelled = true;
    };
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
          Point the receiving device&apos;s camera at the code. Keep this screen open until the
          receiver shows it has every block — the code keeps changing on purpose.
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
            {dataUrl && (
              <img
                data-testid="qr-frame"
                src={dataUrl}
                alt={`QR fountain symbol ${seq + 1}`}
                className="aspect-square w-full max-w-[20rem] rounded-lg bg-white p-2"
              />
            )}
            <span data-testid="qr-send-progress" className="text-lg font-semibold tabular-nums">
              <span className="text-brand">{seq + 1} sent</span>{' '}
              <span className="text-muted-foreground">
                · {encoder.k} block{encoder.k === 1 ? '' : 's'} to receive
              </span>
            </span>
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
