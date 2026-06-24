import { describe, it, expect } from 'vitest';
import {
  crc32hex,
  crc32hexBytes,
  symbolIndices,
  FountainEncoder,
  FountainDecoder,
  frameToString,
  parseFrame,
  reportsToBytes,
  bytesToReports,
  type QrFrame,
} from '@/qr/envelope';
import { FOUNTAIN_BLOCK_BYTES, QR_ENVELOPE_VERSION } from '@/sync/constants';

// Sample backlog of "reports" — opaque objects; the envelope treats them as
// unknown JSON. Big enough to span many fountain blocks.
function makeReports(): Record<string, unknown>[] {
  return Array.from({ length: 12 }, (_, i) => ({
    id: `report-${i}-${'x'.repeat(80)}`,
    matchKey: `qm${i}`,
    targetTeamNumber: 1000 + i,
    notes: 'lorem ipsum dolor sit amet '.repeat(4),
    nested: { a: [1, 2, 3, i], b: { c: i % 2 === 0 } },
  }));
}

/** Drive an encoder into a decoder until complete (or give up past a bound). */
function decodeToCompletion(
  encoder: FountainEncoder,
  maxSymbols: number,
): { decoder: FountainDecoder; used: number } {
  const decoder = new FountainDecoder();
  let t = 0;
  for (; t < maxSymbols && !decoder.complete; t += 1) {
    decoder.add(encoder.frame(t));
  }
  return { decoder, used: t };
}

describe('crc32', () => {
  it('crc32hex returns 8 lowercase hex chars', () => {
    expect(crc32hex('hello')).toMatch(/^[0-9a-f]{8}$/);
  });
  it('matches standard vectors', () => {
    expect(crc32hex('')).toBe('00000000');
    expect(crc32hex('The quick brown fox jumps over the lazy dog')).toBe('414fa339');
    expect(crc32hex('123456789')).toBe('cbf43926');
  });
  it('crc32hexBytes agrees with crc32hex over the UTF-8 bytes', () => {
    expect(crc32hexBytes(new TextEncoder().encode('abc'))).toBe(crc32hex('abc'));
  });
});

describe('symbolIndices', () => {
  it('is deterministic for a given (seed, k)', () => {
    expect(symbolIndices(42, 10)).toEqual(symbolIndices(42, 10));
  });
  it('returns 1..k distinct, in-range, sorted indices', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const idx = symbolIndices(seed, 8);
      expect(idx.length).toBeGreaterThanOrEqual(1);
      expect(idx.length).toBeLessThanOrEqual(8);
      expect(new Set(idx).size).toBe(idx.length); // distinct
      expect(idx.every((i) => i >= 0 && i < 8)).toBe(true);
      expect([...idx].sort((a, b) => a - b)).toEqual(idx); // sorted
    }
  });
  it('degenerates to [0] when k = 1', () => {
    expect(symbolIndices(0, 1)).toEqual([0]);
    expect(symbolIndices(99, 1)).toEqual([0]);
  });
});

describe('FountainEncoder', () => {
  it('exposes block count and carries consistent header fields', () => {
    const bytes = reportsToBytes(makeReports());
    const enc = new FountainEncoder(bytes, 'sid1', false);
    expect(enc.k).toBe(Math.max(1, Math.ceil(bytes.length / FOUNTAIN_BLOCK_BYTES)));
    const f = enc.frame(0);
    expect(f.v).toBe(QR_ENVELOPE_VERSION);
    expect(f.s).toBe('sid1');
    expect(f.k).toBe(enc.k);
    expect(f.l).toBe(bytes.length);
    expect(f.b).toBe(FOUNTAIN_BLOCK_BYTES);
    expect(f.z).toBe(0);
    expect(f.p).toBe(crc32hexBytes(bytes));
    expect(f.h).toBe(crc32hex(f.d));
  });
  it('frame(seq) is deterministic', () => {
    const enc = new FountainEncoder(reportsToBytes(makeReports()), 'sid2', false);
    expect(enc.frame(7)).toEqual(enc.frame(7));
  });
});

describe('frameToString / parseFrame', () => {
  it('round-trips a single frame', () => {
    const enc = new FountainEncoder(reportsToBytes(makeReports()), 'sid-rt', false);
    const f = enc.frame(3);
    expect(parseFrame(frameToString(f))).toEqual(f);
  });
  it('returns null on malformed JSON / wrong shapes', () => {
    expect(parseFrame('{bad')).toBeNull();
    expect(parseFrame('')).toBeNull();
    expect(parseFrame('null')).toBeNull();
    expect(parseFrame('[]')).toBeNull();
  });
  it('returns null on the wrong envelope version', () => {
    const enc = new FountainEncoder(reportsToBytes(makeReports()), 'sid-v', false);
    const bad = { ...enc.frame(0), v: 1 };
    expect(parseFrame(JSON.stringify(bad))).toBeNull();
  });
  it('returns null when a required field is missing', () => {
    const enc = new FountainEncoder(reportsToBytes(makeReports()), 'sid-m', false);
    const obj: Record<string, unknown> = { ...enc.frame(0) };
    delete obj.h;
    expect(parseFrame(JSON.stringify(obj))).toBeNull();
  });
  it('returns null when d is tampered (per-frame crc mismatch)', () => {
    const enc = new FountainEncoder(reportsToBytes(makeReports()), 'sid-t', false);
    const f = enc.frame(0);
    const tampered: QrFrame = { ...f, d: f.d.slice(0, -1) + (f.d.endsWith('A') ? 'B' : 'A') };
    expect(parseFrame(frameToString(tampered))).toBeNull();
  });
});

describe('FountainDecoder', () => {
  it('reconstructs the payload from a stream of symbols', () => {
    const reports = makeReports();
    const enc = new FountainEncoder(reportsToBytes(reports), 'sid-dec', false);
    const { decoder, used } = decodeToCompletion(enc, enc.k * 5 + 50);
    expect(decoder.complete).toBe(true);
    // Rateless overhead should be modest — nowhere near "several full passes".
    expect(used).toBeLessThan(enc.k * 3 + 30);
    expect(bytesToReports(decoder.payloadBytes())).toEqual(reports);
  });

  it('completes regardless of symbol order (no specific frame is required)', () => {
    const reports = makeReports();
    const enc = new FountainEncoder(reportsToBytes(reports), 'sid-ord', false);
    // Gather enough symbols, then feed them in a shuffled order.
    const seeds = Array.from({ length: enc.k * 3 + 30 }, (_, t) => t);
    const shuffled = seeds.sort((a, b) => ((a * 7) % 13) - ((b * 7) % 13));
    const decoder = new FountainDecoder();
    for (const t of shuffled) {
      if (decoder.complete) break;
      decoder.add(enc.frame(t));
    }
    expect(decoder.complete).toBe(true);
    expect(bytesToReports(decoder.payloadBytes())).toEqual(reports);
  });

  it('dedups by seed (re-scanning the same symbol is idempotent)', () => {
    const enc = new FountainEncoder(reportsToBytes(makeReports()), 'sid-dup', false);
    const decoder = new FountainDecoder();
    // Feed the first symbol many times — solvedCount must not be inflated by it.
    for (let i = 0; i < 5; i += 1) decoder.add(enc.frame(0));
    const afterDupes = decoder.solvedCount;
    decoder.add(enc.frame(0));
    expect(decoder.solvedCount).toBe(afterDupes);
  });

  it('ignores frames from a different hand-off (sid mismatch)', () => {
    const reports = makeReports();
    const enc = new FountainEncoder(reportsToBytes(reports), 'sid-keep', false);
    const foreign = new FountainEncoder(reportsToBytes([{ junk: true }]), 'sid-other', false);
    const decoder = new FountainDecoder();
    decoder.add(enc.frame(0)); // pins the session
    for (let t = 0; t < 10; t += 1) decoder.add(foreign.frame(t)); // ignored
    for (let t = 1; t < enc.k * 3 + 30 && !decoder.complete; t += 1) decoder.add(enc.frame(t));
    expect(decoder.sessionId).toBe('sid-keep');
    expect(decoder.complete).toBe(true);
    expect(bytesToReports(decoder.payloadBytes())).toEqual(reports);
  });

  it('exposes null/zero state before any frame, and throws if decoded early', () => {
    const decoder = new FountainDecoder();
    expect(decoder.sessionId).toBeNull();
    expect(decoder.total).toBeNull();
    expect(decoder.compressed).toBeNull();
    expect(decoder.solvedCount).toBe(0);
    expect(decoder.complete).toBe(false);
    expect(() => decoder.payloadBytes()).toThrow();
  });

  it('round-trips a UTF-8 payload (multi-byte chars)', () => {
    const reports = [{ notes: 'café ☕ 日本語 — emoji 🚀', team: 254 }];
    const enc = new FountainEncoder(reportsToBytes(reports), 'sid-utf8', false);
    const { decoder } = decodeToCompletion(enc, enc.k * 5 + 50);
    expect(decoder.complete).toBe(true);
    expect(bytesToReports(decoder.payloadBytes())).toEqual(reports);
  });

  it('handles a tiny single-block payload (k = 1)', () => {
    const reports = [{ a: 1 }];
    const enc = new FountainEncoder(reportsToBytes(reports), 'sid-k1', false);
    expect(enc.k).toBe(1);
    const decoder = new FountainDecoder();
    decoder.add(enc.frame(0));
    expect(decoder.complete).toBe(true);
    expect(bytesToReports(decoder.payloadBytes())).toEqual(reports);
  });

  it('surfaces compression flag from the frame header', () => {
    const enc = new FountainEncoder(reportsToBytes([{ a: 1 }]), 'sid-z', true);
    const decoder = new FountainDecoder();
    decoder.add(enc.frame(0));
    expect(decoder.compressed).toBe(true);
  });
});
