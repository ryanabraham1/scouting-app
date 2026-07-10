import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const uploadMock = vi.fn();
const createSignedUrlMock = vi.fn();
const removeMock = vi.fn();
const serverRowsMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => serverRowsMock().then(resolve, reject),
      };
      return chain;
    }),
    storage: {
      from: vi.fn(() => ({
        upload: uploadMock,
        createSignedUrl: createSignedUrlMock,
        remove: removeMock,
      })),
    },
  },
}));

import { supabase } from '@/lib/supabase';
import {
  cleanupPitPhotoTombstones,
  uploadPitPhoto,
  signedPitPhotoUrl,
} from '../photoUpload';
import {
  completePitPhotoCleanup,
  pitDb,
  queuePitPhotoCleanup,
  savePitDraft,
  type PitReport,
} from '../pitStore';

describe('uploadPitPhoto', () => {
  beforeEach(() => {
    uploadMock.mockReset();
    createSignedUrlMock.mockReset();
    removeMock.mockReset();
    serverRowsMock.mockReset();
    serverRowsMock.mockResolvedValue({ data: [], error: null });
    (supabase.storage.from as unknown as ReturnType<typeof vi.fn>).mockClear();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-1111-1111-111111111111'
    );
  });

  it('uploads to an immutable per-photo path and returns it', async () => {
    uploadMock.mockResolvedValue({ data: { path: 'x' }, error: null });
    const file = new Blob(['abc'], { type: 'image/jpeg' });
    const path = await uploadPitPhoto('2026casj', 254, 'photo-1', file);
    expect(supabase.storage.from).toHaveBeenCalledWith('pit-photos');
    expect(uploadMock).toHaveBeenCalledWith('2026casj/254/photo-1.jpg', file, {
      upsert: false,
      contentType: 'image/jpeg',
    });
    expect(path).toBe('2026casj/254/photo-1.jpg');
  });

  it('throws on upload error', async () => {
    uploadMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(
      uploadPitPhoto('2026casj', 254, new Blob(['x']))
    ).rejects.toThrow('boom');
  });
});

function report(): PitReport {
  return {
    eventKey: '2026casj',
    teamNumber: 254,
    drivetrain: '',
    mechanisms: [],
    capabilities: [],
    intakeSources: [],
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
    notes: '',
    scoutId: 's1',
  };
}

describe('pit photo tombstone cleanup', () => {
  beforeEach(async () => {
    await pitDb.pitDrafts.clear();
    await pitDb.pitReports.clear();
    await pitDb.pitPhotoCleanup.clear();
    removeMock.mockReset();
    serverRowsMock.mockReset();
    serverRowsMock.mockResolvedValue({ data: [], error: null });
  });

  it('deletes an unreferenced orphan and clears its tombstone', async () => {
    removeMock.mockResolvedValue({ data: [], error: null });
    await queuePitPhotoCleanup('2026casj/254/orphan.jpg', '2026casj', 254);

    await expect(cleanupPitPhotoTombstones()).resolves.toBe(1);
    expect(removeMock).toHaveBeenCalledWith(['2026casj/254/orphan.jpg']);
    expect(await pitDb.pitPhotoCleanup.count()).toBe(0);
  });

  it('never deletes a path still referenced locally or by the server', async () => {
    removeMock.mockResolvedValue({ data: [], error: null });
    const local = report();
    local.photos = [{
      id: 'kept',
      path: '2026casj/254/kept.jpg',
      order: 0,
      mimeType: 'image/jpeg',
      width: 10,
      height: 10,
    }];
    local.photoPath = local.photos[0].path;
    await savePitDraft(local.eventKey, local.teamNumber, local);
    await queuePitPhotoCleanup('2026casj/254/kept.jpg', '2026casj', 254);
    await queuePitPhotoCleanup('2026casj/254/server.jpg', '2026casj', 254);
    serverRowsMock.mockResolvedValue({
      data: [{ photo_path: '2026casj/254/server.jpg', photos: [] }],
      error: null,
    });

    await expect(cleanupPitPhotoTombstones()).resolves.toBe(0);
    expect(removeMock).not.toHaveBeenCalled();
    expect(await pitDb.pitPhotoCleanup.count()).toBe(2);
    await completePitPhotoCleanup('2026casj/254/kept.jpg');
    await completePitPhotoCleanup('2026casj/254/server.jpg');
  });

  it('retains a failed removal for a later retry', async () => {
    removeMock
      .mockResolvedValueOnce({ data: null, error: { message: 'storage unavailable' } })
      .mockResolvedValueOnce({ data: [], error: null });
    await queuePitPhotoCleanup('2026casj/254/retry.jpg', '2026casj', 254);

    expect(await cleanupPitPhotoTombstones()).toBe(0);
    expect((await pitDb.pitPhotoCleanup.get('2026casj/254/retry.jpg'))?.attempts).toBe(1);
    expect(await cleanupPitPhotoTombstones()).toBe(1);
    expect(await pitDb.pitPhotoCleanup.get('2026casj/254/retry.jpg')).toBeUndefined();
  });
});

describe('signedPitPhotoUrl', () => {
  beforeEach(() => {
    createSignedUrlMock.mockReset();
  });

  it('returns the signed url for a 7-day expiry (offline weekend survival)', async () => {
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: 'https://signed/url' },
      error: null,
    });
    const url = await signedPitPhotoUrl('2026casj/254/a.jpg');
    expect(createSignedUrlMock).toHaveBeenCalledWith('2026casj/254/a.jpg', 60 * 60 * 24 * 7);
    expect(url).toBe('https://signed/url');
  });

  it('returns null on error', async () => {
    createSignedUrlMock.mockResolvedValue({
      data: null,
      error: { message: 'nope' },
    });
    const url = await signedPitPhotoUrl('2026casj/254/a.jpg');
    expect(url).toBeNull();
  });
});
