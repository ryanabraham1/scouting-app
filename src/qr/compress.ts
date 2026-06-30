// src/qr/compress.ts
// Gzip the QR payload before it's chunked into fountain frames. Match-scouting
// JSON is extremely repetitive (the same snake_case keys repeat across every
// report), so gzip typically shrinks it 3–5×, which directly cuts the number of
// QR frames a receiver must scan.
//
// Uses the platform CompressionStream/DecompressionStream (Safari 16.4+, Chrome
// 80+, Firefox 113+ — all the phones a scout would use). When unavailable we
// fall back to the raw bytes and flag the payload as uncompressed, so the
// hand-off still works, just with more frames.

/** True when the platform exposes gzip via CompressionStream. */
export function compressionSupported(): boolean {
  return (
    typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'
  );
}

async function pipeThrough(
  input: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  // Drive the (de)compression TransformStream directly through its writer/reader
  // rather than via Blob/Response — the Web Streams API is consistent across
  // browsers and Node, whereas Blob.stream()/Response interop is not (jsdom).
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // Drive the write CONCURRENTLY with the read so backpressure on a large payload
  // can't deadlock — but keep the promise (with a handler) so write/close
  // rejections SURFACE instead of becoming swallowed unhandled rejections (the
  // old `void writer.write()/close()` lost errors on large inputs).
  // Cast: lib.dom types the writer as BufferSource, but the newer Uint8Array
  // generic (ArrayBufferLike) isn't structurally assignable; the value is a
  // plain Uint8Array at runtime.
  const writeDone = writer.write(input as unknown as BufferSource).then(() => writer.close());

  const chunks: Uint8Array[] = [];
  let total = 0;
  let readErr: unknown;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch (err) {
    readErr = err;
  }
  // Observe the write side's completion/error too. Prefer surfacing a read error.
  try {
    await writeDone;
  } catch (err) {
    if (readErr === undefined) readErr = err;
  }
  if (readErr !== undefined) throw readErr;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Compress `bytes` for the QR hand-off. Returns the (possibly compressed) bytes
 * plus a flag the receiver uses to decide whether to inflate. Never throws: any
 * failure (or missing platform support) degrades to the raw bytes.
 */
export async function compressForQr(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; compressed: boolean }> {
  if (!compressionSupported()) return { bytes, compressed: false };
  try {
    const out = await pipeThrough(bytes, new CompressionStream('gzip'));
    // Guard against the pathological case where gzip framing overhead beats a
    // tiny payload — send whichever is smaller.
    if (out.length < bytes.length) return { bytes: out, compressed: true };
    return { bytes, compressed: false };
  } catch {
    return { bytes, compressed: false };
  }
}

/**
 * Thrown when a payload was gzipped by the SENDER but THIS device (the receiver)
 * has no DecompressionStream to inflate it. Sender/receiver capability is
 * independent — a modern sender can compress for a stale-WebView receiver — and
 * retrying with the same bytes would re-throw forever, so the UI must treat this
 * as NON-retryable (don't offer an identical "Retry upload").
 */
export class DecompressionUnsupportedError extends Error {
  constructor() {
    super(
      'This device can’t open the compressed data (no DecompressionStream). Open ' +
        'the receiver in an up-to-date browser, or have the sender resend.',
    );
    this.name = 'DecompressionUnsupportedError';
  }
}

/** Inverse of compressForQr: inflate when `compressed`, else pass through. */
export async function decompressForQr(
  bytes: Uint8Array,
  compressed: boolean,
): Promise<Uint8Array> {
  if (!compressed) return bytes;
  // The receiver's capability is independent of the sender's — guard before
  // constructing the stream so a missing API surfaces as a clear, non-retryable
  // error rather than an opaque "DecompressionStream is not defined" on every retry.
  if (typeof DecompressionStream === 'undefined') {
    throw new DecompressionUnsupportedError();
  }
  return pipeThrough(bytes, new DecompressionStream('gzip'));
}
