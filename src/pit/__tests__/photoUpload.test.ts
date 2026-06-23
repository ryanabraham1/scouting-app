import { describe, it, expect, vi, beforeEach } from 'vitest';

const uploadMock = vi.fn();
const createSignedUrlMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: {
      from: vi.fn(() => ({
        upload: uploadMock,
        createSignedUrl: createSignedUrlMock,
      })),
    },
  },
}));

import { supabase } from '@/lib/supabase';
import { uploadPitPhoto, signedPitPhotoUrl } from '../photoUpload';

describe('uploadPitPhoto', () => {
  beforeEach(() => {
    uploadMock.mockReset();
    createSignedUrlMock.mockReset();
    (supabase.storage.from as unknown as ReturnType<typeof vi.fn>).mockClear();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-1111-1111-111111111111'
    );
  });

  it('uploads to a namespaced .jpg path and returns it', async () => {
    uploadMock.mockResolvedValue({ data: { path: 'x' }, error: null });
    const file = new Blob(['abc'], { type: 'image/jpeg' });
    const path = await uploadPitPhoto('2026casj', 254, file);
    expect(supabase.storage.from).toHaveBeenCalledWith('pit-photos');
    expect(uploadMock).toHaveBeenCalledWith(
      '2026casj/254/11111111-1111-1111-1111-111111111111.jpg',
      file,
      { upsert: false }
    );
    expect(path).toBe('2026casj/254/11111111-1111-1111-1111-111111111111.jpg');
  });

  it('throws on upload error', async () => {
    uploadMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(
      uploadPitPhoto('2026casj', 254, new Blob(['x']))
    ).rejects.toThrow('boom');
  });
});

describe('signedPitPhotoUrl', () => {
  beforeEach(() => {
    createSignedUrlMock.mockReset();
  });

  it('returns the signed url for a 1h expiry', async () => {
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: 'https://signed/url' },
      error: null,
    });
    const url = await signedPitPhotoUrl('2026casj/254/a.jpg');
    expect(createSignedUrlMock).toHaveBeenCalledWith('2026casj/254/a.jpg', 3600);
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
