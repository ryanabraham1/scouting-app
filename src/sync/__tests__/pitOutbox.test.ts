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
  cleanupPitPhotoTombstones: vi.fn(async () => 0),
}));

import {
  pitDb,
  enqueuePitReport,
  deletePitReport,
  getPitSyncQueue,
  listPitDeadLetters,
  type PitReport,
} from '@/pit/pitStore';
import { SYNC_MAX_ATTEMPTS } from '@/sync/constants';
import { syncPitOnce } from '../pitOutbox';
import { clearSyncCircuit } from '../retrySchedule';

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
    photos: [],
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
    clearSyncCircuit();
    await pitDb.pitReports.clear();
    await pitDb.pitDrafts.clear();
    await pitDb.pitPhotoCleanup.clear();
    upsertMock.mockReset();
    uploadPitPhoto.mockReset();
  });

  it('all-success: upserts each queued report and marks them synced', async () => {
    upsertMock.mockResolvedValue({ data: { status: 'applied' }, error: null });
    await enqueuePitReport(makeReport({ teamNumber: 254 }));
    await enqueuePitReport(makeReport({ teamNumber: 1678 }));

    const summary = await syncPitOnce();
    expect(summary).toEqual({ attempted: 2, synced: 2, retried: 0, deadLettered: 0 });
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect((await getPitSyncQueue()).length).toBe(0);
    expect((await getRec('2026casj:254'))?.syncState).toBe('synced');
  });

  it('treats an idempotent pit upsert verdict as synced', async () => {
    upsertMock.mockResolvedValue({
      data: { status: 'idempotent', current_revision: 1 },
      error: null,
    });
    await enqueuePitReport(makeReport());

    expect(await syncPitOnce()).toEqual({
      attempted: 1,
      synced: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect((await getRec('2026casj:254'))?.syncState).toBe('synced');
  });

  it('uploads a pending photo first, then records the returned path on the row', async () => {
    uploadPitPhoto.mockResolvedValue('2026casj/254/uploaded.jpg');
    upsertMock.mockResolvedValue({ data: { status: 'applied' }, error: null });
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

  it('does not send a stale photo upload after a same-timestamp re-submit', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    let uploadStartedResolve!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      uploadStartedResolve = resolve;
    });
    let finishUpload!: (path: string) => void;
    const uploadResult = new Promise<string>((resolve) => {
      finishUpload = resolve;
    });
    uploadPitPhoto.mockImplementation(async () => {
      uploadStartedResolve();
      return uploadResult;
    });
    upsertMock.mockResolvedValue({ data: { status: 'applied' }, error: null });

    try {
      const oldPhotoId = 'old-photo';
      await enqueuePitReport(
        makeReport({
          notes: 'old submission',
          photos: [{
            id: oldPhotoId,
            path: null,
            order: 0,
            mimeType: 'image/jpeg',
            width: 100,
            height: 80,
          }],
          photoPath: null,
        }),
        { [oldPhotoId]: new Blob(['old'], { type: 'image/jpeg' }) },
      );
      const old = await getRec('2026casj:254');
      const syncing = syncPitOnce();
      await uploadStarted;

      await enqueuePitReport(
        makeReport({ notes: 'new submission', photos: [], photoPath: null }),
        {},
      );
      const newer = await getRec('2026casj:254');
      expect(newer?.updatedAt).toBe(old?.updatedAt);
      expect(newer?.rowRevision).toBe(old!.rowRevision! + 1);

      const orphanPath = '2026casj/254/old-photo.jpg';
      finishUpload(orphanPath);
      expect(await syncing).toEqual({
        attempted: 1,
        synced: 0,
        retried: 0,
        deadLettered: 0,
      });

      expect(upsertMock).not.toHaveBeenCalled();
      expect(await pitDb.pitPhotoCleanup.get(orphanPath)).toBeDefined();
      expect(await getRec('2026casj:254')).toMatchObject({
        rowRevision: old!.rowRevision! + 1,
        syncState: 'dirty',
        data: { notes: 'new submission', photos: [] },
      });
    } finally {
      now.mockRestore();
    }
  });

  it('does not mark a same-timestamp re-submit synced when an old RPC completes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    let upsertStartedResolve!: () => void;
    const upsertStarted = new Promise<void>((resolve) => {
      upsertStartedResolve = resolve;
    });
    let finishUpsert!: () => void;
    const upsertResult = new Promise<{ data: { status: string }; error: null }>((resolve) => {
      finishUpsert = () => resolve({ data: { status: 'applied' }, error: null });
    });
    upsertMock.mockImplementation(async () => {
      upsertStartedResolve();
      return upsertResult;
    });

    try {
      await enqueuePitReport(makeReport({ notes: 'old submission' }));
      const old = await getRec('2026casj:254');
      const syncing = syncPitOnce();
      await upsertStarted;

      await enqueuePitReport(makeReport({ notes: 'new submission' }));
      finishUpsert();

      expect(await syncing).toMatchObject({ attempted: 1, synced: 0 });
      expect(await getRec('2026casj:254')).toMatchObject({
        rowRevision: old!.rowRevision! + 1,
        syncState: 'dirty',
        data: { notes: 'new submission' },
      });
    } finally {
      now.mockRestore();
    }
  });

  it.each(['applied', 'idempotent'] as const)(
    'rebases a newer pending edit after its predecessor is %s, then syncs it',
    async (predecessorStatus) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(101);
      let firstUpsertStarted!: () => void;
      const upsertStarted = new Promise<void>((resolve) => {
        firstUpsertStarted = resolve;
      });
      let finishFirstUpsert!: (
        value: { data: { status: typeof predecessorStatus; current_revision: number }; error: null },
      ) => void;
      const firstUpsert = new Promise<{
        data: { status: typeof predecessorStatus; current_revision: number };
        error: null;
      }>((resolve) => {
        finishFirstUpsert = resolve;
      });

      try {
        // Start from a locally synced snapshot of authoritative server rev 100.
        await enqueuePitReport(makeReport({ notes: 'server base' }), {}, null);
        await pitDb.pitReports.update('2026casj:254', {
          syncState: 'synced',
          rowRevision: 100,
          baseRevision: 100,
        });

        await enqueuePitReport(makeReport({ notes: 'submission A' }));
        const submissionA = await getRec('2026casj:254');
        const revisionA = submissionA!.rowRevision!;
        expect(submissionA?.baseRevision).toBe(100);

        upsertMock.mockImplementationOnce(async () => {
          firstUpsertStarted();
          return firstUpsert;
        });
        const syncingA = syncPitOnce();
        await upsertStarted;

        // B replaces the local row while A's RPC is in flight. It must retain
        // base 100 until A's acknowledgement atomically advances it.
        await enqueuePitReport(makeReport({ notes: 'submission B' }));
        const submissionB = await getRec('2026casj:254');
        const revisionB = submissionB!.rowRevision!;
        expect(revisionB).toBe(revisionA + 1);
        expect(submissionB?.baseRevision).toBe(100);

        finishFirstUpsert({
          data: { status: predecessorStatus, current_revision: revisionA },
          error: null,
        });
        expect(await syncingA).toMatchObject({ attempted: 1, synced: 0, deadLettered: 0 });

        const rebasedB = await getRec('2026casj:254');
        expect(rebasedB).toMatchObject({
          rowRevision: revisionB,
          baseRevision: revisionA,
          syncState: 'dirty',
          data: { notes: 'submission B' },
        });

        upsertMock.mockResolvedValueOnce({
          data: { status: 'applied', current_revision: revisionB },
          error: null,
        });
        expect(await syncPitOnce()).toMatchObject({ attempted: 1, synced: 1, deadLettered: 0 });
        expect(upsertMock.mock.calls[1][1].p).toMatchObject({
          base_revision: revisionA,
          row_revision: revisionB,
          notes: 'submission B',
        });
        expect(await getRec('2026casj:254')).toMatchObject({
          rowRevision: revisionB,
          baseRevision: revisionB,
          syncState: 'synced',
          data: { notes: 'submission B' },
        });
      } finally {
        now.mockRestore();
      }
    },
  );

  it.each(['ack-first', 'conflict-first'] as const)(
    'retries B when its conflict exactly matches in-flight predecessor A (%s)',
    async (ordering) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(101);
      let resolveA!: (value: unknown) => void;
      let resolveB!: (value: unknown) => void;
      const responseA = new Promise((resolve) => { resolveA = resolve; });
      const responseB = new Promise((resolve) => { resolveB = resolve; });
      try {
        await enqueuePitReport(makeReport({ notes: 'server base' }), {}, 100);
        await pitDb.pitReports.update('2026casj:254', {
          syncState: 'synced', rowRevision: 100, baseRevision: 100,
        });
        await enqueuePitReport(makeReport({ notes: 'submission A' }));
        const revisionA = (await getRec('2026casj:254'))!.rowRevision!;
        upsertMock.mockImplementationOnce(() => responseA);
        const syncingA = syncPitOnce();
        await vi.waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));

        await enqueuePitReport(makeReport({ notes: 'submission B' }));
        const revisionB = (await getRec('2026casj:254'))!.rowRevision!;
        upsertMock.mockImplementationOnce(() => responseB);
        const syncingB = syncPitOnce();
        await vi.waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(2));

        const ack = { data: { status: 'applied', current_revision: revisionA }, error: null };
        const conflict = { data: { status: 'conflict', current_revision: revisionA }, error: null };
        if (ordering === 'ack-first') {
          resolveA(ack);
          await syncingA;
          resolveB(conflict);
          expect(await syncingB).toMatchObject({ retried: 1, deadLettered: 0 });
        } else {
          resolveB(conflict);
          expect(await syncingB).toMatchObject({ retried: 1, deadLettered: 0 });
          resolveA(ack);
          await syncingA;
        }
        expect(await getRec('2026casj:254')).toMatchObject({
          rowRevision: revisionB, baseRevision: revisionA, syncState: 'dirty',
        });

        upsertMock.mockResolvedValueOnce({
          data: { status: 'applied', current_revision: revisionB }, error: null,
        });
        expect(await syncPitOnce()).toMatchObject({ synced: 1, deadLettered: 0 });
      } finally {
        now.mockRestore();
      }
    },
  );

  it('recovers an applied predecessor after its owner crashed before completion', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(101);
    try {
      await enqueuePitReport(makeReport({ notes: 'submission A' }), {}, 100);
      const revisionA = (await getRec('2026casj:254'))!.rowRevision!;
      // Claim A, then simulate a tab/process crash: no completion handler runs.
      await pitDb.pitReports.update('2026casj:254', {
        syncState: 'pending',
        predecessorAttempts: [{ rowRevision: revisionA, baseRevision: 100 }],
      });
      await enqueuePitReport(makeReport({ notes: 'submission B' }));
      const revisionB = (await getRec('2026casj:254'))!.rowRevision!;
      upsertMock.mockResolvedValueOnce({
        data: { status: 'stale', current_revision: revisionA }, error: null,
      });
      expect(await syncPitOnce()).toMatchObject({ retried: 1, deadLettered: 0 });
      expect(await getRec('2026casj:254')).toMatchObject({ baseRevision: revisionA });
      upsertMock.mockResolvedValueOnce({
        data: { status: 'applied', current_revision: revisionB }, error: null,
      });
      expect(await syncPitOnce()).toMatchObject({ synced: 1 });
    } finally {
      now.mockRestore();
    }
  });

  it('dead-letters a same-revision conflict instead of treating the attempt as its own predecessor', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(101);
    try {
      await enqueuePitReport(makeReport({ notes: 'local B' }), {}, 100);
      expect((await getRec('2026casj:254'))?.rowRevision).toBe(101);
      upsertMock.mockResolvedValueOnce({
        data: { status: 'conflict', current_revision: 101 },
        error: null,
      });

      expect(await syncPitOnce()).toMatchObject({
        attempted: 1,
        retried: 0,
        deadLettered: 1,
      });
      expect(await getRec('2026casj:254')).toMatchObject({
        rowRevision: 101,
        baseRevision: 100,
        syncState: 'error',
        predecessorAttempts: [],
        data: { notes: 'local B' },
      });
    } finally {
      now.mockRestore();
    }
  });

  it('does not let a later C launder B same-revision conflict into predecessor recovery', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(101);
    try {
      await enqueuePitReport(makeReport({ notes: 'local B' }), {}, 100);
      upsertMock.mockResolvedValueOnce({
        data: { status: 'conflict', current_revision: 101 },
        error: null,
      });
      expect(await syncPitOnce()).toMatchObject({ deadLettered: 1, retried: 0 });

      await enqueuePitReport(makeReport({ notes: 'later C' }));
      expect(await getRec('2026casj:254')).toMatchObject({
        rowRevision: 102,
        baseRevision: 100,
        predecessorAttempts: [],
      });
      upsertMock.mockResolvedValueOnce({
        data: { status: 'conflict', current_revision: 101 },
        error: null,
      });

      expect(await syncPitOnce()).toMatchObject({
        attempted: 1,
        retried: 0,
        deadLettered: 1,
      });
      expect(await getRec('2026casj:254')).toMatchObject({
        rowRevision: 102,
        baseRevision: 100,
        syncState: 'error',
        data: { notes: 'later C' },
      });
    } finally {
      now.mockRestore();
    }
  });

  it('prunes an authoritative HTTP 4xx attempt from newer C without laundering its conflict', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(101);
    let finishB!: (value: unknown) => void;
    const responseB = new Promise((resolve) => { finishB = resolve; });
    try {
      await enqueuePitReport(makeReport({ notes: 'terminal B' }), {}, 100);
      const revisionB = (await getRec('2026casj:254'))!.rowRevision!;
      upsertMock.mockImplementationOnce(() => responseB);
      const syncingB = syncPitOnce();
      await vi.waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));

      // C replaces B while B's RPC is in flight and inherits B's claimed
      // predecessor evidence. B's authoritative terminal error must prune only
      // that evidence from C, leaving C's content/base/state untouched.
      await enqueuePitReport(makeReport({ notes: 'newer C' }));
      const revisionC = (await getRec('2026casj:254'))!.rowRevision!;
      finishB({ data: null, error: { status: 400, message: 'invalid payload' } });
      expect(await syncingB).toMatchObject({ attempted: 1, deadLettered: 0 });
      expect(await getRec('2026casj:254')).toMatchObject({
        rowRevision: revisionC,
        baseRevision: 100,
        syncState: 'dirty',
        predecessorAttempts: [],
        data: { notes: 'newer C' },
      });

      // An unrelated server row happens to use B's numeric revision. C must not
      // mistake it for its own landed predecessor and auto-rebase over it.
      upsertMock.mockResolvedValueOnce({
        data: { status: 'conflict', current_revision: revisionB },
        error: null,
      });
      expect(await syncPitOnce()).toMatchObject({ retried: 0, deadLettered: 1 });
      expect(await getRec('2026casj:254')).toMatchObject({
        rowRevision: revisionC,
        baseRevision: 100,
        syncState: 'error',
        data: { notes: 'newer C' },
      });
    } finally {
      now.mockRestore();
    }
  });

  it.each([null, 'not-a-revision'])(
    'prunes B after a conflict with invalid current_revision %s so C cannot launder it',
    async (invalidRevision) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(101);
      try {
        await enqueuePitReport(makeReport({ notes: 'invalid-conflict B' }), {}, 100);
        const revisionB = (await getRec('2026casj:254'))!.rowRevision!;
        upsertMock.mockResolvedValueOnce({
          data: { status: 'conflict', current_revision: invalidRevision },
          error: null,
        });
        expect(await syncPitOnce()).toMatchObject({ retried: 0, deadLettered: 1 });
        expect((await getRec('2026casj:254'))?.predecessorAttempts).toEqual([]);

        await enqueuePitReport(makeReport({ notes: 'later C' }));
        const revisionC = (await getRec('2026casj:254'))!.rowRevision!;
        upsertMock.mockResolvedValueOnce({
          data: { status: 'conflict', current_revision: revisionB },
          error: null,
        });
        expect(await syncPitOnce()).toMatchObject({ retried: 0, deadLettered: 1 });
        expect(await getRec('2026casj:254')).toMatchObject({
          rowRevision: revisionC,
          baseRevision: 100,
          syncState: 'error',
          data: { notes: 'later C' },
        });
      } finally {
        now.mockRestore();
      }
    },
  );

  it('prunes a pre-RPC photo failure so a later C cannot launder B', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(101);
    const photoId = 'pre-rpc-photo';
    try {
      uploadPitPhoto.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await enqueuePitReport(
        makeReport({
          notes: 'photo B',
          photos: [{
            id: photoId,
            path: null,
            order: 0,
            mimeType: 'image/jpeg',
            width: 100,
            height: 80,
          }],
        }),
        { [photoId]: new Blob(['photo'], { type: 'image/jpeg' }) },
        100,
      );
      const revisionB = (await getRec('2026casj:254'))!.rowRevision!;
      expect(await syncPitOnce()).toMatchObject({ retried: 1, deadLettered: 0 });
      expect(upsertMock).not.toHaveBeenCalled();
      expect((await getRec('2026casj:254'))?.predecessorAttempts).toEqual([]);

      await enqueuePitReport(makeReport({ notes: 'later C', photos: [] }), {});
      const revisionC = (await getRec('2026casj:254'))!.rowRevision!;
      clearSyncCircuit();
      upsertMock.mockResolvedValueOnce({
        data: { status: 'conflict', current_revision: revisionB },
        error: null,
      });
      expect(await syncPitOnce()).toMatchObject({ retried: 0, deadLettered: 1 });
      expect(await getRec('2026casj:254')).toMatchObject({
        rowRevision: revisionC,
        baseRevision: 100,
        syncState: 'error',
        data: { notes: 'later C' },
      });
    } finally {
      now.mockRestore();
    }
  });

  it('retains an ambiguous post-RPC transport attempt for exact predecessor recovery', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(101);
    let rejectB!: (reason: unknown) => void;
    const responseB = new Promise((_resolve, reject) => { rejectB = reject; });
    try {
      await enqueuePitReport(makeReport({ notes: 'ambiguous B' }), {}, 100);
      const revisionB = (await getRec('2026casj:254'))!.rowRevision!;
      upsertMock.mockImplementationOnce(() => responseB);
      const syncingB = syncPitOnce();
      await vi.waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));

      await enqueuePitReport(makeReport({ notes: 'newer C' }));
      const revisionC = (await getRec('2026casj:254'))!.rowRevision!;
      rejectB(new TypeError('Failed to fetch'));
      expect(await syncingB).toMatchObject({ attempted: 1, deadLettered: 0 });
      expect((await getRec('2026casj:254'))?.predecessorAttempts).toEqual([
        { rowRevision: revisionB, baseRevision: 100 },
      ]);

      clearSyncCircuit();
      upsertMock.mockResolvedValueOnce({
        data: { status: 'stale', current_revision: revisionB },
        error: null,
      });
      expect(await syncPitOnce()).toMatchObject({ retried: 1, deadLettered: 0 });
      expect(await getRec('2026casj:254')).toMatchObject({
        rowRevision: revisionC,
        baseRevision: revisionB,
        syncState: 'dirty',
        data: { notes: 'newer C' },
      });
    } finally {
      now.mockRestore();
    }
  });

  it.each([503, 504])(
    'retains B after ambiguous HTTP %s, then safely rebases and syncs replacement C',
    async (status) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(101);
      let finishB!: (value: unknown) => void;
      const responseB = new Promise((resolve) => { finishB = resolve; });
      try {
        await enqueuePitReport(makeReport({ notes: 'ambiguous B' }), {}, 100);
        const revisionB = (await getRec('2026casj:254'))!.rowRevision!;
        upsertMock.mockImplementationOnce(() => responseB);
        const syncingB = syncPitOnce();
        await vi.waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));

        await enqueuePitReport(makeReport({ notes: 'replacement C' }));
        const revisionC = (await getRec('2026casj:254'))!.rowRevision!;
        finishB({ data: null, error: { status, message: 'gateway/service timeout' } });
        expect(await syncingB).toMatchObject({ attempted: 1, deadLettered: 0 });
        expect((await getRec('2026casj:254'))?.predecessorAttempts).toEqual([
          { rowRevision: revisionB, baseRevision: 100 },
        ]);

        clearSyncCircuit();
        upsertMock.mockResolvedValueOnce({
          data: { status: 'conflict', current_revision: revisionB },
          error: null,
        });
        expect(await syncPitOnce()).toMatchObject({ retried: 1, deadLettered: 0 });
        expect(await getRec('2026casj:254')).toMatchObject({
          rowRevision: revisionC,
          baseRevision: revisionB,
          syncState: 'dirty',
          data: { notes: 'replacement C' },
        });

        upsertMock.mockResolvedValueOnce({
          data: { status: 'applied', current_revision: revisionC },
          error: null,
        });
        expect(await syncPitOnce()).toMatchObject({ synced: 1, deadLettered: 0 });
        expect(await getRec('2026casj:254')).toMatchObject({
          rowRevision: revisionC,
          baseRevision: revisionC,
          syncState: 'synced',
          predecessorAttempts: [],
        });
      } finally {
        now.mockRestore();
      }
    },
  );

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

  it('preserves a concurrent edit as a fixable conflict dead-letter', async () => {
    upsertMock.mockResolvedValue({
      data: { status: 'conflict', current_revision: 200 },
      error: null,
    });
    await enqueuePitReport(makeReport(), {}, 100);

    const summary = await syncPitOnce();

    expect(summary.deadLettered).toBe(1);
    const record = await getRec('2026casj:254');
    expect(record?.syncState).toBe('error');
    expect(record?.lastSyncError).toMatch(/changed on another device/i);
  });

  it('preserves a stale pit upload and records the authoritative revision', async () => {
    upsertMock.mockResolvedValue({
      data: { status: 'stale', current_revision: 201 },
      error: null,
    });
    await enqueuePitReport(makeReport({ notes: 'keep this local pit edit' }), {}, 100);

    const summary = await syncPitOnce();
    expect(summary).toMatchObject({ synced: 0, deadLettered: 1 });
    const record = await getRec('2026casj:254');
    expect(record?.syncState).toBe('error');
    expect(record?.data.notes).toBe('keep this local pit edit');
    expect(record?.lastSyncError).toContain('201');
  });

  it('tombstones uploaded paths when a conflicted local copy is discarded', async () => {
    upsertMock.mockResolvedValue({
      data: { status: 'conflict', current_revision: 200 },
      error: null,
    });
    const path = '2026casj/254/conflicted.jpg';
    await enqueuePitReport(
      makeReport({
        photos: [{
          id: 'conflicted',
          path,
          order: 0,
          mimeType: 'image/jpeg',
          width: 100,
          height: 80,
        }],
        photoPath: path,
      }),
      {},
      100,
    );
    await syncPitOnce();
    expect((await getRec('2026casj:254'))?.syncState).toBe('error');

    await deletePitReport('2026casj:254');
    expect(await pitDb.pitPhotoCleanup.get(path)).toMatchObject({
      path,
      attempts: 0,
    });
  });

  it('keeps infrastructure failures queued after the legacy attempt cap', async () => {
    upsertMock.mockResolvedValue({ error: { message: 'service unavailable', status: 503 } });
    await enqueuePitReport(makeReport());
    await pitDb.pitReports.update('2026casj:254', { syncAttempts: SYNC_MAX_ATTEMPTS });

    const summary = await syncPitOnce();

    expect(summary).toMatchObject({ retried: 1, deadLettered: 0 });
    expect((await getRec('2026casj:254'))?.syncState).toBe('dirty');
  });

  it('idempotency: re-running after success is a no-op', async () => {
    upsertMock.mockResolvedValue({ data: { status: 'applied' }, error: null });
    await enqueuePitReport(makeReport());
    await syncPitOnce();
    upsertMock.mockClear();

    const summary = await syncPitOnce();
    expect(summary).toEqual({ attempted: 0, synced: 0, retried: 0, deadLettered: 0 });
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
