export const SYNC_MAX_ATTEMPTS = 5; // attempts beyond which a transient failure → dead-letter
export const SYNC_POLL_MS = 15_000; // periodic auto-sync tick while online
// Bytes per fountain source block. The base64 of one block (~4/3×) plus the
// small frame header is what each QR code carries, so this sets the QR density.
// 140 bytes → ~187 base64 chars + header ≈ a ~v14 / 73-module code: sparse
// enough for a phone camera to lock and decode quickly. With fountain coding a
// missed frame is free (the next distinct symbol is just as useful), so we no
// longer pay a coupon-collector penalty for dense or fast frames.
export const FOUNTAIN_BLOCK_BYTES = 140;
export const QR_FRAME_MS = 600; // sender symbol cadence
export const QR_ENVELOPE_VERSION = 2 as const;
