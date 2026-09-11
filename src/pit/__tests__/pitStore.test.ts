import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();

// Reference rpcMock LAZILY (inside a function body) so the hoisted vi.mock factory
// doesn't read it at import time — a direct `rpc: rpcMock` hits the const's TDZ.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import {
  savePitDraft,
  getPitDraft,
  listPitDraftsForEvent,
  listPitQuarantine,
  deletePitQuarantine,
  completePitSync,
  enqueuePitReport,
  getPitReport,
  markPitPending,
  pitDb,
  setPitUploadedPhoto,
  submitPit,
  type PitReport,
} from '../pitStore';

function makeReport(over: Partial<PitReport> = {}): PitReport {
  return {
    eventKey: '2026casj',
    teamNumber: 254,
    drivetrain: 'swerve',
    mechanisms: ['shooter', 'climber'],
    capabilities: ['auto', 'climb_l3'],
    intakeSources: ['neutral'],
    visionSystem: 'Limelight 3',
    batteryCount: 6,
    chargerCount: 2,
    batteryBrand: 'MK',
    batteryConnector: 'Anderson SB50',
    preferredAutoStartPosition: { x: 0.2, y: 0.5 },
    preferredAutoPath: [
      { x: 0.2, y: 0.5 },
      { x: 0.6, y: 0.5 },
    ],
    matchStrategy: ['score', 'cycle'],
    robotLengthIn: 30,
    robotWidthIn: 28,
    robotHeightIn: 24,
    trenchCapable: true,
    photos: [],
    photoPath: '2026casj/254/a.jpg',
    notes: 'fast',
    scoutId: 'scout-1',
    ...over,
  };
}

describe('pit draft', () => {
  beforeEach(async () => {
    await pitDb.pitDrafts.clear();
    await pitDb.pitQuarantine.clear();
    await pitDb.pitPhotoCleanup.clear();
  });

  it('saves and reads back a draft by event+team', async () => {
    const r = makeReport();
    await savePitDraft(r.eventKey, r.teamNumber, r);
    const got = await getPitDraft('2026casj', 254);
    expect(got?.draftKey).toBe('2026casj:254');
    expect(got?.data.drivetrain).toBe('swerve');
    expect(got?.updatedAt).toBeTruthy();
  });

  it('returns undefined for a missing draft', async () => {
    const got = await getPitDraft('2026casj', 9999);
    expect(got).toBeUndefined();
  });

  it('quarantines malformed persisted rows for export/delete recovery', async () => {
    await pitDb.pitDrafts.put({
      draftKey: '2026casj:254',
      eventKey: '2026casj',
      teamNumber: 254,
      updatedAt: '2026-07-10T12:00:00.000Z',
      data: { ...makeReport(), batteryCount: Number.POSITIVE_INFINITY },
    });

    expect(await listPitDraftsForEvent('2026casj')).toEqual([]);
    const quarantined = await listPitQuarantine('2026casj');
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].reason).toMatch(/batteryCount/i);
    expect(quarantined[0].raw).toBeTruthy();
    expect(await pitDb.pitDrafts.count()).toBe(0);

    await deletePitQuarantine(quarantined[0].id);
    expect(await pitDb.pitQuarantine.count()).toBe(0);
  });
});

describe('submitPit', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('upserts snake_case row via the revision-guarded upsert_pit_report RPC', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    await submitPit(makeReport());
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [fn, args] = rpcMock.mock.calls[0];
    expect(fn).toBe('upsert_pit_report');
    const { row_revision, ...rest } = args.p as Record<string, unknown>;
    expect(rest).toEqual({
      event_key: '2026casj',
      team_number: 254,
      drivetrain: 'swerve',
      mechanisms: ['shooter', 'climber'],
      // intake sources are folded into the capabilities jsonb; there is no
      // top-level intake_sources column on pit_scouting_report.
      capabilities: { items: ['auto', 'climb_l3'], intakeSources: ['neutral'] },
      vision_system: 'Limelight 3',
      batteries: { count: 6, chargers: 2, brand: 'MK', connector: 'Anderson SB50' },
      preferred_auto_start_position: { x: 0.2, y: 0.5 },
      preferred_auto_path: [
        { x: 0.2, y: 0.5 },
        { x: 0.6, y: 0.5 },
      ],
      match_strategy: ['score', 'cycle'],
      robot_dimensions: { lengthIn: 30, widthIn: 28, heightIn: 24, trenchCapable: true },
      pit_questionnaire: {},
      auto_routines: [],
      photos: [{
        id: 'legacy',
        path: '2026casj/254/a.jpg',
        order: 0,
        mimeType: null,
        width: null,
        height: null,
      }],
      photo_path: '2026casj/254/a.jpg',
      notes: 'fast',
      author_scout_id: 'scout-1',
    });
    // The guard value is a monotonic epoch-ms (the report's edit time).
    expect(typeof row_revision).toBe('number');
  });

  it('throws on upsert error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'rls' } });
    await expect(submitPit(makeReport())).rejects.toThrow('rls');
  });
});

describe('setPitUploadedPhoto', () => {
  beforeEach(async () => {
    await pitDb.pitReports.clear();
    await pitDb.pitDrafts.clear();
    await pitDb.pitPhotoCleanup.clear();
  });

  it('atomically rejects a stale upload after a newer edit is written', async () => {
    const photoId = 'photo-1';
    const newerPhotoId = 'photo-2';
    const oldBlob = new Blob(['old-photo'], { type: 'image/jpeg' });
    await enqueuePitReport(
      makeReport({
        photos: [{
          id: photoId,
          path: null,
          order: 0,
          mimeType: 'image/jpeg',
          width: 100,
          height: 80,
        }],
        photoPath: null,
        notes: 'old edit',
      }),
      { [photoId]: oldBlob },
    );
    const original = await pitDb.pitReports.get('2026casj:254');
    expect(original).toBeDefined();

    const newerBlob = new Blob(['new-photo'], { type: 'image/png' });
    const originalRevision = original!.rowRevision!;
    let newerWriteStarted!: () => void;
    const newerWriteHasStarted = new Promise<void>((resolve) => {
      newerWriteStarted = resolve;
    });
    let releaseNewerWrite!: () => void;
    const newerWriteMayCommit = new Promise<void>((resolve) => {
      releaseNewerWrite = resolve;
    });

    // Hold the newer edit's read-write transaction open after its put. The
    // stale upload completion must queue behind it and evaluate its guard
    // against the newly committed row, not an earlier snapshot.
    const newerWrite = pitDb.transaction('rw', pitDb.pitReports, async () => {
      await pitDb.pitReports.put({
        ...original!,
        // Deliberately keep the timestamp unchanged. The monotonic revision,
        // not updatedAt, is the submission/upload fence.
        rowRevision: originalRevision + 1,
        data: {
          ...original!.data,
          notes: 'newer edit survives',
          photos: [{
            id: newerPhotoId,
            path: null,
            order: 0,
            mimeType: 'image/png',
            width: 120,
            height: 90,
          }],
          photoPath: null,
        },
        photoBlobs: { [newerPhotoId]: newerBlob },
      });
      newerWriteStarted();
      await Dexie.waitFor(newerWriteMayCommit);
    });
    await newerWriteHasStarted;

    const staleCompletion = setPitUploadedPhoto(
      '2026casj:254',
      photoId,
      '2026casj/254/stale-upload.jpg',
      originalRevision,
    );
    releaseNewerWrite();
    await newerWrite;

    await expect(staleCompletion).resolves.toBe(false);
    const stored = await pitDb.pitReports.get('2026casj:254');
    expect(stored?.updatedAt).toBe(original!.updatedAt);
    expect(stored?.rowRevision).toBe(originalRevision + 1);
    expect(stored?.data.notes).toBe('newer edit survives');
    expect(stored?.data.photos[0]).toMatchObject({
      id: newerPhotoId,
      path: null,
      mimeType: 'image/png',
    });
    expect(stored?.data.photoPath).toBeNull();
    expect(stored?.photoBlobs).toHaveProperty(newerPhotoId);
    expect(stored?.photoBlobs).not.toHaveProperty(photoId);
  });

  it('rejects an upload completion whose photo id is no longer present', async () => {
    await enqueuePitReport(makeReport({ photos: [], photoPath: null }), {});
    const current = await pitDb.pitReports.get('2026casj:254');

    await expect(
      setPitUploadedPhoto(
        '2026casj:254',
        'removed-photo',
        '2026casj/254/removed-photo.jpg',
        current!.rowRevision,
      ),
    ).resolves.toBe(false);
    expect((await pitDb.pitReports.get('2026casj:254'))?.data.photos).toEqual([]);
  });
});

describe('completePitSync', () => {
  beforeEach(async () => {
    await pitDb.pitReports.clear();
    await pitDb.pitDrafts.clear();
  });

  it('does not rebase a newer row whose base has already moved', async () => {
    await enqueuePitReport(makeReport({ notes: 'newer edit' }), {}, 999);
    const newer = await pitDb.pitReports.get('2026casj:254');
    expect(newer).toBeDefined();

    const completion = await completePitSync(
      '2026casj:254',
      newer!.rowRevision! - 1,
      100,
      101,
    );

    expect(completion).toBe('unchanged');
    expect(await pitDb.pitReports.get('2026casj:254')).toMatchObject({
      rowRevision: newer!.rowRevision,
      baseRevision: 999,
      syncState: 'dirty',
      data: { notes: 'newer edit' },
    });
  });

  it('keeps a draft opened during an RPC on the acknowledged base despite stale UI saves', async () => {
    await enqueuePitReport(makeReport({ notes: 'submission A' }), {}, 100);
    const submissionA = await getPitReport('2026casj', 254);
    const revisionA = submissionA!.rowRevision!;
    await markPitPending(submissionA!.draftKey, revisionA);

    await savePitDraft('2026casj', 254, makeReport({ notes: 'open draft' }), {}, 100);
    expect(await completePitSync('2026casj:254', revisionA, 100, revisionA)).toBe('synced');
    expect((await getPitDraft('2026casj', 254))?.baseRevision).toBe(revisionA);

    await savePitDraft('2026casj', 254, makeReport({ notes: 'late UI save' }), {}, 100);
    expect((await getPitDraft('2026casj', 254))?.baseRevision).toBe(revisionA);
    await enqueuePitReport(makeReport({ notes: 'submission B' }), {}, 100);
    expect((await getPitReport('2026casj', 254))?.baseRevision).toBe(revisionA);
  });
});
