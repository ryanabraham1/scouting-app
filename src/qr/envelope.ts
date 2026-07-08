import { FOUNTAIN_BLOCK_BYTES, QR_ENVELOPE_VERSION } from '@/sync/constants';

// ---------------------------------------------------------------------------
// QR transport envelope (contracts §6) — LUBY-TRANSFORM FOUNTAIN CODES.
//
// The old transport chopped the payload into a FIXED ordered set of chunks and
// cycled them. A receiver had to catch every specific frame, so the last few
// stragglers forced several full passes through the animation (a coupon-
// collector problem) — exactly the "it takes multiple cycles to scan
// everything" slowness.
//
// Fountain coding fixes this: the payload is split into K source blocks, and the
// sender emits an ENDLESS stream of distinct "symbols", each a random XOR of a
// few source blocks chosen by a seeded PRNG. The receiver runs a peeling
// decoder and reconstructs the whole payload after collecting ~K successful
// symbols — IN ANY ORDER, with NO waiting for a specific frame. Missing a frame
// costs nothing; the next distinct symbol is just as useful.
//
// Pure module: no Math.random / Date.now. Every symbol is a deterministic
// function of its integer seed, so encoder and decoder derive identical block
// selections, and tests stay reproducible. `sid` is passed in by the caller.
// ---------------------------------------------------------------------------

export interface QrFrame {
  v: typeof QR_ENVELOPE_VERSION; // envelope version
  s: string; // session id (stable across all frames of one hand-off)
  t: number; // symbol seed / sequence number (drives the PRNG)
  k: number; // total source block count
  l: number; // payload byte length (pre-padding, for trimming)
  b: number; // block size in bytes
  z: 0 | 1; // payload compression flag (1 = gzip)
  p: string; // CRC32 (8 hex) of the FULL payload bytes — end-to-end integrity
  h: string; // CRC32 (8 hex) of THIS frame's `d` string — per-frame integrity
  d: string; // base64 of this symbol's XORed bytes
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

/** CRC32 of raw bytes → 8 lowercase hex chars. */
export function crc32hexBytes(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return crc.toString(16).padStart(8, '0');
}

/** CRC32 of a UTF-8 string → 8 lowercase hex chars. */
export function crc32hex(s: string): string {
  return crc32hexBytes(new TextEncoder().encode(s));
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

/** reports[] → UTF-8 JSON bytes (the bytes the fountain encodes). */
export function reportsToBytes(reports: unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(reports));
}

/** Inverse of reportsToBytes: decoded payload bytes → reports[]. */
export function bytesToReports(bytes: Uint8Array): unknown[] {
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown[];
}

// --- Seeded PRNG + Robust-Soliton degree distribution ----------------------

/** mulberry32 — a tiny, fast, fully-deterministic PRNG in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Robust-Soliton CDF, memoized per K. Encoder and decoder both read this, so the
// degree sampling is identical on both ends.
const cdfCache = new Map<number, number[]>();
function robustSolitonCdf(k: number): number[] {
  const cached = cdfCache.get(k);
  if (cached) return cached;
  const c = 0.1;
  const delta = 0.5;
  const R = c * Math.log(k / delta) * Math.sqrt(k);
  const mu = new Array<number>(k + 1).fill(0);
  let Z = 0;
  const kr = Math.max(1, Math.floor(k / R));
  for (let i = 1; i <= k; i += 1) {
    // Ideal soliton ρ.
    const rho = i === 1 ? 1 / k : 1 / (i * (i - 1));
    // Robust spike τ.
    let tau = 0;
    if (i < kr) tau = R / (i * k);
    else if (i === kr) tau = (R * Math.log(R / delta)) / k;
    mu[i] = rho + tau;
    Z += mu[i];
  }
  const cdf = new Array<number>(k + 1).fill(0);
  let acc = 0;
  for (let i = 1; i <= k; i += 1) {
    acc += mu[i] / Z;
    cdf[i] = acc;
  }
  cdfCache.set(k, cdf);
  return cdf;
}

/**
 * Deterministically derive a symbol's source-block indices from its seed. K=1 is
 * a degenerate fountain (one block, always degree 1). For K>1 we draw a degree
 * from the Robust-Soliton distribution, then take that many distinct block
 * indices via a partial Fisher–Yates shuffle — all off the same PRNG stream so
 * encoder and decoder agree exactly.
 */
export function symbolIndices(seed: number, k: number): number[] {
  if (k <= 1) return [0];
  const rng = mulberry32(seed);
  const r = rng();
  const cdf = robustSolitonCdf(k);
  let degree = k;
  for (let i = 1; i <= k; i += 1) {
    if (r <= cdf[i]) {
      degree = i;
      break;
    }
  }
  const pool = Array.from({ length: k }, (_, i) => i);
  for (let i = 0; i < degree; i += 1) {
    const j = i + Math.floor(rng() * (k - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, degree).sort((a, b) => a - b);
}

function xorInto(dst: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < dst.length; i += 1) dst[i] ^= src[i];
}

// --- Encoder ----------------------------------------------------------------

/**
 * Splits payload bytes into K fixed-size blocks and emits an endless stream of
 * fountain symbols. `frame(seq)` is pure: the same seq always yields the same
 * symbol, so the sender just walks seq = 0, 1, 2, … forever.
 */
export class FountainEncoder {
  readonly k: number;
  readonly b: number;
  readonly l: number;
  readonly z: 0 | 1;
  readonly p: string;
  private readonly blocks: Uint8Array[];

  constructor(
    payload: Uint8Array,
    private readonly sid: string,
    compressed: boolean,
    blockSize: number = FOUNTAIN_BLOCK_BYTES,
  ) {
    this.l = payload.length;
    this.b = blockSize;
    this.z = compressed ? 1 : 0;
    this.p = crc32hexBytes(payload);
    this.k = Math.max(1, Math.ceil(payload.length / blockSize));
    this.blocks = [];
    for (let i = 0; i < this.k; i += 1) {
      const block = new Uint8Array(blockSize); // zero-padded tail block
      block.set(payload.subarray(i * blockSize, Math.min((i + 1) * blockSize, payload.length)));
      this.blocks.push(block);
    }
  }

  /** The fountain symbol for sequence number `seq`. */
  frame(seq: number): QrFrame {
    const symbol = new Uint8Array(this.b);
    for (const idx of symbolIndices(seq, this.k)) xorInto(symbol, this.blocks[idx]);
    const d = bytesToBase64(symbol);
    return {
      v: QR_ENVELOPE_VERSION,
      s: this.sid,
      t: seq,
      k: this.k,
      l: this.l,
      b: this.b,
      z: this.z,
      p: this.p,
      h: crc32hex(d),
      d,
    };
  }
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
  if (typeof f.s !== 'string') return null;
  if (typeof f.t !== 'number' || !Number.isInteger(f.t) || f.t < 0) return null;
  if (typeof f.k !== 'number' || !Number.isInteger(f.k) || f.k < 1) return null;
  if (typeof f.l !== 'number' || !Number.isInteger(f.l) || f.l < 0) return null;
  if (typeof f.b !== 'number' || !Number.isInteger(f.b) || f.b < 1) return null;
  if (f.z !== 0 && f.z !== 1) return null;
  if (typeof f.p !== 'string') return null;
  if (typeof f.h !== 'string') return null;
  if (typeof f.d !== 'string') return null;
  if (crc32hex(f.d) !== f.h) return null;
  return {
    v: QR_ENVELOPE_VERSION,
    s: f.s,
    t: f.t,
    k: f.k,
    l: f.l,
    b: f.b,
    z: f.z,
    p: f.p,
    h: f.h,
    d: f.d,
  };
}

// --- Decoder (peeling / belief-propagation) --------------------------------

interface PendingSymbol {
  idx: Set<number>; // unsolved source blocks still XORed into `data`
  data: Uint8Array;
}

/**
 * Stateful fountain receiver. Feed it parsed frames in any order; it peels off
 * degree-1 symbols, cascading until every source block is solved. `complete`
 * flips once all K blocks are known; `payloadBytes()` then returns the original
 * bytes (CRC-verified). Frames from a different hand-off (sid/params mismatch)
 * and already-seen seeds are ignored.
 */
export class FountainDecoder {
  private sid: string | null = null;
  private k: number | null = null;
  private b: number | null = null;
  private l: number | null = null;
  private z: 0 | 1 | null = null;
  private p: string | null = null;
  private readonly solved = new Map<number, Uint8Array>();
  private readonly pending: PendingSymbol[] = [];
  private readonly seenSeeds = new Set<number>();

  add(f: QrFrame): void {
    if (this.sid === null) {
      this.sid = f.s;
      this.k = f.k;
      this.b = f.b;
      this.l = f.l;
      this.z = f.z;
      this.p = f.p;
    } else if (
      f.s !== this.sid ||
      f.k !== this.k ||
      f.b !== this.b ||
      f.l !== this.l ||
      f.z !== this.z ||
      f.p !== this.p
    ) {
      // A different hand-off (or a version/param skew) — ignore. `l`/`z` are checked
      // too so a frame sharing sid+params but a different payload length can't set a
      // mismatched final trim length (defense-in-depth on top of the payload CRC).
      return;
    }
    if (this.seenSeeds.has(f.t)) return; // duplicate scan of the same symbol
    this.seenSeeds.add(f.t);

    const data = base64ToBytes(f.d);
    if (data.length !== this.b) return; // malformed symbol length

    const idx = new Set(symbolIndices(f.t, this.k as number));
    // Reduce against everything already solved before queuing.
    for (const i of [...idx]) {
      const sb = this.solved.get(i);
      if (sb) {
        xorInto(data, sb);
        idx.delete(i);
      }
    }
    if (idx.size === 0) return; // wholly redundant
    if (idx.size === 1) {
      this.solve(idx.values().next().value as number, data);
    } else {
      this.pending.push({ idx, data });
    }
  }

  /** Mark a block solved and cascade through pending symbols that reference it. */
  private solve(block: number, data: Uint8Array): void {
    if (this.solved.has(block)) return;
    this.solved.set(block, data);
    const queue = [block];
    while (queue.length > 0) {
      const done = queue.shift() as number;
      const doneData = this.solved.get(done) as Uint8Array;
      for (let s = this.pending.length - 1; s >= 0; s -= 1) {
        const sym = this.pending[s];
        if (!sym.idx.has(done)) continue;
        xorInto(sym.data, doneData);
        sym.idx.delete(done);
        if (sym.idx.size === 1) {
          this.pending.splice(s, 1);
          const only = sym.idx.values().next().value as number;
          if (!this.solved.has(only)) {
            this.solved.set(only, sym.data);
            queue.push(only);
          }
        } else if (sym.idx.size === 0) {
          this.pending.splice(s, 1); // became fully redundant
        }
      }
    }
  }

  get sessionId(): string | null {
    return this.sid;
  }

  /** Number of source blocks solved so far. */
  get solvedCount(): number {
    return this.solved.size;
  }

  /** Total source block count (null before the first frame). */
  get total(): number | null {
    return this.k;
  }

  /** Whether the payload was gzip-compressed (null before the first frame). */
  get compressed(): boolean | null {
    return this.z === null ? null : this.z === 1;
  }

  get complete(): boolean {
    return this.k !== null && this.solved.size === this.k;
  }

  /** Reassemble + CRC-verify the payload bytes. Throws if not complete/corrupt. */
  payloadBytes(): Uint8Array {
    if (!this.complete || this.k === null || this.b === null || this.l === null) {
      throw new Error('FountainDecoder: cannot decode — payload not yet complete');
    }
    const out = new Uint8Array(this.k * this.b);
    for (let i = 0; i < this.k; i += 1) {
      const block = this.solved.get(i);
      if (block === undefined) throw new Error(`FountainDecoder: missing block ${i}`);
      out.set(block, i * this.b);
    }
    const trimmed = out.subarray(0, this.l);
    if (crc32hexBytes(trimmed) !== this.p) {
      throw new Error('FountainDecoder: payload CRC mismatch — corrupt hand-off');
    }
    return trimmed;
  }
}
