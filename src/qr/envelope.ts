import { QR_CHUNK_CHARS, QR_ENVELOPE_VERSION } from '@/sync/constants';

// ---------------------------------------------------------------------------
// QR transport envelope (contracts §6).
//
// A backlog of unsynced reports → one JSON string → UTF-8-safe base64 → N
// chunked frames. Each QR frame encodes ONE envelope as a compact JSON string.
//
// Pure module: no Math.random / Date.now here. `sid` is always passed in by the
// caller (the app runtime derives it from crypto.randomUUID(); tests pass a
// fixed seed) so frame construction is fully deterministic.
// ---------------------------------------------------------------------------

export interface QrFrame {
  v: typeof QR_ENVELOPE_VERSION; // envelope version
  sid: string; // session id (stable across all frames of one hand-off)
  i: number; // frame index, 0-based
  n: number; // total frame count
  crc: string; // CRC32 (8 hex chars) of THIS frame's `d` string
  d: string; // this frame's slice of the base64 payload
}

// --- CRC32 (standard polynomial 0xEDB88320) --------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 of a UTF-8 string → 8 lowercase hex chars. */
export function crc32hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return crc.toString(16).padStart(8, '0');
}

// --- UTF-8-safe base64 ------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodePayload(reports: unknown[]): string {
  const json = JSON.stringify(reports);
  return bytesToBase64(new TextEncoder().encode(json));
}

function decodePayload(b64: string): unknown[] {
  const json = new TextDecoder().decode(base64ToBytes(b64));
  return JSON.parse(json) as unknown[];
}

// --- Frame build / serialize / parse ---------------------------------------

/** Chunk a backlog of reports into an ordered set of QR frames. */
export function buildFrames(reports: unknown[], sid: string): QrFrame[] {
  const b64 = encodePayload(reports);
  // Always emit at least one frame (an empty backlog still carries "[]" base64).
  const n = Math.max(1, Math.ceil(b64.length / QR_CHUNK_CHARS));
  const frames: QrFrame[] = [];
  for (let i = 0; i < n; i += 1) {
    const d = b64.slice(i * QR_CHUNK_CHARS, (i + 1) * QR_CHUNK_CHARS);
    frames.push({ v: QR_ENVELOPE_VERSION, sid, i, n, crc: crc32hex(d), d });
  }
  return frames;
}

export function frameToString(f: QrFrame): string {
  return JSON.stringify(f);
}

/** Parse + validate a scanned frame string. Returns null on anything off. */
export function parseFrame(s: string): QrFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const f = obj as Record<string, unknown>;
  if (f.v !== QR_ENVELOPE_VERSION) return null;
  if (typeof f.sid !== 'string') return null;
  if (typeof f.i !== 'number' || !Number.isInteger(f.i) || f.i < 0) return null;
  if (typeof f.n !== 'number' || !Number.isInteger(f.n) || f.n < 1) return null;
  if (typeof f.crc !== 'string') return null;
  if (typeof f.d !== 'string') return null;
  if (f.i >= f.n) return null;
  if (crc32hex(f.d) !== f.crc) return null;
  return {
    v: QR_ENVELOPE_VERSION,
    sid: f.sid,
    i: f.i,
    n: f.n,
    crc: f.crc,
    d: f.d,
  };
}

// --- Stateful receiver ------------------------------------------------------

export class FrameAccumulator {
  private sid: string | null = null;
  private n: number | null = null;
  private readonly chunks = new Map<number, string>();

  /** Add a frame. Ignores frames from a different session; dedups by index. */
  add(f: QrFrame): void {
    if (this.sid === null) {
      this.sid = f.sid;
      this.n = f.n;
    } else if (f.sid !== this.sid) {
      // Frame belongs to a different hand-off — ignore it.
      return;
    }
    // First frame of the session pins n; ignore frames that disagree on n or
    // carry an out-of-range index.
    if (this.n !== null && (f.n !== this.n || f.i < 0 || f.i >= this.n)) return;
    if (!this.chunks.has(f.i)) {
      this.chunks.set(f.i, f.d);
    }
  }

  get sessionId(): string | null {
    return this.sid;
  }

  get received(): number {
    return this.chunks.size;
  }

  get total(): number | null {
    return this.n;
  }

  get complete(): boolean {
    return this.n !== null && this.chunks.size === this.n;
  }

  /** Reassemble the original reports. Throws if not yet complete. */
  reports(): unknown[] {
    if (!this.complete || this.n === null) {
      throw new Error('FrameAccumulator: cannot decode — not all frames received');
    }
    let b64 = '';
    for (let i = 0; i < this.n; i += 1) {
      const chunk = this.chunks.get(i);
      if (chunk === undefined) {
        throw new Error(`FrameAccumulator: missing frame ${i}`);
      }
      b64 += chunk;
    }
    return decodePayload(b64);
  }
}
