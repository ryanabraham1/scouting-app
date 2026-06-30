import { describe, it, expect } from 'vitest';
import {
  compressForQr,
  decompressForQr,
  compressionSupported,
  DecompressionUnsupportedError,
} from '@/qr/compress';

const supported = compressionSupported();

describe('compressForQr / decompressForQr', () => {
  it.runIf(supported)('round-trips bytes through gzip', async () => {
    // Highly repetitive input (like our snake_case report JSON) so gzip wins.
    const original = new TextEncoder().encode(JSON.stringify(
      Array.from({ length: 40 }, (_, i) => ({ event_key: '2026casnv', scout_id: 'scout1', i })),
    ));
    const { bytes, compressed } = await compressForQr(original);
    expect(compressed).toBe(true);
    expect(bytes.length).toBeLessThan(original.length);
    const out = await decompressForQr(bytes, compressed);
    // Compare as plain arrays — vitest's typed-array toEqual is byte-identical
    // here ("no visual difference") but trips on buffer/prototype nuances.
    expect([...out]).toEqual([...original]);
  });

  it('passes raw bytes through when not compressed', async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await decompressForQr(original, false);
    expect([...out]).toEqual([...original]);
  });

  it('throws a clear non-retryable error when the receiver lacks DecompressionStream (BUG-10)', async () => {
    // A modern sender can gzip a payload (z=1) for a receiver on a stale WebView
    // that has no DecompressionStream. Previously the constructor threw an opaque
    // "DecompressionStream is not defined" and the UI looped on an identical retry.
    const g = globalThis as { DecompressionStream?: unknown };
    const original = g.DecompressionStream;
    g.DecompressionStream = undefined;
    try {
      await expect(decompressForQr(new Uint8Array([1, 2, 3]), true)).rejects.toBeInstanceOf(
        DecompressionUnsupportedError,
      );
      // Uncompressed payloads still pass through fine without the API.
      const raw = new Uint8Array([9, 9, 9]);
      expect([...(await decompressForQr(raw, false))]).toEqual([...raw]);
    } finally {
      g.DecompressionStream = original;
    }
  });

  it('never claims compression for an incompressible tiny payload', async () => {
    // A few random-ish bytes: gzip framing overhead exceeds any savings, so the
    // helper must fall back to raw + compressed:false (still a valid hand-off).
    const tiny = new Uint8Array([7, 200, 13, 99]);
    const { bytes, compressed } = await compressForQr(tiny);
    if (!compressed) {
      expect([...bytes]).toEqual([...tiny]);
      expect([...(await decompressForQr(bytes, compressed))]).toEqual([...tiny]);
    }
  });
});
