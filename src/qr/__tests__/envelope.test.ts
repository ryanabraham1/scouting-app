import { describe, it, expect } from 'vitest';
import {
  crc32hex,
  buildFrames,
  frameToString,
  parseFrame,
  FrameAccumulator,
  type QrFrame,
} from '@/qr/envelope';
import { QR_CHUNK_CHARS, QR_ENVELOPE_VERSION } from '@/sync/constants';

// Sample backlog of "reports" — opaque objects; the envelope treats them as
// unknown JSON. Make them big enough to span several frames once base64'd.
function makeReports(): Record<string, unknown>[] {
  return Array.from({ length: 12 }, (_, i) => ({
    id: `report-${i}-${'x'.repeat(80)}`,
    matchKey: `qm${i}`,
    targetTeamNumber: 1000 + i,
    notes: 'lorem ipsum dolor sit amet '.repeat(4),
    nested: { a: [1, 2, 3, i], b: { c: i % 2 === 0 } },
  }));
}

describe('crc32hex', () => {
  it('returns 8 lowercase hex chars', () => {
    const out = crc32hex('hello');
    expect(out).toMatch(/^[0-9a-f]{8}$/);
  });

  it('matches the standard CRC32 vector for empty string', () => {
    expect(crc32hex('')).toBe('00000000');
  });

  it('matches the standard CRC32 vector for "The quick brown fox jumps over the lazy dog"', () => {
    expect(crc32hex('The quick brown fox jumps over the lazy dog')).toBe('414fa339');
  });

  it('matches the standard CRC32 vector for "123456789"', () => {
    expect(crc32hex('123456789')).toBe('cbf43926');
  });

  it('is deterministic', () => {
    expect(crc32hex('abc')).toBe(crc32hex('abc'));
  });
});

describe('buildFrames', () => {
  it('produces frames covering the full base64 payload', () => {
    const reports = makeReports();
    const frames = buildFrames(reports, 'sid-1');
    expect(frames.length).toBeGreaterThan(1);
    // Every frame agrees on n, version, sid.
    const n = frames.length;
    frames.forEach((f, i) => {
      expect(f.v).toBe(QR_ENVELOPE_VERSION);
      expect(f.sid).toBe('sid-1');
      expect(f.i).toBe(i);
      expect(f.n).toBe(n);
      expect(f.crc).toBe(crc32hex(f.d));
      // Non-final frames are exactly the chunk size; the last is the remainder.
      if (i < n - 1) {
        expect(f.d.length).toBe(QR_CHUNK_CHARS);
      } else {
        expect(f.d.length).toBeLessThanOrEqual(QR_CHUNK_CHARS);
        expect(f.d.length).toBeGreaterThan(0);
      }
    });
  });

  it('always produces at least one frame, even for an empty backlog', () => {
    const frames = buildFrames([], 'sid-empty');
    expect(frames.length).toBe(1);
    expect(frames[0].n).toBe(1);
    expect(frames[0].i).toBe(0);
  });

  it('chunk count equals ceil(len / QR_CHUNK_CHARS)', () => {
    const reports = makeReports();
    const frames = buildFrames(reports, 'sid-c');
    const totalLen = frames.reduce((acc, f) => acc + f.d.length, 0);
    expect(frames.length).toBe(Math.max(1, Math.ceil(totalLen / QR_CHUNK_CHARS)));
  });
});

describe('frameToString / parseFrame', () => {
  it('round-trips a single frame', () => {
    const [f] = buildFrames(makeReports(), 'sid-rt');
    const parsed = parseFrame(frameToString(f));
    expect(parsed).toEqual(f);
  });

  it('returns null on malformed JSON', () => {
    expect(parseFrame('{bad')).toBeNull();
    expect(parseFrame('')).toBeNull();
    expect(parseFrame('null')).toBeNull();
    expect(parseFrame('[]')).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    const [f] = buildFrames(makeReports(), 'sid-miss');
    const obj: Record<string, unknown> = { ...f };
    delete obj.crc;
    expect(parseFrame(JSON.stringify(obj))).toBeNull();
  });

  it('returns null on the wrong envelope version', () => {
    const [f] = buildFrames(makeReports(), 'sid-ver');
    const bad = { ...f, v: 2 };
    expect(parseFrame(JSON.stringify(bad))).toBeNull();
  });

  it('returns null when d has been tampered with (crc mismatch)', () => {
    const [f] = buildFrames(makeReports(), 'sid-tamper');
    const tampered: QrFrame = { ...f, d: f.d.slice(0, -1) + (f.d.endsWith('A') ? 'B' : 'A') };
    expect(parseFrame(frameToString(tampered))).toBeNull();
  });
});

describe('FrameAccumulator', () => {
  it('reassembles the original reports from shuffled frames', () => {
    const reports = makeReports();
    const frames = buildFrames(reports, 'sid-acc');
    // Shuffle deterministically.
    const shuffled = [...frames].sort((a, b) => ((a.i * 7) % 5) - ((b.i * 7) % 5));
    const acc = new FrameAccumulator();
    shuffled.forEach((f) => acc.add(f));
    expect(acc.sessionId).toBe('sid-acc');
    expect(acc.total).toBe(frames.length);
    expect(acc.received).toBe(frames.length);
    expect(acc.complete).toBe(true);
    expect(acc.reports()).toEqual(reports);
  });

  it('is incomplete and throws when a frame is missing', () => {
    const reports = makeReports();
    const frames = buildFrames(reports, 'sid-missing');
    const acc = new FrameAccumulator();
    frames.slice(0, -1).forEach((f) => acc.add(f)); // drop the last
    expect(acc.complete).toBe(false);
    expect(acc.received).toBe(frames.length - 1);
    expect(() => acc.reports()).toThrow();
  });

  it('dedups by index (duplicate frames are idempotent)', () => {
    const reports = makeReports();
    const frames = buildFrames(reports, 'sid-dup');
    const acc = new FrameAccumulator();
    frames.forEach((f) => acc.add(f));
    // Re-add everything (and one frame thrice) — received must not grow.
    frames.forEach((f) => acc.add(f));
    acc.add(frames[0]);
    expect(acc.received).toBe(frames.length);
    expect(acc.complete).toBe(true);
    expect(acc.reports()).toEqual(reports);
  });

  it('ignores frames from a different session id', () => {
    const reports = makeReports();
    const frames = buildFrames(reports, 'sid-keep');
    const foreign = buildFrames([{ junk: true }], 'sid-other');
    const acc = new FrameAccumulator();
    acc.add(frames[0]); // establishes the session id
    foreign.forEach((f) => acc.add(f)); // must be ignored
    frames.slice(1).forEach((f) => acc.add(f));
    expect(acc.sessionId).toBe('sid-keep');
    expect(acc.received).toBe(frames.length);
    expect(acc.complete).toBe(true);
    expect(acc.reports()).toEqual(reports);
  });

  it('exposes null/zero state before any frame is added', () => {
    const acc = new FrameAccumulator();
    expect(acc.sessionId).toBeNull();
    expect(acc.total).toBeNull();
    expect(acc.received).toBe(0);
    expect(acc.complete).toBe(false);
    expect(() => acc.reports()).toThrow();
  });

  it('round-trips a UTF-8 payload (multi-byte chars)', () => {
    const reports = [{ notes: 'café ☕ 日本語 — emoji 🚀', team: 254 }];
    const frames = buildFrames(reports, 'sid-utf8');
    const acc = new FrameAccumulator();
    frames.forEach((f) => acc.add(f));
    expect(acc.complete).toBe(true);
    expect(acc.reports()).toEqual(reports);
  });
});
