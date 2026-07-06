import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the network layer used by the pit outbox: the row upsert (now via the
// revision-guarded upsert_pit_report RPC) and the Storage photo upload. The local
// Dexie outbox is real.
const upsertMock = vi.fn();
// Reference upsertMock lazily so the hoisted factory doesn't read the const in its TDZ.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => upsertMock(...args),
  },
}));
const uploadPitPhoto = vi.fn();
vi.mock('@/pit/photoUpload', () => ({
  uploadPitPhoto: (...a: unknown[]) => uploadPitPhoto(...a),
}));

import {
  pitDb,
  enqueuePitReport,
  getPitSyncQueue,
  listPitDeadLetters,
  type PitReport,
} from '@/pit/pitStore';
import { SYNC_MAX_ATTEMPTS } from '@/sync/constants';
import { syncPitOnce } from '../pitOutbox';

function makeReport(over: Partial<PitReport> = {}): PitReport {
  return {
    eventKey: '2026casj',
    teamNumber: 254,
    drivetrain: 'swerve',
    mechanisms: ['shooter'],
    capabilities: ['auto'],
    intakeSources: ['neutral'],
    visionSystem: '',
    batteryCount: null,
    chargerCount: null,
    batteryBrand: '',
    batteryConnector: '',
    preferredAutoStartPosition: null,
    preferredAutoPath: null,
    matchStrategy: [],
    robotLengthIn: null,
    robotWidthIn: null,
    robotHeightIn: null,
    trenchCapable: false,
    photoPath: null,
    notes: 'fast',
    scoutId: 'scout-1',
    ...over,
  };
}

async function getRec(draftKey: string) {
  return pitDb.pitReports.get(draftKey);
}

describe('syncPitOnce', () => {
  beforeEach(async () => {
    await pitDb.pitReports.clear();
    await pitDb.pitDrafts.clear();
    upsertMock.mockReset();
    uploadPitPhoto.mockReset();
  });

  it('all-success: upserts each queued report and marks them synced', async () => {
    upsertMock.mockResolvedValue({ error: null });
    await enqueuePitReport(makeReport({ teamNumber: 254 }));
    await enqueuePitReport(makeReport({ teamNumber: 1678 }));

    const summary = await syncPitOnce();

    expect(summary).toEqual({ attempted: 2, synced: 2, retried: 0, deadLettered: 0 });
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect((await getPitSyncQueue()).length).toBe(0);
    expect((await getRec('2026casj:254'))?.syncState).toBe('synced');
  });

  it('uploads a pending photo first, then records the returned path on the row', async () => {
    uploadPitPhoto.mockResolvedValue('2026casj/254/uploaded.jpg');
    upsertMock.mockResolvedValue({ error: null });
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    await enqueuePitReport(makeReport({ photoPath: null }), blob);

    const summary = await syncPitOnce();

    expect(summary.synced).toBe(1);
    // (fake-indexeddb structured-clones the Blob, so compare the call shape, not
    // the exact reference — real IndexedDB preserves the Blob.)
    expect(uploadPitPhoto).toHaveBeenCalledTimes(1);
    expect(uploadPitPhoto.mock.calls[0][0]).toBe('2026casj');
    expect(uploadPitPhoto.mock.calls[0][1]).toBe(254);
    // The RPC payload carried the uploaded path. rpc(fn, { p: payload }).
    expect(upsertMock.mock.calls[0][0]).toBe('upsert_pit_report');
    expect(upsertMock.mock.calls[0][1].p).toMatchObject({
      photo_path: '2026casj/254/uploaded.jpg',
    });
    const rec = await getRec('2026casj:254');
    expect(rec?.syncState).toBe('synced');
    expect(rec?.data.photoPath).toBe('2026casj/254/uploaded.jpg');
    expect(rec?.photoBlob ?? null).toBeNull();
  });

  it('network gap (photo upload throws): returns to dirty WITHOUT burning an attempt', async () => {
    uploadPitPhoto.mockRejectedValue(new TypeError('Failed to fetch'));
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    await enqueuePitReport(makeReport(), blob);

    const summary = await syncPitOnce();

    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 1, deadLettered: 0 });
    const rec = await getRec('2026casj:254');
    expect(rec?.syncState).toBe('dirty');
    // A pure network gap never walks a report toward the dead-letter cap.
    expect(rec?.syncAttempts).toBe(0);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('transient (5xx upsert): returns to dirty and increments attempts', async () => {
    upsertMock.mockResolvedValue({ error: { message: 'service unavailable', status: 503 } });
    await enqueuePitReport(makeReport());

    const summary = await syncPitOnce();

    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 1, deadLettered: 0 });
    const rec = await getRec('2026casj:254');
    expect(rec?.syncState).toBe('dirty');
    expect(rec?.syncAttempts).toBe(1);
  });

  it('terminal ({ error } with 42501): dead-letters the report', async () => {
    upsertMock.mockResolvedValue({ error: { code: '42501', message: 'denied' } });
    await enqueuePitReport(makeReport());

    const summary = await syncPitOnce();

    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 0, deadLettered: 1 });
    expect((await getRec('2026casj:254'))?.syncState).toBe('error');
    expect((await listPitDeadLetters()).length).toBe(1);
  });

  it('cap: a transient at SYNC_MAX_ATTEMPTS dead-letters', async () => {
    upsertMock.mockResolvedValue({ error: { message: 'service unavailable', status: 503 } });
    await enqueuePitReport(makeReport());
    await pitDb.pitReports.update('2026casj:254', { syncAttempts: SYNC_MAX_ATTEMPTS });

    const summary = await syncPitOnce();

    expect(summary.deadLettered).toBe(1);
    expect((await getRec('2026casj:254'))?.syncState).toBe('error');
  });

  it('idempotency: re-running after success is a no-op', async () => {
    upsertMock.mockResolvedValue({ error: null });
    await enqueuePitReport(makeReport());
    await syncPitOnce();
    upsertMock.mockClear();

    const summary = await syncPitOnce();
    expect(summary).toEqual({ attempted: 0, synced: 0, retried: 0, deadLettered: 0 });
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
