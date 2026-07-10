// Retained for diagnostics/backward-compatible test fixtures. Infrastructure
// failures no longer dead-letter solely because this count is exceeded.
export const SYNC_MAX_ATTEMPTS = 5;
export const SYNC_POLL_MS = 15_000; // periodic auto-sync tick while online
// Bytes per fountain source block. The base64 of one block (~4/3×) plus the
// small frame header is what each QR code carries, so this sets the QR density.
// 140 bytes → ~187 base64 chars + header ≈ a ~v14 / 73-module code: sparse
// enough for a phone camera to lock and decode quickly. With fountain coding a
// missed frame is free (the next distinct symbol is just as useful), so we no
// longer pay a coupon-collector penalty for dense or fast frames.
export const FOUNTAIN_BLOCK_BYTES = 140;

// Sender symbol cadence. The receiver decodes ~20 attempts/sec (see
// QR_SCAN_DELAY_MS), so a fast sender just means more distinct fountain symbols
// delivered per second — and a torn frame (image swapped mid-exposure) fails its
// per-frame CRC and is harmlessly skipped, never corrupting the payload. 100ms
// (10 fps) keeps ~2 receiver attempts per displayed symbol while staying well
// under the tearing threshold; it is 6× the old 600ms.
export const QR_FRAME_MS = 100;

// Receiver decode cadence (zxing delayBetweenScanAttempts / delayBetweenScanSuccess).
// zxing defaults BOTH to 500ms — so it sleeps half a second after every decode,
// capping the receiver at ~2 frames/sec no matter the camera's real frame rate.
// That was the dominant QR-transfer bottleneck. 50ms ⇒ ~20 attempts/sec.
export const QR_SCAN_DELAY_MS = 50;

export const QR_ENVELOPE_VERSION = 2 as const;
