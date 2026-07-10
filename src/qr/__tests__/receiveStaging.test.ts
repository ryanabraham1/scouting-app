import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearStagedQrTransfer,
  loadStagedQrTransfer,
  QR_RECEIVE_STAGING_MAX_AGE,
  stageCompletedQrTransfer,
} from '../receiveStaging';

describe('completed QR receive staging', () => {
  beforeEach(async () => {
    await clearStagedQrTransfer();
  });

  it('durably restores a completed decoded payload', async () => {
    const payload = new Uint8Array([91, 93]);
    const saved = await stageCompletedQrTransfer({
      sessionId: 'sid-1',
      compressed: false,
      payload,
    });
    const restored = await loadStagedQrTransfer(saved.completedAt + 1);
    expect(restored?.sessionId).toBe('sid-1');
    expect([...restored!.payload]).toEqual([91, 93]);
  });

  it('expires old staging instead of replaying it forever', async () => {
    const saved = await stageCompletedQrTransfer({
      sessionId: 'sid-old',
      compressed: false,
      payload: new Uint8Array([91, 93]),
    });
    expect(
      await loadStagedQrTransfer(saved.completedAt + QR_RECEIVE_STAGING_MAX_AGE + 1),
    ).toBeNull();
    expect(await loadStagedQrTransfer()).toBeNull();
  });
});
