import { createStore, del, get, set } from 'idb-keyval';
import {
  MAX_QR_PAYLOAD_BYTES,
  MAX_QR_SESSION_ID_LENGTH,
} from './envelope';

const STAGING_KEY = 'completed-transfer';
const STAGING_VERSION = 1;
export const QR_RECEIVE_STAGING_MAX_AGE = 24 * 60 * 60 * 1_000;
const stagingStore = createStore('frc-qr-receive', 'staging');

export interface StagedQrTransfer {
  version: typeof STAGING_VERSION;
  sessionId: string;
  compressed: boolean;
  payload: Uint8Array;
  completedAt: number;
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
  await set(STAGING_KEY, staged, stagingStore);
  return staged;
}

export async function loadStagedQrTransfer(
  now = Date.now(),
): Promise<StagedQrTransfer | null> {
  const value = await get<unknown>(STAGING_KEY, stagingStore);
  if (
    !validStaging(value) ||
    value.completedAt > now ||
    now - value.completedAt > QR_RECEIVE_STAGING_MAX_AGE
  ) {
    if (value !== undefined) await del(STAGING_KEY, stagingStore);
    return null;
  }
  return { ...value, payload: stagingPayload(value.payload) as Uint8Array };
}

export async function clearStagedQrTransfer(): Promise<void> {
  await del(STAGING_KEY, stagingStore);
}
