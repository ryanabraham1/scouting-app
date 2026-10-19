import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createStore, set } from 'idb-keyval';
import {
  clearStagedQrTransfer,
  listStagedQrTransfers,
  MAX_STAGED_QR_TRANSFERS,
  QR_RECEIVE_STAGING_MAX_AGE,
  stageCompletedQrTransfer,
} from '../receiveStaging';

const payload = () => new Uint8Array([91, 93]);

describe('completed QR receive staging', () => {
  beforeEach(async () => {
    await clearStagedQrTransfer();
  });

  it('durably restores a completed decoded payload', async () => {
    const saved = await stageCompletedQrTransfer({
      sessionId: 'sid-1',
      compressed: false,
      payload: payload(),
    });
    const [restored] = await listStagedQrTransfers(saved.completedAt + 1);
    expect(restored?.sessionId).toBe('sid-1');
    expect([...restored!.payload]).toEqual([91, 93]);
  });

  it('holds several senders at once and clears them one by one', async () => {
    await stageCompletedQrTransfer({ sessionId: 'sid-a', compressed: false, payload: payload() });
    await stageCompletedQrTransfer({ sessionId: 'sid-b', compressed: false, payload: payload() });
    expect((await listStagedQrTransfers()).map((t) => t.sessionId).sort()).toEqual([
      'sid-a',
      'sid-b',
    ]);
    await clearStagedQrTransfer('sid-a');
    expect((await listStagedQrTransfers()).map((t) => t.sessionId)).toEqual(['sid-b']);
  });

  it('refuses a new transfer past the cap instead of overwriting one', async () => {
    for (let i = 0; i < MAX_STAGED_QR_TRANSFERS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await stageCompletedQrTransfer({ sessionId: `sid-${i}`, compressed: false, payload: payload() });
    }
    await expect(
      stageCompletedQrTransfer({ sessionId: 'sid-extra', compressed: false, payload: payload() }),
    ).rejects.toThrow(/already holding/);
    // Re-staging an existing sender is still allowed.
    await stageCompletedQrTransfer({ sessionId: 'sid-0', compressed: false, payload: payload() });
    expect(await listStagedQrTransfers()).toHaveLength(MAX_STAGED_QR_TRANSFERS);
  });

  it('migrates the legacy single-slot entry', async () => {
    const store = createStore('frc-qr-receive', 'staging');
    await set(
      'completed-transfer',
      { version: 1, sessionId: 'sid-legacy', compressed: false, payload: payload(), completedAt: Date.now() },
      store,
    );
    expect((await listStagedQrTransfers()).map((t) => t.sessionId)).toEqual(['sid-legacy']);
    await clearStagedQrTransfer('sid-legacy');
    expect(await listStagedQrTransfers()).toEqual([]);
  });

  it('expires old staging instead of replaying it forever', async () => {
    const saved = await stageCompletedQrTransfer({
      sessionId: 'sid-old',
      compressed: false,
      payload: payload(),
    });
    expect(
      await listStagedQrTransfers(saved.completedAt + QR_RECEIVE_STAGING_MAX_AGE + 1),
    ).toEqual([]);
    expect(await listStagedQrTransfers()).toEqual([]);
  });
});
