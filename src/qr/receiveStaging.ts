import { createStore, del, entries, set } from 'idb-keyval';
import {
  MAX_QR_PAYLOAD_BYTES,
  MAX_QR_SESSION_ID_LENGTH,
} from './envelope';

// Each completed transfer is staged under its own sender session id, so an
// offline receiver can collect several scouts' hand-offs in a row and upload
// them all once it is back online. Builds before multi-slot staging kept a
// single transfer under LEGACY_STAGING_KEY; it is migrated on first read.
const LEGACY_STAGING_KEY = 'completed-transfer';
const STAGING_KEY_PREFIX = 'transfer:';
const STAGING_VERSION = 1;
export const QR_RECEIVE_STAGING_MAX_AGE = 24 * 60 * 60 * 1_000;
// Bounds IndexedDB use (each transfer is at most MAX_QR_PAYLOAD_BYTES). A full
// pit's worth of scouts is well under this.
export const MAX_STAGED_QR_TRANSFERS = 25;
const stagingStore = createStore('frc-qr-receive', 'staging');

export interface StagedQrTransfer {
  version: typeof STAGING_VERSION;
  sessionId: string;
  compressed: boolean;
  payload: Uint8Array;
  completedAt: number;
}

function stagingKey(sessionId: string): string {
  return `${STAGING_KEY_PREFIX}${sessionId}`;
}

function stagingPayload(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return new Uint8Array(value);
  }
  return null;
}

function validStaging(value: unknown): value is StagedQrTransfer {
  if (!value || typeof value !== 'object') return false;
  const staged = value as Partial<StagedQrTransfer>;
  return (
    staged.version === STAGING_VERSION &&
    typeof staged.sessionId === 'string' &&
    staged.sessionId.length > 0 &&
    staged.sessionId.length <= MAX_QR_SESSION_ID_LENGTH &&
    typeof staged.compressed === 'boolean' &&
    stagingPayload(staged.payload) !== null &&
    (stagingPayload(staged.payload)?.byteLength ?? 0) > 0 &&
    (stagingPayload(staged.payload)?.byteLength ?? 0) <= MAX_QR_PAYLOAD_BYTES &&
    typeof staged.completedAt === 'number' &&
    Number.isFinite(staged.completedAt)
  );
}

export async function stageCompletedQrTransfer(
  transfer: Omit<StagedQrTransfer, 'version' | 'completedAt'>,
): Promise<StagedQrTransfer> {
  const staged: StagedQrTransfer = {
    ...transfer,
    version: STAGING_VERSION,
    completedAt: Date.now(),
  };
  if (!validStaging(staged)) throw new Error('Completed QR transfer is outside safe limits.');
  const keys = (await entries<IDBValidKey, unknown>(stagingStore)).map(([key]) => String(key));
  const key = stagingKey(staged.sessionId);
  if (!keys.includes(key) && keys.length >= MAX_STAGED_QR_TRANSFERS) {
    throw new Error(
      `This device is already holding ${keys.length} transfers. Upload or discard them first.`,
    );
  }
  await set(key, staged, stagingStore);
  return staged;
}

/**
 * Every staged transfer still worth uploading, oldest first. Malformed and
 * expired entries are removed. A legacy single-slot entry is moved to its
 * per-session key so it is uploaded and cleared like the others.
 */
export async function listStagedQrTransfers(
  now = Date.now(),
): Promise<StagedQrTransfer[]> {
  const rows = await entries<IDBValidKey, unknown>(stagingStore);
  const staged = new Map<string, StagedQrTransfer>();
  for (const [rawKey, value] of rows) {
    const key = String(rawKey);
    if (
      !validStaging(value) ||
      value.completedAt > now ||
      now - value.completedAt > QR_RECEIVE_STAGING_MAX_AGE
    ) {
      await del(rawKey, stagingStore);
      continue;
    }
    const transfer = { ...value, payload: stagingPayload(value.payload) as Uint8Array };
    if (key === LEGACY_STAGING_KEY) {
      await set(stagingKey(transfer.sessionId), transfer, stagingStore);
      await del(rawKey, stagingStore);
    }
    staged.set(transfer.sessionId, transfer);
  }
  return [...staged.values()].sort((a, b) => a.completedAt - b.completedAt);
}

/** Remove one staged transfer, or every staged transfer when no id is given. */
export async function clearStagedQrTransfer(sessionId?: string): Promise<void> {
  if (sessionId !== undefined) {
    await del(stagingKey(sessionId), stagingStore);
    return;
  }
  for (const [key] of await entries<IDBValidKey, unknown>(stagingStore)) {
    await del(key, stagingStore);
  }
}
